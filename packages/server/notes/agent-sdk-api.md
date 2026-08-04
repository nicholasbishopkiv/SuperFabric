# Agent SDK API — reconnaissance (version 0.3.220, 2026-08-03)

Source of truth: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (pinned 0.3.220), which
resolves via pnpm symlink to:

```
node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.220_@anthropic-ai+sdk@0.115.0_zod@3.25.76__@modelcontextpr_icleo3jlyzp4ofvat73biynyvm/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
```

`package.json` for the package: `"main": "sdk.mjs"`, `"types": "sdk.d.ts"`. That file (306 KB, ~7150
lines) is the entry point resolved by `import { query } from '@anthropic-ai/claude-agent-sdk'` and is
the sole authority below — no other doc, memory, or training-data recollection was used.

The peer package `@anthropic-ai/sdk` is pinned to `0.115.0` (via the pnpm dependency-key suffix) and
supplies `MessageParam`, `BetaMessage`, `BetaContentBlock`, etc. that the agent SDK re-exports/uses by
reference. Its own `.d.ts` (under
`node_modules/.pnpm/@anthropic-ai+sdk@0.115.0_zod@3.25.76/node_modules/@anthropic-ai/sdk/resources/...`)
was read directly wherever `sdk.d.ts` deferred to it (assistant content blocks, `MessageParam`).

---

## query()

```ts
export declare function query(_params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
}): Query;
```

`prompt` **does** accept `string` or `AsyncIterable<SDKUserMessage>` — confirms the plan's assumption.
`Query` is not a plain `AsyncGenerator` — it is a named interface that *extends*
`AsyncGenerator<SDKMessage, void>` and adds many control methods:

```ts
export declare interface Query extends AsyncGenerator<SDKMessage, void> {
    interrupt(): Promise<SDKControlInterruptResponse | undefined>;
    setPermissionMode(mode: PermissionMode): Promise<void>;
    setMcpPermissionModeOverride(serverName: string, mode: 'default' | 'auto' | null): Promise<{ warning?: string }>;
    setModel(model?: string): Promise<void>;
    setMaxThinkingTokens(maxThinkingTokens: number | null, thinkingDisplay?: 'summarized' | 'omitted' | null): Promise<void>; // @deprecated — use `thinking` option
    applyFlagSettings(settings: { [K in keyof Settings]?: ... }): Promise<void>;
    initializationResult(): Promise<SDKControlInitializeResponse>;
    reinitialize(): Promise<SDKControlInitializeResponse>;
    supportedCommands(): Promise<SlashCommand[]>;
    supportedModels(): Promise<ModelInfo[]>;
    supportedAgents(): Promise<AgentInfo[]>;
    mcpServerStatus(): Promise<McpServerStatus[]>;
    getContextUsage(): Promise<SDKControlGetContextUsageResponse>;
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<SDKControlGetUsageResponse>;
    readFile(path: string, options?: { maxBytes?: number; encoding?: 'utf-8' | 'base64' }): Promise<SDKControlReadFileResponse | null>;
    reloadPlugins(): Promise<SDKControlReloadPluginsResponse>;
    reloadSkills(): Promise<SDKControlReloadSkillsResponse>;
    accountInfo(): Promise<AccountInfo>;
    rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;
    seedReadState(path: string, mtime: number): Promise<void>;
    reconnectMcpServer(serverName: string): Promise<void>;
    toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
    setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
    streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
    stopTask(taskId: string): Promise<void>;
    backgroundTasks(toolUseId?: string): Promise<boolean>;
    close(): void;
}
```

All the control-request methods (`interrupt`, `setPermissionMode`, `setModel`, `setMcpPermissionModeOverride`,
`applyFlagSettings`, `setMaxThinkingTokens`, `setMcpServers`, `streamInput`, `stopTask`,
`backgroundTasks`) are explicitly documented as **"only supported when streaming input/output is
used"** — i.e. only when `prompt` was passed as an `AsyncIterable`, not a plain `string`. `close()` is
unconditional: "forcefully ends the query, cleaning up all resources including pending requests, MCP
transports, and the CLI subprocess."

`mcpServerStatus()` and `supportedModels()` both exist exactly as the plan assumed.

---

## Streaming input

`prompt: string | AsyncIterable<SDKUserMessage>` — confirmed. The exact shape you must yield:

```ts
export declare type SDKUserMessage = {
    type: 'user';                              // required
    message: MessageParam;                     // required — from @anthropic-ai/sdk/resources
    parent_tool_use_id: string | null;          // required
    isSynthetic?: boolean;
    tool_use_result?: unknown;
    priority?: 'now' | 'next' | 'later';
    origin?: SDKMessageOrigin;
    shouldQuery?: boolean;                      // if false, appended to transcript without triggering a turn
    timestamp?: string;                         // ISO
    uuid?: UUID;                                // optional
    session_id?: string;                        // optional
    subagent_type?: string;
    task_description?: string;
};
```

`MessageParam` (peer `@anthropic-ai/sdk`, `resources/messages/messages.d.ts`):

```ts
export interface MessageParam {
    content: string | Array<ContentBlockParam>;
    role: 'user' | 'assistant' | 'system';
}
```

So the minimal object to yield is:

```ts
{
  type: 'user',
  message: { role: 'user', content: 'text or ContentBlockParam[]' },
  parent_tool_use_id: null,
}
```

**Both `session_id` and `uuid` are optional on the input side** — you do NOT need to know/set the
session id to stream a user turn; the CLI subprocess assigns/reconciles it. (Contrast with the
*emitted* `SDKAssistantMessage`/`SDKResultMessage`/etc., where `session_id` and `uuid` are required —
see below.)

