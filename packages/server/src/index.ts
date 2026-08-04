import { mkdirSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import { AccountManager } from "./accountManager.js";
import { registerAttachmentRoutes } from "./attachmentRoutes.js";
import { Chronicle } from "./chronicle.js";
import { openDb } from "./db.js";
import { EventStore } from "./eventStore.js";
import { FactoryBus } from "./factoryBus.js";
import { ProjectManager } from "./projectManager.js";
import { RoomManager } from "./roomManager.js";
import { TaskRouter } from "./router.js";
import { SessionManager } from "./sessionManager.js";
import { TaskStore } from "./taskStore.js";
import { ClaudeCodeExecutor } from "./executors/claudeCode.js";
import { isOriginAllowed } from "./origin.js";
import { WsHub } from "./wsHub.js";

const dataDir = process.env.SUPERFABRIC_DATA ?? path.join(process.cwd(), ".fabrica");
mkdirSync(dataDir, { recursive: true });

// The project the server boots on: the first factory floor, and the fallback scope for anything that
// does not name a project. It is no longer the only project there can be — the operator adds and
// switches between them from the UI, and each is its own floor with its own rooms, agents and board.
const projectRoot = path.resolve(process.env.SUPERFABRIC_PROJECT ?? process.cwd());

const db = openDb(path.join(dataDir, "fabrica.db"));
const store = new EventStore(db);
const projects = new ProjectManager(db, projectRoot);
const rooms = new RoomManager(db, projects);
const tasks = new TaskStore(db, projects);
// The Chronicle writes into the operator's own repository (docs/decisions/), so it needs the project
// roots and nothing else — the FTS index over it and over the event log is kept in step by triggers.
const chronicle = new Chronicle(db, projects);
// Accounts are machine-wide: no project, no root, just the `CLAUDE_CONFIG_DIR` of each subscription
// the operator has added. Bindings (which room, which agent) are what carry the per-project choice.
const accounts = new AccountManager(db);
// The bus and the session runner need each other: the bus delivers *through* the runner, and the
// runner hands every agent the bus as tools and flushes the bus at each turn boundary. The bus takes
// callbacks rather than the runner itself, so the dependency stays one-way in the module graph — and
// the callbacks are only ever invoked after `mgr` exists.
let mgr!: SessionManager;
const bus = new FactoryBus({
  db,
  rooms,
  projects,
  deliver: (sessionId, text) => mgr.prompt(sessionId, text),
  roomAgents: (roomId) => mgr.roomAgents(roomId),
});
// Routing is the same shape again: it needs to know which session is the orchestrator and who is
// standing in each room, and it gets both as callbacks rather than as the runner itself.
const router = new TaskRouter({
  bus,
  tasks,
  rooms,
  orchestratorFor: (projectId) => mgr.orchestratorFor(projectId),
  roomAgents: (roomId) => mgr.roomAgents(roomId),
});
mgr = new SessionManager(db, store, new ClaudeCodeExecutor(), rooms, projects, {
  bus, tasks, router, chronicle, accounts,
});
const hub = new WsHub(store, mgr, rooms, projects, { tasks, bus, router, chronicle, accounts });

const bootProject = projects.defaultProject();
// Every project needs its central building, including one that existed before this boot.
for (const project of projects.list()) rooms.ensureProjectRoom(project.id);
const projectRoom = rooms.ensureProjectRoom(bootProject.id);
console.log(
  `project root: ${projectRoot} (project room "${projectRoom.name}", `
  + `${rooms.listRooms(bootProject.id).length - 1} room(s), ${projects.list().length} project(s))`,
);

const resumed = mgr.resumeAll();
if (resumed.length > 0) console.log(`resumed sessions: ${resumed.join(", ")}`);
else console.log("no sessions to resume");

// A message that was queued when the server went down is still queued now — that is the whole point
// of persisting before delivering. Flush every room so a resumed agent gets its mail without the
// operator having to prompt it first; delivery is idempotent, so a room with an empty queue costs
// nothing, and a room with nobody available simply keeps waiting.
const carried = projects.list().flatMap((p) => rooms.listRooms(p.id)).flatMap((r) => bus.flushRoom(r.id));
if (carried.length > 0) console.log(`delivered ${carried.length} message(s) queued before the restart`);

const port = Number(process.env.PORT ?? 4620);
const host = "127.0.0.1";
const wsPath = "/ws";

const app = Fastify();
app.get("/healthz", async () => ({ ok: true }));

// Files in, paths out. The only endpoint that takes bytes, and it is gated by the same origin
// allow-list as the WebSocket handshake — see attachmentRoutes.ts for why it is HTTP at all.
registerAttachmentRoutes(app, {
  projects,
  rooms,
  port,
  allowedOrigins: process.env.SUPERFABRIC_ALLOWED_ORIGINS,
  notify: (projectId, message) => hub.noticeProject(projectId, message),
});

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
