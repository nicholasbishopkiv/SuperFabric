import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AccountManager } from "./accountManager.js";
import { FACTORY_MCP_SERVER_NAME, busTools } from "./busTools.js";
import type { Chronicle } from "./chronicle.js";
import type { Db } from "./db.js";
import type { EventStore } from "./eventStore.js";
import type { Executor, ExecutorHandle } from "./executor.js";
import { classifyExecutorError } from "./executors/claudeCode.js";
import type { FactoryBus, RoomAgent } from "./factoryBus.js";
import { ONBOARDING_ROLE_ID, type OnboardingManager } from "./onboarding.js";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "./orchestrator.js";
import type { ProjectManager } from "./projectManager.js";
import type { RoleLibrary } from "./roleLibrary.js";
import type { RoomManager } from "./roomManager.js";
import type { TaskRouter } from "./router.js";
import { describeInstall, type SkillLibrary } from "./skills.js";
import type { TaskStore } from "./taskStore.js";
import {
  AutonomyMode, DEFAULT_AUTONOMY, SessionStatus, type RoleSpec, type SessionInfo,
} from "@superfabric/shared";

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
  /**
   * Start this agent as a role: its charter, its skills, and — only where the caller has said nothing
   * — its model and its autonomy. Omitted => a plain agent.
   *
   * An id this server does not have is **refused**, for the same reason an unknown account is: an
   * agent that quietly starts as nothing when the operator asked for an architect is an agent whose
   * behaviour has no visible explanation.
   */
  roleId?: string;
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
  /**
   * The role library. Absent => `roleId` is refused and every session is a plain one, which is the
   * pre-M1c shape and a valid server rather than a broken one — the same arrangement `accounts`,
   * `bus` and `tasks` have.
   */
  roles?: RoleLibrary;
  /**
   * Where skills come from. Absent => a role still composes its prompt, model and tool servers, but
   * nothing is copied into the room. Separate from `roles` because they genuinely can differ: a
   * server can have the library and no skill packs installed, and "the charter arrived, the skills did
   * not" is a better outcome than refusing the role.
   */
  skills?: SkillLibrary;
  /**
   * Onboarding. Absent => `factory_suggest_rooms` is in nobody's tool list, which is the pre-M1c
   * shape and a valid server rather than a broken one — the same arrangement `roles` and `chronicle`
   * have. Only a session wearing the onboarding role is offered it (see `busToolServers`).
   */
  onboarding?: OnboardingManager;
  /**
   * A session was refused with a rate-limit error.
   *
   * The one thing the session runner knows about limits, and it reports it rather than acting on it:
   * a 429 mid-turn is the earliest, most certain evidence that an account is spent, and the limit
   * monitor's poller may be minutes behind. A callback rather than the monitor itself, for the same
   * reason the bus and the router are callbacks — the dependency stays one-way, and a server with no
   * monitor is a valid (pre-M2) shape rather than a broken one.
   *
   * `accountId` is null for a session on the ambient `~/.claude`, which has no row to mark.
   */
  onRateLimited?: (sessionId: string, accountId: string | null) => void;
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
  /** The role this agent arrived as; null is a plain agent. Resolved to a spec at start time. */
  roleId: string | null;
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
    roleId: row.role_id,
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
  /**
   * sessionId -> a pause armed while that agent had a turn in flight.
   *
   * **An agent is never cut off mid-thought.** The bus already refuses to inject a message into a
   * working agent and drains its queue at `turn_complete`; a pause is the same discipline pointed the
   * other way, and for a stronger reason — interrupting a turn to save quota would throw away the
   * tokens that turn already spent. So the pause waits for the boundary the runner already knows how
   * to find.
   */
  private pausePending = new Map<string, { until: number | null; reason: string }>();
  /**
   * sessionId -> which executor incarnation is the current one.
   *
   * An executor keeps emitting for a moment after we have let go of it — the SDK's `result` message
   * is immediately followed by an `idle` status, and a pause applied *at* that `result` would then be
   * overwritten in the log by the `idle` that arrives one line later. The row would say paused and
   * the transcript would say idle, and the transcript is what the operator reads.
   *
   * So every `startExecutor` closes over a generation number, and anything that lets an executor go
   * (pause, restart, shutdown) bumps it. Events from a superseded incarnation are teardown noise and
   * are dropped rather than appended.
   */
  private generation = new Map<string, number>();
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
        "INSERT INTO sessions (id, project_id, cwd, autonomy, room_id, model, is_orchestrator, account_id, role_id)"
        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
      // "Is an interview running on this factory?" — the newest *live* one, because onboarding is a
      // one-shot job and a finished one is history rather than an agent to hand a second click to.
      onboarderOf: db.prepare(
        "SELECT id FROM sessions WHERE project_id = ? AND role_id = ? AND state = 'active'"
        + " ORDER BY created_at DESC, rowid DESC LIMIT 1",
      ),
      setAutonomy: db.prepare("UPDATE sessions SET autonomy = ? WHERE id = ?"),
      setModel: db.prepare("UPDATE sessions SET model = ? WHERE id = ?"),
      setAccount: db.prepare("UPDATE sessions SET account_id = ? WHERE id = ?"),
      setRole: db.prepare("UPDATE sessions SET role_id = ? WHERE id = ?"),
      // Pausing and coming back. `state` alone would be enough to stop `resumeAll` re-spawning a
      // paused agent; the two timestamps are what an unattended resume and a countdown are made of.
      markPaused: db.prepare(
        "UPDATE sessions SET state = 'paused', paused_at = ?, paused_until = ? WHERE id = ? AND state = 'active'",
      ),
      markResumed: db.prepare(
        "UPDATE sessions SET state = 'active', paused_at = NULL, paused_until = NULL WHERE id = ?",
      ),
      pausedSessions: db.prepare(
        `SELECT ${SESSION_COLUMNS}, paused_at, paused_until FROM sessions WHERE state = 'paused' ORDER BY created_at, rowid`,
      ),
      // "Who is running on this subscription?" — the question the scheduler asks about every account
      // it is about to warn or hold.
      activeOnAccount: db.prepare(
        "SELECT id FROM sessions WHERE account_id = ? AND state = 'active' ORDER BY created_at, rowid",
      ),
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
    // The role is resolved before anything is written, so an unknown id fails the call rather than
    // leaving a session row behind that nobody asked for.
    const role = opts.roleId === undefined ? undefined : this.requireRole(opts.roleId);
    // An explicit choice always beats a preset — and here the operator's silence is what lets the
    // role speak. The result is written to the row, so from now on it *is* the agent's autonomy and a
    // later change of role never moves it again: a privilege level that shifted as a side effect of
    // picking a job title would not be a level the operator chose.
    const autonomy = opts.autonomy ?? role?.autonomy ?? DEFAULT_AUTONOMY;
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
    // Deliberately *not* `?? role.model`: NULL on the row means "the operator pinned nothing", and
    // the role's suggestion is applied at start time from the role itself (see `startExecutor`).
    // Baking it into the column would turn a suggestion into a choice, and clearing the role would
    // then leave the agent silently pinned to a model nobody picked.
    const model = opts.model ?? null;
    const spec: RunSpec = {
      cwd, resume: null, autonomy, roomId, model, accountId: accountId ?? null, isOrchestrator,
      roleId: role?.id ?? null,
    };
    this.stmts.insertSession.run(
      id, projectId, cwd, autonomy, roomId, model, isOrchestrator ? 1 : 0, spec.accountId, spec.roleId,
    );
    // Before the executor starts, so a skill this agent is meant to have is on disk by the time the
    // CLI reads the folder rather than one turn later.
    this.installRoleSkills(id, cwd, role);
    this.startExecutor(id, spec);
    return id;
  }

  /**
   * Refuse a role this server does not have.
   *
   * Only for ids arriving from *outside*. A stored `role_id` is never re-validated for the same
   * reason a stored `account_id` is not: the session row outlives the file it names, and an agent
   * must still come back after the operator deleted or renamed a preset — as a plain agent, and
   * saying so (see `roleOf`).
   */
  private requireRole(roleId: string): RoleSpec {
    const roles = this.opts.roles;
    if (roles === undefined) throw new Error("this server has no role library");
    const role = roles.get(roleId);
    if (role === undefined) throw new Error(`unknown role ${roleId}`);
    return role;
  }

  /**
   * The role a stored session should come back as, or `undefined`.
   *
   * A stored id that no longer resolves is **not** an error: the operator may have deleted the file,
   * and refusing to boot the agent over it would be the worst available reaction. It is said out loud
   * in the session's own log instead, once, at the moment it matters — the alternative is an agent
   * that used to be an architect quietly behaving like a blank session with nothing to explain it.
   */
  private roleOf(sessionId: string, roleId: string | null): RoleSpec | undefined {
    if (roleId === null) return undefined;
    const role = this.opts.roles?.get(roleId);
    if (role !== undefined) return role;
    this.store.append(sessionId, {
      type: "session_status",
      status: "starting",
      detail: `role ${roleId} is no longer in the role library — starting as a plain agent`,
    });
    return undefined;
  }

  /**
   * Copy a role's skills into the folder this agent works in, and say what actually happened.
   *
   * Reported into the session's own log rather than returned, because the interesting cases are the
   * partial ones: a pack this machine does not have, or a directory the operator has already edited
   * and which is therefore left alone. "The role was applied" with three of its four skills missing is
   * the kind of half-truth that makes an operator distrust the whole feature.
   */
  private installRoleSkills(sessionId: string, cwd: string, role: RoleSpec | undefined): void {
    if (role === undefined || role.skills.length === 0) return;
    const skills = this.opts.skills;
    if (skills === undefined) {
      this.store.append(sessionId, {
        type: "session_status",
        status: "starting",
        detail: `role ${role.name}: this server installs no skills, so ${role.skills.join(", ")} `
          + "did not arrive",
      });
      return;
    }
    let line: string | null;
    try { line = describeInstall(skills.installInto(cwd, role.skills)); }
    catch (err) {
      // Writing into the operator's repository can fail (read-only checkout, a full disk). It must
      // not stop the agent starting — the charter and the model are the larger half of a role.
      line = `could not be installed: ${String(err)}`;
    }
    if (line === null) return;
    this.store.append(sessionId, {
      type: "session_status", status: "starting", detail: `role ${role.name} skills — ${line}`,
    });
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
   * The live agent interviewing the operator about this project, or `undefined`.
   *
   * Read off the row's `role_id` rather than off a flag of its own: the onboarder *is* an agent
   * wearing a role, and a second column saying the same thing could disagree with it. Only an active
   * session counts — a finished interview is history, and `start_onboarding` on a project whose
   * onboarder has stopped should stand up a new one rather than hand back a corpse.
   */
  onboarderFor(projectId: string): string | undefined {
    const row = this.stmts.onboarderOf.get(projectId, ONBOARDING_ROLE_ID) as { id: string } | null;
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

  /**
   * Give a live agent a role, or take it away (`null` => a plain agent again).
   *
   * The fourth member of the `setAutonomy`/`setModel`/`setAccount` family, with the same shape for the
   * same mechanical reason: a role composes `systemPrompt`, `model`, `mcpServers` and `allowedTools`,
   * every one of which is fixed for the lifetime of a `query()`. So the executor is restarted and the
   * conversation resumed — the agent keeps what it knows and changes what it is.
   *
   * **Autonomy is deliberately not touched.** A role's `autonomy` applies when an agent is created and
   * never again: raising what a running agent may do because someone picked "DevOps" from a dropdown
   * is not a decision the operator made, and it would be invisible next to the change they did make.
   *
   * The new role is persisted first, so even a failed restart leaves the next boot starting the agent
   * as what the operator asked for.
   */
  async setRole(id: string, roleId: string | null): Promise<void> {
    const row = this.stmts.session.get(id) as SessionRow | null;
    if (row == null) throw new Error(`unknown session ${id}`);
    const role = roleId === null ? undefined : this.requireRole(roleId);
    this.stmts.setRole.run(roleId, id);
    // Before the restart, so the folder is right by the time the replacement executor reads it.
    this.installRoleSkills(id, row.cwd, role);

    const label = role === undefined ? "none" : role.name;
    const handle = this.handles.get(id);
    if (handle === undefined) {
      this.store.append(id, {
        type: "session_status", status: "idle",
        detail: `role: ${label} (applies when the session next starts)`,
      });
      return;
    }

    await this.restartExecutor(id, handle, { ...specOf(row), roleId }, `role: ${label}`);
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
    this.supersede(id);
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
    isOnboarder: boolean,
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
        // Same mechanism, same source: the session's own row. It buys the one extra tool an
        // interview needs — proposing rooms — and nothing else about what this agent may do.
        isOnboarder,
        sessionId,
        ...(this.opts.router !== undefined ? { router: this.opts.router } : {}),
        ...(this.opts.chronicle !== undefined ? { chronicle: this.opts.chronicle } : {}),
        ...(this.opts.onboarding !== undefined ? { onboarding: this.opts.onboarding } : {}),
        // factory_report_status is a line in this session's own log: the operator reads the agent's
        // own words next to everything else it did, rather than in a separate channel.
        reportStatus: (summary) => {
          this.store.append(sessionId, { type: "session_status", status: "working", detail: summary });
        },
      }),
    };
  }

  /** Let go of a session's current executor: anything it says from now on is teardown noise. */
  private supersede(id: string): void {
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
  }

  private startExecutor(id: string, spec: RunSpec) {
    const { cwd, resume, autonomy, roomId, model, accountId, isOrchestrator } = spec;
    const role = this.roleOf(id, spec.roleId);
    const generation = (this.generation.get(id) ?? 0) + 1;
    this.generation.set(id, generation);
    // The account, as the one thing the provider seam understands: a directory. `undefined` (no
    // account, or an account row that has since been deleted) leaves the executor's own default in
    // charge, which is the ambient `~/.claude` — the pre-M2 behaviour, unchanged.
    const configDir = this.opts.accounts?.configDirOf(accountId);
    // "This subscription was last used just now", which is what the account list shows and what the
    // limit monitor will poll. Only for an account that actually resolved to a directory.
    if (accountId !== null && configDir !== undefined) this.opts.accounts?.touch(accountId);

    // The charter, as a system-prompt append. This — plus the flag and the extra tools — is the
    // entire difference between the orchestrator and any other session, and now between an architect
    // and any other room agent: same manager, same executor, same event log.
    const appendSystemPrompt = composeAppend(isOrchestrator, role);
    // A role's model is a *suggestion*; `sessions.model` is a *choice*. NULL on the row means nobody
    // chose, which is the one case where the preset gets to decide — and clearing the pin later hands
    // the decision back to the role rather than to a value frozen at creation.
    const effectiveModel = model ?? role?.model ?? null;
    // The factory's own in-process server is spread **last** and therefore wins any name collision: a
    // role must never be able to unplug an agent from the bus its whole department runs on, whether by
    // listing a server called `factory` or by any other route. Everything else a role brings is
    // outside-facing (stdio/http/sse), so it stays gated by `canUseTool` like every other outside tool.
    const mcpServers: Record<string, McpServerConfig> = {
      ...(role?.mcpServers ?? {}),
      // The role, not the id off the wire: a stored `role_id` whose file has gone resolves to no role
      // at all (see `roleOf`), and an agent that is no longer an onboarder must not keep the tool.
      ...this.busToolServers(id, roomId, isOrchestrator, role?.id === ONBOARDING_ROLE_ID),
    };

    const handle = this.executor.start(
      {
        cwd, resumeSessionId: resume, autonomy, model: effectiveModel,
        ...(configDir !== undefined ? { configDir } : {}),
        mcpServers,
        ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
        ...(role !== undefined && role.allowedTools.length > 0
          ? { allowedTools: role.allowedTools }
          : {}),
      },
      {
        onEvent: (event) => {
          // See `generation`: an executor we have already released must not write over the record of
          // why we released it.
          if (this.generation.get(id) !== generation) return;
          this.store.append(id, event);
          // A terminal executor failure must move the session off 'active', otherwise resumeAll()
          // re-spawns a known-broken session on every boot, forever.
          if (event.type === "session_error") {
            this.stmts.markError.run(id);
            // A limit error is not just a failure, it is *evidence about the subscription*. Reported
            // straight away so the monitor can mark the account and the scheduler can hold everyone
            // else on it, instead of each agent discovering the same wall one at a time.
            if (classifyExecutorError(event.message) === "rate_limited") {
              this.opts.onRateLimited?.(id, accountId);
            }
          }
          if (event.type === "session_status") {
            if (event.status === "working") this.turnInFlight.add(id);
            else this.turnInFlight.delete(id);
          }
          if (event.type === "turn_complete") {
            this.turnInFlight.delete(id);
            // The turn boundary is also where an armed pause lands. Before the bus flush, so a
            // message is never delivered to an agent that is about to stop and would not answer it.
            const pending = this.pausePending.get(id);
            if (pending !== undefined) {
              this.pausePending.delete(id);
              void this.applyPause(id, pending.until, pending.reason);
              return;
            }
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

  /**
   * Hold an agent because its account is at its limit — **at the next turn boundary, never mid-turn**.
   *
   * A turn already in flight is left to finish: interrupting it would throw away the tokens it has
   * already spent, which is the opposite of the point, and it would cut the agent off mid-sentence in
   * a transcript the operator later has to read. So a working agent has the pause *armed* and the
   * `turn_complete` the runner already watches for is what applies it — exactly how the bus decides
   * when it may inject a message.
   *
   * `until` is unix **seconds**, or `null` for "nobody knows when this lifts" (a 429 with no reading
   * behind it). Null is a real state and the scheduler reads it as "hold until a reading says
   * otherwise" — it is never treated as "resume now".
   *
   * Idempotent: a session already paused, or already armed, is not paused twice.
   */
  async pauseSession(
    id: string,
    until: number | null,
    reason: string,
  ): Promise<"paused" | "at-turn-boundary" | "already-paused"> {
    const row = this.stmts.session.get(id) as SessionRow | null;
    if (row == null) throw new Error(`unknown session ${id}`);
    if (row.state === "paused" || this.pausePending.has(id)) return "already-paused";

    if (this.turnInFlight.has(id)) {
      this.pausePending.set(id, { until, reason });
      // Said out loud now rather than at the boundary: the operator watching an agent work has to be
      // able to see that it is about to stop, and why.
      this.store.append(id, {
        type: "session_status",
        status: "working",
        detail: `${reason} — pausing at the end of this turn`,
      });
      return "at-turn-boundary";
    }

    await this.applyPause(id, until, reason);
    return "paused";
  }

  /**
   * Actually stop an agent and record that it is held.
   *
   * The order is the design: the row and the log say "paused" *before* the executor is torn down, so
   * a client watching the floor never sees an agent vanish and reappear as paused a second later. The
   * stop races the same timeout `stopAll` uses — a wedged CLI subprocess must not wedge a pause that
   * exists to save quota.
   */
  private async applyPause(id: string, until: number | null, reason: string): Promise<void> {
    const changed = this.stmts.markPaused.run(Math.floor(Date.now() / 1000), until, id).changes;
    // A session that is not 'active' any more (it errored, or shutdown beat us here) is not paused.
    if (changed === 0) return;

    const handle = this.handles.get(id);
    this.supersede(id);
    this.handles.delete(id);
    this.turnInFlight.delete(id);
    this.pausePending.delete(id);
    this.denyPendingApprovals(id);
    this.store.append(id, { type: "session_status", status: "paused", detail: reason });
    if (handle !== undefined) await this.stopWithTimeout(handle, 5000).catch(() => {});
  }

  /**
   * Bring a paused agent back, resuming the conversation it was holding.
   *
   * `options.resume` is what makes this a *continuation* rather than a new agent wearing the same
   * name: the spec is rebuilt from the row, so the model, the autonomy, the room, the role and the
   * account all come back as they were, and `claude_session_id` carries the transcript. The agent is
   * then told what happened to it — being silently restarted after an unexplained gap is how an agent
   * repeats work it already did.
   */
  resumeSession(id: string, reason: string): boolean {
    const row = this.stmts.session.get(id) as SessionRow | null;
    if (row == null) throw new Error(`unknown session ${id}`);
    if (row.state !== "paused") return false;
    if (this.stopping) return false;

    this.stmts.markResumed.run(id);
    this.store.append(id, { type: "session_status", status: "starting", detail: reason });
    this.startExecutor(id, specOf(row));
    return true;
  }

  /** Every agent currently held, with what a resume has to decide from. */
  pausedSessions(): { id: string; accountId: string | null; pausedAt: number | null; pausedUntil: number | null }[] {
    return (this.stmts.pausedSessions.all() as (SessionRow & { paused_at: number | null; paused_until: number | null })[])
      .map((r) => ({
        id: r.id, accountId: r.account_id, pausedAt: r.paused_at, pausedUntil: r.paused_until,
      }));
  }

  /**
   * The live agents running on one account.
   *
   * Only sessions with an executor: a row marked active whose process is gone cannot be warned (there
   * is nothing to inject a turn into) and pausing it would be recording a stop that never happened.
   */
  liveSessionsOnAccount(accountId: string): string[] {
    return (this.stmts.activeOnAccount.all(accountId) as { id: string }[])
      .map((r) => r.id)
      .filter((id) => this.handles.has(id));
  }

  async interrupt(id: string): Promise<void> { await this.handles.get(id)?.interrupt(); }

  /**
   * Stop every live executor. Sessions stay 'active' in the db so resumeAll() picks them up
   * next boot. Each stop() races an unref'd timeout so a wedged CLI subprocess can never wedge
   * shutdown; all stops settle (failures/timeouts are tolerated individually).
   */
  async stopAll(timeoutMs = 5000): Promise<void> {
    this.stopping = true;
    for (const id of this.handles.keys()) {
      this.denyPendingApprovals(id);
      this.supersede(id);
    }
    const handles = [...this.handles.values()];
    this.handles.clear();
    this.turnInFlight.clear();
    // An armed pause belongs to a turn boundary that will never arrive now. The session stays
    // 'active' and comes back on the next boot, where the scheduler will decide again from a fresh
    // reading — writing 'paused' here would hold an agent for a limit that may have rolled overnight.
    this.pausePending.clear();
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
      role_id: string | null; paused_until: number | null;
    }[]).map(r => ({
      id: r.id,
      state: r.state,
      claudeSessionId: r.claude_session_id,
      lastSeq: r.last_seq,
      autonomy: asAutonomy(r.autonomy),
      model: r.model,
      roomId: r.room_id,
      accountId: r.account_id,
      roleId: r.role_id,
      pausedUntil: r.paused_until,
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
const SESSION_COLUMNS =
  "id, state, cwd, claude_session_id, autonomy, room_id, model, is_orchestrator, account_id, role_id";

/**
 * What an agent's system prompt is appended with: the orchestrator's charter, the role's, or both.
 *
 * **Both, when both apply, and in that order.** They answer different questions — "you are this
 * factory's orchestrator, here is how routing works" and "you are an architect, here is what you own"
 * — and dropping either would leave an agent missing something true about itself. The orchestrator's
 * comes first because it is the stronger claim: it says which *seat* the agent is in, and the role
 * only says how it works.
 *
 * (This is a different case from the executor's `appendSystemPrompt ?? defaults.appendSystemPrompt`,
 * which picks rather than joins. Two answers to "what is this session for", one per-session and one
 * process-wide, genuinely are rival claims; these two are not.)
 */
function composeAppend(isOrchestrator: boolean, role: RoleSpec | undefined): string | undefined {
  const parts: string[] = [];
  if (isOrchestrator) parts.push(ORCHESTRATOR_SYSTEM_PROMPT);
  if (role !== undefined) parts.push(role.promptAppend);
  return parts.length === 0 ? undefined : parts.join("\n\n---\n\n");
}

/**
 * The session listing, with a caller-chosen `WHERE`. The clause is a literal from the two call sites
 * below — never anything from the wire — and both statements are prepared once at construction.
 */
function sessionListSql(where: string): string {
  return `
    SELECT s.id AS id, s.state AS state, s.claude_session_id AS claude_session_id,
           s.autonomy AS autonomy, s.model AS model, s.room_id AS room_id,
           s.is_orchestrator AS is_orchestrator, s.account_id AS account_id,
           s.role_id AS role_id,
           s.paused_until AS paused_until,
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
  /** active | paused | done | error. The one column `pauseSession`/`resumeSession` branch on. */
  state: string;
  claude_session_id: string | null;
  autonomy: string;
  /** NULL is "the CLI's own default", not a missing value. */
  model: string | null;
  room_id: string | null;
  /** SQLite has no boolean: 1 is the factory's orchestrator, 0 is every other agent. */
  is_orchestrator: number;
  /** NULL is "the ambient `~/.claude`", not a missing value. */
  account_id: string | null;
  /** NULL is "a plain agent", not a missing value. An id whose file has gone resolves to the same. */
  role_id: string | null;
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
