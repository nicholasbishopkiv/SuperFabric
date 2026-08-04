import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { AccountManager } from "./accountManager.js";
import { FACTORY_MCP_SERVER_NAME, busTools } from "./busTools.js";
import type { Chronicle } from "./chronicle.js";
import type { Db } from "./db.js";
import type { EventStore } from "./eventStore.js";
import type { Executor, ExecutorHandle } from "./executor.js";
import type { FactoryBus, RoomAgent } from "./factoryBus.js";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "./orchestrator.js";
import type { ProjectManager } from "./projectManager.js";
import type { RoomManager } from "./roomManager.js";
import type { TaskRouter } from "./router.js";
import type { TaskStore } from "./taskStore.js";
import { AutonomyMode, DEFAULT_AUTONOMY, SessionStatus, type SessionInfo } from "@superfabric/shared";

/**
 * How many prompts may pile up while one session's executor restarts before further ones are
 * refused outright. A restart is a subprocess teardown and a resume — a second or two — so a queue
 * this deep already means something is wrong, and silently accepting more would turn "your
 * instruction is on its way" into a lie that grows.
 */
const MAX_HELD_PROMPTS = 20;

/** A tool call waiting on an operator decision, bound to the session that asked. */
interface PendingApproval {
  sessionId: string;
  resolve: (behavior: "allow" | "deny") => void;
}

/**
 * What a new agent needs. An options object rather than positional arguments because `roomId` and
 * `cwd` answer the same question — where the agent works — and a caller must be able to give either
 * without knowing about the other.
 */
export interface CreateSessionOptions {
  /** Working directory. Ignored when `roomId` is given: a room's folder is its agents' cwd. */
  cwd?: string;
  /** The room to work in. Its folder becomes the cwd. Unknown ids are rejected. */
  roomId?: string;
  autonomy?: AutonomyMode;
  /** Model id to pin this agent to. Omitted => the executor's default, i.e. the CLI's own. */
  model?: string;
  /**
   * Run this agent on a particular account, overriding whatever its room defaults to. Omitted => the
   * room's account; a roomless session, or a room bound to none, => the ambient `~/.claude`, which is
   * the pre-M2 behaviour and stays the behaviour of a factory that has configured no accounts.
   *
   * Whatever this resolves to is written onto the session's own row, so the room's default changing
   * later cannot move an agent that is already running.
   */
  accountId?: string;
  /**
   * The factory this agent belongs to. With a `roomId` it is implied by the room and only has to be
   * passed to be *checked* — the hub passes the asking socket's active project, so a client that knew
   * another project's room id cannot put an agent on someone else's floor. Without one it defaults to
   * the default project, which is where a roomless (M0-shaped) session lands.
   */
  projectId?: string;
  /**
   * Make this session the project's orchestrator: the `is_orchestrator` flag, the role prompt, and
   * the larger tool surface. At most one per project — a second attempt throws rather than quietly
   * demoting the first. Go through `ensureOrchestrator` (orchestrator.ts) rather than setting this
   * by hand; it is the thing that also puts the session in the project room.
   */
  isOrchestrator?: boolean;
}

/**
 * Optional collaborators. Both are needed together to give an agent the factory bus, and both are
 * optional so a session runner is still constructible (and testable) without one — an M0-shaped
 * server with no bus is a valid configuration, not a broken one.
 */
export interface SessionManagerOptions {
  bus?: FactoryBus;
  tasks?: TaskStore;
  /** Task routing. Only the orchestrator's tool set uses it; absent is a valid M3a-shaped server. */
  router?: TaskRouter;
  /** The Chronicle. Absent => no agent gets the decision tools; see `BusToolsDeps.chronicle`. */
  chronicle?: Chronicle;
  /**
   * The accounts this server knows about. Absent => every session runs on the ambient `~/.claude`,
   * which is a valid (pre-M2-shaped) server rather than a broken one — the same reason `bus` and
   * `tasks` are optional.
   */
  accounts?: AccountManager;
}

/**
 * Everything `startExecutor` needs to bring one agent up — the session row, minus its identity.
 *
 * An object rather than the eight positional arguments this had grown into. Three of them are
 * nullable strings, and `createSession`, `resumeAll` and `restartExecutor` all build the same list
 * independently: one transposed pair there would silently start an agent in the wrong room on the
 * wrong account, and nothing would fail loudly enough to notice.
 */
