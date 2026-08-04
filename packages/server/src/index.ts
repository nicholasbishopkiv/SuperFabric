import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import Docker from "dockerode";
import Fastify from "fastify";
import { RUNNER_SOCKET_FILE } from "@superfabric/shared";
import { WebSocketServer, type WebSocket } from "ws";
import { AccountLoginManager, CredentialsWatcher } from "./accountLogin.js";
import { AccountManager } from "./accountManager.js";
import { registerAttachmentRoutes } from "./attachmentRoutes.js";
import { Chronicle } from "./chronicle.js";
import { openDb } from "./db.js";
import { EventStore } from "./eventStore.js";
import { FactoryPortability } from "./factoryPortability.js";
import { LimitMonitor } from "./limitMonitor.js";
import { MetricsStore } from "./metricsStore.js";
import { FactoryBus } from "./factoryBus.js";
import { OnboardingManager } from "./onboarding.js";
import { ProjectManager } from "./projectManager.js";
import { RoleLibrary, USER_ROLES_DIRNAME } from "./roleLibrary.js";
import { RoomManager } from "./roomManager.js";
import { SkillLibrary } from "./skills.js";
import { LimitScheduler } from "./scheduler.js";
import { TaskRouter } from "./router.js";
import { SessionManager } from "./sessionManager.js";
import { TaskStore } from "./taskStore.js";
import { ClaudeCodeExecutor } from "./executors/claudeCode.js";
import { ContainerExecutor, type DockerLike } from "./executors/container.js";
import { isOriginAllowed } from "./origin.js";
import { RunnerHub } from "./runnerHub.js";
import { startRunnerListener } from "./runnerListener.js";
import { WsHub } from "./wsHub.js";

const dataDir = process.env.SUPERFABRIC_DATA ?? path.join(process.cwd(), ".fabrica");
mkdirSync(dataDir, { recursive: true });

/** An optional numeric knob. A value that is not a number is ignored rather than becoming NaN. */
function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

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
// Roles are files, not rows: the shipped presets in `roles/` at the product root, the operator's own
// in `<data dir>/roles/` overriding them by id. Both are re-read when they change, so tuning a preset
// does not mean bouncing the server. Skills come from the machine's own skill directories — nothing
// here invents one, and a role naming a pack this machine lacks says so in the agent's log.
const roles = new RoleLibrary({ userDir: path.join(dataDir, USER_ROLES_DIRNAME) });
const skills = new SkillLibrary();
for (const problem of roles.problems()) {
  console.warn(`role file ${problem.file} ${problem.message}`);
}
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
// The limit monitor needs the accounts and nothing else; the session runner needs to be able to
// tell it about a 429 without knowing what it is. Declared before `mgr` and populated after, the
// same one-way-callback shape the bus and the router use.
let limits!: LimitMonitor;
// First contact: an interview for a project nobody has written down, and the rooms it proposes — which
// stay proposals until the operator approves them. Same one-way-callback shape again; it needs the
// session runner (the onboarder is an ordinary session with a role) and the runner needs it (for the
// one tool that records a proposal), so it is declared here and populated after.
let onboarding!: OnboardingManager;
// M4: the second half of the `Executor` seam. Containers reach the server over a **unix socket**
// in a directory of its own under the data directory, bind-mounted read-only into every container —
// see `RUNNER_SOCKET_DIR` in the shared protocol for why that rather than a TCP port. The TCP
// fallback exists for a Docker daemon that does not share this filesystem and is off unless
// `SUPERFABRIC_RUNNER_TCP_PORT` says otherwise.
const runnerHub = new RunnerHub({ log: (line) => console.log(`runner: ${line}`) });
const runnerSocketDir = process.env.SUPERFABRIC_RUNNER_SOCKET_DIR ?? path.join(dataDir, "run");
const runnerTcpPort = process.env.SUPERFABRIC_RUNNER_TCP_PORT === undefined
  ? undefined
  : Number(process.env.SUPERFABRIC_RUNNER_TCP_PORT);