There is also `SDKUserMessageReplay` (same shape, used for replaying persisted history) — not
something you construct for a live turn.

---

## Message union (`SDKMessage`)

```ts
export declare type SDKMessage =
    SDKAssistantMessage | SDKUserMessage | SDKUserMessageReplay | SDKResultMessage
  | SDKSystemMessage | SDKPartialAssistantMessage | SDKCompactBoundaryMessage | SDKStatusMessage
  | SDKAPIRetryMessage | SDKControlRequestProgressMessage | SDKModelRefusalFallbackMessage
  | SDKModelRefusalNoFallbackMessage | SDKLocalCommandOutputMessage | SDKHookStartedMessage
  | SDKHookProgressMessage | SDKHookResponseMessage | SDKPluginInstallMessage
  | SDKToolProgressMessage | SDKAuthStatusMessage | SDKTaskNotificationMessage
  | SDKTaskStartedMessage | SDKTaskUpdatedMessage | SDKTaskProgressMessage
  | SDKBackgroundTasksChangedMessage | SDKThinkingTokensMessage | SDKSessionStateChangedMessage
  | SDKWorkerShuttingDownMessage | SDKCommandsChangedMessage | SDKNotificationMessage
  | SDKFilesPersistedEvent | SDKToolUseSummaryMessage | SDKMemoryRecallMessage
  | SDKRateLimitEvent | SDKElicitationCompleteMessage | SDKPermissionDeniedMessage
  | SDKPromptSuggestionMessage | SDKMirrorErrorMessage | SDKInformationalMessage
  | SDKConversationResetMessage;
```

~38 variants total. The discriminant is `type`, and for `type: 'system'` there's a second-level
`subtype` discriminant (init, status, compact_boundary, task_notification, task_progress,
task_started, permission_denied, plugin_install, background_tasks_changed, session_state_changed,
…). Only the ones relevant to Task 9 (executor plumbing) are detailed below; the rest are
operational/telemetry variants (hooks, tasks, plugins, rate limits, prompt suggestions).

### `system` / `init` — carries `session_id`

```ts
export declare type SDKSystemMessage = {
    type: 'system';
    subtype: 'init';                 // exact subtype value
    agents?: string[];
    apiKeySource: ApiKeySource;       // 'user' | 'project' | 'org' | 'temporary' | 'oauth'
    betas?: string[];
    claude_code_version: string;
    cwd: string;
    tools: string[];
    mcp_servers: { name: string; status: string }[];
    model: string;
    permissionMode: PermissionMode;
    slash_commands: string[];
    output_style: string;
    skills: string[];
    plugins: { name: string; path: string; version?: string }[];
    fast_mode_state?: FastModeState;
    fast_mode_disabled_reason?: FastModeDisabledReason;
    capabilities?: string[];          // e.g. 'interrupt_receipt_v1', 'interrupt_cancel_queued_v1'
    uuid: UUID;
    session_id: string;               // <-- session id is here
};
```

Confirms the plan's assumption: the init/system message carries `session_id`, discriminated by
`type: 'system'` + `subtype: 'init'` (not just `type: 'system'` alone — many other system subtypes
exist, see list above).

### `assistant` — text/thinking/tool_use arrive as nested content blocks

```ts
export declare type SDKAssistantMessage = {
    type: 'assistant';
    message: BetaMessage;             // from @anthropic-ai/sdk/resources/beta/messages
    parent_tool_use_id: string | null;
    error?: SDKAssistantMessageError; // 'authentication_failed' | 'oauth_org_not_allowed' | 'billing_error'
                                       // | 'rate_limit' | 'overloaded' | 'invalid_request'
                                       // | 'model_not_found' | 'server_error' | 'unknown' | 'max_output_tokens'
    uuid: UUID;
    session_id: string;
    request_id?: string;
    resumed_from_incomplete_thinking?: true;
    supersedes?: UUID[];              // refusal-fallback supersede: uuids this message replaces
    aborted?: true;                   // truncated by interrupt/abort mid-stream
    subagent_type?: string;
    task_description?: string;
    timestamp?: string;
};
```

`message: BetaMessage` (peer `@anthropic-ai/sdk`, `resources/beta/messages/messages.d.ts`):

```ts
export interface BetaMessage {
    id: string;
    container: BetaContainer | null;
    content: Array<BetaContentBlock>;   // <-- the nested blocks
    context_management: BetaContextManagementResponse | null;
    diagnostics: BetaDiagnostics | null;
    model: MessagesAPI.Model;
    role: 'assistant';
    // ...stop_reason, stop_sequence, usage, etc. (not fully enumerated here — see SDK types)
}

export type BetaContentBlock =
    BetaTextBlock | BetaThinkingBlock | BetaRedactedThinkingBlock | BetaToolUseBlock
  | BetaServerToolUseBlock | BetaWebSearchToolResultBlock | BetaWebFetchToolResultBlock
  | BetaAdvisorToolResultBlock | BetaCodeExecutionToolResultBlock
  | BetaBashCodeExecutionToolResultBlock | BetaTextEditorCodeExecutionToolResultBlock
  | BetaToolSearchToolResultBlock | BetaMCPToolUseBlock | BetaMCPToolResultBlock
  | BetaContainerUploadBlock | BetaCompactionBlock | BetaFallbackBlock;

export interface BetaTextBlock     { type: 'text';     text: string; citations: Array<BetaTextCitation> | null; }
export interface BetaThinkingBlock { type: 'thinking';  thinking: string; signature: string; }
export interface BetaToolUseBlock  { type: 'tool_use';  id: string; name: string; input: unknown; caller?: ...; }
```