interface RunSpec {
  cwd: string;
  /** Provider-native session id to resume, or null for a fresh conversation. */
  resume: string | null;
  autonomy: AutonomyMode;
  roomId: string | null;
  model: string | null;
  /** The account this agent runs on; null is the ambient `~/.claude`. */
  accountId: string | null;
  isOrchestrator: boolean;
}

/** The spec that brings a stored session back exactly as it was. */
function specOf(row: SessionRow): RunSpec {
  return {
    cwd: row.cwd,
    resume: row.claude_session_id,
    autonomy: asAutonomy(row.autonomy),
    roomId: row.room_id,
    model: row.model,
    accountId: row.account_id,
    isOrchestrator: isOrchestratorRow(row),
  };
}

export class SessionManager {
  private handles = new Map<string, ExecutorHandle>();
  /**
   * approvalId -> pending decision. The session id is recorded server-side on purpose: a client
   * must not be able to steer where an `approval_resolved` row lands by sending someone else's
   * (or a bogus) session id alongside a valid approvalId.
   */
  private approvals = new Map<string, PendingApproval>();
  /**
   * Sessions with a turn in flight. The event log knows this too, but it lags by one event: at
   * `turn_complete` the newest `session_status` is still `working` and the `idle` that follows has
   * not been appended yet — which is exactly the instant the bus asks "who is free?". This set is
   * the live answer, so the bus never has to guess.
   */
  private turnInFlight = new Set<string>();
  /** Set by stopAll(): no new executor may be started once shutdown has begun. */
  private stopping = false;
  /**
   * sessionId -> prompts that arrived while that session's executor was being restarted.
   *
   * A restart (`setAutonomy`, `setModel`) tears the old executor down and awaits it before starting
   * the replacement, and for that window the session has no handle. An instruction landing there
   * used to be refused with "no live session", which is technically an error but reads to the
   * operator as the agent having died — and the instruction was gone either way. It is held here
   * instead and delivered the moment the replacement is up. An entry exists **only** while a restart
   * is in flight, so `prompt()` can tell "restarting" from "not running" without a second flag.
   */
  private heldPrompts = new Map<string, string[]>();
  private readonly stmts;

  constructor(
    private db: Db,
    private store: EventStore,
    private executor: Executor,
    private rooms: RoomManager,
    private projects: ProjectManager,
    private opts: SessionManagerOptions = {},
  ) {
    this.stmts = {
      insertSession: db.prepare(
        "INSERT INTO sessions (id, project_id, cwd, autonomy, room_id, model, is_orchestrator, account_id)"
        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      setProviderSessionId: db.prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?"),
      activeSessions: db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE state = 'active'`),
      markError: db.prepare("UPDATE sessions SET state = 'error' WHERE id = ? AND state = 'active'"),
      session: db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`),
      // "Does this factory have an orchestrator, and which session is it?" — asked by every
      // unassigned task and by `ensure_orchestrator`, so it rides `sessions_orchestrator`.
      orchestratorOf: db.prepare(
        "SELECT id FROM sessions WHERE project_id = ? AND is_orchestrator = 1 ORDER BY created_at, rowid LIMIT 1",
      ),
      setAutonomy: db.prepare("UPDATE sessions SET autonomy = ? WHERE id = ?"),
      setModel: db.prepare("UPDATE sessions SET model = ? WHERE id = ?"),
      setAccount: db.prepare("UPDATE sessions SET account_id = ? WHERE id = ?"),
      // One statement, one pass: a per-row MAX(seq) query inside a .map() is O(sessions) queries.
      // `status` and `blocked` are derived from the log by correlated subqueries rather than a
      // second round of queries per row, for the same reason — the 3D floor asks for this list on
      // every status tick, so it has to stay one statement.
      listSessions: db.prepare(sessionListSql("s.project_id = ?")),
      // The same list, filtered to one room. The bus asks "who is standing here and free?" at every
      // turn boundary; a room id already implies a project, so this needs no second scope — and
      // filtering in SQL keeps that question one query rather than a whole floor's listing.
      listRoomSessions: db.prepare(sessionListSql("s.room_id = ?")),
    };
  }

