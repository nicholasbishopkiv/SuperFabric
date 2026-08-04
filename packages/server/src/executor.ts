import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AutonomyMode, SessionEvent } from "@superfabric/shared";

export interface ExecutorEvents {
  onEvent: (event: SessionEvent) => void;
  /** Ask the operator to approve a tool call. Resolves allow/deny. */
  requestApproval: (toolName: string, input: unknown) => Promise<"allow" | "deny">;
}

/**
 * Per-session configuration. Anything that varies between agents belongs here rather than on the
 * executor's constructor, so one executor instance can serve every session: the constructor only
 * carries process-wide defaults.
 */
export interface ExecutorStartOptions {
  cwd: string;
  /**
   * This agent's account, as the `CLAUDE_CONFIG_DIR` its provider process should use. Omitted =>
   * the executor's own default, and failing that the ambient `~/.claude` — which is what every
   * session ran on before M2 and still does when nothing is bound.
   *
   * Per session rather than per executor because that is what "several subscriptions run agents in
   * parallel" means: one executor instance serves the whole factory, and two agents in it are
   * routinely on different accounts. Named as a directory rather than as an account id because the
   * seam is provider-agnostic — a provider that authenticates differently ignores it, and nothing
   * here has to know what a SuperFabric account row is.
   */
  configDir?: string;
  /** Provider-native session id to resume, if any. */
  resumeSessionId?: string | null;
  /** How much this agent is allowed to do unattended. Omitted => the executor's own default. */
  autonomy?: AutonomyMode;
  /**
   * Which model this agent runs on. Omitted or `null` => the executor's own default, and failing
   * that the provider's. Per session rather than per executor for the same reason `autonomy` is:
   * one executor instance serves the whole factory, and two agents in it are routinely worth
   * running on different models (a cheap one triaging, an expensive one implementing).
   */
  model?: string | null;
  /**
   * Tool servers to expose to this agent — for us, the in-process factory bus built per session
   * from its room (`busTools`). The type is the Agent SDK's `Options.mcpServers` shape, which is the
   * one place this provider-agnostic seam names an SDK type: MCP is the protocol, not a Claude
   * detail, and a future provider either speaks it or ignores the field. The import is type-only,
   * so nothing about the seam's runtime independence changes.
   */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Text appended to this agent's system prompt — its *role*, as opposed to its instructions.
   *
   * Per session for the same reason `autonomy` and `model` are: one executor instance serves the
   * whole factory, and the orchestrator differs from an ordinary room agent by exactly this string
   * plus a flag and a larger tool set. A role that lived on the executor's constructor would mean a
   * second executor instance per role, i.e. a parallel runtime for what is one session with a job.
   */
  appendSystemPrompt?: string;
  /**
   * Tool names this session pre-approves, in the SDK's `allowedTools` sense: an **auto-allow list**,
   * not a restriction. Anything named here is allowed without reaching the operator, so an entry is a
   * privilege grant and MCP tools have to be written in the namespaced form the model sees
   * (`mcp__<server>__<tool>`).
   *
   * Per session because it comes from a session's role, and empty for every session that has none —
   * which is the shape every session had before roles existed, and the shape the ten shipped presets
   * still have. Nothing in the product grants a privilege on an operator's behalf; this exists so a
   * role an operator wrote *can*.
   */
  allowedTools?: readonly string[];
}

export interface ExecutorHandle {
  /** Provider-native session id, available after start. */
  readonly providerSessionId: Promise<string>;
  send(text: string): void;          // queue a user turn into the live session
  interrupt(): Promise<void>;
  stop(): Promise<void>;             // graceful shutdown, session stays resumable
}

export interface Executor {
  readonly name: string;             // "claude-code", later "codex", ...
  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorHandle;
}