Confirms the plan's assumption exactly: `message.content[]` blocks with discriminant `type` of
`'text' | 'thinking' | 'tool_use'` (plus many more server-tool/MCP block types not in the plan's
scope). Field names (`text`, `thinking`, `id`/`name`/`input` for tool_use) match the plan.

### `stream_event` — partial/streaming deltas (gated by `includePartialMessages`)

```ts
export declare type SDKPartialAssistantMessage = {
    type: 'stream_event';
    event: BetaRawMessageStreamEvent;   // union: MessageStart|MessageDelta|MessageStop|ContentBlockStart|ContentBlockDelta|ContentBlockStop
    parent_tool_use_id: string | null;
    uuid: UUID;
    session_id: string;
    ttft_ms?: number;
};
```

Confirmed: partial/streaming deltas exist as a distinct message type `'stream_event'`, and are only
emitted when `Options.includePartialMessages` is `true` — exact flag name matches the plan's
assumption (`includePartialMessages`).

### `result` — exact fields, `subtype` values

```ts
export declare type SDKResultMessage = SDKResultSuccess | SDKResultError;

export declare type SDKResultSuccess = {
    type: 'result';
    subtype: 'success';
    duration_ms: number;
    duration_api_ms: number;
    ttft_ms?: number;
    is_error: boolean;
    api_error_status?: number | null;
    num_turns: number;
    result: string;
    stop_reason: string | null;
    total_cost_usd: number;                       // <-- confirmed, exact name
    usage: NonNullableUsage;                       // { [K in keyof BetaUsage]: NonNullable<BetaUsage[K]> }
    modelUsage: Record<string, ModelUsage>;        // per-model cost/token breakdown (see below)
    permission_denials: SDKPermissionDenial[];
    structured_output?: unknown;
    deferred_tool_use?: SDKDeferredToolUse;
    terminal_reason?: TerminalReason;
    fast_mode_state?: FastModeState;
    fast_mode_disabled_reason?: FastModeDisabledReason;
    origin?: SDKMessageOrigin;
    uuid: UUID;
    session_id: string;
};

export declare type SDKResultError = {
    type: 'result';
    subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
    duration_ms: number;
    duration_api_ms: number;
    is_error: boolean;
    num_turns: number;
    stop_reason: string | null;
    total_cost_usd: number;
    usage: NonNullableUsage;
    modelUsage: Record<string, ModelUsage>;
    permission_denials: SDKPermissionDenial[];
    errors: string[];
    terminal_reason?: TerminalReason;
    fast_mode_state?: FastModeState;
    fast_mode_disabled_reason?: FastModeDisabledReason;
    origin?: SDKMessageOrigin;
    uuid: UUID;
    session_id: string;
};
```

Confirms the plan's assumption exactly: `result` has `total_cost_usd`, `is_error`, `num_turns`. Four
error subtypes exist beyond `'success'`. `usage` is `NonNullableUsage` (all fields of the peer SDK's
`BetaUsage`, non-nullable) — not a bespoke shape. `modelUsage` gives a **per-model** breakdown
(`ModelUsage`: `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`,
`webSearchRequests`, `costUSD`, `contextWindow`, `maxOutputTokens`, `canonicalModel?`, `provider?`) —
useful if Task 9 needs per-model cost attribution instead of just the aggregate `total_cost_usd`.

`TerminalReason` (why the loop ended) is a large enum: `'blocking_limit' | 'rapid_refill_breaker' |
'prompt_too_long' | 'image_error' | 'model_error' | 'api_error' | 'malformed_tool_use_exhausted' |
'aborted_streaming' | 'aborted_tools' | 'stop_hook_prevented' | 'hook_stopped' | 'tool_deferred' |
'max_turns' | 'background_requested' | 'completed' | 'budget_exhausted' |
'structured_output_retry_exhausted' | 'tool_deferred_unavailable' | 'turn_setup_failed'`.

### Other notable variants

| Variant | subtype | Notes |
|---|---|---|
| `SDKStatusMessage` | `'status'` | `status: 'compacting' \| 'requesting' \| null`, `permissionMode?`, `compact_result?` |
| `SDKCompactBoundaryMessage` | `'compact_boundary'` | `compact_metadata: { trigger: 'manual'\|'auto', pre_tokens, post_tokens?, ... }` |
| `SDKPermissionDeniedMessage` | `'permission_denied'` | Auto-deny without a prompt (classifier/dontAsk/rule) — separate from the interactive `canUseTool` "ask" path |
| `SDKTaskNotificationMessage` / `SDKTaskStartedMessage` / `SDKTaskProgressMessage` | `'task_notification'` / `'task_started'` / `'task_progress'` | Background task (Bash/subagent) lifecycle |
| `SDKSessionStateChangedMessage` | `'session_state_changed'` | `state: 'idle' \| 'running' \| 'requires_action'` |
| `SDKRateLimitEvent` | (top-level `type: 'rate_limit_event'`, no subtype) | claude.ai plan rate-limit windows |

---

## Options

Full type at `sdk.d.ts` line 1322 (`export declare type Options = { ... }`). Every property the task
asked about, verbatim:

| Option | Exact name | Type | Notes |
|---|---|---|---|
| cwd | `cwd` | `string?` | Defaults to `process.cwd()` |
| resume | `resume` | `string?` | Session ID to resume; loads history |
| forkSession | `forkSession` | `boolean?` | With `resume`: fork to a new session ID instead of continuing |
| model | `model` | `string?` | e.g. `'claude-sonnet-5'`, `'claude-opus-4-8'`, `'claude-fable-5'` |
| permissionMode | `permissionMode` | `PermissionMode?` | `'default' \| 'acceptEdits' \| 'bypassPermissions' \| 'plan' \| 'dontAsk' \| 'auto'` |
| allowedTools | `allowedTools` | `string[]?` | Auto-allow list; passing `'Skill'` is deprecated |
| disallowedTools | `disallowedTools` | `string[]?` | Removed from model context entirely |
| canUseTool | `canUseTool` | `CanUseTool` (see below) | Custom permission handler |
| mcpServers | `mcpServers` | `Record<string, McpServerConfig>?` | stdio / sse / http / sdk-in-process configs |
| env | `env` | `{ [envVar: string]: string \| undefined }?` | **Replaces** subprocess env entirely — does NOT merge with `process.env` (see Auth section) |
| systemPrompt | `systemPrompt` | `string \| string[] \| { type: 'preset'; preset: 'claude_code'; append?: string; excludeDynamicSections?: boolean }?` | No separate `appendSystemPrompt` field — append lives inside the preset-object form |
| settingSources | `settingSources` | `SettingSource[]?` | `'user' \| 'project' \| 'local'`; omit = load all (CLI default); `[]` = SDK isolation mode |
| agents | `agents` | `Record<string, AgentDefinition>?` | Programmatic subagent definitions |
| hooks | `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>?` | |
| maxTurns | `maxTurns` | `number?` | Max conversation turns |
| abortController | `abortController` | `AbortController?` | Aborting stops query + cleans up resources |
| stderr | `stderr` | `(data: string) => void` | Callback for subprocess stderr |
| executable | `executable` | `'bun' \| 'deno' \| 'node'` | JS runtime; auto-detected if omitted |
| pathToClaudeCodeExecutable | `pathToClaudeCodeExecutable` | `string?` | Overrides built-in executable path |
| includePartialMessages | `includePartialMessages` | `boolean?` | Emits `SDKPartialAssistantMessage` (`type: 'stream_event'`) |
| maxThinkingTokens | `maxThinkingTokens` | `number?` | **Deprecated** — use `thinking` instead |
| effort | `effort` | `EffortLevel?` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` |

Additional Options fields not explicitly asked for but relevant to Task 9: `additionalDirectories`,
`agent` (main-thread agent name), `toolAliases`, `tools` (base built-in tool set —
`string[] \| { type: 'preset'; preset: 'claude_code' }`), `extraArgs`, `fallbackModel`,
`enableFileCheckpointing`, `toolConfig`, `betas` (`SdkBeta[]`, currently only
`'context-1m-2025-08-07'`), `onElicitation`, `onUserDialog` + `supportedDialogKinds`,
`persistSession`, `sessionStore` + `sessionStoreFlush` + `loadTimeoutMs` (alpha, external
transcript-mirroring adapter), `includeHookEvents`, `forwardSubagentText`, `thinking`
(`ThinkingConfig`, see below), `maxBudgetUsd`, `taskBudget` (alpha, `{ total: number }`),
`outputFormat` (`{ type: 'json_schema'; schema: Record<string, unknown> }`),
`planModeInstructions`, `allowDangerouslySkipPermissions` (required alongside
`permissionMode: 'bypassPermissions'`), `permissionPromptToolName`, `plugins`
(`SdkPluginConfig[]`), `promptSuggestions`, `agentProgressSummaries`, `sessionId`,
`resumeSessionAt`, `sandbox` (`SandboxSettings`), `settings` (path or inline `Settings`
object — flag-tier layer), `managedSettings`, `skills` (`string[] \| 'all'`), `debug` /
`debugFile`, `strictMcpConfig`, `title`, `spawnClaudeCodeProcess` (custom process spawner
for VM/container execution).

### `thinking` — `ThinkingConfig`

```ts
export declare type ThinkingConfig = ThinkingAdaptive | ThinkingEnabled | ThinkingDisabled;
export declare type ThinkingAdaptive  = { type: 'adaptive'; display?: 'summarized' | 'omitted'; };
export declare type ThinkingEnabled   = { type: 'enabled'; budgetTokens?: number; display?: 'summarized' | 'omitted'; };
export declare type ThinkingDisabled  = { type: 'disabled'; };
```

### `canUseTool` — exact signature and return type

```ts
export declare type CanUseTool = (
    toolName: string,
    input: Record<string, unknown>,
    options: {
        signal: AbortSignal;
        suggestions?: PermissionUpdate[];
        blockedPath?: string;
        decisionReason?: string;
        title?: string;
        displayName?: string;
        description?: string;
        toolUseID: string;
        agentID?: string;
        requestId: string;
        matchedAskRule?: { source: string; toolName: string; ruleContent?: string };
    }
) => Promise<PermissionResult | null>;
```

`PermissionResult` — the exact allow/deny discriminated union:

```ts
export declare type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification; // 'user_temporary' | 'user_permanent' | 'user_reject'
    }
  | {
      behavior: 'deny';
      message: string;                 // required on deny
      interrupt?: boolean;
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification;
    };
```

Returning `null` from `canUseTool` is valid (falls through to default handling).

### `permissionMode` allowed values

```ts
export declare type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
```

Six values — `'dontAsk'` and `'auto'` are not in most people's mental model of the older SDK
(`default`/`acceptEdits`/`bypassPermissions`/`plan` only). `'auto'` routes through a model classifier;
`'dontAsk'` denies anything not pre-approved instead of prompting.

### `mcpServers` value union

```ts
export declare type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig | McpSdkServerConfigWithInstance;