  /**
   * Start an agent. In a room, the room's folder is the cwd — that is what "room = folder" means for
   * the agent working there — so an unknown `roomId` is refused rather than quietly falling back to
   * some other directory.
   */
  createSession(opts: CreateSessionOptions = {}): string {
    const autonomy = opts.autonomy ?? DEFAULT_AUTONOMY;
    let roomId: string | null = null;
    let cwd = opts.cwd ?? process.cwd();
    let projectId = opts.projectId ?? this.projects.defaultProject().id;
    /** The room's default account, when the agent is being put in a room that has one. */
    let roomAccountId: string | null = null;

    if (opts.roomId !== undefined) {
      const room = this.rooms.getRoom(opts.roomId);
      if (room === undefined) throw new Error(`unknown room ${opts.roomId}`);
      const roomProject = this.rooms.projectOf(room.id)!;
      // A caller that named both must mean both: putting an agent in a room the asking socket is not
      // even looking at is either a bug or a client reaching across factories.
      if (opts.projectId !== undefined && roomProject !== opts.projectId) {
        throw new Error(`room ${room.id} belongs to another project`);
      }
      projectId = roomProject;
      roomId = room.id;
      cwd = room.path;
      roomAccountId = room.accountId;
    }

    // `cwd` comes straight off the wire. An unchecked value is persisted forever and makes the
    // executor fail obscurely on this boot and every boot after it, so validate it here.
    let isDir = false;
    try { isDir = statSync(cwd).isDirectory(); }
    catch { throw new Error(`cwd does not exist: ${cwd}`); }
    if (!isDir) throw new Error(`cwd is not a directory: ${cwd}`);

    // One orchestrator per factory, enforced here rather than by a schema constraint (see migration
    // 7). A second attempt throws: silently returning the first would make `createSession` lie about
    // what it created, and silently demoting it would take the role away from a live agent mid-turn.
    const isOrchestrator = opts.isOrchestrator === true;
    if (isOrchestrator && this.orchestratorFor(projectId) !== undefined) {
      throw new Error(`project ${projectId} already has an orchestrator`);
    }

    // The agent's own choice wins over its room's default; with neither, the ambient `~/.claude`. An
    // explicit id is checked here rather than allowed to become a dangling reference: an agent
    // silently starting on the operator's own subscription because a typo'd account id fell back to
    // "none" is the multi-account bug that would be hardest to see.
    const accountId = opts.accountId ?? roomAccountId;
    if (accountId !== null && accountId !== undefined) this.requireAccount(accountId);

    const id = randomUUID();
    const model = opts.model ?? null;
    const spec: RunSpec = {
      cwd, resume: null, autonomy, roomId, model, accountId: accountId ?? null, isOrchestrator,
    };
    this.stmts.insertSession.run(
      id, projectId, cwd, autonomy, roomId, model, isOrchestrator ? 1 : 0, spec.accountId,
    );
    this.startExecutor(id, spec);
    return id;
  }

  /**
   * Refuse an account id this server does not have. Only for ids arriving from *outside* — a stored
   * `account_id` is never re-validated, because a session row outlives the account row it names and a
   * resumed agent must still come back rather than refusing to boot over a deleted account.
   */
  private requireAccount(accountId: string): void {
    const accounts = this.opts.accounts;
    if (accounts === undefined) throw new Error("this server has no accounts");
    accounts.require(accountId);
  }

  /**
   * The session that is this factory's orchestrator, or `undefined` when it has none.
   *
   * `undefined` is a real and *expected* answer, not a failure: a project without an orchestrator
   * routes nothing, and the board says so. Nothing in the server may invent an assignment to cover
   * for it.
   */
  orchestratorFor(projectId: string): string | undefined {
    // `== null`, not `=== undefined`: "no such row" is `null` for the driver db.ts uses.
    const row = this.stmts.orchestratorOf.get(projectId) as { id: string } | null;
    return row == null ? undefined : row.id;
  }

