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
  }),
  z.object({ kind: z.literal("set_autonomy"), sessionId: z.string(), autonomy: AutonomyMode }),
  /**
   * Switch a live agent's model. `null` hands it back to the CLI's default rather than pinning one.
   * Like `set_autonomy`, this restarts the session's executor (resuming the same provider session),
   * because the model is fixed for the lifetime of a `query()` — see `SessionManager.setModel`.
   */
  z.object({ kind: z.literal("set_model"), sessionId: z.string(), model: ModelId.nullable() }),
  z.object({ kind: z.literal("list_sessions") }),
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
  z.object({ kind: z.literal("list_rooms") }),
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
  z.object({ kind: z.literal("list_tasks") }),
  /**
   * The bus's recent traffic. A client needs this on connect for two reasons: a message still
   * queued for a busy room is *state* the floor has to draw (the pile at its sender's door), and the
   * answer is the baseline against which later broadcasts are new — without it a tab either shows no
   * queue until something changes, or replays an hour of history as packages on the belt.
   */
  z.object({ kind: z.literal("list_messages") }),
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
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
