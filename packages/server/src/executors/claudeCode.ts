import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig, Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { APPROVAL_DENIED_MESSAGE, classifyExecutorError, mapSdkMessage } from "@superfabric/shared";
import type { AutonomyMode, SdkMessageLike } from "@superfabric/shared";
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
 *
 * Re-exported rather than defined here: it moved to `@superfabric/shared` when a *second* host for
 * a session appeared (`packages/agent-runner`, inside a container), because both produce the
 * `session_error` message that `SessionManager` then re-classifies. Existing importers are
 * unaffected.
 */
export { classifyExecutorError };

/** The SDK's own `query` signature — the injection seam used by tests. */
export type QueryFn = typeof sdkQuery;

/**
 * Tool-name prefixes that belong to **our own in-process MCP servers** — today, the factory bus.
 *
 * The SDK namespaces every MCP tool as `mcp__<serverName>__<toolName>` (verified in
 * `notes/agent-sdk-api.md`), so the bus's `factory_send` reaches `canUseTool` as
 * `mcp__factory__factory_send`. The prefixes are derived from the servers this session was actually
 * given rather than hard-coded, and only from the `type: "sdk"` variant: an in-process server is code
 * in this process that we wrote, while a stdio/http MCP server is a third party reaching outside and
 * stays gated like every other outside-facing tool.
 *
 * See `docs/decisions/0002-factory-tools-are-not-gated.md`.
 */
export function inProcessToolPrefixes(servers: Record<string, McpServerConfig> | undefined): string[] {
  if (servers === undefined) return [];
  return Object.entries(servers)
    .filter(([, config]) => (config as { type?: string }).type === "sdk")
    .map(([name]) => `mcp__${name}__`);
}

export interface ClaudeCodeExecutorOptions {
  /**
   * Process-wide fallback model id, e.g. "claude-opus-5". Omitted => the CLI's own default. A
   * session's own `ExecutorStartOptions.model` wins over this; this is only the default for
   * sessions that pinned nothing.
   */
  model?: string;
  /**
   * Process-wide fallback `CLAUDE_CONFIG_DIR` (auth/settings/transcript isolation). A session's own
   * `ExecutorStartOptions.configDir` wins over this; this is only the default for sessions bound to
   * no account.
   */
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

    // tool_use_id -> toolName, so a `tool_result` block (which only carries the id) can be
    // reported under the name the operator saw on the matching tool_use line. It is also what
    // keeps an ungated factory tool to exactly one `tool_use` event, whichever of the two paths
    // (canUseTool, or the assistant message's tool_use block) observes the call first.
    const toolNames = new Map<string, string>();
    /** Record that a tool call happened, once per tool_use id. */
    const noteToolUse = (toolUseId: string, toolName: string, input: unknown): void => {
      if (toolNames.has(toolUseId)) return;
      toolNames.set(toolUseId, toolName);
      ev.onEvent({ type: "tool_use", toolName, input });
    };