  /**
   * Switch an agent's autonomy. The SDK's permission mode is fixed for the lifetime of a `query()`,
   * so a live session is restarted — resuming from the stored `claude_session_id`, which keeps the
   * conversation — instead of being mutated in place. (`Query.setPermissionMode()` exists and would
   * avoid the restart, but "bypassPermissions" additionally requires the
   * `allowDangerouslySkipPermissions` spawn flag, so a mid-flight switch into bypass is not
   * guaranteed to be honoured by the CLI; a restart makes the stored mode and the mode actually in
   * force identical in every direction.) The new mode is persisted first: even if the restart
   * fails, the next boot starts the agent in the mode the operator asked for.
   */
  async setAutonomy(id: string, autonomy: AutonomyMode): Promise<void> {
    const row = this.stmts.session.get(id) as SessionRow | null;
    if (row == null) throw new Error(`unknown session ${id}`);
    this.stmts.setAutonomy.run(autonomy, id);

    const handle = this.handles.get(id);
    if (handle === undefined) {
      // Nothing live to restart (stopped, errored, or not resumed yet); the stored mode applies
      // the next time this session starts.
      this.store.append(id, {
        type: "session_status", status: "idle",
        detail: `autonomy: ${autonomy} (applies when the session next starts)`,
      });
      return;
    }

    await this.restartExecutor(id, handle, { ...specOf(row), autonomy }, `autonomy: ${autonomy}`);
  }

  /**
   * Switch an agent's model. Same shape and the same reason as `setAutonomy`: the SDK's `model` is
   * an `Options` field baked in when `query()` is called, so a live session is restarted — resuming
   * from the stored `claude_session_id`, which keeps the conversation — rather than mutated. The
   * stored value and the value actually in force can then never disagree, which is the property
   * that matters: an operator who set "Haiku" and is silently still being billed for Opus has been
   * lied to. (`Query.setModel()` does exist and would avoid the restart; a restart is chosen anyway
   * so that the running model, the stored model and the model a reboot would use are one thing.)
   *
   * `null` un-pins the session, handing it back to the CLI's default. The new value is persisted
   * first: even if the restart fails, the next boot starts the agent on the model asked for.
   */
  async setModel(id: string, model: string | null): Promise<void> {
    const row = this.stmts.session.get(id) as SessionRow | null;
    if (row == null) throw new Error(`unknown session ${id}`);
    this.stmts.setModel.run(model, id);

    const handle = this.handles.get(id);
    if (handle === undefined) {
      this.store.append(id, {
        type: "session_status", status: "idle",
        detail: `model: ${model ?? "default"} (applies when the session next starts)`,
      });
      return;
    }

    await this.restartExecutor(id, handle, { ...specOf(row), model }, `model: ${model ?? "default"}`);
  }

  /**
   * Move an agent onto another account. `null` hands it back to the ambient `~/.claude`.
   *
   * The third member of the `setAutonomy`/`setModel` family, with the same shape for the same reason:
   * `Options.env` — which is where `CLAUDE_CONFIG_DIR` lives — is fixed when `query()` is called, so
   * a live session is restarted (resuming from the stored `claude_session_id`, which keeps the
   * conversation) rather than mutated. There is no in-place alternative here at all: the environment
   * belongs to a subprocess that is already running.
   *
   * The new account is persisted first, so even a failed restart leaves the next boot starting the
   * agent on the subscription the operator asked for.
   *
   * **What this does not do**: move the transcript. Sessions live under `<config dir>/projects/…`, so
   * an agent resumed against a different account is resuming a `claude_session_id` that account has
   * never seen. The CLI starts a fresh conversation in that case; the SuperFabric event log — which is
   * the source of truth the operator reads — is untouched and complete either way. Said out loud in
   * the UI rather than discovered.
   */
  async setAccount(id: string, accountId: string | null): Promise<void> {
    const row = this.stmts.session.get(id) as SessionRow | null;
    if (row == null) throw new Error(`unknown session ${id}`);
    if (accountId !== null) this.requireAccount(accountId);
    this.stmts.setAccount.run(accountId, id);

    const label = accountId === null ? "the ambient ~/.claude" : this.accountLabel(accountId);
    const handle = this.handles.get(id);
    if (handle === undefined) {
      this.store.append(id, {
        type: "session_status", status: "idle",
        detail: `account: ${label} (applies when the session next starts)`,
      });
      return;
    }

    await this.restartExecutor(id, handle, { ...specOf(row), accountId }, `account: ${label}`);
  }

  /** An account's label for the log, falling back to its id if the row has since gone. */
  private accountLabel(accountId: string): string {
    return this.opts.accounts?.get(accountId)?.label ?? accountId;
  }

