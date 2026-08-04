import { CHRONICLE_SEARCH_LIMIT, ClientMessage, type ServerMessage } from "@superfabric/shared";
import type { AccountLoginManager } from "./accountLogin.js";
import type { AccountManager } from "./accountManager.js";
import type { Demolition } from "./demolition.js";
import { detectAgentClis } from "./toolchain.js";
import type { FactoryPortability } from "./factoryPortability.js";
import type { LimitMonitor } from "./limitMonitor.js";
import type { MetricsStore } from "./metricsStore.js";
import type { Chronicle } from "./chronicle.js";
import type { EventStore } from "./eventStore.js";
import type { FactoryBus } from "./factoryBus.js";
import type { OnboardingManager } from "./onboarding.js";
import { ensureOrchestrator } from "./orchestrator.js";
import type { ProjectManager } from "./projectManager.js";
import type { RoleLibrary } from "./roleLibrary.js";
import type { RoomManager } from "./roomManager.js";
import type { TaskRouter } from "./router.js";
import type { SessionManager } from "./sessionManager.js";
import type { TaskStore } from "./taskStore.js";

export interface SocketLike { send(data: string): void; }

/**
 * Event types that change what a `sessions` message would say (`status`, `blocked`, and the state a
 * terminal failure moves a session to). Everything else — `agent_text` above all — arrives by the
 * token and must never trigger a list broadcast.
 */
const SESSION_SHAPE_EVENTS = new Set(["session_status", "approval_request", "approval_resolved", "session_error"]);

/** Coalescing window for the pushed state broadcasts. */
const BROADCAST_DEBOUNCE_MS = 250;

/** State the server pushes on its own, as opposed to answering a query. */
type PushedList = "sessions" | "tasks" | "messages" | "accounts" | "usage" | "onboarding" | "metrics";

export interface WsHubOptions {
  /** The task board. Absent => `create_task`/`update_task`/`list_tasks` are refused with an error. */
  tasks?: TaskStore;
  /** The factory bus. Absent => no `messages` broadcasts (there is no traffic to report). */
  bus?: FactoryBus;
  /**
   * Task routing. Absent => an unassigned task is simply left unassigned and `route_task` is refused
   * with an error, which is the same shape as a server with no board.
   */
  router?: TaskRouter;
  /**
   * The chronicle. Absent => `search_chronicle` is refused with an error rather than answered with
   * an empty list: "this server records no decisions" and "nobody has decided anything" are
   * different facts, and a surface that showed the second for the first would be lying.
   */
  chronicle?: Chronicle;
  /**
   * The accounts on this machine. Absent => the five account messages are refused with an error
   * rather than answered with an empty list, for the same reason the chronicle is: "this server has
   * no accounts configured" and "you have no accounts" are different facts.
   */
  accounts?: AccountManager;
  /** The in-app login flow. Absent => an account can still be created and bound, just not logged in here. */
  logins?: AccountLoginManager;
  /**
   * The limit monitor. Absent => `list_usage` is refused with an error rather than answered with an
   * empty list, for the same reason the chronicle is: "this server reads no limits" and "your
   * accounts have used nothing" are different facts, and one of them is dangerous to show.
   */
  limits?: LimitMonitor;
  /**
   * The role library. Absent => `list_roles` and `set_role` are refused with an error rather than
   * answered with an empty list, for the same reason the chronicle is: "this server ships no roles"
   * and "there are no roles" are different facts, and a picker showing the second for the first would
   * leave the operator looking for a feature that is right there.
   */
  roles?: RoleLibrary;
  /**
   * Onboarding. Absent => the four onboarding messages are refused with an error rather than answered
   * with "already onboarded", for the same reason the chronicle is: "this server cannot onboard" and
   * "this project needs no onboarding" are different facts, and a UI shown the second for the first
   * would quietly hide the feature.
   */
  onboarding?: OnboardingManager;
  /**
   * Burn rate and cost. Absent => `list_metrics` is refused with an error rather than answered with
   * zeroes, for the same reason the chronicle is: "this server computes no metrics" and "you have spent
   * nothing" are different facts, and the second one is the dangerous one to show.
   */
  metrics?: MetricsStore;
  /**
   * Exporting and importing a factory. Absent => the two messages are refused with an error, which is
   * the shape of every other optional collaborator here.
   */
  portability?: FactoryPortability;
  /**
   * Removing an agent, a room or a factory. Absent => the three deletes are refused with an error
   * rather than half-done — the shape of every other optional collaborator here, and the one where
   * "silently do part of it" would be least forgivable.
   */
  demolition?: Demolition;
  /** Overridable so tests do not have to wait out the real window. */
  sessionsDebounceMs?: number;
}

export class WsHub {
  /** socket -> subscribed sessionIds with last sent seq */
  private subs = new Map<SocketLike, Map<string, number>>();
  /**
   * socket -> the project it is looking at. **The active project is per-socket, not per-server**: a
   * second tab watching another factory must not see this one's rooms, board or belts, and that is
   * only true if every push is addressed by the socket's own scope rather than by a global "current
   * project". Set at `attach` (to the last-opened project) and changed only by `open_project`.
   */
  private active = new Map<SocketLike, string>();
  /**
   * One timer for every pushed list. A second mechanism per list would mean a burst of agent
   * activity costs one frame *per kind* per window instead of one frame, and would need its own
   * unref'd-timer discipline — so `sessions`, `tasks` and `messages` share this path.
   */
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingBroadcasts = new Set<PushedList>();
  private readonly broadcastDebounceMs: number;
  private readonly tasks: TaskStore | undefined;
  private readonly bus: FactoryBus | undefined;
  private readonly router: TaskRouter | undefined;
  private readonly chronicle: Chronicle | undefined;
  private readonly accounts: AccountManager | undefined;
  private readonly logins: AccountLoginManager | undefined;
  private readonly limits: LimitMonitor | undefined;
  private readonly roles: RoleLibrary | undefined;
  private readonly onboarding: OnboardingManager | undefined;
  private readonly metrics: MetricsStore | undefined;
  private readonly transfer: FactoryPortability | undefined;
  private readonly demolition: Demolition | undefined;

