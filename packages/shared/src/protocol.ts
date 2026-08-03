import { z } from "zod";

// ---- events persisted in the event log and streamed to clients ----
export const SessionEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session_status"), status: z.enum(["starting", "working", "idle", "paused", "error", "done"]), detail: z.string().optional() }),
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

// ---- client -> server ----
export const ClientMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("subscribe"), sessionId: z.string(), afterSeq: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("prompt"), sessionId: z.string(), text: z.string().min(1) }),
  z.object({ kind: z.literal("approval"), sessionId: z.string(), approvalId: z.string(), behavior: z.enum(["allow", "deny"]) }),
  z.object({ kind: z.literal("interrupt"), sessionId: z.string() }),
  z.object({ kind: z.literal("create_session"), cwd: z.string().optional() }),
  z.object({ kind: z.literal("list_sessions") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- server -> client ----
export const SessionInfo = z.object({
  id: z.string(),
  state: z.enum(["active", "paused", "done"]),
  claudeSessionId: z.string().nullable(),
  lastSeq: z.number().int(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const ServerMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), sessionId: z.string(), seq: z.number().int(), event: SessionEvent }),
  z.object({ kind: z.literal("sessions"), sessions: z.array(SessionInfo) }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