  /**
   * Swap a live session's executor for a new one that resumes the same provider session — the one
   * mechanism behind `setAutonomy`, `setModel` and `setAccount`, because each changes an `Options`
   * field that is fixed for the lifetime of a `query()`.
   *
   * The ordering is the design: the old executor must be gone before a new one resumes the same
   * provider session, whatever turn was in flight died with it, and its pending approvals are denied
   * rather than left to hang. `heldPrompts` opens **before the first await**, so there is no instant
   * in which a prompt can arrive to a session that is neither live nor known to be restarting.
   */
  private async restartExecutor(
    id: string,
    handle: ExecutorHandle,
    spec: RunSpec,
    detail: string,
  ): Promise<void> {
    this.store.append(id, { type: "session_status", status: "starting", detail });
    this.handles.delete(id);
    this.turnInFlight.delete(id);
    this.denyPendingApprovals(id);
    this.heldPrompts.set(id, []);

    let undeliverable = "the restart did not complete";
    try {
      // A wedged CLI subprocess must not wedge the toggle; the abort in stop() still fires.
      await this.stopWithTimeout(handle, 5000).catch(() => {});
      // Shutdown may have started while we were stopping the old executor. Spawning a replacement
      // now would leak a CLI subprocess past the server's exit; the stored value still applies on
      // the next boot.
      if (this.stopping) {
        undeliverable = "the server is shutting down";
        return;
      }
      this.startExecutor(id, spec);
    } catch (err) {
      undeliverable = `the restart failed: ${String(err)}`;
      throw err;
    } finally {
      this.releaseHeldPrompts(id, undeliverable);
    }
  }

  /**
   * Hand everything held during a restart to the new executor, in the order it arrived.
   *
   * If the restart produced no executor (shutdown, or a failed start) the prompts cannot be
   * delivered — but they are still not dropped in silence, which is the failure this whole mechanism
   * exists to prevent. Each one is appended to the session's own log as a `session_error` carrying
   * its text, so the operator sees in the transcript both that the instruction did not land and what
   * it said. Appended here rather than through the executor's own `onEvent`, so it does not move the
   * session off 'active': a session that failed to restart during shutdown is healthy and must come
   * back on the next boot.
   */
  private releaseHeldPrompts(id: string, undeliverable: string): void {
    const held = this.heldPrompts.get(id);
    this.heldPrompts.delete(id);
    if (held === undefined || held.length === 0) return;
    const handle = this.handles.get(id);
    if (handle === undefined) {
      for (const text of held) {
        this.store.append(id, {
          type: "session_error",
          message: `prompt not delivered — ${undeliverable}. It said: ${text}`,
        });
      }
      return;
    }
    for (const text of held) handle.send(text);
  }

  /**
   * Restart executors for all sessions marked active. Returns only the ids actually started, so a
   * second call (or a call with sessions already live) does not overstate what happened.
   */
  resumeAll(): string[] {
    const rows = this.stmts.activeSessions.all() as SessionRow[];
    const started: string[] = [];
    for (const r of rows) {
      if (this.handles.has(r.id)) continue;
      // Everything stored on the row is what a session comes back as: a bypass agent stays bypass, an
      // attended one stays attended, an agent pinned to a model comes back on that model rather than
      // on the CLI's default, and — since M2 — an agent bound to an account comes back on that
      // account's `CLAUDE_CONFIG_DIR` rather than on the operator's own. The role is stored the same
      // way, so the factory's orchestrator comes back as the orchestrator, with its charter and its
      // routing tools, rather than as an ordinary agent standing in the central building.
      this.startExecutor(r.id, specOf(r));
      started.push(r.id);
    }
    return started;
  }

  /**
   * The factory bus as this session's own tool set. The room is read from the session row — never
   * from anything an agent could say — so an agent can only ever send messages as the department it
   * actually works in. A roomless session gets no bus tools at all: it has no department to speak
   * for, and a tool that would have to guess one is worse than an absent tool.
   */
  private busToolServers(
    sessionId: string,
    roomId: string | null,
    isOrchestrator: boolean,
  ): Record<string, ReturnType<typeof busTools>> {
    const { bus, tasks } = this.opts;
    if (roomId === null || bus === undefined || tasks === undefined) return {};
    return {
      [FACTORY_MCP_SERVER_NAME]: busTools({
        bus, tasks, rooms: this.rooms, roomId,
        // The tool surface is per session, which is the whole mechanism behind "orchestrator-only
        // tools": the MCP server is built once per `query()` from this session's own row, so an
        // ordinary agent's tool list simply does not contain the routing tools. (Calling one anyway
        // is still refused inside the handler — see `busTools`.)
        isOrchestrator,
        sessionId,
        ...(this.opts.router !== undefined ? { router: this.opts.router } : {}),
        ...(this.opts.chronicle !== undefined ? { chronicle: this.opts.chronicle } : {}),
        // factory_report_status is a line in this session's own log: the operator reads the agent's
        // own words next to everything else it did, rather than in a separate channel.
        reportStatus: (summary) => {
          this.store.append(sessionId, { type: "session_status", status: "working", detail: summary });
        },
      }),
    };
  }

