import { mkdirSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import { openDb } from "./db.js";
import { EventStore } from "./eventStore.js";
import { RoomManager } from "./roomManager.js";
import { SessionManager } from "./sessionManager.js";
import { ClaudeCodeExecutor } from "./executors/claudeCode.js";
import { isOriginAllowed } from "./origin.js";
import { WsHub } from "./wsHub.js";

const dataDir = process.env.SUPERFABRIC_DATA ?? path.join(process.cwd(), ".fabrica");
mkdirSync(dataDir, { recursive: true });

// The project the factory runs on: rooms are folders under this root, and the central building
// stands for the root itself.
const projectRoot = path.resolve(process.env.SUPERFABRIC_PROJECT ?? process.cwd());

const db = openDb(path.join(dataDir, "fabrica.db"));
const store = new EventStore(db);
const rooms = new RoomManager(db, projectRoot);
const mgr = new SessionManager(db, store, new ClaudeCodeExecutor(), rooms);
const hub = new WsHub(store, mgr, rooms);

const projectRoom = rooms.ensureProjectRoom();
console.log(`project root: ${projectRoot} (project room "${projectRoom.name}", ${rooms.listRooms().length - 1} room(s))`);

const resumed = mgr.resumeAll();
if (resumed.length > 0) console.log(`resumed sessions: ${resumed.join(", ")}`);
else console.log("no sessions to resume");

const app = Fastify();
app.get("/healthz", async () => ({ ok: true }));

const port = Number(process.env.PORT ?? 4620);
const host = "127.0.0.1";
const wsPath = "/ws";

await app.listen({ port, host });

const wss = new WebSocketServer({
  server: app.server,
  path: wsPath,
  // ws's default cap is 100 MB, handed straight to JSON.parse. Our largest legitimate frame is a
  // prompt; 1 MiB is generous for that and cheap to reject.
  maxPayload: 1024 * 1024,
  // Browsers do not apply CORS to WebSockets, so without this any website the operator visits
  // could drive their agent. See src/origin.ts for the full policy.
  verifyClient: ({ origin, req }, done) => {
    if (isOriginAllowed(origin, port, process.env.SUPERFABRIC_ALLOWED_ORIGINS)) return done(true);
    console.warn(`ws: rejected handshake from origin ${origin} (${req.socket.remoteAddress ?? "?"})`);
    done(false, 403, "Forbidden origin");
  },
});
wss.on("connection", (sock: WebSocket) => {
  hub.attach(sock);
  sock.on("message", (raw) => hub.handleMessage(sock, raw.toString()));
  sock.on("close", () => hub.detach(sock));
  sock.on("error", () => hub.detach(sock));
});

console.log(`listening on http://${host}:${port} (ws path: ${wsPath})`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);

  // wss.close()'s callback only fires once every tracked client has disconnected, so a client
  // that never closes on its own would hang shutdown forever. Force them closed up front.
  console.log("shutdown: closing ws server (no new connections)");
  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
    for (const client of wss.clients) client.terminate();
  });

  console.log("shutdown: stopping executors");
  await mgr.stopAll();

  console.log("shutdown: closing fastify");
  await app.close();

  console.log("shutdown: closing db");
  db.close();

  console.log("shutdown: done");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