  constructor(
    private store: EventStore,
    private mgr: SessionManager,
    private rooms: RoomManager,
    private projects: ProjectManager,
    opts: WsHubOptions = {},
  ) {
    this.broadcastDebounceMs = opts.sessionsDebounceMs ?? BROADCAST_DEBOUNCE_MS;
    this.tasks = opts.tasks;
    this.bus = opts.bus;
    this.router = opts.router;
    this.chronicle = opts.chronicle;
    this.accounts = opts.accounts;
    this.logins = opts.logins;
    this.limits = opts.limits;
    this.roles = opts.roles;
    this.onboarding = opts.onboarding;
    this.metrics = opts.metrics;
    this.transfer = opts.portability;
    this.demolition = opts.demolition;
    // The bus persists and delivers on its own schedule (a send from a tool, a delivery at a turn
    // boundary), so the hub learns about traffic by subscribing rather than by being called. The
    // board is the same story and for a stronger reason: an agent moving its own task with
    // `factory_task_update`, and the bus blocking a task on a request, never pass through this hub.
    opts.bus?.onChange(() => this.scheduleBroadcast("messages"));
    opts.tasks?.onChange(() => this.scheduleBroadcast("tasks"));
    // Accounts announce their own changes for the same reason the board does: `touch()` fires from
    // inside starting a session, which is a path that holds no socket — and `resumeAll` on a busy
    // server fires it once per agent, which the coalescing window turns into one frame.
    opts.accounts?.onChange(() => this.scheduleBroadcast("accounts"));
    // The meters announce themselves too: a poll finishes on a timer that holds no socket, and a
    // 429 seen mid-turn marks an account from inside the session runner. A fresh reading is also a
    // fresh *rate*, so the projection rides the same signal.
    opts.limits?.onChange(() => {
      this.scheduleBroadcast("usage");
      this.scheduleBroadcast("metrics");
    });
    store.onAppend((sessionId, seq, event) => {
      const msg: ServerMessage = { kind: "event", sessionId, seq, event };
      for (const [sock, sessions] of this.subs) {
        const last = sessions.get(sessionId);
        if (last === undefined || seq <= last) continue;
        // The watermark advances only on a *successful* send. The client resubscribes from the
        // last seq it actually holds, so advancing past an event we failed to deliver would lose
        // it permanently. A socket we cannot write to is dead: drop it.
        if (this.safeSend(sock, msg)) sessions.set(sessionId, seq);
        else this.detach(sock);
      }
      // The 3D floor draws a status beacon per building from `SessionInfo.status`/`blocked`, and it
      // must not have to subscribe to (and replay) every session to keep them right. So a status
      // change pushes the whole session list to everyone — but only for the handful of event types
      // that can change it, and coalesced, because a working agent emits events continuously.
      if (SESSION_SHAPE_EVENTS.has(event.type)) this.scheduleBroadcast("sessions");
      // Onboarding's central fact — `CLAUDE.md` now exists at the project root — is changed by an
      // *agent writing a file*. No client request causes it and no event names it, so there is
      // nothing to react to except the moment a writing agent stops: the turn boundary. Cheap (one
      // `existsSync` per project, coalesced) and it means the offer disappears as soon as it is met
      // rather than on the operator's next reload.
      if (this.onboarding !== undefined && event.type === "turn_complete") {
        this.scheduleBroadcast("onboarding");
      }
      // A turn boundary is the only thing that changes what the work has cost — `turn_complete` is
      // where `costUsd` arrives — so the metrics frame rides it, coalesced like everything else.
      if (this.metrics !== undefined && event.type === "turn_complete") {
        this.scheduleBroadcast("metrics");
      }
    });
  }

  /**
   * A new socket starts on the last-opened project, so reloading a tab returns the operator to the
   * factory they were in rather than to whichever folder the server was started from.
   */
  attach(sock: SocketLike): void {
    this.subs.set(sock, new Map());
    // `undefined` on a server with no factory yet — a fresh install, which is a state rather than a
    // failure. Nothing is seeded here: a socket attaching is someone opening a browser tab, and a
    // browser tab is not a decision about which folder this operator works in.
    const landing = this.projects.lastOpened();
    if (landing !== undefined) this.active.set(sock, landing.id);
  }

  detach(sock: SocketLike): void {
    this.subs.delete(sock);
    this.active.delete(sock);
  }

  /**
   * Which factory a socket is looking at, or `null` when this server has none.
   *
   * It used to fall back to "the project for the directory the server runs in", creating it if it was
   * not there — which is how a first run produced a factory over SuperFabric's own source tree. There
   * is no fallback now: an empty server answers empty listings and the UI asks for a folder.
   */
  private activeProject(sock: SocketLike): string | null {
    return this.active.get(sock) ?? null;
  }

  /**
   * The same, for everything that cannot mean anything without a floor — creating a room, an agent, a
   * task, starting an interview. Refused in words the operator can act on rather than by inventing a
   * project for them.
   */
  private requireProject(sock: SocketLike): string {
    const projectId = this.activeProject(sock);
    if (projectId === null) {
      throw new Error(
        "this server has no factory yet — point it at a project folder first (the switcher at the "
        + "top left, or set SUPERFABRIC_PROJECT before starting the server)",
      );
    }
    return projectId;
  }