  private startExecutor(id: string, spec: RunSpec) {
    const { cwd, resume, autonomy, roomId, model, accountId, isOrchestrator } = spec;
    // The account, as the one thing the provider seam understands: a directory. `undefined` (no
    // account, or an account row that has since been deleted) leaves the executor's own default in
    // charge, which is the ambient `~/.claude` — the pre-M2 behaviour, unchanged.
    const configDir = this.opts.accounts?.configDirOf(accountId);
    // "This subscription was last used just now", which is what the account list shows and what the
    // limit monitor will poll. Only for an account that actually resolved to a directory.
    if (accountId !== null && configDir !== undefined) this.opts.accounts?.touch(accountId);

    const handle = this.executor.start(
      {
        cwd, resumeSessionId: resume, autonomy, model,
        ...(configDir !== undefined ? { configDir } : {}),
        mcpServers: this.busToolServers(id, roomId, isOrchestrator),
        // The role, as a system-prompt append. This — plus the flag and the extra tools — is the
        // entire difference between the orchestrator and any other session: same manager, same
        // executor, same event log.
        ...(isOrchestrator ? { appendSystemPrompt: ORCHESTRATOR_SYSTEM_PROMPT } : {}),
      },
      {
        onEvent: (event) => {
          this.store.append(id, event);
          // A terminal executor failure must move the session off 'active', otherwise resumeAll()
          // re-spawns a known-broken session on every boot, forever.
          if (event.type === "session_error") this.stmts.markError.run(id);
          if (event.type === "session_status") {
            if (event.status === "working") this.turnInFlight.add(id);
            else this.turnInFlight.delete(id);
          }
          if (event.type === "turn_complete") {
            this.turnInFlight.delete(id);
            // The turn boundary: the one moment a message from another room may be injected into
            // this agent without interrupting anything. Delivery is idempotent, so flushing here on
            // every boundary costs nothing when the room's queue is empty.
            if (roomId !== null) this.opts.bus?.flushRoom(roomId);
          }
        },
        requestApproval: (toolName, input) =>
          new Promise((resolve) => {
            const approvalId = randomUUID();
            this.approvals.set(approvalId, { sessionId: id, resolve });
            this.store.append(id, { type: "approval_request", approvalId, toolName, input });
          }),
      },
    );
    this.handles.set(id, handle);
    void handle.providerSessionId.then((psid) => this.stmts.setProviderSessionId.run(psid, id));
  }

  /**
   * Send a turn to an agent.
   *
   * A session whose executor is mid-restart (`setAutonomy`, `setModel`) has no handle for a moment.
   * The instruction is **held** and delivered as soon as the replacement is up, because a dropped
   * instruction is the worst outcome available here: the operator watched themselves type it and
   * nothing in the transcript ever mentions it again. The hold is bounded — past
   * `MAX_HELD_PROMPTS` the call throws, which the hub turns into an `error` the UI shows, so a
   * restart that never finishes cannot quietly swallow an unbounded pile of instructions.
   */
  prompt(id: string, text: string): void {
    const h = this.handles.get(id);
    if (h !== undefined) { h.send(text); return; }
    const held = this.heldPrompts.get(id);
    if (held === undefined) throw new Error(`no live session ${id}`);
    if (held.length >= MAX_HELD_PROMPTS) {
      throw new Error(
        `session ${id} is restarting and already has ${held.length} prompts waiting; `
        + "this one was not accepted — wait for it to come back and send it again",
      );
    }
    held.push(text);
    // Not a `user_prompt`: nothing has been said to the agent yet, and the log must not claim it
    // has. This is the operator's receipt that the instruction was taken and is waiting.
    this.store.append(id, {
      type: "session_status",
      status: "starting",
      detail: `prompt held until the restart finishes (${held.length} waiting)`,
    });
  }