export declare type McpStdioServerConfig = { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; timeout?: number; /* ... */ };
export declare type McpSSEServerConfig  = { type: 'sse';  url: string; headers?: Record<string, string>; tools?: McpServerToolPolicy[]; timeout?: number; alwaysLoad?: boolean; };
export declare type McpHttpServerConfig = { type: 'http'; url: string; headers?: Record<string, string>; tools?: McpServerToolPolicy[]; timeout?: number; alwaysLoad?: boolean; };
export declare type McpSdkServerConfig  = { type: 'sdk';  name: string; };
export declare type McpSdkServerConfigWithInstance = McpSdkServerConfig & { instance: McpServer }; // in-process
```

---

## Session id & resume

- **Learning the session id of a new session**: read `SDKSystemMessage.session_id` (the first message
  in the stream, `type: 'system'`, `subtype: 'init'`). Every subsequent `SDKMessage` variant also
  carries `session_id` (it's on essentially all of them, required on assistant/result/system,
  optional on the input-side `SDKUserMessage`).
- **Resuming**: `Options.resume: string` (the session UUID). `Options.forkSession: boolean` — when
  `true`, a resumed session forks to a **new** session ID instead of continuing the original.
  `Options.resumeSessionAt: string` — resume but replay history only up to (and including) a given
  message UUID (from `SDKAssistantMessage.uuid`). `Options.sessionId: string` lets you pin a specific
  UUID for a *new* session (mutually exclusive with `continue`/`resume` unless `forkSession` is also
  set). `Options.continue: boolean` continues the most recent conversation in `cwd` (mutually
  exclusive with `resume`).
- **Session management helpers** (top-level exports, not on `Query`):
  - `listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>` — `{ dir?, limit?,
    offset?, includeWorktrees?, includeProgrammatic? }`. `SDKSessionInfo`: `sessionId`, `summary`,
    `lastModified`, `fileSize?`, `customTitle?`, `firstPrompt?`, `gitBranch?`, `cwd?`, `tag?`,
    `createdAt?`.
  - `getSessionInfo(sessionId, options?: GetSessionInfoOptions): Promise<SDKSessionInfo | undefined>`
  - `getSessionMessages(sessionId, options?: GetSessionMessagesOptions): Promise<SessionMessage[]>` —
    parses the JSONL transcript, follows `parentUuid` links, returns chronological user/assistant
    messages (`includeSystemMessages?: boolean` to also get system messages).
  - `getSubagentMessages(sessionId, agentId, options?): Promise<SessionMessage[]>`
  - `forkSession(sessionId, options?: ForkSessionOptions): Promise<ForkSessionResult>` —
    `{ upToMessageId?, title? }` → `{ sessionId: string }` (new UUID, resumable via
    `query({ options: { resume: sessionId } })`).
  - `renameSession(sessionId, title, options?): Promise<void>`
  - `deleteSession(sessionId, options?): Promise<void>`

  All of these accept an optional `sessionStore` (alpha) to redirect from local
  `~/.claude/projects/` JSONL files to an external store (`SessionStore` adapter interface with
  `save`/`load`/`delete`/`listSubkeys`-shaped methods — see `Options.sessionStore`).

---

## Interrupt

**Both mechanisms exist, at different layers:**

1. **`query.interrupt(): Promise<SDKControlInterruptResponse | undefined>`** — a method on the
   returned `Query` object. Only works in streaming-input mode (per the doc comment on every control
   method). On CLIs advertising the `interrupt_receipt_v1` capability (see `SDKSystemMessage.capabilities`)
   it resolves to a receipt object:
   ```ts
   export declare type SDKControlInterruptResponse = {
       still_queued: string[];   // uuids of async user messages that will still run unless cancelled
       cancelled?: string[];     // present only if the request set cancel_queued: true
   };
   ```
   Older CLIs resolve to `undefined`.
2. **`Options.abortController: AbortController`** — pass your own controller; calling
   `.abort()` on it stops the query and cleans up resources (subprocess, MCP transports, pending
   requests). This works regardless of streaming vs. string-prompt mode.

`query.close(): void` is a third, more forceful option — "forcefully ends the query... After calling
close(), no further messages will be received." Use `close()` for a hard teardown, `interrupt()` for a
graceful mid-turn stop that leaves the session resumable, `abortController.abort()` when you need
cancellation without depending on streaming-input mode.

---

## Auth & config dir

- **`Options.env`**: "Environment variables for the Claude Code process. When set, this value
  REPLACES the subprocess environment entirely — it is **not merged** with `process.env`." If you set
  `env` and still want the subprocess to see `ANTHROPIC_API_KEY`, `PATH`, `HOME`, etc., you must spread
  `process.env` yourself: `env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'my-app/1.0.0' }`. This
  directly answers "is `env` passed through" — **yes, but as a full replacement, not a merge**, which
  is a real footgun for Task 9 if it sets `env` for any reason (e.g. to inject a marker var) without
  spreading `process.env` first.
- **`CLAUDE_AGENT_SDK_CLIENT_APP`** — the one SDK-documented env var for self-identifying in the
  User-Agent header.
- **`CLAUDE_CONFIG_DIR`** — mentioned twice in doc comments (for `sessionStore` and for session JSONL
  location): "the subprocess still writes to `CLAUDE_CONFIG_DIR` (set it to `/tmp` for ephemeral local
  copy)" and "Local-disk transcripts under `CLAUDE_CONFIG_DIR` are swept by the existing
  `cleanupPeriodDays` setting." **This is exactly the lever for multi-account/profile isolation**: set
  `env: { ...process.env, CLAUDE_CONFIG_DIR: '/path/per/account' }` per `query()` call to point each
  account/session at its own config/credentials directory, since `env` fully replaces the subprocess
  environment (see above) and `CLAUDE_CONFIG_DIR` is the directory the CLI reads its
  auth/settings/session-storage from.
- **No explicit `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` handling is defined in `sdk.d.ts` itself** —
  auth resolution happens inside the spawned CLI subprocess (same resolution chain as `claude` CLI:
  env vars → OAuth profile → managed settings), not in the SDK's TS types. The SDK surface only lets
  you control it indirectly via `env` (to set/unset those vars for the subprocess) and
  `pathToClaudeCodeExecutable` / `executable` (which binary/runtime spawns).
- **`AccountInfo`** (returned by `query.accountInfo()` and embedded in `SDKControlInitializeResponse.account`):
  ```ts
  export declare type AccountInfo = {
      email?: string;
      organization?: string;
      subscriptionType?: string;
      tokenSource?: string;
      apiKeySource?: string;
      apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws' | 'anthropicGoogleCloud' | 'mantle' | 'gateway';
  };
  export declare type ApiKeySource = 'user' | 'project' | 'org' | 'temporary' | 'oauth';
  ```
  `SDKSystemMessage.apiKeySource: ApiKeySource` is present on every init message — useful for
  Task 9 to log/verify which credential source is active per session without a separate call.

---

## In-process MCP

Both exported, exact signatures:

```ts
export declare function createSdkMcpServer(_options: CreateSdkMcpServerOptions): McpSdkServerConfigWithInstance;