    // The factory's own bus tools are never gated — see the ADR. Computed once per session because
    // the tool set is baked in at query() time.
    const ownToolPrefixes = inProcessToolPrefixes(opts.mcpServers);
    const isOwnTool = (toolName: string): boolean =>
      ownToolPrefixes.some((prefix) => toolName.startsWith(prefix));

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
      //   strictMcpConfig — the agent's MCP servers are exactly the ones *we* pass in `mcpServers`
      //     (today: the room's factory bus). The operator's personal servers, their plugins' servers
      //     and their claude.ai connectors are all out, and by a documented flag rather than as a
      //     side effect of `settingSources` — `~/.claude.json` is not a settings *file*, so nothing
      //     promises that dropping "user" keeps its `mcpServers` out, and an isolation property
      //     must not rest on behaviour nobody documented. A room that needs a server of its own
      //     gets it through `mcpServers`, which is a decision SuperFabric makes and can show the
      //     operator. See `notes/agent-sdk-api.md` ("How the SDK sources MCP servers").
      permissionMode,
      settingSources: ["project", "local"],
      strictMcpConfig: true,
      canUseTool: async (toolName, input, { toolUseID }): Promise<PermissionResult> => {
        // The factory's own bus tools are the factory's nervous system, not the agent reaching
        // outside it: an approval card for "tell the payments room I need a webhook" is noise, and
        // it would deadlock inter-room work whenever the operator is away. So they are allowed
        // without asking, in every autonomy mode — but the call is still recorded, because "not
        // asked about" must never mean "not visible".
        if (isOwnTool(toolName)) {
          noteToolUse(toolUseID, toolName, input);
          return { behavior: "allow", updatedInput: input };
        }
        const behavior = await ev.requestApproval(toolName, input);
        // SessionManager owns approval_request/approval_resolved events; don't double-emit here.
        return behavior === "allow"
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: APPROVAL_DENIED_MESSAGE };
      },
    };
    // The SDK requires this alongside "bypassPermissions" ("a safety measure to ensure
    // intentional bypassing"); it turns into the CLI's --allow-dangerously-skip-permissions.
    // It is set only for that mode, so nothing about the other two modes changes.
    if (permissionMode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;
    if (opts.resumeSessionId) options.resume = opts.resumeSessionId;
    // In-process MCP servers (the factory bus). `mcpServers` is the SDK's exact option name, and an
    // `{ type: "sdk", instance }` entry is one variant of its config union — the tools run in this
    // process, with no transport and no subprocess.
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) options.mcpServers = opts.mcpServers;
    // A role's pre-approved tools. Set only when there are some, so a session with no role tells the
    // CLI nothing about allow-lists and every gated call still reaches `canUseTool` exactly as before.
    if (opts.allowedTools !== undefined && opts.allowedTools.length > 0) {
      options.allowedTools = [...opts.allowedTools];
    }
    // Per-session model wins; then the process-wide default; then the CLI's own. Left unset rather
    // than guessed at, because an id the CLI does not know is a 404 mid-turn.
    const model = opts.model ?? this.defaults.model;
    if (model) options.model = model;
    // Per-session role wins over the process-wide default, exactly as `model` and `autonomy` do: the
    // orchestrator's charter must not be diluted by whatever the server was started with, and a
    // session that declares no role still gets the default. Never concatenated — two appends
    // disagreeing about what an agent is would be worse than either alone.
    const appendSystemPrompt = opts.appendSystemPrompt ?? this.defaults.appendSystemPrompt;
    if (appendSystemPrompt) {
      // There is no `appendSystemPrompt` option; appending lives inside the preset object form.
      options.systemPrompt = { type: "preset", preset: "claude_code", append: appendSystemPrompt };
    }
    // Per-session account wins over the process-wide default, exactly as `model`, `autonomy` and the
    // role do. This is the whole multi-account mechanism: two sessions of the *same* executor
    // instance get two different `CLAUDE_CONFIG_DIR`s and therefore two different subscriptions.
    const configDir = opts.configDir ?? this.defaults.configDir;
    if (configDir) {
      // Options.env REPLACES the subprocess environment (it does not merge), so process.env
      // must be spread first or the CLI loses PATH/HOME/credentials.
      options.env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
    }

    const q: Query = this.queryFn({ prompt: queue, options });

    const pump = (async () => {
      try {
        for await (const msg of q) this.handleMessage(msg, ev, resolveSessionId, toolNames, noteToolUse);
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

  /**
   * Turn one SDK message into events.
   *
   * The translation itself lives in `@superfabric/shared` (`mapSdkMessage`) because there are now
   * two hosts for a session — this one, and `agent-runner` inside a container — and `SessionManager`
   * must not be able to tell their output apart. What stays here is what is local to *this* host:
   * resolving the session-id promise, and de-duplicating a tool call the `canUseTool` path may
   * already have recorded.
   */
  private handleMessage(
    msg: SDKMessage,
    ev: ExecutorEvents,
    resolveSessionId: (id: string) => void,
    toolNames: Map<string, string>,
    noteToolUse: (toolUseId: string, toolName: string, input: unknown) => void,
  ): void {
    for (const m of mapSdkMessage(msg as SdkMessageLike, toolNames)) {
      if (m.kind === "session_id") resolveSessionId(m.providerSessionId);
      // `noteToolUse`, not a bare append: an ungated factory tool is already recorded from
      // canUseTool, and the operator must see the call once rather than twice.
      else if (m.kind === "tool_use") noteToolUse(m.toolUseId, m.toolName, m.input);
      else ev.onEvent(m.event);
    }
  }
}