  /**
   * Record an operator decision. Throws on anything unexpected (unknown/expired approvalId, a
   * session id that does not own the approval); WsHub turns the throw into an `error` reply.
   */
  approve(id: string, approvalId: string, behavior: "allow" | "deny"): void {
    const pending = this.approvals.get(approvalId);
    if (!pending) return this.closeExpiredApproval(id, approvalId);
    if (pending.sessionId !== id) {
      throw new Error(`approval ${approvalId} does not belong to session ${id}`);
    }
    this.approvals.delete(approvalId);
    // The stored session id wins over the client's: the log is the source of truth and must
    // record the decision against the session that actually asked.
    this.store.append(pending.sessionId, { type: "approval_resolved", approvalId, behavior });
    pending.resolve(behavior);
  }

  /**
   * No live resolver for this approvalId. Either it never existed, or it is an `approval_request`
   * replayed from the log after a restart — the tool call died with the previous process, so
   * "denied" is the truthful record. Close the card out in the log and report the reason, instead
   * of returning silently and leaving the UI's approval card orange forever.
   */
  private closeExpiredApproval(id: string, approvalId: string): never {
    const events = this.store.listAfter(id, 0).map((r) => r.event);
    const requested = events.some((e) => e.type === "approval_request" && e.approvalId === approvalId);
    if (!requested) throw new Error(`unknown approval ${approvalId} for session ${id}`);
    if (events.some((e) => e.type === "approval_resolved" && e.approvalId === approvalId)) {
      throw new Error(`approval ${approvalId} is already resolved`);
    }
    this.store.append(id, { type: "approval_resolved", approvalId, behavior: "deny" });
    throw new Error(`approval ${approvalId} expired with the previous process; recorded as denied`);
  }

  /**
   * Resolve every approval still pending for a session with "deny" and log it. Called whenever a
   * session's executor goes away: the SDK's canUseTool promise would otherwise never settle, and
   * the log (and the UI card derived from it) would never close out.
   */
  private denyPendingApprovals(sessionId: string): void {
    for (const [approvalId, pending] of this.approvals) {
      if (pending.sessionId !== sessionId) continue;
      this.approvals.delete(approvalId);
      this.store.append(sessionId, { type: "approval_resolved", approvalId, behavior: "deny" });
      pending.resolve("deny");
    }
  }

  async interrupt(id: string): Promise<void> { await this.handles.get(id)?.interrupt(); }

  /**
   * Stop every live executor. Sessions stay 'active' in the db so resumeAll() picks them up
   * next boot. Each stop() races an unref'd timeout so a wedged CLI subprocess can never wedge
   * shutdown; all stops settle (failures/timeouts are tolerated individually).
   */
  async stopAll(timeoutMs = 5000): Promise<void> {
    this.stopping = true;
    for (const id of this.handles.keys()) this.denyPendingApprovals(id);
    const handles = [...this.handles.values()];
    this.handles.clear();
    this.turnInFlight.clear();
    await Promise.allSettled(handles.map((h) => this.stopWithTimeout(h, timeoutMs)));
  }

