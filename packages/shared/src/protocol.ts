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
  }),
  z.object({ kind: z.literal("set_autonomy"), sessionId: z.string(), autonomy: AutonomyMode }),
  z.object({ kind: z.literal("list_sessions") }),
  z.object({ kind: z.literal("create_room"), name: RoomName }),
  z.object({ kind: z.literal("move_room"), roomId: z.string(), position: ScenePosition }),
  z.object({ kind: z.literal("list_rooms") }),
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
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
