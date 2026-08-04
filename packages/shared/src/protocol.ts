import { z } from "zod";

/**
 * How much rope an agent gets. Deliberately our own vocabulary, not the SDK's `permissionMode`
 * strings: the wire protocol stays stable if the SDK renames or adds modes, and the product only
 * exposes these three of the SDK's six. The mapping to SDK strings lives in
 * `server/src/executors/claudeCode.ts` (`sdkPermissionMode`).
 *
 * - `attended` — every gated tool call raises an approval card (SDK `"default"`).
 * - `auto` — the CLI's classifier decides; cards become rare, not impossible (SDK `"auto"`).
 * - `bypass` — nothing is gated (SDK `"bypassPermissions"`). Per-agent opt-in, only appropriate
 *   for a sandboxed room (M4).
 */
export const AutonomyMode = z.enum(["attended", "auto", "bypass"]);
export type AutonomyMode = z.infer<typeof AutonomyMode>;

/** Product default: agents run in `auto` unless someone says otherwise. */
export const DEFAULT_AUTONOMY: AutonomyMode = "auto";

/**
 * Which model an agent runs on.
 *
 * A free string, not an enum, and that is the whole design. Model ids are Anthropic's release
 * schedule, not our protocol: a closed union would mean a SuperFabric release is required before an
 * operator can use a model that shipped this morning, and a *wrong* id in that union is a 404 at
 * runtime — the worst kind of bug to ship, because it only appears when someone selects it. So the
 * wire accepts any non-empty id, `AGENT_MODELS` below is a convenience list for the UI, and the two
 * are deliberately not the same thing.
 *
 * `null`/omitted means "whatever the CLI would use" — not a model we chose.
 */
export const ModelId = z.string().min(1).max(200);
export type ModelId = z.infer<typeof ModelId>;

/** One entry in the picker: the id sent on the wire, and what a person is shown. */
export interface AgentModel {
  id: string;
  label: string;
  /** One line of "why would I pick this one". */
  note: string;
}

/**
 * The curated model list, and the single source of truth for the UI's picker.
 *
 * Deliberately short. Every id here is one we are confident exists (they are the ids
 * `packages/server/notes/agent-sdk-api.md` documents for `Options.model`, in Anthropic's current
 * `claude-<family>-<version>` scheme); anything else the operator can still type by hand, because
 * `ModelId` accepts any string. Fewer ids we are sure about plus a free-text field beats a long list
 * with a 404 hiding in it.
 *
 * **This list could be populated dynamically instead.** The Agent SDK's `Query.supportedModels()`
 * (see `notes/agent-sdk-api.md`) returns the CLI's own `ModelInfo[]` — the authoritative answer for
 * the account and CLI version actually installed. It needs a live `query()` to ask, so it is not a
 * static import; a later change can have the server call it once at boot and broadcast the result,
 * at which point this list becomes the fallback for a server that has not asked yet.
 */