  /**
   * At most one broadcast per list per window, carrying whatever the state is when the timer fires —
   * so a burst of transitions costs one frame per client and the frame is the newest truth, not the
   * first change that started the burst.
   */
  private scheduleBroadcast(kind: PushedList): void {
    this.pendingBroadcasts.add(kind);
    if (this.broadcastTimer !== null) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const kinds = [...this.pendingBroadcasts];
      this.pendingBroadcasts.clear();
      for (const k of kinds) {
        // Reading a list can throw only if the db is gone (shutdown); a throw here would be an
        // uncaught exception on a timer callback, which takes the process with it.
        try { this.broadcastList(k); } catch { /* the db is closing; nothing to tell anyone */ }
      }
    }, this.broadcastDebounceMs);
    // A pending broadcast must never be the reason the process refuses to exit.
    this.broadcastTimer.unref?.();
  }

  private broadcastList(kind: PushedList): void {
    if (kind === "sessions") this.broadcastSessions();
    else if (kind === "tasks") this.broadcastTasks();
    else if (kind === "accounts") this.broadcastAccounts();
    else if (kind === "usage") this.broadcastUsage();
    else if (kind === "onboarding") this.broadcastOnboarding();
    else if (kind === "metrics") this.broadcastMetrics();
    else this.broadcastMessages();
  }

  handleMessage(sock: SocketLike, raw: string): void {
    let msg: ClientMessage;
    try { msg = ClientMessage.parse(JSON.parse(raw)); }
    catch { this.safeSend(sock, { kind: "error", message: "bad message" }); return; }

    // A detached socket (closed, or dropped after a failed send) must never resurrect itself by
    // sending another frame — creating a subscription entry here would start feeding a dead peer.
    if (!this.subs.has(sock)) {
      this.safeSend(sock, { kind: "error", message: "socket is not attached" });
      return;
    }

    // Every branch below can throw by design (unknown session, non-existent cwd, an approval that
    // does not belong to the session). One malformed-but-valid frame must not escape the socket's
    // 'message' listener and take the process — and every live agent session — down with it.
    try {
      switch (msg.kind) {
        case "subscribe": this.subscribe(sock, msg.sessionId, msg.afterSeq); break;
        case "prompt": this.mgr.prompt(msg.sessionId, msg.text); break;
        case "approval": this.mgr.approve(msg.sessionId, msg.approvalId, msg.behavior); break;
        case "interrupt":
          // An async rejection is an unhandled rejection, which also exits the process on Node 22.
          void this.mgr.interrupt(msg.sessionId).catch((err: unknown) => {
            this.safeSend(sock, { kind: "error", message: String(err) });
          });
          break;
        case "create_session": {
          // `autonomy` omitted => SessionManager applies the product default ("auto"); `model`
          // omitted => the CLI's own default, which is not ours to guess. A `roomId` makes the
          // room's folder the cwd, and an unknown one throws into the catch below. The active
          // project is passed so a room from another factory is refused rather than adopted.
          const id = this.mgr.createSession({
            cwd: msg.cwd, roomId: msg.roomId, autonomy: msg.autonomy, model: msg.model,
            // Omitted => the room's default account, and failing that the ambient `~/.claude`. The
            // resolution is the session runner's, not this hub's: an agent's account is decided once,
            // where it is written to the row.
            accountId: msg.accountId,
            // Omitted => a plain agent. An unknown id throws into the catch below rather than
            // quietly starting a session that is not what was asked for.
            roleId: msg.roleId,
            // Omitted => Claude Code. A provider this server has no executor for throws into the
            // catch below rather than quietly starting the agent on a different CLI.
            provider: msg.provider,
            projectId: this.requireProject(sock),
          });
          this.broadcastSessions();
          // The room's agentCount just changed; refresh it in the same round trip so the building's
          // label never lags behind the agent standing in it.
          if (msg.roomId !== undefined) this.broadcastRooms();
          this.subscribe(sock, id, 0); // auto-subscribe the creator from seq 0
          break;
        }
        case "set_autonomy":
          // Restarting the executor is async, so the outcome is reported from the promise — an
          // unhandled rejection would exit the process on Node 22.
          void this.mgr.setAutonomy(msg.sessionId, msg.autonomy).then(
            () => { this.broadcastSessions(); },
            (err: unknown) => { this.safeSend(sock, { kind: "error", message: String(err) }); },
          );
          break;
        // Same shape as set_autonomy, and for the same reason: the model is fixed for the lifetime
        // of a query(), so the session's executor is restarted and resumed.
        case "set_model":
          void this.mgr.setModel(msg.sessionId, msg.model).then(
            () => { this.broadcastSessions(); },
            (err: unknown) => { this.safeSend(sock, { kind: "error", message: String(err) }); },
          );
          break;
        // And the third of the family. Same shape again: `CLAUDE_CONFIG_DIR` lives in `Options.env`,
        // which is fixed for the lifetime of a `query()`, so the session's executor is restarted and
        // resumed rather than mutated.
        case "set_session_account":
          void this.mgr.setAccount(msg.sessionId, msg.accountId).then(
            () => { this.broadcastSessions(); },
            (err: unknown) => { this.safeSend(sock, { kind: "error", message: String(err) }); },
          );
          break;
        // A query, not a state change: the answer belongs to the socket that asked. Broadcasting it
        // would make every tab's connect handshake spam every other tab with lists it already has.
        // And the fourth of the family. A role composes the system prompt, the model and the tool
        // servers — all `Options` fields fixed for the lifetime of a `query()` — so the session's
        // executor is restarted and resumed rather than mutated.
        case "set_role":
          void this.mgr.setRole(msg.sessionId, msg.roleId).then(
            () => { this.broadcastSessions(); },
            (err: unknown) => { this.safeSend(sock, { kind: "error", message: String(err) }); },
          );
          break;
        // Ending an agent. The counterpart of `interrupt` (which ends a turn), and reported as a
        // notice rather than silently, because the interesting case is the one where nothing appears
        // to happen: an agent mid-turn stops at the boundary it is already heading for.
        case "stop_session": {
          this.requireSessionOnFloor(sock, msg.sessionId);
          void this.mgr.stopSession(msg.sessionId, "stopped by the operator").then(
            (outcome) => {
              this.broadcastSessions();
              this.safeSend(sock, {
                kind: "notice",
                message: outcome === "at-turn-boundary"
                  ? "this agent is finishing its turn and then stops — its transcript stays; "
                    + "interrupt it first if you want the turn cut short"
                  : outcome === "already-stopped"
                    ? "this agent had already stopped"
                    : "agent stopped — its transcript stays, and it will not come back on a restart",
              });
            },
            (err: unknown) => { this.safeSend(sock, { kind: "error", message: String(err) }); },
          );
          break;
        }
        // The one message that destroys history, so it says exactly what it destroyed. The room's
        // agent count changes with it, hence the second broadcast — the same pair `create_session`
        // sends, in reverse.
        case "delete_session": {
          this.requireSessionOnFloor(sock, msg.sessionId);
          void this.demolisher().deleteSession(msg.sessionId).then(
            (removed) => {
              this.broadcastSessions();
              if (removed.roomId !== null) this.broadcastRooms();
              this.safeSend(sock, {
                kind: "notice",
                message: "agent removed, with everything it said"
                  + (removed.tasksUnassigned === 0
                    ? ""
                    : ` — ${removed.tasksUnassigned} task${removed.tasksUnassigned === 1 ? " it owned is" : "s it owned are"} `
                      + "back on the board, unassigned"),
              });
            },
            (err: unknown) => { this.safeSend(sock, { kind: "error", message: String(err) }); },
          );
          break;
        }
        // The listings below answer **empty** rather than refusing when this server has no factory:
        // a client asks for all of them on connect, and a first run would otherwise open on a wall of
        // errors instead of on the one question it needs answered.
        case "list_sessions": {
          const projectId = this.activeProject(sock);
          this.safeSend(sock, {
            kind: "sessions",
            sessions: projectId === null ? [] : this.mgr.listSessions(projectId),
          });
          break;
        }
        // The role library, with its own failures attached. Machine-wide like the accounts — a role
        // is a file on this machine, not a property of a factory — so the answer is the same on every
        // floor and, like every other listing, it goes to the socket that asked.
        case "list_roles": {
          const roles = this.roleStore();
          this.safeSend(sock, { kind: "roles", roles: roles.list(), problems: roles.problems() });
          break;
        }
        // The factory's senior agent. Idempotent, so the UI can call it from a button without first
        // asking whether one exists; the answer is the same fresh `sessions` list either way, and the
        // socket is subscribed to it so the operator can watch it work. It stands in the project room,
        // so the central building's agent count changes too.
        case "ensure_orchestrator": {
          const projectId = this.requireProject(sock);
          const { sessionId, created } = ensureOrchestrator(
            { sessions: this.mgr, rooms: this.rooms }, projectId,
          );
          if (created) {
            this.broadcastSessions();
            this.broadcastRooms();
            this.safeSend(sock, {
              kind: "notice",
              message: "the orchestrator is on the floor, in the project room — give it a task with "
                + "no room and it will route it",
            });
          } else {
            this.safeSend(sock, { kind: "sessions", sessions: this.mgr.listSessions(projectId) });
          }
          this.subscribe(sock, sessionId, 0);
          break;
        }
        // Rooms: each case answers with the whole room list rather than a delta, so a client can
        // rebuild the floor from one message and never has to merge. A failure (duplicate name,
        // unknown id) throws into the catch below and is reported as an error instead.
        case "create_room":
          // `path` given => the room's folder is exactly that, anywhere on disk; omitted => the
          // default `<project root>/<name>`, which still has to stay inside the root.
          this.rooms.createRoom(msg.name, {
            projectId: this.requireProject(sock),
            ...(msg.path !== undefined ? { path: msg.path } : {}),
          });
          this.broadcastRooms();
          break;
        case "move_room":
          this.requireRoomOnFloor(sock, msg.roomId);
          this.rooms.moveRoom(msg.roomId, msg.position);
          this.broadcastRooms();
          break;
        // Re-point a room. Agents already running there keep the cwd their SDK session was started
        // with, which the operator has to know — and that is a fact about a *successful* change, so
        // it goes out as a `notice`. It used to travel on the `error` channel (labelling a success
        // as a failure) and was then only said by the panel; now the protocol has the right channel
        // for it, the server says it itself.
        case "set_room_path": {
          this.requireRoomOnFloor(sock, msg.roomId);
          const room = this.rooms.setPath(msg.roomId, msg.path);
          this.broadcastRooms();
          this.safeSend(sock, {
            kind: "notice",
            message: `room ${room.name} now works in ${room.path} — nothing was moved, and agents `
              + "already running keep the folder they started in",
          });
          break;
        }
        // The room's default account for *new* agents. Nobody already working there moves — the SDK
        // owns a live session's environment — so the notice says so rather than leaving the operator
        // to infer it from an agent that did not change.
        case "set_room_account": {
          this.requireRoomOnFloor(sock, msg.roomId);
          if (msg.accountId !== null) this.accountStore().require(msg.accountId);
          const room = this.rooms.setAccount(msg.roomId, msg.accountId);
          this.broadcastRooms();
          const label = msg.accountId === null
            ? "the ambient ~/.claude"
            : this.accountStore().require(msg.accountId).label;
          this.safeSend(sock, {
            kind: "notice",
            message: `new agents in ${room.name} will run on ${label} — agents already working there `
              + "keep the account they started on",
          });
          break;
        }
        // Where this room's agents run. Like the account and the folder it is a default for the
        // *next* executor start, and the notice says so — but here the lag has to be spelled out
        // rather than implied, because the thing that lags is an isolation boundary. An operator who
        // switched a room to `container` and read "done" would reasonably believe the agent working
        // in it was already sandboxed; it is not until it restarts.
        case "set_room_runtime": {
          this.requireRoomOnFloor(sock, msg.roomId);
          const room = this.rooms.setRuntime(msg.roomId, msg.runtime);
          this.broadcastRooms();
          this.broadcastSessions();
          const live = this.mgr
            .listSessions(this.requireProject(sock))
            .filter((s) => s.roomId === room.id && s.runtime !== null && s.runtime !== msg.runtime);
          const where = msg.runtime === "container"
            ? "in a container — only this room's folder and its account's credentials, capped CPU, "
              + "memory and processes, and default-deny egress"
            : "on this machine, as you, with your filesystem and your credentials";
          this.safeSend(sock, {
            kind: "notice",
            message: `new agents in ${room.name} will run ${where}`
              + (live.length === 0
                ? ""
                : ` — ${live.length} agent${live.length === 1 ? " is" : "s are"} already running here `
                  + `and stay${live.length === 1 ? "s" : ""} on the ${live[0]!.runtime} runtime until `
                  + "restarted (change its model or its role to restart it now)"),
          });
          break;
        }
        // Taking a building off the floor. The notice names the two things an operator cannot see
        // from the floor going quiet: the folder is still there, and the agents that stood in it are
        // not — the client warned about the second before asking, and this confirms what happened.
        case "delete_room": {
          this.requireRoomOnFloor(sock, msg.roomId);
          void this.demolisher().deleteRoom(msg.roomId).then(
            (removed) => {
              this.broadcastRooms();
              this.broadcastSessions();
              const agents = removed.agents === 0
                ? ""
                : `, and ${removed.agents} agent${removed.agents === 1 ? "" : "s"} with it`;
              const tasks = removed.tasksUnassigned === 0
                ? ""
                : ` — ${removed.tasksUnassigned} task${removed.tasksUnassigned === 1 ? " is" : "s are"} `
                  + "back on the board, unassigned";
              this.safeSend(sock, {
                kind: "notice",
                message: `room ${removed.room.name} removed${agents}. Its folder is untouched: `
                  + `${removed.room.path} is exactly as it was${tasks}`,
              });
            },
            (err: unknown) => { this.safeSend(sock, { kind: "error", message: String(err) }); },
          );
          break;
        }
        case "list_rooms": {
          const projectId = this.activeProject(sock);
          this.safeSend(sock, {
            kind: "rooms",
            rooms: projectId === null ? [] : this.rooms.listRooms(projectId),
          });
          break;
        }
        // Accounts. The one group of messages here that is *not* scoped to a project: a subscription is
        // the operator's and serves every factory, so the answer goes to every socket rather than only
        // to those on one floor. See `AccountInfo`.
        case "list_accounts":
          this.safeSend(sock, { kind: "accounts", accounts: this.accountStore().list() });
          break;
        // What agent CLIs this machine has. Machine-wide like the accounts, and answered to the
        // socket that asked. Detection is a PATH walk and a stat — nothing is executed, so a client
        // asking on every connect costs no subprocesses.
        case "list_toolchain":
          this.safeSend(sock, { kind: "toolchain", tools: detectAgentClis() });
          break;
        // The meters, as the monitor last read them. Deliberately does **not** trigger a read: a
        // client connecting is not a reason to spend a request against an undocumented, rate-limited
        // endpoint, and ten tabs opening at once must not become ten requests.
        case "list_usage":
          this.safeSend(sock, { kind: "usage", usage: this.limitStore().list() });
          break;
        // Burn rate and cost, from readings and log rows this server already holds. Like `list_usage`
        // it reads nothing over the network — and unlike it, it is scoped, because the room half of
        // the answer belongs to one floor.
        // Metrics and onboarding are the two listings with nothing to say about a floor that does not
        // exist — a `FactoryMetrics` or an `OnboardingState` for no project would have to invent an
        // id. Nothing is sent, and the client keeps the null it started with.
        case "list_metrics": {
          const projectId = this.activeProject(sock);
          if (projectId === null) break;
          this.safeSend(sock, { kind: "metrics", metrics: this.metricStore().snapshot(projectId) });
          break;
        }
        case "create_account": {
          // The store announces its own change (see the constructor), so the fresh list reaches every
          // tab without this branch having to push it — the same arrangement the board has.
          const account = this.accountStore().create({
            label: msg.label, configDir: msg.configDir,
            // Omitted => Claude Code. It decides which file means "logged in" and where the limits
            // are read from, so it has to travel with the row rather than be guessed from the path.
            ...(msg.provider !== undefined ? { provider: msg.provider } : {}),
          });
          this.safeSend(sock, {
            kind: "notice",
            message: `account ${account.label} uses ${account.configDir} — log it in to give it a `
              + "subscription of its own",
          });
          break;
        }
        case "remove_account": {
          const { label, roomsUnbound } = this.accountStore().remove(msg.accountId);
          // A room's default silently becoming "the operator's own account" is exactly the kind of
          // change that has to be said out loud.
          if (roomsUnbound > 0) this.broadcastRooms();
          this.safeSend(sock, {
            kind: "notice",
            message: roomsUnbound === 0
              ? `account ${label} removed`
              : `account ${label} removed — ${roomsUnbound} room${roomsUnbound === 1 ? "" : "s"} `
                + "now default to the ambient ~/.claude",
          });
          break;
        }
        // The in-app login. Three messages for one conversation: start it, hand over the code the
        // OAuth page gives you, or give up. Nothing here blocks — the flow reports itself through the
        // `accounts` broadcast, which is also what makes it visible in a second tab.
        case "begin_account_login":
          this.loginStore().begin(msg.accountId);
          break;
        case "submit_account_login_code":
          this.loginStore().submitCode(msg.accountId, msg.code);
          break;
        case "cancel_account_login":
          this.loginStore().cancel(msg.accountId);
          break;
        // Projects. `list_projects` answers the asking socket; the other two change global state (a
        // new project) or per-socket state (which floor this tab is on), and both end with this socket
        // holding a complete, freshly scoped set of lists.
        case "list_projects": this.sendProjects(sock); break;
        case "create_project": {
          const project = this.projects.create({
            root: msg.root, ...(msg.name !== undefined ? { name: msg.name } : {}),
          });
          // A factory with no central building is not a factory: the floor would be empty and there
          // would be nothing for the first room's belt to join.
          this.rooms.ensureProjectRoom(project.id);
          // The operator typed a path to go there, so go there — and tell every other tab that the
          // switcher has a new entry.
          this.openProject(sock, project.id);
          break;
        }
        case "open_project": this.openProject(sock, msg.projectId); break;
        // Removing a whole factory. Unlike `export_project` this is *not* restricted to the floor this
        // tab is on: deleting reads nothing, and the switcher lists every project — being made to
        // switch to a factory in order to remove it would be a strange dance. Every tab that *was*
        // looking at it has to be moved, though, because its project id no longer resolves.
        case "delete_project": {
          const wasLookingAt = [...this.subs.keys()]
            .filter((s) => this.activeProject(s) === msg.projectId);
          void this.demolisher().deleteProject(msg.projectId).then(
            (removed) => {
              // `undefined` when that was the last factory: those tabs are moved to no floor at all
              // and the UI shows its first-run screen again, which is the truth.
              const fallback = this.projects.lastOpened();
              for (const other of wasLookingAt) {
                // Only sockets still attached: a failed send during the move detaches them.
                if (!this.subs.has(other)) continue;
                if (fallback === undefined) this.leaveProject(other);
                else this.openProject(other, fallback.id);
              }
              for (const other of [...this.subs.keys()]) this.sendProjects(other);
              this.safeSend(sock, {
                kind: "notice",
                message: `factory ${removed.project.name} removed — ${removed.rooms} room(s), `
                  + `${removed.agents} agent(s) and ${removed.tasks} task(s). Nothing on disk was `
                  + `touched: ${removed.project.root} still holds every folder, charter and ADR `
                  + "the factory wrote",
              });
            },
            (err: unknown) => { this.safeSend(sock, { kind: "error", message: String(err) }); },
          );
          break;
        }
        // Onboarding. A query, then three changes — and every one of them answers with the whole
        // state rather than a delta, like the room list does, so a client can rebuild the surface
        // from one frame and never has to merge.
        case "list_onboarding": {
          const projectId = this.activeProject(sock);
          if (projectId === null) break;
          this.safeSend(sock, {
            kind: "onboarding",
            onboarding: this.onboardingStore().state(projectId),
          });
          break;
        }
        // Idempotent like `ensure_orchestrator`, and answered the same way: the notice is what tells
        // the operator where the interview is happening, because the agent stands in the project room
        // and its first question arrives in the console like any other turn.
        case "start_onboarding": {
          const projectId = this.requireProject(sock);
          const { sessionId, created } = this.onboardingStore().start(projectId);
          this.broadcastSessions();
          this.broadcastRooms();
          this.scheduleBroadcast("onboarding");
          this.safeSend(sock, {
            kind: "notice",
            message: created
              ? "an onboarding agent is in the project room — it will ask you one question at a "
                + "time in the console, and write CLAUDE.md and README.md when it has enough"
              : "onboarding is already running for this project — its questions are in the console",
          });
          this.subscribe(sock, sessionId, 0);
          break;
        }
        // The proposal becomes rooms **here**, through `RoomManager.createRoom` — the same path the
        // room panel's own form uses, with the same invariants. Nothing an agent said reached a
        // folder until this message arrived.
        case "accept_room_suggestions": {
          const projectId = this.requireProject(sock);
          const result = this.onboardingStore().accept(projectId, msg.rooms);
          if (result.created.length > 0) this.broadcastRooms();
          this.scheduleBroadcast("onboarding");
          const made = result.created.map((r) => r.name).join(", ");
          const refused = result.failed.map((f) => `${f.name} (${f.message})`).join("; ");
          this.safeSend(sock, refused === ""
            ? { kind: "notice", message: `created ${result.created.length} room(s): ${made}` }
            : {
              kind: "error",
              message: result.created.length === 0
                ? `no rooms were created — ${refused}`
                : `created ${made}; not created — ${refused}`,
            });
          break;
        }
        case "dismiss_room_suggestion":
          this.onboardingStore().dismiss(this.requireProject(sock), msg.suggestionId);
          this.scheduleBroadcast("onboarding");
          break;
        // Tasks. The board is global state like rooms are, so a change is broadcast — on the
        // coalescing path, because an agent driving `factory_task_update` can change it as fast as
        // it can call a tool. The broadcast is *not* scheduled here: the store announces its own
        // changes (see the constructor), which is the only way the board also stays right for the
        // changes that never come through this hub. An unknown task or an assignee from the wrong
        // room throws into the catch below and is reported to the socket that asked.
        case "create_task": {
          const task = this.taskStore().create({
            title: msg.title, detail: msg.detail, roomId: msg.roomId,
            projectId: this.requireProject(sock),
          });
          // A card with no room is the intended path, and this is where routing starts: the
          // orchestrator is sent a message describing it and the floor. With no orchestrator nothing
          // is sent and nothing changes — the task stays visibly unassigned, which is the truth.
          if (task.roomId === null && this.router !== undefined) this.router.requestRouting(task.id);
          break;
        }
        // The board's "route it": ask again, for a card that was created before this factory had an
        // orchestrator or whose question went unanswered. Never assigns anything itself.
        case "route_task": {
          const router = this.taskRouter();
          const sent = router.requestRouting(msg.taskId);
          this.safeSend(sock, sent === undefined
            ? {
              kind: "notice",
              message: "this factory has no orchestrator yet, so the task stays unassigned — create "
                + "one and route it again",
            }
            : { kind: "notice", message: "the orchestrator has been asked where this task belongs" });
          break;
        }
        case "update_task":
          this.taskStore().update(msg.taskId, {
            ...(msg.status !== undefined ? { status: msg.status } : {}),
            ...(msg.roomId !== undefined ? { roomId: msg.roomId } : {}),
            ...(msg.agentId !== undefined ? { agentId: msg.agentId } : {}),
          });
          break;
        case "list_tasks": {
          const projectId = this.activeProject(sock);
          this.safeSend(sock, {
            kind: "tasks",
            tasks: projectId === null ? [] : this.taskStore().list(projectId),
          });
          break;
        }
        // A query like the others: the socket that asked gets the bus's newest traffic, and nobody
        // else is spammed with a list they already hold.
        case "list_messages": {
          const projectId = this.activeProject(sock);
          this.safeSend(sock, {
            kind: "messages",
            messages: projectId === null ? [] : this.busStore().list(projectId),
          });
          break;
        }
        // The chronicle, as the operator's own copy of `factory_search_history`: the same index, the
        // same hits, answered to the socket that asked. An empty query is "show me what has been
        // decided here", which is the question someone opening the surface actually has.
        case "search_chronicle": {
          const chronicle = this.chronicleStore();
          const projectId = this.requireProject(sock);
          const limit = msg.limit ?? CHRONICLE_SEARCH_LIMIT;
          const hits = msg.query.trim() === ""
            ? chronicle.recentHits(projectId, limit)
            : chronicle.search(projectId, msg.query, limit);
          // The query travels back with its answer so a client can drop the results of a search it
          // has already moved on from — see `chronicle` in the protocol.
          this.safeSend(sock, { kind: "chronicle", query: msg.query, hits });
          break;
        }
        // Portability. An export is a read of this socket's own floor — answered to the socket that
        // asked, never broadcast, because it is a file the operator started downloading.
        case "export_project": {
          const projectId = msg.projectId ?? this.requireProject(sock);
          // A client holding another project's id must not be able to read that factory's shape
          // through this socket, for the same reason `requireRoomOnFloor` exists.
          if (projectId !== this.requireProject(sock)) {
            throw new Error("a factory can only be exported from the floor this tab is looking at");
          }
          this.safeSend(sock, { kind: "factory_export", factory: this.portability().export(projectId) });
          break;
        }
        // An import changes the world: a project may appear, rooms and a board certainly do. So the
        // switcher is refreshed for everybody, this socket is moved onto the floor it just built (an
        // operator who imports a factory wants to be looking at it), and the *result* — including
        // everything the import could not do — goes back as its own message rather than as a notice.
        case "import_factory": {
          const result = this.portability().import({
            root: msg.root,
            ...(msg.name !== undefined ? { name: msg.name } : {}),
            factory: msg.factory,
          });
          this.safeSend(sock, { kind: "factory_import", result });
          this.openProject(sock, result.projectId);
          for (const other of [...this.subs.keys()]) {
            if (other !== sock) this.sendProjects(other);
          }
          break;
        }
      }
    } catch (err) {
      this.safeSend(sock, { kind: "error", message: String(err) });
    }
  }

  /**
   * Send a message to every attached socket **looking at the given project**. Room, session, board and
   * bus state is global to a factory but not to the server, so a change made in one tab has to reach
   * the other tabs on that floor — and must not reach a tab watching another one. The list is built
   * once per project rather than once per socket, so ten tabs on one floor still cost one query.
   *
   * Errors stay per-socket: they answer one request.
   */
  private broadcastPerProject(build: (projectId: string) => ServerMessage | null): void {
    const byProject = new Map<string, SocketLike[]>();
    // Snapshot the keys: a failed send detaches, and mutating the map while iterating it is how a
    // "cannot happen" skipped socket happens.
    for (const sock of [...this.subs.keys()]) {
      const projectId = this.activeProject(sock);
      // A socket on no floor has nothing to be told about one. It gets its state the moment it opens
      // a project, which is the only thing it can do from there.
      if (projectId === null) continue;
      const group = byProject.get(projectId);
      if (group === undefined) byProject.set(projectId, [sock]);
      else group.push(sock);
    }
    for (const [projectId, socks] of byProject) {
      const msg = build(projectId);
      if (msg === null) continue;
      for (const sock of socks) {
        if (!this.safeSend(sock, msg)) this.detach(sock);
      }
    }
  }

  private broadcastRooms(): void {
    this.broadcastPerProject((p) => ({ kind: "rooms", rooms: this.rooms.listRooms(p) }));
  }

  private broadcastSessions(): void {
    this.broadcastPerProject((p) => ({ kind: "sessions", sessions: this.mgr.listSessions(p) }));
  }

  private broadcastTasks(): void {
    if (this.tasks === undefined) return;
    this.broadcastPerProject((p) => ({ kind: "tasks", tasks: this.tasks!.list(p) }));
  }

  /**
   * The account list, to **every** attached socket.
   *
   * The one broadcast here that does not go through `broadcastPerProject`, and deliberately: accounts
   * are machine-wide (see `AccountInfo`), so there is one list and every tab has the same one whatever
   * factory it is looking at. Building it per project would send identical frames N times and imply a
   * scoping that does not exist.
   *
   * `announceAccounts` is the public entry point, and it goes through the same coalescing window as
   * every other pushed list: the login flow reports a state change on each chunk the CLI prints, and
   * a frame per chunk would be a frame per few characters of a URL.
   */
  announceAccounts(): void {
    this.scheduleBroadcast("accounts");
  }

  /**
   * Public entry point for "the meters changed", on the same coalescing window as every other pushed
   * list: a poll finishing and a 429 landing in the same second cost one frame, not two.
   */
  /**
   * Public entry point for "an agent's state changed for a reason that came from outside a socket" —
   * the scheduler pausing or resuming one. Coalesced like every other pushed list.
   */
  announceSessions(): void {
    this.scheduleBroadcast("sessions");
  }

  announceUsage(): void {
    this.scheduleBroadcast("usage");
  }

  private broadcastAccounts(): void {
    if (this.accounts === undefined) return;
    const msg: ServerMessage = { kind: "accounts", accounts: this.accounts.list() };
    for (const sock of [...this.subs.keys()]) {
      if (!this.safeSend(sock, msg)) this.detach(sock);
    }
  }

  /**
   * The meters, to **every** attached socket — the same reasoning as `broadcastAccounts`: an
   * account's quota is machine-wide, so there is one answer and every tab has it.
   */
  private broadcastUsage(): void {
    if (this.limits === undefined) return;
    const msg: ServerMessage = { kind: "usage", usage: this.limits.list() };
    for (const sock of [...this.subs.keys()]) {
      if (!this.safeSend(sock, msg)) this.detach(sock);
    }
  }

  private broadcastMessages(): void {
    if (this.bus === undefined) return;
    this.broadcastPerProject((p) => ({ kind: "messages", messages: this.bus!.list(p) }));
  }

  /**
   * Burn rate and cost, per floor.
   *
   * Per project rather than to every socket, unlike `usage` — the account half of the frame is
   * machine-wide and identical everywhere, but the room half belongs to one factory, and a tab must
   * never be shown another floor's spend. See `FactoryMetrics`.
   */
  private broadcastMetrics(): void {
    if (this.metrics === undefined) return;
    this.broadcastPerProject((p) => ({ kind: "metrics", metrics: this.metrics!.snapshot(p) }));
  }

  /**
   * Public entry point for "the metrics moved for a reason outside a socket". Coalesced like every
   * other pushed list.
   */
  announceMetrics(): void {
    this.scheduleBroadcast("metrics");
  }

  /**
   * Where each floor stands with onboarding. Per project like the rooms, because that is what it is
   * about — and because `onboarded` is a `CLAUDE.md` at *one* project's root.
   */
  private broadcastOnboarding(): void {
    if (this.onboarding === undefined) return;
    this.broadcastPerProject((p) => ({ kind: "onboarding", onboarding: this.onboarding!.state(p) }));
  }

  /**
   * Public entry point for "onboarding changed for a reason that came from outside a socket" — a tool
   * call recording a proposal. Coalesced like every other pushed list.
   */
  announceOnboarding(): void {
    this.scheduleBroadcast("onboarding");
  }

  /**
   * Tell every tab on one factory floor that something worked.
   *
   * Used by the attachment endpoint, which has no socket of its own: an upload arrives over HTTP and
   * the operator has to learn *where the file landed*, in the tab they are looking at. Addressed by
   * project for the same reason every other push is — a tab watching another factory has no business
   * hearing about this one's files.
   */
  noticeProject(projectId: string, message: string): void {
    for (const sock of [...this.subs.keys()]) {
      if (this.activeProject(sock) !== projectId) continue;
      if (!this.safeSend(sock, { kind: "notice", message })) this.detach(sock);
    }
  }

  /**
   * The project list, plus which one *this* socket is on. Every socket gets the same projects and its
   * own active id, so this is a per-socket frame even when the reason for sending it was global (a
   * project someone else created).
   */
  private sendProjects(sock: SocketLike): void {
    this.safeSend(sock, {
      kind: "projects",
      projects: this.projects.list(),
      activeProjectId: this.activeProject(sock),
    });
  }

  /**
   * Point one socket at no factory at all — what is left after the operator deletes the one it was
   * looking at and there is no other.
   *
   * Deliberately the same shape as `openProject`: the scope is dropped, the session subscriptions go
   * with it (their transcripts have just been deleted), and the socket is handed the empty floor
   * rather than left holding the last one it saw. An empty server is a state the UI draws — its
   * first-run screen — not an error to report.
   */
  private leaveProject(sock: SocketLike): void {
    this.active.delete(sock);
    this.subs.set(sock, new Map());
    this.sendProjects(sock);
    this.safeSend(sock, { kind: "rooms", rooms: [] });
    this.safeSend(sock, { kind: "sessions", sessions: [] });
    if (this.tasks !== undefined) this.safeSend(sock, { kind: "tasks", tasks: [] });
    if (this.bus !== undefined) this.safeSend(sock, { kind: "messages", messages: [] });
  }

  /**
   * Point one socket at another factory. `ProjectManager.open` throws for an unknown id (reported as
   * an error, nothing changed), then this socket is re-scoped and handed a complete fresh set of
   * lists — rooms, agents, board, bus traffic — because the client throws away everything it held for
   * the previous project rather than merging. Every other socket is only told that the switcher
   * changed; their own floors are untouched.
   */
  private openProject(sock: SocketLike, projectId: string): void {
    const project = this.projects.open(projectId);
    this.active.set(sock, project.id);
    // Session subscriptions belong to the floor this socket has just left: its transcripts are not
    // this project's, and the client has dropped them too.
    this.subs.set(sock, new Map());

    this.sendProjects(sock);
    this.safeSend(sock, { kind: "rooms", rooms: this.rooms.listRooms(project.id) });
    this.safeSend(sock, { kind: "sessions", sessions: this.mgr.listSessions(project.id) });
    if (this.tasks !== undefined) {
      this.safeSend(sock, { kind: "tasks", tasks: this.tasks.list(project.id) });
    }
    if (this.bus !== undefined) {
      this.safeSend(sock, { kind: "messages", messages: this.bus.list(project.id) });
    }
    // Onboarding is per project too, and it is the first thing this socket needs to know about a
    // factory it has just switched to: an undocumented one should say so before anything else.
    if (this.onboarding !== undefined) {
      this.safeSend(sock, { kind: "onboarding", onboarding: this.onboarding.state(project.id) });
    }
    // The metrics frame's room half is this floor's spend, so it is re-scoped like the rooms rather
    // than surviving the switch the way the machine-wide `usage` does.
    if (this.metrics !== undefined) {
      this.safeSend(sock, { kind: "metrics", metrics: this.metrics.snapshot(project.id) });
    }
    // Other tabs: the switcher gained (or re-ordered) an entry, and their `lastOpenedAt` changed.
    for (const other of [...this.subs.keys()]) {
      if (other !== sock) this.sendProjects(other);
    }
  }

  /**
   * Refuse to touch a building that is not on the floor this socket is looking at. Room ids are
   * globally unique, so without this a client holding another project's room id could move or
   * re-point it — and the change would be broadcast to a floor that never asked for it.
   */
  private requireRoomOnFloor(sock: SocketLike, roomId: string): void {
    const projectId = this.rooms.projectOf(roomId);
    if (projectId === undefined) throw new Error(`unknown room ${roomId}`);
    if (projectId !== this.requireProject(sock)) {
      throw new Error(`room ${roomId} belongs to another project`);
    }
  }

  /**
   * Refuse to touch an agent that is not on the floor this socket is looking at — the twin of
   * `requireRoomOnFloor`, and needed for the same reason: session ids are globally unique, so without
   * it a client holding another project's id could stop or delete an agent on a floor it cannot see,
   * and the change would be announced to operators who never asked for it.
   */
  private requireSessionOnFloor(sock: SocketLike, sessionId: string): void {
    const projectId = this.mgr.projectOf(sessionId);
    if (projectId === undefined) throw new Error(`unknown session ${sessionId}`);
    if (projectId !== this.requireProject(sock)) {
      throw new Error(`session ${sessionId} belongs to another project`);
    }
  }

  /** Likewise for demolition: "this server does not delete" is an answer; half a delete is not. */
  private demolisher(): Demolition {
    if (this.demolition === undefined) {
      throw new Error("this server cannot remove agents, rooms or factories");
    }
    return this.demolition;
  }

  /** Likewise for the router: a factory with no routing says so rather than swallowing the request. */
  private taskRouter(): TaskRouter {
    if (this.router === undefined) throw new Error("this server has no task router");
    return this.router;
  }

  /** A task request on a server with no task board is a routing error, not a silent no-op. */
  private taskStore(): TaskStore {
    if (this.tasks === undefined) throw new Error("this server has no task board");
    return this.tasks;
  }

  /** Likewise for the chronicle: no index is not the same answer as an empty index. */
  private chronicleStore(): Chronicle {
    if (this.chronicle === undefined) throw new Error("this server has no chronicle");
    return this.chronicle;
  }

  /** Likewise for accounts: a server with none configured says so rather than answering with `[]`. */
  private accountStore(): AccountManager {
    if (this.accounts === undefined) throw new Error("this server has no accounts");
    return this.accounts;
  }

  /**
   * Likewise for the login flow. Separate from `accountStore` because they can genuinely differ: a
   * server can list and bind accounts without being able to log one in here, and "logging in from the
   * app is not available" is a better answer than a button that does nothing.
   */
  private loginStore(): AccountLoginManager {
    if (this.logins === undefined) throw new Error("this server cannot log accounts in");
    return this.logins;
  }

  /** Likewise for the limit monitor: no meters is an answer, all-zero meters would be a lie. */
  private limitStore(): LimitMonitor {
    if (this.limits === undefined) throw new Error("this server does not monitor limits");
    return this.limits;
  }

  /** Likewise for the metrics: no projection is an answer, a projection of zero would be a lie. */
  private metricStore(): MetricsStore {
    if (this.metrics === undefined) throw new Error("this server does not compute metrics");
    return this.metrics;
  }

  /** Likewise for portability: "this server cannot move a factory" is not an empty export. */
  private portability(): FactoryPortability {
    if (this.transfer === undefined) {
      throw new Error("this server cannot export or import a factory");
    }
    return this.transfer;
  }

  /** Likewise for roles: a server that ships none says so rather than answering with an empty picker. */
  private roleStore(): RoleLibrary {
    if (this.roles === undefined) throw new Error("this server has no role library");
    return this.roles;
  }

  /** Likewise for onboarding: "this server cannot onboard" is not "this project is onboarded". */
  private onboardingStore(): OnboardingManager {
    if (this.onboarding === undefined) throw new Error("this server does not do onboarding");
    return this.onboarding;
  }

  /** Likewise for the bus: "no factory bus here" is an answer, an empty list would be a lie. */
  private busStore(): FactoryBus {
    if (this.bus === undefined) throw new Error("this server has no factory bus");
    return this.bus;
  }

  /** Replay the log after `afterSeq`, then keep tailing from wherever the replay ended. */
  private subscribe(sock: SocketLike, sessionId: string, afterSeq: number): void {
    const sessions = this.subs.get(sock);
    if (sessions === undefined) return;

    const maxSeq = this.store.maxSeq(sessionId);
    // Clamp: a client claiming an afterSeq past the end of the log would otherwise park the
    // watermark above every seq the session will ever produce and mute it forever, silently.
    const from = Math.min(afterSeq, maxSeq);
    if (afterSeq > maxSeq) {
      this.safeSend(sock, {
        kind: "error",
        message: `afterSeq ${afterSeq} is beyond the log of session ${sessionId} (max seq ${maxSeq})`,
      });
    }

    let last = from;
    for (const { seq, event } of this.store.listAfter(sessionId, from)) {
      if (!this.safeSend(sock, { kind: "event", sessionId, seq, event })) { this.detach(sock); return; }
      last = seq;
    }
    sessions.set(sessionId, last);
  }

  /** Returns whether the frame was handed to the socket; false means the socket is unusable. */
  private safeSend(sock: SocketLike, msg: ServerMessage): boolean {
    try { sock.send(JSON.stringify(msg)); return true; }
    catch { return false; }
  }
}
