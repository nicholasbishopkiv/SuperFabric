import type { SessionEvent } from "./protocol.js";

/**
 * The one translation from a Claude Agent SDK message to SuperFabric's `SessionEvent` vocabulary.
 *
 * **Here rather than in the executor because there are now two executors.** `ClaudeCodeExecutor`
 * hosts `query()` in the server's own process; `agent-runner` hosts the same `query()` inside a
 * container and ships the result over a socket. `SessionManager` must not be able to tell those
 * apart — that equivalence is the entire point of the `Executor` seam — and two copies of this
 * mapping would make it a claim rather than a fact: the day someone fixes a `tool_result` edge case
 * on one side, a contained session's transcript starts reading differently from a host session's,
 * and nothing would say so.
 *
 * **It names no SDK type on purpose.** `@superfabric/shared` is imported by the browser bundle, and
 * a type-only import of `@anthropic-ai/claude-agent-sdk` here would put that dependency into the web
 * package's type graph for a mapping the browser never runs. `SdkMessageLike` is a structural
 * stand-in that every `SDKMessage` variant satisfies; the field names and shapes it assumes are the
 * ones verified in `packages/server/notes/agent-sdk-api.md` ("Message union"), which is the
 * authority — not memory.
 */

/**
 * Coarse classification of provider failures. Rate limits are the one class the factory has to
 * react to differently (pause the agent, wait for the window), everything else is opaque.
 *
 * Shared for the same reason the mapping above is: both hosts turn a failed stream into a
 * `session_error` whose message starts with this word, and `SessionManager` runs the *same*
 * classifier over that message again to decide whether an account has hit its limit. Two copies of
 * the regex would mean a contained agent that hit a 429 was never paused — a bug with a three-hour
 * feedback loop.
 */
export function classifyExecutorError(err: unknown): "rate_limited" | "unknown" {
  const s = String(err).toLowerCase();
  return /429|rate.?limit|usage limit reached/.test(s) ? "rate_limited" : "unknown";
}

/**
 * Structural stand-in for the SDK's `SDKMessage` union, covering only the fields this mapping
 * reads. Every variant of the real union is assignable to it.
 */
export interface SdkMessageLike {
  type: string;
  /** Second-level discriminant for `type: "system"` — `"init"` is the one carrying the session id. */
  subtype?: string;
  session_id?: string;
  /** `BetaMessage` on an assistant message, `MessageParam` on a user one. Narrowed below. */
  message?: unknown;
  /** Marks history the CLI re-emits when a session is resumed. */
  isReplay?: boolean;
  total_cost_usd?: number;
}

/**
 * One thing that follows from an SDK message.
 *
 * `tool_use` is not an event but an *instruction to record a tool call*, because a call can be
 * observed twice — once by `canUseTool` and once as a `tool_use` content block — and the operator
 * must see it once. Both hosts own that de-duplication (`noteToolUse`), so the mapping reports the
 * observation and lets them decide.
 */
export type SdkMapping =
  | { kind: "session_id"; providerSessionId: string }
  | { kind: "tool_use"; toolUseId: string; toolName: string; input: unknown }
  | { kind: "event"; event: SessionEvent };

/**
 * Translate one SDK message. Returns what it means, in order; an empty array for the ~30 variants
 * neither host reacts to (hooks, tasks, plugins, partial deltas, …).
 *
 * `toolNames` maps a `tool_use_id` to the name the operator saw, so a `tool_result` block — which
 * carries only the id — is reported under that name. It is **read and pruned** here: an entry is
 * removed once its result has arrived, so a re-used id can never resolve to a stale name.
 */
export function mapSdkMessage(msg: SdkMessageLike, toolNames: Map<string, string>): SdkMapping[] {
  if (msg.type === "system" && msg.subtype === "init") {
    return msg.session_id ? [{ kind: "session_id", providerSessionId: msg.session_id }] : [];
  }

  if (msg.type === "assistant") {
    const out: SdkMapping[] = [];
    for (const block of assistantBlocks(msg.message)) {
      if (block.type === "text" && typeof block.text === "string") {
        out.push({ kind: "event", event: { type: "agent_text", text: block.text } });
      } else if (block.type === "thinking") {
        out.push({ kind: "event", event: { type: "agent_thinking" } });
      } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        out.push({ kind: "tool_use", toolUseId: block.id, toolName: block.name, input: block.input });
      }
    }
    return out;
  }

  // The CLI reports tool outcomes as `type: "user"` messages carrying tool_result content blocks —
  // there is no dedicated tool_result message type. `isReplay` marks history the CLI re-emits when a
  // session is resumed; our own log already holds those rows, so skip them instead of appending a
  // duplicate transcript on every restart.
  if (msg.type === "user") {
    if (msg.isReplay === true) return [];
    const content = messageContent(msg.message);
    if (content === undefined) return []; // our own injected prompts round-tripping back
    const out: SdkMapping[] = [];
    for (const block of content) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const event: Extract<SessionEvent, { type: "tool_result" }> = {
        type: "tool_result",
        toolName: toolNames.get(block.tool_use_id) ?? block.tool_use_id,
        isError: block.is_error === true,
      };
      toolNames.delete(block.tool_use_id);
      const output = toolResultText(block.content);
      if (output !== undefined) event.output = output;
      out.push({ kind: "event", event });
    }
    return out;
  }

  if (msg.type === "result") {
    const complete: Extract<SessionEvent, { type: "turn_complete" }> = { type: "turn_complete" };
    if (typeof msg.total_cost_usd === "number") complete.costUsd = msg.total_cost_usd;
    return [
      { kind: "event", event: complete },
      { kind: "event", event: { type: "session_status", status: "idle" } },
    ];
  }

  return [];
}

/** Structural view of one assistant content block. */
interface BlockLike {
  type: string;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

function assistantBlocks(message: unknown): BlockLike[] {
  if (typeof message !== "object" || message === null) return [];
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as BlockLike[]) : [];
}

/** Structural view of one `tool_result` block on a user message. */
interface ToolResultLike {
  type: string;
  tool_use_id?: unknown;
  content?: ToolResultContent;
  is_error?: unknown;
}

/** `undefined` for a plain-string user turn — our own prompt coming back, which says nothing new. */
function messageContent(message: unknown): ToolResultLike[] | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as ToolResultLike[]) : undefined;
}

/** `tool_result.content` is a string or a block array; our event carries a plain string. */
function toolResultText(content: ToolResultContent): string | undefined {
  if (content === undefined) return undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : `[${b.type}]`)).join("\n");
}

/** Structural stand-in for `ToolResultBlockParam["content"]` (peer `@anthropic-ai/sdk`). */
type ToolResultContent = string | { type: string; text?: string }[] | undefined;