declare type CreateSdkMcpServerOptions = {
    name: string;
    version?: string;
    instructions?: string;
    tools?: Array<SdkMcpToolDefinition<any>>;
    alwaysLoad?: boolean;   // all tools always in prompt, never deferred behind tool search
};

export declare function tool<Schema extends AnyZodRawShape>(
    _name: string,
    _description: string,
    _inputSchema: Schema,
    _handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
    _extras?: {
        annotations?: ToolAnnotations;
        searchHint?: string;
        alwaysLoad?: boolean;
    }
): SdkMcpToolDefinition<Schema>;
```

`tool()` takes a Zod raw shape (`AnyZodRawShape`) for `inputSchema` (the SDK's peer `zod` dependency is
pinned to `^4.0.0` per `package.json`; the type import in `sdk.d.ts` uses `zod/v4`). The handler
returns `CallToolResult` (from `@modelcontextprotocol/sdk/types.js`). Register the resulting
`McpSdkServerConfigWithInstance` under `Options.mcpServers: { myServer: createSdkMcpServer({...}) }` —
it is one variant of the `McpServerConfig` union (`type: 'sdk'` + `instance: McpServer`), so it's
"non-serializable" (contains a live object), unlike the stdio/sse/http variants.

Tool calls through an in-process server are bounded by `MCP_TOOL_TIMEOUT` (env var, ms; "effectively
unbounded by default").

### In-process MCP, verified in practice (M3a, `src/busTools.ts`)

Everything below was re-checked against the pinned 0.3.220 `.d.ts` **and** exercised at runtime
under `bun test` while building the factory bus's tool set. It is the part of the SDK the plan
called its biggest risk, so it is written down rather than re-derived.

- **Which resolution is ours.** `packages/server/node_modules/@anthropic-ai/claude-agent-sdk`
  symlinks to the **`zod@4.4.3`** variant in `node_modules/.pnpm` (a `zod@3.25.76` variant of the
  same version also exists in the store — do not read that one's types by mistake). The workspace's
  own `zod` is 4.x, and `AnyZodRawShape = ZodRawShape | ZodRawShape_2` (zod 3 *or* zod 4 raw shapes),
  so plain `import { z } from "zod"` shapes type-check and work.
- **`tool()` is a plain object factory.** It returns
  `{ name, description, inputSchema, handler, annotations?, _meta? }` and does no validation and no
  schema conversion. `searchHint`/`alwaysLoad` in `_extras` become `_meta['anthropic/searchHint']`
  and `_meta['anthropic/alwaysLoad']`.
- **`createSdkMcpServer()` returns `{ type: 'sdk', name, instance }`** where `instance` is an
  `McpServer` from `@modelcontextprotocol/sdk` (v1.30.0 here) with every tool already
  `registerTool`'d. `alwaysLoad: true` at the server level ORs into each tool's `_meta`. Tools are
  reachable in tests via the MCP SDK's private `instance._registeredTools` map, whose entries carry
  `handler` (**not** `callback` — `callback` is only a field of `RegisteredTool.update()`'s argument).
- **Input schema is a zod raw shape, not a zod object and not JSON Schema.** Pass
  `{ to_room: z.string(), kind: z.enum([...]) }`, never `z.object({...})`. `.describe()` on each field
  is what the model reads; the SDK explicitly copies a field's `description` across into the
  registered tool.
- **Validation happens in the MCP layer, above the handler.** `registerTool` validates the incoming
  arguments against `inputSchema` before the handler runs, so a handler called *directly* (from a
  test, or from any in-process caller) gets whatever it was handed. If the handler is meant to be
  callable directly, re-validate inside it — `busTools` does, with `z.object(shape).parse(raw)`, which
  additionally strips undeclared fields.
- **Handler return type.** `CallToolResult` is `{ content: [...], isError?: boolean, _meta?, ... }`
  and is an **open** object type (it carries an index signature), so a hand-written interface for it
  must include `[extra: string]: unknown` or it will not be assignable. `CallToolResult` itself lives
  in `@modelcontextprotocol/sdk/types.js` — a transitive dependency, not one we declare, so state the
  shape structurally instead of importing it.
- **A throwing handler is invisible to the agent.** Return
  `{ content: [{ type: "text", text }], isError: true }` instead: the model can read that and correct
  itself.
- **Tool names the model sees are namespaced**: `mcp__<serverName>__<toolName>`, e.g.
  `mcp__factory__factory_send` for server `factory` and tool `factory_send`. Anything that names
  tools (a room charter, an `allowedTools` entry, a `disallowedTools` entry) must use the full
  namespaced form.
- **`Options.mcpServers` is the exact field**, `Record<string, McpServerConfig>`; the `sdk` variant
  must be passed **by reference** (it holds a live `McpServer`). Our executor omits the field entirely
  when the record is empty, so a roomless session does not tell the CLI it has MCP servers.
- **`Query.setMcpServers()` / `toggleMcpServer()` / `reconnectMcpServer()`** exist for changing
  servers on a live query, but only in streaming-input mode. We do not use them: the tool set is
  per-session and baked in at `query()` time, and an autonomy switch already restarts the executor.

---

## How the SDK sources MCP servers (verified by probe, 2026-08-04)

The question this answers: **what MCP servers does a factory agent actually get, and which of them
can we control?** It was asked because obsidian / figma / computer-control were reported in a factory
agent's tool list, and the answer decides whether that is a hole we can close from our side.

### The sources, in the CLI the SDK spawns

| Source | Where it lives | Gated by |
|---|---|---|
| `Options.mcpServers` | passed by us, in-process (`type: 'sdk'`) or stdio/sse/http | nothing — always applied |
| user-scope servers | **`~/.claude.json`, top-level `mcpServers`** (this is where `claude mcp add -s user` writes) | `settingSources` excluding `'user'`, *empirically* — see the caveat below |
| project `.mcp.json` | `<cwd>/.mcp.json` | `settingSources` including `'project'`, **plus** the operator's per-project approval in `~/.claude.json` (`enabledMcpjsonServers` / `disabledMcpjsonServers`, or the `enableAllProjectMcpServers` setting) |
| plugin servers | `~/.claude/plugins/*` | `settingSources` including `'user'` |
| claude.ai connectors | the operator's claude.ai account | `settingSources` including `'user'`; also `disableClaudeAiConnectors` in any settings source |
| `agents` definitions | `Options.agents`, or agent frontmatter on disk | `strictMcpConfig` (for the on-disk ones) |

`Options.strictMcpConfig?: boolean` maps to the CLI's `--strict-mcp-config` and is documented as:
"Only use MCP servers passed via the `mcpServers` option (and servers declared by explicitly-passed
agent definitions in `agents`), ignoring all other MCP configurations: project `.mcp.json`, user
settings, plugins, and on-disk agent frontmatter — including subagent frontmatter MCP."

Related `Settings` keys, for completeness: `enableAllProjectMcpServers`, `enabledMcpjsonServers`,
`disabledMcpjsonServers`, `disableClaudeAiConnectors`, and the enterprise-tier
`allowedMcpServers` / `deniedMcpServers` (name / command / URL matchers; denylist wins). The
enterprise pair is only meaningfully settable by us through `Options.managedSettings`, which is
filtered restrictive-only and is dropped entirely if the machine already has an admin tier — so it is
not a lever we can rely on.

### What the probe actually showed

Method: build `busTools` exactly as `SessionManager` does, call `query()` with a prompt iterable that
yields one `shouldQuery: false` message (appended to the transcript **without** triggering a turn)
and then never yields again, read the `system`/`init` message's `mcp_servers` and `tools`, and close.
No prompt is ever sent to a model, so this costs no quota. On this machine the operator has five
user-scope servers in `~/.claude.json` (`mcp-video`, `figma-free`, `computer-control`,
`dictate-voice`, `obsidian`), two plugin servers and ~20 claude.ai connectors.

| Options | `mcp_servers` in the init message |
|---|---|
| `settingSources` omitted (the CLI default) | all 5 user servers + 2 plugin servers + ~20 claude.ai connectors + `factory` |
| `settingSources: ['project','local']` | `factory` only |
| same, `permissionMode: 'bypassPermissions'` | `factory` only |
| same, plus a `.mcp.json` in the cwd | `factory` + that server, at status **`pending`**, contributing **no tools** |
| same, plus `strictMcpConfig: true` | `factory` only |

Three things follow, and they are the reason this section exists:

1. **`settingSources: ['project','local']` already keeps the operator's personal servers out.** The
   reported leak does not reproduce against this SDK (0.3.220) with the options the executor passes.
   The likeliest explanation for the original observation is that the tool list inspected belonged to
   the *development* agent working on SuperFabric — which does run with obsidian, figma and
   computer-control — rather than to a factory agent.
2. **That exclusion was undocumented, and therefore not something to rely on.** `settingSources` is
   specified as controlling *filesystem settings files* (`settings.json` and friends), and user-scope
   MCP servers do not live in one — they live in `~/.claude.json`. The observed behaviour is what the
   CLI happens to do today. An isolation property must not rest on that, so the executor now sets
   `strictMcpConfig: true`, which is the documented flag for exactly this.
3. **A project `.mcp.json` is listed but not usable.** It reaches the init message at status
   `pending` and offers no tools, because approving a project MCP server is an interactive act
   recorded in the operator's `~/.claude.json`. So `strictMcpConfig` removes nothing that works
   today — it removes a name from a list.

### Consequences to remember

- **A room that needs its own MCP server gets it through `Options.mcpServers`**, i.e. SuperFabric
  decides and can show the operator what it decided. There is no room-level MCP configuration yet;
  when there is, this is the seam.
- **Servers we pass are trusted servers.** Anything in `Options.mcpServers` skips the CLI's approval
  flow. So a future "read the room's `.mcp.json` and pass it through" feature must answer the trust
  question itself — a cloned repository shipping a hostile `.mcp.json` is exactly what that approval
  flow exists for.
- **None of this is a sandbox.** `strictMcpConfig` decides what the *agent* is offered; it does not
  stop anything else on the machine, and the agent still runs as the operator with the operator's
  credentials and `~/.claude`. Real isolation is M4: a container per session and one
  `CLAUDE_CONFIG_DIR` per account.

---

## Implications for our ClaudeCodeExecutor

Verdicts on the plan draft's five load-bearing assumptions, all against this pinned 0.3.220 API:

1. **`query({prompt: asyncIterable, options: {...canUseTool...}})`** — **CONFIRMED.** Exact shape:
   `query(_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query`, and
   `Options.canUseTool?: CanUseTool` exists with the signature documented above.
2. **A `system` message carries `session_id`** — **CONFIRMED, but narrow the discriminant.** It's not
   just `type: 'system'` (there are ~15 system subtypes) — check `type === 'system' && subtype ===
   'init'` for `SDKSystemMessage`. `session_id: string` is required on it (and on almost every other
   variant too, so don't gate purely on the init message if you just need to tag outgoing events).
3. **Assistant messages have `message.content[]` blocks with `type: "text" | "thinking" | "tool_use"`**
   — **CONFIRMED**, field names match exactly (`text`, `thinking`, `id`/`name`/`input`). `message` is
   typed `BetaMessage` from the peer `@anthropic-ai/sdk`, not a bespoke SDK type — pull the content
   block types from there, not from the agent-sdk's own `.d.ts`, when building the discriminated
   union in code.
4. **`result` has `total_cost_usd`** — **CONFIRMED**, exact field name, on both `SDKResultSuccess` and
   `SDKResultError`. Also grab `is_error`, `num_turns`, `usage: NonNullableUsage`, and
   `modelUsage: Record<string, ModelUsage>` (per-model cost breakdown) while there — useful for
   accounting beyond the aggregate.
5. **`interrupt()` exists on the returned generator** — **CONFIRMED**, but it is one of many
   control methods on `Query` (which extends `AsyncGenerator`, it isn't a bare generator), and per the
   type's own doc comments it **only works in streaming-input mode** — i.e. it will silently be a
   no-op/reject if Task 9 ever calls `query()` with a plain `string` prompt instead of an
   `AsyncIterable`. Since our design needs mid-session interrupts, the executor must always drive
   `query()` with the async-iterable prompt form, never the string form, or interrupt won't be usable.
   `Options.abortController` is the other cancellation path and works in both prompt modes — worth
   wiring as a belt-and-suspenders hard-stop alongside `interrupt()`.

Concrete deltas the plan's draft executor should apply:

- **`Query` is not `AsyncGenerator<SDKMessage, void>` alone** — it's an interface with ~20 extra
  methods (`setPermissionMode`, `setModel`, `mcpServerStatus`, `supportedModels`,
  `initializationResult`, `close`, etc.). Type the executor's handle as the SDK's own `Query` type,
  not a hand-rolled `AsyncGenerator<SDKMessage>` alias, so these are available later without a second
  round of type surgery.
- **No separate `appendSystemPrompt` option exists.** The plan should use
  `systemPrompt: { type: 'preset', preset: 'claude_code', append: '...' }` instead of a bespoke
  top-level field.
- **`includePartialMessages: boolean`** is the real flag name for streaming deltas (confirmed) — wire
  it if Task 9 wants live token-by-token UI updates via `type: 'stream_event'` messages.
  `SDKPartialAssistantMessage.event` is `BetaRawMessageStreamEvent` from the peer SDK (message_start /
  content_block_delta / etc.) — reuse the peer SDK's streaming-accumulator patterns rather than
  building a new one.
- **`env` fully replaces the subprocess environment** rather than merging. Any executor code that
  sets `Options.env` for any reason (multi-account `CLAUDE_CONFIG_DIR`, telemetry markers, etc.) must
  spread `process.env` first or the spawned CLI will lose `PATH`/`HOME`/`ANTHROPIC_API_KEY`/etc. This
  is the exact mechanism to use for the planned multi-account work: one `CLAUDE_CONFIG_DIR` per
  account, injected via `env: { ...process.env, CLAUDE_CONFIG_DIR: perAccountDir }`.
- **`PermissionMode` has 6 values**, not 4 — `'dontAsk'` and `'auto'` exist alongside
  `default`/`acceptEdits`/`bypassPermissions`/`plan`. If Task 9's permission-mode type is a hand-typed
  union, it's currently missing two valid values.
- **`canUseTool`'s deny branch requires `message: string`** (not optional) while `allow` has no
  required fields beyond `behavior` — code that constructs a deny result must always supply a message.
- **Session id discovery does not require draining to the `result` message** — `session_id` arrives on
  the very first `system`/`init` message, so the executor can resolve/store the session id as soon as
  that message is seen, without waiting for the full turn to complete.
- **`mcpServerStatus()`, `supportedModels()`, `supportedAgents()`, `getContextUsage()`, and
  `accountInfo()`** are all real, working control methods worth exposing on our executor's public API
  surface for diagnostics/UI, not just the five things the plan called out.
