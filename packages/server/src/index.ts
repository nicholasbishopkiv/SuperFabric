import { mkdirSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import { openDb } from "./db.js";
import { EventStore } from "./eventStore.js";
import { SessionManager } from "./sessionManager.js";
import { ClaudeCodeExecutor } from "./executors/claudeCode.js";
import { WsHub } from "./wsHub.js";

const dataDir = process.env.SUPERFABRIC_DATA ?? path.join(process.cwd(), ".fabrica");
mkdirSync(dataDir, { recursive: true });

const db = openDb(path.join(dataDir, "fabrica.db"));
const store = new EventStore(db);
const mgr = new SessionManager(db, store, new ClaudeCodeExecutor());
const hub = new WsHub(store, mgr);

const resumed = mgr.resumeAll();
if (resumed.length > 0) console.log(`resumed sessions: ${resumed.join(", ")}`);
else console.log("no sessions to resume");

const app = Fastify();
app.get("/healthz", async () => ({ ok: true }));

const port = Number(process.env.PORT ?? 4620);
const host = "127.0.0.1";
const wsPath = "/ws";

await app.listen({ port, host });

const wss = new WebSocketServer({ server: app.server, path: wsPath });
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

  console.log("shutdown: closing ws server (no new connections)");
  await new Promise<void>((resolve) => wss.close(() => resolve()));

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