  private stopWithTimeout(handle: ExecutorHandle, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stop() timed out")), timeoutMs);
      timer.unref();
      handle.stop().then(
        () => { clearTimeout(timer); resolve(); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  /**
   * The live agents standing in a room, with the status the bus uses to decide whether it may inject
   * a turn now. Only sessions with a live executor are listed: a row marked active whose process is
   * gone cannot carry a message, and offering it would make the bus mark one delivered to nobody.
   */
  roomAgents(roomId: string): RoomAgent[] {
    return this.toSessionInfo(this.stmts.listRoomSessions.all(roomId))
      .filter((s) => this.handles.has(s.id))
      .map((s) => ({
        sessionId: s.id,
        // See `turnInFlight`: the log's `working` outlives the turn by one event.
        status: s.status === "working" && !this.turnInFlight.has(s.id) ? "idle" : s.status,
      }));
  }

  /** The agents of one factory. Another project's sessions are never in here. */
  listSessions(projectId: string = this.projects.defaultProject().id): SessionInfo[] {
    return this.toSessionInfo(this.stmts.listSessions.all(projectId));
  }

  private toSessionInfo(rows: unknown[]): SessionInfo[] {
    return (rows as {
      id: string; state: SessionInfo["state"]; claude_session_id: string | null;
      autonomy: string; model: string | null; room_id: string | null; last_seq: number;
      status: string | null; blocked: number; is_orchestrator: number; account_id: string | null;
    }[]).map(r => ({
      id: r.id,
      state: r.state,
      claudeSessionId: r.claude_session_id,
      lastSeq: r.last_seq,
      autonomy: asAutonomy(r.autonomy),
      model: r.model,
      roomId: r.room_id,
      accountId: r.account_id,
      status: asStatus(r.status),
      blocked: r.blocked === 1,
      isOrchestrator: r.is_orchestrator === 1,
    }));
  }
}

/**
 * The columns a *running* session is rebuilt from — what `startExecutor` needs to bring an agent
 * back exactly as it was. One list, used by every statement that reads a session row, so adding a
 * per-session property cannot be remembered in `resumeAll` and forgotten in `setModel`.
 */
const SESSION_COLUMNS = "id, cwd, claude_session_id, autonomy, room_id, model, is_orchestrator, account_id";

/**
 * The session listing, with a caller-chosen `WHERE`. The clause is a literal from the two call sites
 * below — never anything from the wire — and both statements are prepared once at construction.
 */
function sessionListSql(where: string): string {
  return `
    SELECT s.id AS id, s.state AS state, s.claude_session_id AS claude_session_id,
           s.autonomy AS autonomy, s.model AS model, s.room_id AS room_id,
           s.is_orchestrator AS is_orchestrator, s.account_id AS account_id,
           COALESCE(MAX(e.seq), 0) AS last_seq,
           -- latest session_status wins; NULL (no such event) folds to 'idle' in TS
           (SELECT json_extract(st.payload, '$.status')
              FROM events st
              WHERE st.session_id = s.id AND st.type = 'session_status'
              ORDER BY st.seq DESC LIMIT 1) AS status,
           -- an approval_request with no approval_resolved carrying the same approvalId
           EXISTS (SELECT 1
              FROM events req
              WHERE req.session_id = s.id AND req.type = 'approval_request'
                AND NOT EXISTS (SELECT 1
                  FROM events res
                  WHERE res.session_id = s.id AND res.type = 'approval_resolved'
                    AND json_extract(res.payload, '$.approvalId')
                        = json_extract(req.payload, '$.approvalId'))) AS blocked
    FROM sessions s LEFT JOIN events e ON e.session_id = s.id
    WHERE ${where}
    GROUP BY s.id ORDER BY s.created_at
  `;
}

/** Row shape of the columns the manager needs off `sessions`. */
interface SessionRow {
  id: string;
  cwd: string;
  claude_session_id: string | null;
  autonomy: string;
  /** NULL is "the CLI's own default", not a missing value. */
  model: string | null;
  room_id: string | null;
  /** SQLite has no boolean: 1 is the factory's orchestrator, 0 is every other agent. */
  is_orchestrator: number;
  /** NULL is "the ambient `~/.claude`", not a missing value. */
  account_id: string | null;
}

/**
 * Read the role off a stored row. A hand-edited or downgraded database could hold anything in an
 * INTEGER column, and only an exact 1 promotes a session — "not obviously an orchestrator" must
 * resolve to "ordinary agent", never the other way round.
 */
function isOrchestratorRow(row: SessionRow): boolean {
  return Number(row.is_orchestrator) === 1;
}

/**
 * `sessions.autonomy` is a TEXT column, so a hand-edited or downgraded database could hold anything.
 * An unparseable value falls back to the product default rather than crashing a listing — and never
 * silently escalates, because the default is the least privileged mode we run agents in by default.
 */
function asAutonomy(value: string): AutonomyMode {
  const parsed = AutonomyMode.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_AUTONOMY;
}

/**
 * A session with no `session_status` in its log has never reported anything, so it is `idle` — not
 * an error and not a missing value the client has to special-case. An unrecognised stored status
 * (hand-edited row, or a status this build predates) folds to `idle` for the same reason.
 */
function asStatus(value: string | null): SessionStatus {
  if (value === null) return "idle";
  const parsed = SessionStatus.safeParse(value);
  return parsed.success ? parsed.data : "idle";
}
