import { z } from "zod";
import { AutonomyMode, ModelId, SessionEvent } from "./protocol.js";

/**
 * The runner protocol: what an `agent-runner` inside a container says to the server, and what the
 * server says back.
 *
 * **This is an envelope, not a second event language.** The payload that matters is the very
 * `SessionEvent` the local executor emits — imported from `./protocol.js`, never re-declared — so a
 * contained session and a host session produce byte-identical rows in the event log. Everything
 * added here exists for one of exactly three reasons the host path does not have:
 *
 * 1. **the socket can drop while the agent keeps working.** So the runner's output is a numbered,
 *    buffered, cumulatively-acked stream and re-attaching replays the tail (`hello` → `attached
 *    {ackedSeq}` → resend). It is the same replay contract the browser already gets from
 *    `EventStore` (`subscribe(afterSeq)`), turned around: here the *runner* holds the log and the
 *    server catches up.
 * 2. **`canUseTool` has to reach the operator across a process boundary.** So an approval is a
 *    request/answer pair keyed by `requestId` rather than a function call.
 * 3. **the container has to prove who it is.** The WebSocket origin allow-list (`server/src/origin.ts`)
 *    deliberately admits header-less non-browser clients, so it says nothing about a runner. The token
 *    does.
 *
 * Declared in `@superfabric/shared` rather than in either endpoint because both endpoints validate
 * it: the runner parses what the server sends and the server parses what the runner sends, from one
 * schema, so the two cannot drift.
 */

/**
 * Bumped when a frame's meaning changes in a way an older peer would get wrong.
 *
 * The server checks it on `hello` and refuses a mismatch with `fatal` rather than guessing — a
 * container built from last week's image talking to today's server is a real situation once images
 * are cached, and a half-understood frame is worse than a clean refusal the operator can read.
 */
export const RUNNER_PROTOCOL_VERSION = 1;

/** The path the server listens on for runners. Separate from the browser hub's `/ws`. */
export const RUNNER_WS_PATH = "/runner";

/**
 * The container image a contained session runs in — the one name the build script produces and the
 * server looks for.
 *
 * Here rather than in either of them because it is exactly a contract between the two: a server
 * that looks for a tag nobody builds fails at the worst possible moment (an operator switching a
 * room to `container` for the first time), and the failure would look like Docker's problem rather
 * than ours. `packages/agent-runner/scripts/build-image.sh` reads this value rather than repeating
 * it, so there is one string.
 *
 * The tag is versioned so a stale image left over from an earlier release is a *different* tag and
 * simply gets built, rather than being silently reused with an older protocol inside it.
 */
export const RUNNER_IMAGE_TAG = "superfabric/agent-runner:0.0.1";

/** Where `ContainerExecutor` mounts the room's workspace. The agent's `cwd` is this or below it. */
export const RUNNER_WORKSPACE_DIR = "/workspace";

/**
 * Where `ContainerExecutor` mounts the account's `CLAUDE_CONFIG_DIR`, read-write because the CLI
 * rewrites its refresh token in place — the invariant that makes one directory one account.
 */
export const RUNNER_CONFIG_DIR = "/config";

/**
 * How many un-acknowledged frames a runner holds while the server is away, and therefore how long
 * an agent can keep working through a server restart before something has to give.
 *
 * A bound rather than no bound because the runner is a process inside a memory-capped container: an
 * unbounded buffer turns "the operator restarted the server and forgot" into an OOM kill, which
 * loses the whole agent — the precise failure the buffer exists to prevent. 2000 frames is minutes
 * of a busy agent (a turn is tens of events), which comfortably covers a restart.
 *
 * **When it is hit the oldest events are dropped, never the newest**, and the gap is replaced in
 * place by a `session_error` event saying how many went. The newest events are the ones that say
 * what the agent is doing now; and losing a *record* is survivable in a way that losing the running
 * agent is not. What is never dropped is the frame carrying the provider session id — without it
 * the session could not be resumed, so it is pinned (see `Outbox`).
 */
export const RUNNER_OUTBOX_LIMIT = 2000;

/** Environment variables a container hands its runner. A container gets no argv a human would type. */
export const RUNNER_ENV = {
  /** SuperFabric's session id — the row this runner speaks for. */
  sessionId: "SUPERFABRIC_SESSION_ID",
  /** Full WebSocket URL of the server, e.g. `ws://host.docker.internal:4620/runner`. */
  serverUrl: "SUPERFABRIC_SERVER_URL",
  /** The per-container secret the server generated and will check on `hello`. */
  token: "SUPERFABRIC_RUNNER_TOKEN",
  /** `RunnerOptions` as JSON: everything `ExecutorStartOptions` carries that survives the boundary. */
  options: "SUPERFABRIC_RUNNER_OPTIONS",
} as const;

