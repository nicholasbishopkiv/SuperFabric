import { randomUUID } from "node:crypto";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, PermissionResult, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  APPROVAL_DENIED_MESSAGE,
  RUNNER_PROTOCOL_VERSION,
  RunnerServerMessage,
  classifyExecutorError,
  mapSdkMessage,
  type AutonomyMode,
  type RunnerFrameBody,
  type RunnerMessage,
  type RunnerOptions,
  type SessionEvent,
} from "@superfabric/shared";
import { Outbox } from "./outbox.js";
import { connectWebSocket, type ConnectFn, type RunnerSocket } from "./socket.js";

/** The SDK's own `query` signature — the injection seam used by tests. */
export type QueryFn = typeof sdkQuery;

type SdkPermissionMode = NonNullable<Options["permissionMode"]>;

/**
 * Our `AutonomyMode` vocabulary meeting the SDK's `permissionMode` strings — the same table
 * `server/src/executors/claudeCode.ts` keeps, because the runner *is* that executor, hosted on the
 * other side of a socket. A contained `bypass` agent must run in exactly the mode a host `bypass`
 * agent runs in, or the room's runtime setting would quietly change what the operator chose.
 */
const SDK_PERMISSION_MODE: Record<AutonomyMode, SdkPermissionMode> = {
  attended: "default",
  auto: "auto",
  bypass: "bypassPermissions",
};