const runnerListener = await startRunnerListener({
  hub: runnerHub,
  socketDir: runnerSocketDir,
  socketFile: RUNNER_SOCKET_FILE,
  ...(runnerTcpPort !== undefined ? { tcpPort: runnerTcpPort } : {}),
  log: (line) => console.log(line),
});
// dockerode talks to the daemon's own unix socket in pure JS; nothing here is loaded unless a room
// is actually set to `container`, and a machine with no Docker simply reports it when one is.
const containerExecutor = new ContainerExecutor({
  docker: new Docker() as unknown as DockerLike,
  hub: runnerHub,
  // What identifies *this* factory to the daemon. The data directory, canonicalised, because that is
  // what a server instance is — one `fabrica.db`, one set of sessions — and because without it the
  // boot-time orphan sweep is machine-wide and a second server destroys the first one's agents.
  instanceId: realpathSync(dataDir),
  socketDir: runnerSocketDir,
  ...(runnerTcpPort !== undefined
    ? { serverUrl: `ws://host.docker.internal:${runnerTcpPort}/runner` }
    : {}),
  ...(numberFromEnv("SUPERFABRIC_CONTAINER_MEMORY_MB") !== undefined
    ? { memoryMb: numberFromEnv("SUPERFABRIC_CONTAINER_MEMORY_MB")! }
    : {}),
  ...(numberFromEnv("SUPERFABRIC_CONTAINER_CPUS") !== undefined
    ? { cpus: numberFromEnv("SUPERFABRIC_CONTAINER_CPUS")! }
    : {}),
  ...(numberFromEnv("SUPERFABRIC_CONTAINER_PIDS") !== undefined
    ? { pids: numberFromEnv("SUPERFABRIC_CONTAINER_PIDS")! }
    : {}),
  log: (line) => console.log(`container: ${line}`),
});
mgr = new SessionManager(db, store, new ClaudeCodeExecutor(), rooms, projects, {
  bus, tasks, router, chronicle, accounts, roles, skills, containerExecutor,
  // A getter for the same reason `onRateLimited` below is a closure: it is read when an executor
  // starts, which is long after both objects exist.
  get onboarding() { return onboarding; },
  // A rate-limit error from any session marks that account at once, rather than waiting up to three
  // minutes for the poller to agree. A session on the ambient `~/.claude` has no row to mark.
  onRateLimited: (sessionId, accountId) => {
    if (accountId === null) return;
    limits.markLimited(accountId, `a session was refused with a rate-limit error (${sessionId})`);
  },
});
// The same one-way-callback shape as the bus and the router: the login flow announces itself and the
// hub turns that into a frame, rather than the two holding each other. `hub` exists before anything
// can call back — nothing here runs until a socket sends something.
let hub!: WsHub;
onboarding = new OnboardingManager({
  db, projects, rooms, sessions: mgr, onChange: () => hub.announceOnboarding(),
});
limits = new LimitMonitor(db, accounts, { onChange: () => hub.announceUsage() });
// Utilisation into action: warn at 80 %, hold at 95 % (at a turn boundary, never mid-turn), and
// bring everyone back when the window rolls. It never moves an agent to another subscription — see
// the class comment, and `docs/RESEARCH.md` §5 for why that line is where it is.
const scheduler = new LimitScheduler({
  monitor: limits, sessions: mgr, accounts, onChange: () => hub.announceSessions(),
});
const logins = new AccountLoginManager({ accounts, onChange: () => hub.announceAccounts() });
// So one `AccountInfo` describes the whole account — the row, whether it has credentials, and where
// its login has got to — rather than the UI joining two lists that can disagree.
accounts.setLoginStateSource((id) => logins.stateOf(id));
// Burn rate and cost. The projection is the slope of the readings `limits` has already persisted, and
// the cost is reconstructed from the event log — so this reads nothing over the network and spends no
// quota, which is why a client may ask for it whenever it likes.
const metrics = new MetricsStore(db, accounts, projects);
// Moving a factory. Everything it needs is already here; nothing it produces contains a credential —
// accounts travel as the labels the operator typed, and an import re-binds them by hand.
const portability = new FactoryPortability({ db, projects, rooms, accounts, tasks, chronicle });
hub = new WsHub(store, mgr, rooms, projects, {
  tasks, bus, router, chronicle, accounts, logins, limits, roles, onboarding, metrics, portability,
});

// `.credentials.json` appearing is how the server learns a login finished — and it works whether the
// login was driven from the UI or by the operator running `claude auth login` in their own terminal,
// which is the whole reason it is a filesystem watch rather than something the login flow reports.
const credentials = new CredentialsWatcher(() => {
  hub.announceAccounts();
  // An account that has just been logged in can be read for the first time. The monitor's per-account
  // floor makes this free when it is not due, so it is safe to ask on every file event.
  void limits.pollAll();
});
const watchAccountDirs = (): void => credentials.sync(accounts.list().map((a) => a.configDir));
// Re-synced on every account change, so a directory added at runtime is watched from the moment it
// exists and a removed account stops holding a watcher.
accounts.onChange(watchAccountDirs);
watchAccountDirs();

// The meters. `start()` reads everything due immediately and then no faster than
// `USAGE_POLL_INTERVAL_MS` per account — the floor that keeps us welcome at an undocumented endpoint.
limits.start();
scheduler.start();

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

// A contained agent's container outlives the server on purpose, and `RestartPolicy: unless-stopped`
// brings it back after a machine reboot — so something has to remove the ones no live session claims
// any more. Measured against *every* active session rather than the ones this boot started, because
// a resume adopts its container asynchronously. Fire-and-forget: a factory with no Docker still boots.
void containerExecutor.reapOrphans(new Set(mgr.activeSessionIds())).then((removed) => {
  if (removed.length > 0) console.log(`removed ${removed.length} orphaned container(s)`);
});

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

  // A half-finished `claude auth login` must not outlive the server that started it: it holds a
  // subprocess and a pipe nobody can reach any more.
  logins.stopAll();
  credentials.close();
  // After `stopAll`, which detached from every container rather than ending it: the socket file
  // must outlive nothing, but the containers do — they are reconnecting already, and the next boot
  // will find them by their labels.
  await runnerListener.close();
  limits.stop();
  scheduler.stop();

  console.log("shutdown: closing fastify");
  await app.close();

  console.log("shutdown: closing db");
  db.close();

  console.log("shutdown: done");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