/**
 * The per-session start options that cross into the container.
 *
 * The subset of `ExecutorStartOptions` that can travel: everything except `mcpServers`, whose
 * in-process (`type: "sdk"`) variant holds a live `McpServer` object in the *server's* process and
 * therefore cannot be serialised at all. `ungatedToolPrefixes` is what survives of it — see below.
 *
 * `configDir` is absent on purpose. Inside a container the account's `CLAUDE_CONFIG_DIR` is an
 * ordinary environment variable of the container, which the CLI subprocess inherits because the
 * runner never sets `Options.env` (setting it would *replace* the environment — see
 * `server/notes/agent-sdk-api.md`). One mount, one variable, no option.
 */
export const RunnerOptions = z.object({
  /** The agent's working directory *inside the container* — the room's workspace, mounted there. */
  cwd: z.string().min(1),
  /** Provider-native session id to resume, if any. */
  resumeSessionId: z.string().nullable().default(null),
  /** Omitted => the runner's default, which is the product default (`auto`). */
  autonomy: AutonomyMode.optional(),
  /** `null` => the CLI's own default. Never guessed at. */
  model: ModelId.nullable().default(null),
  /** The role's charter, appended to the system prompt. */
  appendSystemPrompt: z.string().optional(),
  /** The SDK's auto-allow list — a privilege grant, not a restriction. */
  allowedTools: z.array(z.string()).default([]),
  /**
   * Tool-name prefixes this session must never raise an approval card for: the factory's own
   * in-process tools, per `docs/decisions/0002-factory-tools-are-not-gated.md`.
   *
   * Sent as prefixes rather than re-derived, because the fact that `mcp__factory__*` is *ours* is
   * something only the server knows — it is the process that built the server instance. The runner
   * applies the same rule the local executor applies (`inProcessToolPrefixes`): allow without
   * asking, and still emit the `tool_use` event, because "not asked about" must never mean "not
   * visible".
   */
  ungatedToolPrefixes: z.array(z.string()).default([]),
});
export type RunnerOptions = z.infer<typeof RunnerOptions>;

/**
 * One thing the runner has to get to the server in order and at-least-once, then de-duplicated by
 * sequence number on arrival.
 *
 * Approvals are deliberately *not* in here: they are keyed by `requestId`, are idempotent, and are
 * re-sent wholesale on every attach, so they need no position in the stream. The operator's log
 * entry for an approval is appended by `SessionManager` (which owns `approval_request` /
 * `approval_resolved`, exactly as it does for a host session), not by the runner.
 */
export const RunnerFrameBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: SessionEvent }),
  /**
   * The SDK's own session id, learned from the `system`/`init` message.
   *
   * A frame rather than a field on `hello`, because it is not known until the query has started —
   * and the most important frame in the stream: it is what makes the session resumable, so the
   * outbox pins it and will drop events before it.
   */
  z.object({ type: z.literal("provider_session"), providerSessionId: z.string().min(1) }),
]);
export type RunnerFrameBody = z.infer<typeof RunnerFrameBody>;

export const RunnerMessage = z.discriminatedUnion("kind", [
  /** First frame on every connection, including every re-connection. */
  z.object({
    kind: z.literal("hello"),
    protocolVersion: z.number().int(),
    sessionId: z.string().min(1),
    token: z.string().min(1),
  }),
  z.object({ kind: z.literal("frame"), seq: z.number().int().positive(), body: RunnerFrameBody }),
  /**
   * `canUseTool`, as a question. Re-sent on every attach for as long as it is unanswered, so the
   * answer to "the server restarted while an approval card was on screen" is that the card comes
   * back. Idempotent by `requestId`: a second copy is the same question, not a second question.
   */
  z.object({
    kind: z.literal("approval_request"),
    requestId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.unknown(),
  }),
  /** A clean goodbye (SIGTERM). The session stays resumable; this is not a failure. */
  z.object({ kind: z.literal("bye"), reason: z.string().max(500) }),
]);
export type RunnerMessage = z.infer<typeof RunnerMessage>;

export const RunnerServerMessage = z.discriminatedUnion("kind", [
  /**
   * The answer to `hello`: "I already have everything up to `ackedSeq`." The runner drops those and
   * replays the rest. `0` means the server has nothing — a fresh session, or a server that lost its
   * place — and the runner replays its whole buffer.
   */
  z.object({ kind: z.literal("attached"), ackedSeq: z.number().int().nonnegative() }),
  /** Cumulative: everything up to and including `seq` is durable. The runner forgets it. */
  z.object({ kind: z.literal("ack"), seq: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal("approval_response"),
    requestId: z.string().min(1),
    behavior: z.enum(["allow", "deny"]),
  }),
  /** A user turn to inject into the live query — `ExecutorHandle.send`, across the wire. */
  z.object({ kind: z.literal("prompt"), text: z.string().min(1) }),
  z.object({ kind: z.literal("interrupt") }),
  /** Graceful stop: close the query (the provider session stays resumable) and exit. */
  z.object({ kind: z.literal("stop") }),
  /**
   * "Do not come back." A refused token, an unknown session, a protocol version this server cannot
   * speak. The runner stops reconnecting and exits rather than hammering a door that will not open.
   */
  z.object({ kind: z.literal("fatal"), message: z.string().max(500) }),
]);
export type RunnerServerMessage = z.infer<typeof RunnerServerMessage>;