export const AGENT_MODELS: readonly AgentModel[] = [
  { id: "claude-opus-5", label: "Opus 5", note: "most capable; the default choice for hard work" },
  { id: "claude-sonnet-5", label: "Sonnet 5", note: "fast and cheaper, near-Opus on most tasks" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", note: "cheapest and quickest; simple, scoped work" },
];

/**
 * What an agent is doing right now. The same vocabulary is used twice on purpose: as the payload of
 * a `session_status` event (the log's record of a transition) and as the derived `status` on
 * `SessionInfo` (the current value, so a client does not have to replay a transcript to learn it).
 */
export const SessionStatus = z.enum(["starting", "working", "idle", "paused", "error", "done"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

// ---- events persisted in the event log and streamed to clients ----
export const SessionEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session_status"), status: SessionStatus, detail: z.string().optional() }),
  z.object({ type: z.literal("agent_text"), text: z.string() }),
  z.object({ type: z.literal("agent_thinking") }),
  z.object({ type: z.literal("tool_use"), toolName: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("tool_result"), toolName: z.string(), output: z.string().optional(), isError: z.boolean().optional() }),
  z.object({ type: z.literal("approval_request"), approvalId: z.string(), toolName: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("approval_resolved"), approvalId: z.string(), behavior: z.enum(["allow", "deny"]) }),
  z.object({ type: z.literal("user_prompt"), text: z.string() }),
  z.object({ type: z.literal("turn_complete"), costUsd: z.number().optional() }),
  z.object({ type: z.literal("session_error"), message: z.string() }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;

// ---- M1b: projects ----

/**
 * One factory floor. A project is a root folder plus everything scoped to it — rooms, agents, tasks
 * and bus traffic — so one SuperFabric serves several of them at once and switching is a scope
 * change rather than a restart.
 *
 * `name` is deliberately *not* a `RoomName`: a project root is whatever repository folder the
 * operator picked, and folding "My Project" into a slug would rename the thing they are looking at.
 * The room named after the root (the central building) still gets a folded, protocol-valid label —
 * that is a room, and a room name is a folder segment.
 */
export const ProjectInfo = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  /** Absolute path of the project root. Unique across the server: one folder is one factory. */
  root: z.string().min(1),
  /** When a socket last switched to it; null until someone has. */
  lastOpenedAt: z.number().int().nullable(),
});
export type ProjectInfo = z.infer<typeof ProjectInfo>;

// ---- M2: accounts ----

/**
 * The file whose existence means a `CLAUDE_CONFIG_DIR` has been logged in.
 *
 * Named here rather than in the server because both sides talk about it: the server tests for it and
 * the UI explains it. On Linux the CLI writes the OAuth tokens to `<config dir>/.credentials.json`
 * with mode 0600 (see `docs/RESEARCH.md` §1); on macOS they may go to the keychain instead, which is
 * why `credentialsPresent` is a *hint that a login finished* and never the only signal the login flow
 * waits on.
 */
export const ACCOUNT_CREDENTIALS_FILE = ".credentials.json";

/**
 * Where an account's in-app login has got to.
 *
 * `claude auth login` is a plain-pipe conversation (no terminal emulator involved — see
 * `docs/decisions/0004-account-login-over-a-pipe.md`): it prints a URL, waits for the code the
 * operator gets from it, and exits. These are the four things the operator can be looking at while
 * that happens, plus `idle` for "nothing is running".
 */
export const AccountLoginStatus = z.enum(["idle", "starting", "awaiting_code", "finishing", "failed"]);
export type AccountLoginStatus = z.infer<typeof AccountLoginStatus>;

export const AccountLogin = z.object({
  status: AccountLoginStatus,
  /** The OAuth URL the CLI printed, once it has. This is what the operator opens. */
  url: z.string().nullable(),
  /** The CLI's own last word — an invalid code, a failure — shown verbatim rather than paraphrased. */
  message: z.string().nullable(),
});
export type AccountLogin = z.infer<typeof AccountLogin>;

/**
 * One Claude subscription, as a `CLAUDE_CONFIG_DIR` on disk plus a label.
 *
 * **Machine-wide, not per project.** A subscription belongs to the operator, not to a repository: the
 * same account runs agents on every floor, and a per-project table would make the operator re-create
 * (and re-log-in to) the same account for each one. Worse, it would put two rows on one config
 * directory, which is the exact thing the one-dir-one-account invariant forbids — refresh tokens
 * rewrite in place and two accounts sharing a directory corrupt each other. So accounts are listed
 * globally and *bound* per room and per agent, which is where the per-project choice actually lives.
 */
export const AccountInfo = z.object({
  id: z.string(),
  label: z.string().min(1).max(120),
  /** Absolute path of this account's `CLAUDE_CONFIG_DIR`. Unique across the server. */
  configDir: z.string().min(1),
  /** `<configDir>/.credentials.json` exists — how the server knows a login finished. */
  credentialsPresent: z.boolean(),
  createdAt: z.number().int(),
  /** When an agent last started on this account; null until one has. */
  lastUsedAt: z.number().int().nullable(),
  login: AccountLogin,
});
export type AccountInfo = z.infer<typeof AccountInfo>;

// ---- M2: limits ----

/**
 * Where a usage reading came from, and therefore how much it can be trusted.
 *
 * - `endpoint` — Anthropic's own `GET /api/oauth/usage`, the same authoritative, cross-device
 *   numbers Claude Code's `/usage` shows. A percentage from here is a fact.
 * - `estimate` — counted from the account's local JSONL transcripts. It **cannot see other
 *   devices**, it does not know when the real window began, and the limits it is measured against
 *   are not published. A percentage from here is a guess, and every surface that shows one has to
 *   say so.
 */
export const UsageSource = z.enum(["endpoint", "estimate"]);
export type UsageSource = z.infer<typeof UsageSource>;

/**
 * One rate-limit window, as a meter.
 *
 * `key` is machine-stable and `label` is what a person reads, because the endpoint reports both
 * fixed windows (`five_hour`, `seven_day`) and per-model ones whose identity is a display name the
 * API chooses (`weekly_scoped` scoped to "Opus"). A closed enum here would mean a SuperFabric
 * release is required before a window Anthropic added this morning can be shown at all — the same
 * argument that makes `ModelId` a free string.
 */
export const UsageWindow = z.object({
  /** Stable id: `five_hour`, `seven_day`, `seven_day_opus`, or e.g. `weekly_scoped:Opus`. */
  key: z.string().min(1).max(120),
  /** What the meter is called on screen. */
  label: z.string().min(1).max(120),
  /** How full this window is, 0–100. */
  utilization: z.number().min(0).max(100),
  /** ISO-8601 instant the window rolls, or null when the source did not say. */
  resetsAt: z.string().nullable(),
  /**
   * One line of "where this number came from", when it is worth saying — the token count behind an
   * estimate, say. Null for the ordinary case, where the meter speaks for itself.
   */
  detail: z.string().max(200).nullable().default(null),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

/**
 * What is known about one account's limits right now.
 *
 * **Honesty is the whole design of this type.** `approximate` is not decoration: an estimate shown
 * as a fact is worse than an honest gap, because the operator would plan around it. `note` carries
 * the reason in the reader's own words whenever the primary source failed or returned a shape we
 * only partly recognised — the usage endpoint is undocumented and *will* change, and the failure
 * mode must be a visible degradation rather than a silent blank meter.
 */
export const AccountUsage = z.object({
  accountId: z.string(),
  source: UsageSource,
  /** These numbers are a guess. Every surface showing them must say so. */
  approximate: z.boolean(),
  /** The meters, in the order they should be read. Empty means "nothing is known yet". */
  windows: z.array(UsageWindow),
  /** Unix **seconds** this reading was taken; null when there has never been one. */
  readAt: z.number().int().nullable(),
  /** Why this reading is degraded, verbatim, or null when it is not. */
  note: z.string().max(500).nullable(),
  /**
   * This account is at its limit *now* — either a window reached 100, or a session on it was
   * answered with a 429 before the poller caught up. The second path is why this is a field rather
   * than something derived from `windows`: a limit error from a live session is the earliest and
   * most certain signal there is, and waiting up to three minutes to believe it would be silly.
   */
  limited: z.boolean(),
  /** ISO-8601 instant the limit is expected to lift, or null when nothing said when. */
  limitedUntil: z.string().nullable(),
  /**
   * *How* we know this account is at its limit, or null when it is not.
   *
   * The distinction is load-bearing rather than informational. `window` is a reading — and a reading
   * from the estimate is a guess, which must never be allowed to cut an agent off mid-thought.
   * `rate_limit_error` is the provider itself refusing a turn: not an estimate at all, and reason
   * enough to pause whatever the meters happen to say. The scheduler branches on exactly this, and
   * the UI says which so an operator is never left wondering why work stopped.
   */
  limitedBy: z.enum(["window", "rate_limit_error"]).nullable().default(null),
});
export type AccountUsage = z.infer<typeof AccountUsage>;

/**
 * The thresholds the scheduler acts on, as percentages of any one window.
 *
 * Shared rather than server-only because the UI marks the same lines on its meters: a bar that turns
 * amber at a different number from the one that actually warns the agents would be a lie drawn to
 * scale.
 */
export const LIMIT_WARN_PERCENT = 80;
export const LIMIT_PAUSE_PERCENT = 95;

/**
 * The floor under how often one account's usage may be read, in milliseconds.
 *
 * `docs/RESEARCH.md` §2: the endpoint is undocumented and aggressive polling earns a 429 — which
 * would be a monitor that causes the condition it exists to watch for. Three minutes is what the
 * research calls safe, and a five-hour window does not move meaningfully faster than that.
 */
export const USAGE_POLL_INTERVAL_MS = 180_000;

// ---- rooms ----

/**
 * A room name is used verbatim as a folder segment, so it must be safe on its own.
 *
 * The regex rejects `..` only because `.` cannot be the first character — `a..b` is still allowed
 * and is a legal folder name, so traversal is prevented by the leading-character rule *plus* the
 * no-separator rule together. Do not relax either. `RoomManager.createRoom` re-checks the resolved
 * path against the project root anyway; this is the first of two layers, not the only one.
 */
export const RoomName = z.string().min(1).max(64).regex(
  /^[a-z0-9][a-z0-9._-]*$/,
  "lowercase letters, digits, dot, dash and underscore only; must not start with a separator",
);

export const ScenePosition = z.object({ x: z.number(), z: z.number() });
export type ScenePosition = z.infer<typeof ScenePosition>;

export const RoomInfo = z.object({
  id: z.string(),
  /** Folder segment and display name. */
  name: RoomName,
  /** Absolute path of the room's folder. */
  path: z.string(),
  /** Where the building stands on the factory floor. */
  position: ScenePosition.default({ x: 0, z: 0 }),
  /** "project" is the single central building; "room" is a workshop. */
  kind: z.enum(["project", "room"]),
  agentCount: z.number().int().nonnegative(),
  /**
   * The account new agents in this room start on, or null for the ambient `~/.claude`.
   *
   * A *default*, resolved once when an agent is created and then persisted on that agent: changing
   * it here never moves an agent that is already running, because a live session's environment is
   * fixed for the lifetime of its `query()`. See `SessionInfo.accountId`.
   */
  accountId: z.string().nullable().default(null),
});
export type RoomInfo = z.infer<typeof RoomInfo>;

// ---- M3a: tasks and the factory bus ----

/** The board's columns. `blocked` specifically means "waiting on another room", see `TaskInfo`. */
export const TaskStatus = z.enum(["open", "in_progress", "blocked", "review", "done"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskInfo = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  detail: z.string().max(4000).default(""),
  status: TaskStatus,
  /** Owning room; null means unassigned — the orchestrator routes it (M3b). */
  roomId: z.string().nullable(),
  /** Assigned agent session, when a room has more than one. */
  agentId: z.string().nullable(),
  /** Message this task is waiting on, when status is "blocked". */
  blockedOnMessageId: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type TaskInfo = z.infer<typeof TaskInfo>;

/**
 * What one room is saying to another. `request` expects an answer (and is what blocks a task),
 * `response` answers one, `info` expects nothing back.
 */
export const MessageKind = z.enum(["request", "response", "info"]);
export type MessageKind = z.infer<typeof MessageKind>;

export const MessageInfo = z.object({
  id: z.string(),
  fromRoomId: z.string(),
  toRoomId: z.string(),
  kind: MessageKind,
  body: z.string().min(1).max(8000),
  taskId: z.string().nullable(),
  /** null until the recipient's turn actually carried it. */
  deliveredAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type MessageInfo = z.infer<typeof MessageInfo>;

// ---- M1b: attachments (files in, paths out) ----

/**
 * The subdirectory an uploaded file lands in, under the project root or the selected room's folder.
 *
 * Predictable on purpose, and a plain visible folder rather than something under `.fabrica/`: the
 * point of the whole feature is that an agent is handed **a path it can open**, and a hidden
 * factory-state directory is the wrong place for the operator's own screenshot. One name, shared by
 * the server that writes there and the UI that explains where things go.
 */
export const ATTACHMENTS_DIRNAME = "attachments";

/**
 * The biggest file the upload endpoint accepts, in bytes.
 *
 * A cap rather than no cap because the endpoint writes into the operator's repository: a runaway
 * upload should be a clear rejection, not a full disk. 25 MB is comfortably more than a screenshot,
 * a log or a PDF — the things this feature exists for — and anything genuinely large is a file the
 * operator already has on disk and can simply name.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** One file that made it to disk. `path` is absolute — it is the whole point of the feature. */
export const SavedAttachment = z.object({
  /** The final name on disk, which may not be the name the browser sent (sanitised, uniquified). */
  name: z.string(),
  /** Absolute path of the written file. This is what goes into the turn text. */
  path: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type SavedAttachment = z.infer<typeof SavedAttachment>;

/** The body of a successful `POST /attachments`. */
export const AttachmentUploadResult = z.object({ saved: z.array(SavedAttachment) });
export type AttachmentUploadResult = z.infer<typeof AttachmentUploadResult>;

// ---- M3b: the chronicle ----

/**
 * One hit from the project's chronicle: enough to act on without opening anything.
 *
 * The chronicle spans two sources at once — the decisions someone wrote down, and what agents
 * actually said at the time — and a hit says which it is, because they carry different authority. A
 * `decision` is reasoning that was committed to a file in the repository (`path`); an `event` is a
 * line from a session's log, which is evidence rather than a ruling.
 *
 * The shape is the server's `Chronicle.search` result, declared here so the two cannot drift: the
 * server imports this type rather than describing the same fields a second time.
 */
export const ChronicleHit = z.object({
  kind: z.enum(["decision", "event"]),
  /** The decision's title, or the event's type. */
  title: z.string(),
  /** The matching part of the body, with an ellipsis where it was cut. */
  snippet: z.string(),
  /** Unix **seconds** — the resolution the chronicle's own timestamps have. */
  createdAt: z.number().int(),
  /** Decision id, or the session id whose log this came from. */
  ref: z.string(),
  /** Event seq within that session's log; 0 for a decision. */
  seq: z.number().int(),
  roomId: z.string().nullable(),
  /** Absolute path of the ADR file, for a decision. `null` for an event, which has no file. */
  path: z.string().nullable(),
});
export type ChronicleHit = z.infer<typeof ChronicleHit>;

/** How many hits a chronicle search answers with when the client does not say. */
export const CHRONICLE_SEARCH_LIMIT = 10;

// ---- client -> server ----
export const ClientMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("subscribe"), sessionId: z.string(), afterSeq: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("prompt"), sessionId: z.string(), text: z.string().min(1) }),
  z.object({ kind: z.literal("approval"), sessionId: z.string(), approvalId: z.string(), behavior: z.enum(["allow", "deny"]) }),
  z.object({ kind: z.literal("interrupt"), sessionId: z.string() }),
  z.object({
    kind: z.literal("create_session"),
    cwd: z.string().optional(),
    /** Put the agent in a room; the room's folder becomes its cwd. Omitted => a roomless session. */
    roomId: z.string().optional(),
    autonomy: AutonomyMode.optional(),
    /** Omitted => the CLI's own default model. */
    model: ModelId.optional(),
    /**
     * Run this agent on a particular account, overriding whatever its room defaults to. Omitted =>
     * the room's account; a roomless session, or a room with none, => the ambient `~/.claude`.
     */
    accountId: z.string().optional(),
  }),
  z.object({ kind: z.literal("set_autonomy"), sessionId: z.string(), autonomy: AutonomyMode }),
  /**
   * Switch a live agent's model. `null` hands it back to the CLI's default rather than pinning one.
   * Like `set_autonomy`, this restarts the session's executor (resuming the same provider session),
   * because the model is fixed for the lifetime of a `query()` — see `SessionManager.setModel`.
   */
  z.object({ kind: z.literal("set_model"), sessionId: z.string(), model: ModelId.nullable() }),
  /**
   * Move a live agent onto another account. `null` hands it back to the ambient `~/.claude`.
   *
   * The third member of the `set_autonomy`/`set_model` family and restarted for exactly the same
   * reason: `Options.env` — and therefore `CLAUDE_CONFIG_DIR` — is baked in when `query()` is called,
   * so the session's executor is torn down and resumed rather than mutated. The stored account and
   * the account actually in force can then never disagree.
   */
  z.object({ kind: z.literal("set_session_account"), sessionId: z.string(), accountId: z.string().nullable() }),
  z.object({ kind: z.literal("list_sessions") }),
  /**
   * Give this factory its orchestrator, or hand back the one it already has.
   *
   * Idempotent by design and deliberately argument-free: the orchestrator's room (the project room),
   * its role prompt and its tool surface are the server's to decide, not a client's — an operator
   * hand-building a session and hoping it lands in the right room with the right append is exactly
   * the failure this message exists to prevent. Answered with the fresh `sessions` list, in which
   * exactly one entry carries `isOrchestrator`.
   */
  z.object({ kind: z.literal("ensure_orchestrator") }),
  /**
   * `path` is the room's working folder. Omitted, the room is `<project root>/<name>` and must stay
   * inside the root; given, it is used as-is and may point anywhere — a department is allowed to
   * live in a separate repository. See `RoomManager.createRoom`.
   */
  z.object({ kind: z.literal("create_room"), name: RoomName, path: z.string().min(1).optional() }),
  z.object({ kind: z.literal("move_room"), roomId: z.string(), position: ScenePosition }),
  /**
   * Re-point a room at another folder. Nothing is moved on disk and agents already running keep the
   * `cwd` their SDK session was started with; only new agents get the new folder.
   */
  z.object({ kind: z.literal("set_room_path"), roomId: z.string(), path: z.string().min(1) }),
  /**
   * The account agents created in this room start on. `null` means the ambient `~/.claude`.
   *
   * A default for *new* agents only. Agents already standing there keep the account their session was
   * started with — the environment of a live `query()` cannot be changed — so this is not a way to
   * move a running agent; `set_session_account` is.
   */
  z.object({ kind: z.literal("set_room_account"), roomId: z.string(), accountId: z.string().nullable() }),
  z.object({ kind: z.literal("list_rooms") }),
  // Accounts. Machine-wide rather than project-scoped (see `AccountInfo`), so unlike every other
  // listing here these four take no project and their answer is the same on every floor.
  z.object({ kind: z.literal("list_accounts") }),
  /**
   * What each account's limits look like right now. Machine-wide like `list_accounts`, and for the
   * same reason: a subscription's quota is the operator's, not a factory's.
   *
   * A *query* over state the server already holds — it never triggers a read of the usage endpoint,
   * because a client asking is not a reason to spend a request against a rate-limited API. The
   * poller owns when that happens; this hands back the newest snapshot it took.
   */
  z.object({ kind: z.literal("list_usage") }),
  z.object({
    kind: z.literal("create_account"),
    label: z.string().min(1).max(120),
    /**
     * Absolute path of this account's `CLAUDE_CONFIG_DIR`. Created if it is not there yet, and
     * refused if another account already claims it: one directory is one account, always.
     */
    configDir: z.string().min(1),
  }),
  /** Refused while any session still runs on it — an account is not removed out from under an agent. */
  z.object({ kind: z.literal("remove_account"), accountId: z.string() }),
  /**
   * Log this account in, in the app.
   *
   * The server runs `claude auth login` against that account's config directory over plain pipes and
   * reports what it prints: an OAuth URL for the operator to open, then a wait for the code that page
   * gives them (`submit_account_login_code`). No terminal emulator is involved — the command needs no
   * TTY, which is the measured finding this design rests on.
   */
  z.object({ kind: z.literal("begin_account_login"), accountId: z.string() }),
  z.object({
    kind: z.literal("submit_account_login_code"),
    accountId: z.string(),
    /** The code from the OAuth page, handed to the waiting CLI on its stdin. */
    code: z.string().min(1).max(2000),
  }),
  z.object({ kind: z.literal("cancel_account_login"), accountId: z.string() }),
  // Projects. `open_project` is per-socket: it changes what *this* tab is looking at, and the
  // server answers with that project's rooms, sessions, tasks and messages. Another tab watching
  // another factory is unaffected — which is the whole point of the active project being a
  // property of the socket rather than of the server.
  z.object({ kind: z.literal("list_projects") }),
  z.object({
    kind: z.literal("create_project"),
    /** Absolute path of an existing directory. The server refuses anything else. */
    root: z.string().min(1),
    name: z.string().min(1).max(120).optional(),
  }),
  z.object({ kind: z.literal("open_project"), projectId: z.string() }),
  // Tasks. `roomId` omitted on create means unassigned, which is the intended path: the
  // orchestrator routes it (M3b). On update, `null` is how the operator *clears* an assignment —
  // omitted means "leave it alone", so the two have to be distinguishable on the wire.
  z.object({
    kind: z.literal("create_task"),
    title: z.string().min(1).max(200),
    detail: z.string().max(4000).optional(),
    roomId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("update_task"),
    taskId: z.string(),
    status: TaskStatus.optional(),
    roomId: z.string().nullable().optional(),
    agentId: z.string().nullable().optional(),
  }),
  /**
   * Ask the orchestrator where an unassigned task belongs — the board's "route it" affordance, and
   * the same round trip `create_task` starts on its own for a card created with no room.
   *
   * Explicit rather than implicit because routing is a *model* decision that may be slow or wrong:
   * an operator who has since created the orchestrator, or who wants the question asked again, needs
   * a way to say so. Nothing is assigned by this message — it sends a question, and the task stays
   * visibly unassigned until the orchestrator answers.
   */
  z.object({ kind: z.literal("route_task"), taskId: z.string() }),
  z.object({ kind: z.literal("list_tasks") }),
  /**
   * The bus's recent traffic. A client needs this on connect for two reasons: a message still
   * queued for a busy room is *state* the floor has to draw (the pile at its sender's door), and the
   * answer is the baseline against which later broadcasts are new — without it a tab either shows no
   * queue until something changes, or replays an hour of history as packages on the belt.
   */
  z.object({ kind: z.literal("list_messages") }),
  /**
   * Search this project's chronicle — the same index `factory_search_history` gives agents.
   *
   * A **query**, answered to the asking socket alone: two operators searching different words in two
   * tabs must not overwrite each other's results, and nobody else's screen should change because
   * someone typed in a search box.
   *
   * An empty query is not an error and not "match everything": it asks for the newest recorded
   * decisions, so opening the surface shows what this factory has decided rather than an empty box.
   * Anything an agent could type is accepted verbatim — FTS5 operators are neutralised server-side
   * (`ftsQuery`), so a stray quote is a search, not a syntax error.
   */
  z.object({
    kind: z.literal("search_chronicle"),
    query: z.string().max(500).default(""),
    limit: z.number().int().min(1).max(50).optional(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- server -> client ----
export const SessionInfo = z.object({
  id: z.string(),
  // "error": the executor reported a terminal failure, so the session is not re-spawned on boot.
  state: z.enum(["active", "paused", "done", "error"]),
  claudeSessionId: z.string().nullable(),
  lastSeq: z.number().int(),
  /** Per-session, persisted, and re-applied on resume. */
  autonomy: AutonomyMode,
  /**
   * The model this agent runs on, or `null` for the CLI's own default. Per-session, persisted, and
   * re-applied on resume, exactly like `autonomy`: a restarted agent must come back on the model the
   * operator chose, not on whatever the CLI would have picked.
   */
  model: z.string().nullable(),
  /** The room this agent works in, or null for a roomless session (every M0 session). */
  roomId: z.string().nullable(),
  /**
   * This agent is the factory's orchestrator: the senior agent that routes work, unblocks rooms and
   * decides direction. It is an ordinary session in every other respect — same runtime, same event
   * log, same room (the project room) — so this is a flag on `SessionInfo` rather than a separate
   * kind of thing the client has to model. At most one per project.
   */
  isOrchestrator: z.boolean(),
  /**
   * The account this agent runs on — its `CLAUDE_CONFIG_DIR` — or `null` for the ambient `~/.claude`,
   * which is what every session before M2 ran on and still does.
   *
   * Resolved once when the agent is created (an explicit choice, else its room's default) and then
   * persisted here, so the room's default changing later never silently moves a running agent. Like
   * `autonomy` and `model` it is re-applied on resume: an agent restarted by a reboot comes back on
   * the same subscription, which is the property the whole multi-account feature rests on.
   */
  accountId: z.string().nullable().default(null),
  /**
   * When this agent is expected to come back, as unix **seconds** — non-null only while it is
   * paused, and only when something knows the answer.
   *
   * `null` on a paused agent is a real state rather than a missing value: an account marked by a 429
   * with no reading behind it has no known reset time, and the scheduler holds it until a reading
   * says the window rolled. The UI shows a countdown for the first and "waiting for the limit to
   * lift" for the second — inventing a time for the second would be a promise nobody made.
   */
  pausedUntil: z.number().int().nullable().default(null),
  /**
   * Derived from the session's own event log: the latest `session_status`, or `idle` when it has
   * none. The 3D floor needs the *current* status of every agent, and subscribing to every session
   * just to replay every transcript would be absurd — so the server computes it and sends it.
   */
  status: SessionStatus,
  /**
   * An `approval_request` is outstanding. "Waiting on you" is a different thing to show than
   * "working", and like `status` it must not require a transcript replay to know.
   */
  blocked: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const ServerMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), sessionId: z.string(), seq: z.number().int(), event: SessionEvent }),
  z.object({ kind: z.literal("sessions"), sessions: z.array(SessionInfo) }),
  z.object({ kind: z.literal("rooms"), rooms: z.array(RoomInfo) }),
  /**
   * Every account on this server — the one list here that is *not* scoped to a project, because a
   * subscription is the operator's and serves every floor (see `AccountInfo`). It therefore goes to
   * every attached socket rather than only to those looking at one factory.
   */
  z.object({ kind: z.literal("accounts"), accounts: z.array(AccountInfo) }),
  /**
   * Every account's limit meters. Machine-wide, so like `accounts` it goes to every attached socket
   * rather than only to those on one floor.
   *
   * A separate message from `accounts` on purpose: the account list changes when the operator
   * configures something, and the meters change on a three-minute poll. Folding the two together
   * would rebroadcast every account row (and every in-flight login's state) on every tick.
   */
  z.object({ kind: z.literal("usage"), usage: z.array(AccountUsage) }),
  z.object({ kind: z.literal("tasks"), tasks: z.array(TaskInfo) }),
  /**
   * The bus's traffic. This is what drives the conveyor animation, so it carries `deliveredAt`:
   * a message nobody has picked up yet looks different from one in flight.
   */
  z.object({ kind: z.literal("messages"), messages: z.array(MessageInfo) }),
  /**
   * Every project on this server, plus the one *this socket* is looking at. The active id travels
   * with the list because it is per-socket state: two tabs get the same projects and different
   * active ids, and a client that had to remember which `open_project` it sent last would get it
   * wrong the moment the server changed it (a fresh tab lands on the last-opened project).
   */
  z.object({
    kind: z.literal("projects"),
    projects: z.array(ProjectInfo),
    activeProjectId: z.string(),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
  /**
   * "This worked, and here is what happened."
   *
   * The protocol had exactly one channel for saying anything to the operator — `error` — so every
   * successful-but-worth-reporting outcome had to either travel on it (and be painted red) or be
   * guessed at by the UI. Both have happened: a successful `set_room_path` was once reported as an
   * error, and an attachment saved to disk has no other way to say *where*.
   *
   * Deliberately just a string, and deliberately not persisted: a notice is a fact about the request
   * that just completed, not an event in a session's log. Anything an agent needs to know goes in the
   * event log instead.
   */
  z.object({ kind: z.literal("notice"), message: z.string() }),
  /**
   * The answer to one `search_chronicle`, **carrying the query it answers**.
   *
   * The echo is load-bearing: a search box sends a request per keystroke-ish and the answers come
   * back over a socket in no guaranteed order, so a client that stored whatever arrived last would
   * show the results for a word the operator has already finished deleting. With the query on the
   * frame, an answer that is not the question currently being asked is simply dropped.
   */
  z.object({
    kind: z.literal("chronicle"),
    /** The query as asked. Empty means "the newest decisions", which is what an empty box shows. */
    query: z.string(),
    hits: z.array(ChronicleHit),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
