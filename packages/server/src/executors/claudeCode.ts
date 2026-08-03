import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AutonomyMode, SessionEvent } from "@superfabric/shared";
import type { Executor, ExecutorEvents, ExecutorHandle, ExecutorStartOptions } from "../executor.js";

type SdkPermissionMode = NonNullable<Options["permissionMode"]>;

/**
 * The single place our `AutonomyMode` vocabulary meets the SDK's `permissionMode` strings. The
 * protocol deliberately does not speak SDK — if the SDK renames a mode or adds a seventh, only
 * this table changes.
 */
const SDK_PERMISSION_MODE: Record<AutonomyMode, SdkPermissionMode> = {
  attended: "default",        // canUseTool is consulted for every gated call → approval card
  auto: "auto",               // the CLI's classifier decides; cards become rare, not impossible
  bypass: "bypassPermissions", // nothing is gated at all
};

export function sdkPermissionMode(autonomy: AutonomyMode): SdkPermissionMode {
  return SDK_PERMISSION_MODE[autonomy];
}

/**
 * Coarse classification of executor failures. Rate limits are the one class the runner has to
 * react to differently (back off / surface a wait-until), everything else is opaque.
 */
export function classifyExecutorError(err: unknown): "rate_limited" | "unknown" {
  const s = String(err).toLowerCase();
  return /429|rate.?limit|usage limit reached/.test(s) ? "rate_limited" : "unknown";
}

/** The SDK's own `query` signature — the injection seam used by tests. */
export type QueryFn = typeof sdkQuery;

export interface ClaudeCodeExecutorOptions {
  /** Model id, e.g. "claude-fable-5". Omitted => the CLI's own default. */
  model?: string;
  /** Per-account CLAUDE_CONFIG_DIR (auth/settings/transcript isolation). */
  configDir?: string;
  /** Appended to the claude_code system-prompt preset. */
  appendSystemPrompt?: string;
  /**
   * Fallback SDK permission mode for sessions started without an explicit
   * `ExecutorStartOptions.autonomy`. Defaults to "auto" (the product default). Per-agent
   * autonomy is the normal lever; this is only a process-wide default.
   */
  permissionMode?: SdkPermissionMode;
  /** Test seam: defaults to the SDK's query(). */
  query?: QueryFn;
}