/**
 * Unbounded async queue that doubles as the `AsyncIterable<SDKUserMessage>` prompt for `query()`.
 * Streaming-input mode is mandatory: `Query.interrupt()` and the other control methods only work
 * when the prompt is an async iterable, never a bare string.
 */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(text: string): void {
    if (this.closed) return;
    this.items.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  private notify(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

export interface SessionRunnerDeps {
  /** SuperFabric's session id — the row this runner speaks for. */
  sessionId: string;
  /** WebSocket URL of the server, e.g. `ws://host.docker.internal:4620/runner`. */
  serverUrl: string;
  /** The per-container secret the server will check. */
  token: string;
  options: RunnerOptions;
  /** Test seam: defaults to the SDK's `query()`. */
  query?: QueryFn;
  /** Test seam: defaults to a real WebSocket. */
  connect?: ConnectFn;
  /** Test seam: how long to wait before reconnect attempt `n` (1-based). */
  backoffMs?: (attempt: number) => number;
  /** Test seam: defaults to `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Bound on the outbound buffer. Defaults to `RUNNER_OUTBOX_LIMIT`. */
  outboxLimit?: number;
  /** How long a shutdown waits for the query to finish draining before giving up on it. */
  shutdownGraceMs?: number;
  log?: (line: string) => void;
}

/**
 * Reconnect backoff: quick at first (a server restart is seconds), then patient, capped at fifteen
 * seconds. Jittered so a factory of twenty containers does not stampede the server the instant it
 * comes back up.
 */
export function defaultBackoffMs(attempt: number): number {
  const base = Math.min(15_000, 250 * 2 ** Math.min(attempt - 1, 6));
  return base / 2 + Math.random() * (base / 2);
}

/**
 * One session, hosted inside a container, speaking the factory's event protocol over a socket.
 *
 * It is the far side of the `Executor` seam: it hosts exactly one SDK `query()` and emits exactly
 * the `SessionEvent`s `ClaudeCodeExecutor` emits, through the same shared mapping. What it adds is
 * everything that follows from the server being *elsewhere* — a buffered outbound stream, approvals
 * as a request/answer pair, and the rule that **the query outlives the socket**. An operator
 * restarting the server must not cost them a working agent; that is the one behaviour here worth
 * more than all the rest.
 */
export class SessionRunner {
  private readonly outbox: Outbox;
  private readonly queue = new PromptQueue();
  private readonly abort = new AbortController();
  private readonly toolNames = new Map<string, string>();
  private readonly pendingApprovals = new Map<
    string,
    { toolName: string; input: unknown; resolve: (behavior: "allow" | "deny") => void }
  >();
  private readonly connectFn: ConnectFn;
  private readonly backoff: (attempt: number) => number;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly log: (line: string) => void;

  private socket: RunnerSocket | null = null;
  /** The server has answered `hello`. Nothing is sent before that. */
  private attached = false;
  private attempts = 0;
  private q: Query | null = null;
  private pump: Promise<void> = Promise.resolve();
  private stopping = false;
  /** The server told us not to come back. Reconnecting would be hammering a locked door. */
  private fatal = false;
  private finished = false;
  private resolveFinished!: () => void;
  /** Resolves when the runner has stopped for good — what `main` waits on. */
  readonly done: Promise<void>;

  constructor(private readonly deps: SessionRunnerDeps) {
    this.outbox = new Outbox(deps.outboxLimit);
    this.connectFn = deps.connect ?? connectWebSocket;
    this.backoff = deps.backoffMs ?? defaultBackoffMs;
    this.schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    this.log = deps.log ?? (() => {});
    this.done = new Promise<void>((resolve) => {
      this.resolveFinished = resolve;
    });
  }

  /**
   * Start the query, then the socket — in that order and deliberately.
   *
   * The agent is the thing that matters; the socket is how we talk about it. Starting the query
   * first means a server that is briefly unreachable at container start costs nothing: the events
   * pile up in the outbox and arrive when it answers.
   */
  start(): void {
    this.startQuery();
    this.connect();
  }

  // ---- the query ----------------------------------------------------------

  private startQuery(): void {
    const opts = this.deps.options;
    this.emit({ type: "session_status", status: "starting" });

    const permissionMode: SdkPermissionMode = SDK_PERMISSION_MODE[opts.autonomy ?? "auto"];
    const options: Options = {
      cwd: opts.cwd,
      abortController: this.abort,
      // The same four deliberate choices the local executor makes, for the same reasons
      // (`server/src/executors/claudeCode.ts` carries the full argument):
      //   permissionMode  — always explicit, so nothing on the image can decide it for us.
      //   settingSources  — the room's own CLAUDE.md and skills apply; no user-level settings.
      //   strictMcpConfig — the agent's tool servers are the factory's, never the image's.
      permissionMode,
      settingSources: ["project", "local"],
      strictMcpConfig: true,
      canUseTool: async (toolName, input, { toolUseID }): Promise<PermissionResult> => {
        // The factory's own tools are never gated, in any autonomy mode — and are still recorded,
        // because "not asked about" must never mean "not visible". See
        // `docs/decisions/0002-factory-tools-are-not-gated.md`. Inside a container the prefixes are
        // told to us rather than derived, because whether a server is *ours* is a fact about the
        // server's process, not about anything visible here.
        if (opts.ungatedToolPrefixes.some((p) => toolName.startsWith(p))) {
          this.noteToolUse(toolUseID, toolName, input);
          return { behavior: "allow", updatedInput: input };
        }
        const behavior = await this.requestApproval(toolName, input);
        return behavior === "allow"
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: APPROVAL_DENIED_MESSAGE };
      },
    };
    if (permissionMode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;
    if (opts.resumeSessionId) options.resume = opts.resumeSessionId;
    if (opts.allowedTools.length > 0) options.allowedTools = [...opts.allowedTools];
    if (opts.model) options.model = opts.model;
    if (opts.appendSystemPrompt) {
      options.systemPrompt = { type: "preset", preset: "claude_code", append: opts.appendSystemPrompt };
    }
    // `Options.env` is deliberately not set. It REPLACES the subprocess environment rather than
    // merging, and everything the CLI needs — CLAUDE_CONFIG_DIR above all — is already an
    // environment variable of this container, put there by whoever created it.

    const queryFn = this.deps.query ?? sdkQuery;
    const q = queryFn({ prompt: this.queue, options });
    this.q = q;

    this.pump = (async () => {
      try {
        for await (const msg of q) {
          for (const m of mapSdkMessage(msg, this.toolNames)) {
            if (m.kind === "session_id") this.frame({ type: "provider_session", providerSessionId: m.providerSessionId });
            else if (m.kind === "tool_use") this.noteToolUse(m.toolUseId, m.toolName, m.input);
            else this.emit(m.event);
          }
        }
      } catch (err) {
        if (this.stopping) return; // teardown, not a session failure
        // The same message shape the local executor produces, because `SessionManager` runs the
        // same classifier over it again to decide whether an account has hit its limit.
        this.emit({ type: "session_error", message: `${classifyExecutorError(err)}: ${String(err)}` });
        this.emit({ type: "session_status", status: "error" });
      }
    })();
    this.pump.catch(() => {});
  }

  /** Record that a tool call happened, once per tool_use id. */
  private noteToolUse(toolUseId: string, toolName: string, input: unknown): void {
    if (this.toolNames.has(toolUseId)) return;
    this.toolNames.set(toolUseId, toolName);
    this.emit({ type: "tool_use", toolName, input });
  }

  // ---- the outbound stream ------------------------------------------------

  private emit(event: SessionEvent): void {
    this.frame({ type: "event", event });
  }

  private frame(body: RunnerFrameBody): void {
    const entry = this.outbox.append(body);
    this.send({ kind: "frame", seq: entry.seq, body: entry.body });
  }

  private send(msg: RunnerMessage): void {
    // `hello` is the one message allowed before the server has answered; everything else waits in
    // the outbox, so a half-open socket cannot swallow a frame nobody will ever ask for again.
    if (this.socket === null) return;
    if (!this.attached && msg.kind !== "hello") return;
    this.socket.send(JSON.stringify(msg));
  }

  // ---- approvals ----------------------------------------------------------

  /**
   * `canUseTool`, as a question to the operator on the far side of the socket.
   *
   * There is deliberately **no timeout**: an approval card an operator has not looked at yet is not
   * an error, and the host path waits indefinitely too. A dropped socket therefore blocks the turn
   * rather than failing it, and the question is asked again the moment the server is back — which
   * is exactly what an operator whose server crashed mid-card expects to see.
   */
  private requestApproval(toolName: string, input: unknown): Promise<"allow" | "deny"> {
    const requestId = randomUUID();
    return new Promise<"allow" | "deny">((resolve) => {
      this.pendingApprovals.set(requestId, { toolName, input, resolve });
      this.send({ kind: "approval_request", requestId, toolName, input });
    });
  }

  private resendApprovals(): void {
    for (const [requestId, p] of this.pendingApprovals) {
      this.send({ kind: "approval_request", requestId, toolName: p.toolName, input: p.input });
    }
  }

  // ---- the socket ---------------------------------------------------------

  private connect(): void {
    if (this.stopping || this.fatal) return;
    this.attached = false;
    this.socket = this.connectFn(this.deps.serverUrl, {
      onOpen: () => {
        this.send({
          kind: "hello",
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          sessionId: this.deps.sessionId,
          token: this.deps.token,
        });
      },
      onMessage: (data) => this.handleServerMessage(data),
      onClose: () => {
        this.socket = null;
        this.attached = false;
        if (this.stopping || this.fatal) return;
        this.attempts += 1;
        this.log(`socket closed; reconnecting (attempt ${this.attempts})`);
        this.schedule(() => this.connect(), this.backoff(this.attempts));
      },
    });
  }

  private handleServerMessage(data: string): void {
    let parsed: RunnerServerMessage;
    try {
      parsed = RunnerServerMessage.parse(JSON.parse(data));
    } catch {
      // A frame we cannot understand is the server's problem to fix, not a reason to abandon a
      // running agent. Say so and carry on.
      this.log(`ignoring unparseable server message: ${data.slice(0, 200)}`);
      return;
    }
    switch (parsed.kind) {
      case "attached": {
        // The server has told us where it got to. Forget what it has, replay the rest in order,
        // and ask again about anything still waiting on the operator.
        this.attached = true;
        this.attempts = 0;
        this.outbox.ack(parsed.ackedSeq);
        for (const entry of this.outbox.pending) {
          this.send({ kind: "frame", seq: entry.seq, body: entry.body });
        }
        this.resendApprovals();
        return;
      }
      case "ack":
        this.outbox.ack(parsed.seq);
        return;
      case "approval_response": {
        const pending = this.pendingApprovals.get(parsed.requestId);
        if (pending === undefined) return; // an answer to a question already answered
        this.pendingApprovals.delete(parsed.requestId);
        pending.resolve(parsed.behavior);
        return;
      }
      case "prompt":
        // The `working` / `user_prompt` pair is emitted here rather than by the server's executor
        // handle, so it lands in the stream *in order* with everything the agent then does.
        this.emit({ type: "session_status", status: "working" });
        this.emit({ type: "user_prompt", text: parsed.text });
        this.queue.push(parsed.text);
        return;
      case "interrupt":
        void this.q?.interrupt().catch((err) => this.log(`interrupt failed: ${String(err)}`));
        return;
      case "stop":
        void this.shutdown("stopped by the server");
        return;
      case "fatal":
        // A refused token or an unknown session. Do not reconnect: the answer will not change, and
        // a container retrying forever is a container nobody notices is broken.
        this.log(`server refused this runner: ${parsed.message}`);
        this.fatal = true;
        void this.shutdown(`refused: ${parsed.message}`);
        return;
    }
  }

  // ---- shutdown -----------------------------------------------------------

  /**
   * Stop cleanly: end the query so the provider session stays resumable, flush what can still be
   * flushed, say goodbye, and finish.
   *
   * Nothing here deletes anything. `close()` plus an abort is the same belt-and-braces teardown the
   * local executor does, and neither path touches the transcript the CLI wrote — which is what
   * `resume` will read when this session is started again, in a container or on the host.
   */
  async shutdown(reason: string): Promise<void> {
    if (this.stopping) {
      await this.done;
      return;
    }
    this.stopping = true;
    this.log(`shutting down: ${reason}`);

    // An approval nobody will ever answer must not hang the query's teardown. Denying is the safe
    // reading of "we are going away": the tool does not run, and the agent is told why in the words
    // the SDK requires.
    for (const [, p] of this.pendingApprovals) p.resolve("deny");
    this.pendingApprovals.clear();

    this.queue.close();
    try {
      this.q?.close();
    } finally {
      this.abort.abort();
    }
    await Promise.race([this.pump, this.delay(this.deps.shutdownGraceMs ?? 5_000)]);

    // Flush: anything the server has not acknowledged goes out one last time, then the goodbye.
    // Best effort by definition — if the socket is down there is nowhere to put it, and the events
    // are already in the CLI's own transcript.
    for (const entry of this.outbox.pending) {
      this.send({ kind: "frame", seq: entry.seq, body: entry.body });
    }
    this.send({ kind: "bye", reason });
    this.socket?.close();
    this.socket = null;

    this.finished = true;
    this.resolveFinished();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.schedule(resolve, ms));
  }

  /** For tests and diagnostics: how many frames are still waiting for an acknowledgement. */
  get pendingFrames(): number {
    return this.outbox.pending.length;
  }

  /** For tests and diagnostics: how many events the bound has cost us over this runner's life. */
  get droppedEvents(): number {
    return this.outbox.droppedCount;
  }

  get isFinished(): boolean {
    return this.finished;
  }
}
