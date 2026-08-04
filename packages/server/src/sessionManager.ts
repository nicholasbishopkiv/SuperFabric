import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { FACTORY_MCP_SERVER_NAME, busTools } from "./busTools.js";
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
        "INSERT INTO sessions (id, project_id, cwd, autonomy, room_id, model, is_orchestrator)"
        + " VALUES (?, ?, ?, ?, ?, ?, ?)",
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

    const id = randomUUID();
    const model = opts.model ?? null;
    this.stmts.insertSession.run(id, projectId, cwd, autonomy, roomId, model, isOrchestrator ? 1 : 0);
    this.startExecutor(id, cwd, null, autonomy, roomId, model, isOrchestrator);
    return id;
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

    this.store.append(id, {
      type: "session_status", status: "starting", detail: `autonomy: ${autonomy}`,
    });
    // Order matters: the old executor must be gone before a new one resumes the same provider
    // session. Pending approvals belong to the turn that is being torn down, so deny them.
    this.handles.delete(id);
    // Whatever turn was in flight died with that executor; the replacement starts idle.
    this.turnInFlight.delete(id);
    this.denyPendingApprovals(id);
    // A wedged CLI subprocess must not wedge the toggle; the abort in stop() still fires.
    await this.stopWithTimeout(handle, 5000).catch(() => {});
    // Shutdown may have started while we were stopping the old executor. Spawning a replacement
    // now would leak a CLI subprocess past the server's exit; the stored mode still applies on the
    // next boot.
    if (this.stopping) return;
    this.startExecutor(id, row.cwd, row.claude_session_id, autonomy, row.room_id, row.model, isOrchestratorRow(row));
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

    this.store.append(id, {
      type: "session_status", status: "starting", detail: `model: ${model ?? "default"}`,
    });
    // Order matters exactly as in setAutonomy: the old executor is gone before a new one resumes the
    // same provider session, and the turn that died with it takes its approvals with it.
    this.handles.delete(id);
    this.turnInFlight.delete(id);
    this.denyPendingApprovals(id);
    await this.stopWithTimeout(handle, 5000).catch(() => {});
    if (this.stopping) return;
    this.startExecutor(
      id, row.cwd, row.claude_session_id, asAutonomy(row.autonomy), row.room_id, model, isOrchestratorRow(row),
    );
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
      // The stored mode and the stored model are what a session comes back as: a bypass agent stays
      // bypass across a restart, an attended one stays attended, and an agent pinned to a model
      // comes back on that model rather than on the CLI's default. The role is stored the same way,
      // so the factory's orchestrator comes back as the orchestrator — with its charter and its
      // routing tools — rather than as an ordinary agent standing in the central building.
      this.startExecutor(
        r.id, r.cwd, r.claude_session_id, asAutonomy(r.autonomy), r.room_id, r.model, isOrchestratorRow(r),
      );
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
        ...(this.opts.router !== undefined ? { router: this.opts.router } : {}),
        // factory_report_status is a line in this session's own log: the operator reads the agent's
        // own words next to everything else it did, rather than in a separate channel.
        reportStatus: (summary) => {
          this.store.append(sessionId, { type: "session_status", status: "working", detail: summary });
        },
      }),
    };
  }

  private startExecutor(
    id: string,
    cwd: string,
    resume: string | null,
    autonomy: AutonomyMode,
    roomId: string | null,
    model: string | null,
    isOrchestrator = false,
  ) {
    const handle = this.executor.start(
      {
        cwd, resumeSessionId: resume, autonomy, model,
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

  prompt(id: string, text: string): void {
    const h = this.handles.get(id);
    if (!h) throw new Error(`no live session ${id}`);
    h.send(text);
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
      status: string | null; blocked: number; is_orchestrator: number;
    }[]).map(r => ({
      id: r.id,
      state: r.state,
      claudeSessionId: r.claude_session_id,
      lastSeq: r.last_seq,
      autonomy: asAutonomy(r.autonomy),
      model: r.model,
      roomId: r.room_id,
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
const SESSION_COLUMNS = "id, cwd, claude_session_id, autonomy, room_id, model, is_orchestrator";

/**
 * The session listing, with a caller-chosen `WHERE`. The clause is a literal from the two call sites
 * below — never anything from the wire — and both statements are prepared once at construction.
 */
function sessionListSql(where: string): string {
  return `
    SELECT s.id AS id, s.state AS state, s.claude_session_id AS claude_session_id,
           s.autonomy AS autonomy, s.model AS model, s.room_id AS room_id,
           s.is_orchestrator AS is_orchestrator,
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