/**
 * Unbounded async queue that doubles as the `AsyncIterable<SDKUserMessage>` prompt for
 * `query()`. Streaming-input mode is mandatory: `Query.interrupt()` and the other control
 * methods only work when the prompt is an async iterable, never a bare string.
 */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(text: string): void {
    if (this.closed) return;
    this.items.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
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

export class ClaudeCodeExecutor implements Executor {
  readonly name = "claude-code";
  private readonly queryFn: QueryFn;

  constructor(private readonly defaults: ClaudeCodeExecutorOptions = {}) {
    this.queryFn = defaults.query ?? sdkQuery;
  }

  start(opts: ExecutorStartOptions, ev: ExecutorEvents): ExecutorHandle {
    const queue = new PromptQueue();
    const abort = new AbortController();
    let stopped = false;

    let resolveSessionId!: (id: string) => void;
    // Never rejected: SessionManager consumes this with a bare `.then()`, so a rejection would
    // surface as an unhandled rejection. A failed stream reports via session_error instead and
    // leaves this promise pending.
    const providerSessionId = new Promise<string>((resolve) => {
      resolveSessionId = resolve;
    });

    ev.onEvent({ type: "session_status", status: "starting" });

    // Per-session autonomy wins; then the process-wide default; then the product default.
    const permissionMode: SdkPermissionMode = opts.autonomy !== undefined
      ? sdkPermissionMode(opts.autonomy)
      : this.defaults.permissionMode ?? "auto";

    const options: Options = {
      cwd: opts.cwd,
      abortController: abort,
      // SuperFabric owns an agent's configuration; it does not inherit the operator's personal
      // Claude Code setup. Being explicit matters for both fields:
      //   permissionMode — the product default is "auto" (the CLI's classifier decides, so an
      //     approval card is the exception rather than the rule). It is still set explicitly on
      //     every session so the operator's own `defaultMode` can never leak in and silently
      //     change what a factory agent is allowed to do. `attended` ("default") keeps the
      //     approval card on every gated call; `bypass` ("bypassPermissions") gates nothing at
      //     all and is an explicit per-agent opt-in — only safe once sessions are sandboxed (M4).
      //     Note the CLI auto-allows safe commands like `echo` in every mode, so canUseTool is
      //     consulted only for calls the CLI would ask about anyway.
      //   settingSources — dropping "user" keeps the operator's global hooks, model default and
      //     permission rules out of factory agents, so a room behaves the same on any machine.
      //     "project"/"local" stay because a room's own CLAUDE.md, skills and agents live in its
      //     folder and are meant to apply.
      permissionMode,
      settingSources: ["project", "local"],
      canUseTool: async (toolName, input): Promise<PermissionResult> => {
        const behavior = await ev.requestApproval(toolName, input);
        // SessionManager owns approval_request/approval_resolved events; don't double-emit here.
        return behavior === "allow"
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "Denied by the SuperFabric operator." };
      },
    };
    // The SDK requires this alongside "bypassPermissions" ("a safety measure to ensure
    // intentional bypassing"); it turns into the CLI's --allow-dangerously-skip-permissions.
    // It is set only for that mode, so nothing about the other two modes changes.
    if (permissionMode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;
    if (opts.resumeSessionId) options.resume = opts.resumeSessionId;
    if (this.defaults.model) options.model = this.defaults.model;
    if (this.defaults.appendSystemPrompt) {
      // There is no `appendSystemPrompt` option; appending lives inside the preset object form.
      options.systemPrompt = { type: "preset", preset: "claude_code", append: this.defaults.appendSystemPrompt };
    }
    if (this.defaults.configDir) {
      // Options.env REPLACES the subprocess environment (it does not merge), so process.env
      // must be spread first or the CLI loses PATH/HOME/credentials.
      options.env = { ...process.env, CLAUDE_CONFIG_DIR: this.defaults.configDir };
    }

    const q: Query = this.queryFn({ prompt: queue, options });

    // tool_use_id -> toolName, so a `tool_result` block (which only carries the id) can be
    // reported under the name the operator saw on the matching tool_use line.
    const toolNames = new Map<string, string>();

    const pump = (async () => {
      try {
        for await (const msg of q) this.handleMessage(msg, ev, resolveSessionId, toolNames);
      } catch (err) {
        if (stopped) return; // close()/abort() teardown, not a session failure
        const kind = classifyExecutorError(err);
        ev.onEvent({ type: "session_error", message: `${kind}: ${String(err)}` });
        ev.onEvent({ type: "session_status", status: "error" });
      }
    })();
    // The pump owns all its failures; make sure nothing escapes as an unhandled rejection.
    pump.catch(() => {});

    return {
      providerSessionId,
      send: (text: string) => {
        if (stopped) return;
        ev.onEvent({ type: "session_status", status: "working" });
        ev.onEvent({ type: "user_prompt", text });
        queue.push(text);
      },
      interrupt: async () => {
        await q.interrupt();
      },
      stop: async () => {
        stopped = true;
        queue.close();
        try {
          q.close();
        } finally {
          // Belt-and-suspenders hard stop: works even outside streaming-input mode. Neither
          // path deletes anything, so the provider session stays resumable.
          abort.abort();
        }
        await pump;
      },
    };
  }

  private handleMessage(
    msg: SDKMessage,
    ev: ExecutorEvents,
    resolveSessionId: (id: string) => void,
    toolNames: Map<string, string>,
  ): void {
    if (msg.type === "system" && msg.subtype === "init") {
      resolveSessionId(msg.session_id);
      return;
    }
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") ev.onEvent({ type: "agent_text", text: block.text });
        else if (block.type === "thinking") ev.onEvent({ type: "agent_thinking" });
        else if (block.type === "tool_use") {
          toolNames.set(block.id, block.name);
          ev.onEvent({ type: "tool_use", toolName: block.name, input: block.input });
        }
      }
      return;
    }
    // The CLI reports tool outcomes as `type: "user"` messages carrying tool_result content
    // blocks — there is no dedicated tool_result message type. `isReplay` marks history the CLI
    // re-emits when a session is resumed; our own log already holds those rows, so skip them
    // instead of appending a duplicate transcript on every restart.
    if (msg.type === "user") {
      if ("isReplay" in msg && msg.isReplay === true) return;
      const content = msg.message.content;
      if (typeof content === "string") return; // our own injected prompts round-tripping back
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const event: Extract<SessionEvent, { type: "tool_result" }> = {
          type: "tool_result",
          toolName: toolNames.get(block.tool_use_id) ?? block.tool_use_id,
          isError: block.is_error === true,
        };
        toolNames.delete(block.tool_use_id);
        const output = toolResultText(block.content);
        if (output !== undefined) event.output = output;
        ev.onEvent(event);
      }
      return;
    }
    if (msg.type === "result") {
      ev.onEvent({ type: "turn_complete", costUsd: msg.total_cost_usd });
      ev.onEvent({ type: "session_status", status: "idle" });
    }
  }
}

/** `tool_result.content` is a string or a block array; our event carries a plain string. */
function toolResultText(content: ToolResultContent): string | undefined {
  if (content === undefined) return undefined;
  if (typeof content === "string") return content;
  return content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
}

/** Structural stand-in for `ToolResultBlockParam["content"]` (peer `@anthropic-ai/sdk`). */
type ToolResultContent = string | { type: string; text?: string }[] | undefined;
