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
/**
 * Which agent CLI a session runs on.
 *
 * **Fixed when an agent is created and never changed afterwards**, unlike `autonomy`, `model`,
 * `account` and `role` — those are settings of one conversation, and this decides *whose* conversation
 * it is. `claude_session_id` is a provider-native handle: a thread Codex is holding cannot be resumed
 * by Claude Code, and pretending otherwise would produce an agent that silently forgot everything it
 * had been told. Changing providers means creating another agent, which is what the UI offers.
 *
 * A closed enum rather than a free string (unlike `model`): every value here has to have an
 * `Executor` implementation behind it, so an id we have never heard of is not a future release we
 * should accept — it is an agent that cannot start.
 */
export const AgentProvider = z.enum(["claude", "codex"]);
export type AgentProvider = z.infer<typeof AgentProvider>;

/** What an agent runs on when nobody chose: the provider this product was built around. */
export const DEFAULT_AGENT_PROVIDER: AgentProvider = "claude";

/**
 * One line per provider, for the picker. Kept next to the enum so adding a provider is one place.
 *
 * `bus` is the honest asterisk: the factory bus is an **in-process MCP server** built per session
 * (`busTools`), which the Agent SDK can take as an object and a separate CLI process cannot. Until a
 * bridge exists, a Codex agent works in its room but cannot talk to other rooms — said here, in the
 * picker, rather than discovered by an operator whose message went nowhere.
 */
export const AGENT_PROVIDERS: { id: AgentProvider; name: string; command: string; bus: boolean; summary: string }[] = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    bus: true,
    summary: "the Agent SDK: approval cards, the factory bus, container rooms, per-account subscriptions",
  },
  {
    id: "codex",
    name: "OpenAI Codex",
    command: "codex",
    bus: false,
    summary: "codex exec, one process per turn, resumed by thread id. No factory bus and no approval "
      + "cards yet — autonomy becomes its sandbox setting instead",
  },
];

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

/**
 * What a denied tool call tells the *agent*.
 *
 * The SDK requires a `message` on the deny branch of `canUseTool`, and it goes into the model's
 * context as the tool's result — so this string is part of the conversation, not a log line. Shared
 * because both hosts of a session produce it (the in-process executor and the containerised
 * `agent-runner`), and an agent that read two different explanations for the same refusal depending
 * on where it happened to be running would be a difference the operator never asked for.
 */
export const APPROVAL_DENIED_MESSAGE = "Denied by the SuperFabric operator.";

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

// ---- M2: accounts ----

/**
 * The file whose existence means a `CLAUDE_CONFIG_DIR` has been logged in.
 *
 * Named here rather than in the server because both sides talk about it: the server tests for it and
 * the UI explains it. On Linux the CLI writes the OAuth tokens to `<config dir>/.credentials.json`
 * with mode 0600 (see `docs/RESEARCH.md` §1); on macOS they may go to the keychain instead, which is
 * why `credentialsPresent` is a *hint that a login finished* and never the only signal the login flow
 * waits on.
 */
export const ACCOUNT_CREDENTIALS_FILE = ".credentials.json";

/**
 * The same fact, per provider: which file inside a config directory means "this one is logged in".
 *
 * Codex keeps its tokens in `auth.json` under `CODEX_HOME` rather than in a dotfile, so a single
 * constant stopped being enough the moment an account could belong to another CLI. One table, so the
 * server's check and the UI's explanation cannot drift apart.
 */
export const PROVIDER_CREDENTIALS_FILE: Record<AgentProvider, string> = {
  claude: ACCOUNT_CREDENTIALS_FILE,
  codex: "auth.json",
};

/**
 * Where each provider keeps its configuration when nobody has said otherwise, relative to `$HOME`.
 *
 * What "the ambient account" means for that CLI — the directory an unbound agent already runs on, and
 * the one the server adopts on first boot when it finds a login in it.
 */
export const PROVIDER_HOME_DIRNAME: Record<AgentProvider, string> = {
  claude: ".claude",
  codex: ".codex",
};

/**
 * Where an account's in-app login has got to.
 *
 * `claude auth login` is a plain-pipe conversation (no terminal emulator involved — see
 * `docs/decisions/0004-account-login-over-a-pipe.md`): it prints a URL, waits for the code the
 * operator gets from it, and exits. These are the four things the operator can be looking at while
 * that happens, plus `idle` for "nothing is running".
 */
export const AccountLoginStatus = z.enum(["idle", "starting", "awaiting_code", "finishing", "failed"]);
export type AccountLoginStatus = z.infer<typeof AccountLoginStatus>;

export const AccountLogin = z.object({
  status: AccountLoginStatus,
  /** The OAuth URL the CLI printed, once it has. This is what the operator opens. */
  url: z.string().nullable(),
  /** The CLI's own last word — an invalid code, a failure — shown verbatim rather than paraphrased. */
  message: z.string().nullable(),
});
export type AccountLogin = z.infer<typeof AccountLogin>;

/**
 * One Claude subscription, as a `CLAUDE_CONFIG_DIR` on disk plus a label.
 *
 * **Machine-wide, not per project.** A subscription belongs to the operator, not to a repository: the
 * same account runs agents on every floor, and a per-project table would make the operator re-create
 * (and re-log-in to) the same account for each one. Worse, it would put two rows on one config
 * directory, which is the exact thing the one-dir-one-account invariant forbids — refresh tokens
 * rewrite in place and two accounts sharing a directory corrupt each other. So accounts are listed
 * globally and *bound* per room and per agent, which is where the per-project choice actually lives.
 */
export const AccountInfo = z.object({
  id: z.string(),
  label: z.string().min(1).max(120),
  /**
   * Which CLI this account belongs to. Defaulted, so a row (or a client) written before providers
   * existed still reads as what it is.
   *
   * It decides the vocabulary for everything read out of `configDir`: the name of the credentials
   * file, and where the limits are and what shape they are in. An account cannot be moved between
   * providers for the same reason a session cannot — the directory holds one CLI's login.
   */
  provider: AgentProvider.default(DEFAULT_AGENT_PROVIDER),
  /**
   * Absolute path of this account's configuration directory — `CLAUDE_CONFIG_DIR` for Claude Code,
   * `CODEX_HOME` for Codex. Unique across the server, whichever provider wrote it.
   */
  configDir: z.string().min(1),
  /** The provider's credentials file exists in that directory — how the server knows a login finished. */
  credentialsPresent: z.boolean(),
  createdAt: z.number().int(),
  /** When an agent last started on this account; null until one has. */
  lastUsedAt: z.number().int().nullable(),
  login: AccountLogin,
});
export type AccountInfo = z.infer<typeof AccountInfo>;

// ---- M2: limits ----

/**
 * Where a usage reading came from, and therefore how much it can be trusted.
 *
 * - `endpoint` — Anthropic's own `GET /api/oauth/usage`, the same authoritative, cross-device
 *   numbers Claude Code's `/usage` shows. A percentage from here is a fact.
 * - `estimate` — counted from the account's local JSONL transcripts. It **cannot see other
 *   devices**, it does not know when the real window began, and the limits it is measured against
 *   are not published. A percentage from here is a guess, and every surface that shows one has to
 *   say so.
 */
export const UsageSource = z.enum(["endpoint", "estimate"]);
export type UsageSource = z.infer<typeof UsageSource>;

/**
 * One rate-limit window, as a meter.
 *
 * `key` is machine-stable and `label` is what a person reads, because the endpoint reports both
 * fixed windows (`five_hour`, `seven_day`) and per-model ones whose identity is a display name the
 * API chooses (`weekly_scoped` scoped to "Opus"). A closed enum here would mean a SuperFabric
 * release is required before a window Anthropic added this morning can be shown at all — the same
 * argument that makes `ModelId` a free string.
 */
export const UsageWindow = z.object({
  /** Stable id: `five_hour`, `seven_day`, `seven_day_opus`, or e.g. `weekly_scoped:Opus`. */
  key: z.string().min(1).max(120),
  /** What the meter is called on screen. */
  label: z.string().min(1).max(120),
  /** How full this window is, 0–100. */
  utilization: z.number().min(0).max(100),
  /** ISO-8601 instant the window rolls, or null when the source did not say. */
  resetsAt: z.string().nullable(),
  /**
   * One line of "where this number came from", when it is worth saying — the token count behind an
   * estimate, say. Null for the ordinary case, where the meter speaks for itself.
   */
  detail: z.string().max(200).nullable().default(null),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

/**
 * What is known about one account's limits right now.
 *
 * **Honesty is the whole design of this type.** `approximate` is not decoration: an estimate shown
 * as a fact is worse than an honest gap, because the operator would plan around it. `note` carries
 * the reason in the reader's own words whenever the primary source failed or returned a shape we
 * only partly recognised — the usage endpoint is undocumented and *will* change, and the failure
 * mode must be a visible degradation rather than a silent blank meter.
 */
export const AccountUsage = z.object({
  accountId: z.string(),
  source: UsageSource,
  /** These numbers are a guess. Every surface showing them must say so. */
  approximate: z.boolean(),
  /** The meters, in the order they should be read. Empty means "nothing is known yet". */
  windows: z.array(UsageWindow),
  /** Unix **seconds** this reading was taken; null when there has never been one. */
  readAt: z.number().int().nullable(),
  /** Why this reading is degraded, verbatim, or null when it is not. */
  note: z.string().max(500).nullable(),
  /**
   * This account is at its limit *now* — either a window reached 100, or a session on it was
   * answered with a 429 before the poller caught up. The second path is why this is a field rather
   * than something derived from `windows`: a limit error from a live session is the earliest and
   * most certain signal there is, and waiting up to three minutes to believe it would be silly.
   */
  limited: z.boolean(),
  /** ISO-8601 instant the limit is expected to lift, or null when nothing said when. */
  limitedUntil: z.string().nullable(),
  /**
   * *How* we know this account is at its limit, or null when it is not.
   *
   * The distinction is load-bearing rather than informational. `window` is a reading — and a reading
   * from the estimate is a guess, which must never be allowed to cut an agent off mid-thought.
   * `rate_limit_error` is the provider itself refusing a turn: not an estimate at all, and reason
   * enough to pause whatever the meters happen to say. The scheduler branches on exactly this, and
   * the UI says which so an operator is never left wondering why work stopped.
   */
  limitedBy: z.enum(["window", "rate_limit_error"]).nullable().default(null),
});
export type AccountUsage = z.infer<typeof AccountUsage>;

/**
 * The thresholds the scheduler acts on, as percentages of any one window.
 *
 * Shared rather than server-only because the UI marks the same lines on its meters: a bar that turns
 * amber at a different number from the one that actually warns the agents would be a lie drawn to
 * scale.
 */
export const LIMIT_WARN_PERCENT = 80;
export const LIMIT_PAUSE_PERCENT = 95;

/**
 * The floor under how often one account's usage may be read, in milliseconds.
 *
 * `docs/RESEARCH.md` §2: the endpoint is undocumented and aggressive polling earns a 429 — which
 * would be a monitor that causes the condition it exists to watch for. **Five minutes**, raised from
 * three after a real 429 on a developer's machine: a five-hour window does not move meaningfully in
 * either interval, so the only thing the faster one bought was requests.
 *
 * The floor is measured from the **timestamp of the reading we already hold**, not from an in-memory
 * counter, so it survives a restart. That is what actually earned the 429: `bun --watch` restarts the
 * server on every file save, and each restart used to poll immediately because the counter was empty.
 * A reading that is still fresh means no request is sent at all.
 */
export const USAGE_POLL_INTERVAL_MS = 300_000;

/**
 * How long to leave the usage endpoint alone after it has answered 429, in milliseconds.
 *
 * Longer than the ordinary floor, because a 429 is the endpoint saying *specifically* that we asked
 * too often — retrying on the normal cadence answers it with the same behaviour that caused it. Used
 * only when the response carries no `Retry-After`; when it does, that wins.
 */
export const USAGE_RATE_LIMIT_BACKOFF_MS = 900_000;


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

/**
 * Where a room's agents actually run.
 *
 * - `host` — in the server's own process tree, as the operator, with the operator's filesystem. What
 *   every room did before M4, and still the default: it is the fastest path, it needs no Docker, and
 *   on a machine the operator trusts it is a perfectly reasonable choice.
 * - `container` — one container per agent, holding only that room's folder and that account's
 *   credentials, capped on CPU, memory and processes, with default-deny egress.
 *
 * Per **room** rather than per session because it is a property of the work, not of one agent: a
 * department whose folder is worth sandboxing is worth sandboxing for everyone who stands in it. It
 * is read when an agent's executor starts, so — exactly like the room's folder and its account — an
 * agent already running keeps the runtime it started in until it is restarted.
 */
export const RoomRuntime = z.enum(["host", "container"]);
export type RoomRuntime = z.infer<typeof RoomRuntime>;

/** What a room runs on when nobody has chosen: the pre-M4 behaviour, unchanged. */
export const DEFAULT_ROOM_RUNTIME: RoomRuntime = "host";

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
  /**
   * The account new agents in this room start on, or null for the ambient `~/.claude`.
   *
   * A *default*, resolved once when an agent is created and then persisted on that agent: changing
   * it here never moves an agent that is already running, because a live session's environment is
   * fixed for the lifetime of its `query()`. See `SessionInfo.accountId`.
   */
  accountId: z.string().nullable().default(null),
  /**
   * Whether agents here run on the host or in a container. Defaults to `host`, so a room row written
   * before M4 — and a client built before it — reads the same as it always did.
   */
  runtime: RoomRuntime.default(DEFAULT_ROOM_RUNTIME),
});
export type RoomInfo = z.infer<typeof RoomInfo>;

// ---- M1c: roles ----

/**
 * A role's id: the filename-ish handle an operator types, and the value stored on a session row.
 *
 * Constrained like `RoomName` and for a weaker but real version of the same reason — a role is a file
 * (`roles/<id>.yaml`), and an id that cannot be a filename would make the library's own convention
 * unusable. It is not used to *build* a path (the loader reads whatever files are in the directory and
 * takes the id from inside them), so this is a legibility rule rather than a containment one.
 */
export const RoleId = z.string().min(1).max(64).regex(
  /^[a-z0-9][a-z0-9-]*$/,
  "lowercase letters, digits and dashes only; must start with a letter or digit",
);
export type RoleId = z.infer<typeof RoleId>;

/**
 * The name of a skill a role wants, which is the **directory name** it is installed under.
 *
 * A plain name rather than a pack-qualified one, because that is the mechanic: a skill lands in
 * `<room>/.claude/skills/<name>/` and Claude Code running in that folder finds it there. The server
 * resolves the name against the skill directories on the machine (see `SkillLibrary`), so a role can
 * only ever name a skill that someone has actually installed — and a name that resolves to nothing is
 * reported rather than silently doing nothing.
 */
export const RoleSkillName = z.string().min(1).max(64).regex(
  /^[a-z0-9][a-z0-9._-]*$/,
  "lowercase letters, digits, dot, dash and underscore only; must not start with a separator",
);

/**
 * An MCP server a role brings with it.
 *
 * The three *outside-facing* transports the SDK understands, and deliberately not the in-process
 * (`sdk`) one: that variant holds a live object, so it cannot come from a file — and the only
 * in-process server this product has is the factory bus, which every roomed agent gets anyway and
 * which a role can never take away (see `SessionManager.startExecutor`).
 *
 * Anything here is *trusted*: the SDK skips its approval flow for servers we pass. That is why the
 * shape is closed rather than a passthrough — an operator writing one of these into a role file is
 * making a decision, and it should look like one.
 */
export const RoleMcpServer = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  }).strict(),
  z.object({
    type: z.literal("http"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).default({}),
  }).strict(),
  z.object({
    type: z.literal("sse"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).default({}),
  }).strict(),
]);
export type RoleMcpServer = z.infer<typeof RoleMcpServer>;

/**
 * A role: what an agent arrives as, so an operator who does not know Claude Code's configuration
 * surface can still get an architect rather than a blank session.
 *
 * **`.strict()` is load-bearing.** A role is a file a human writes by hand, and the worst failure
 * available to a hand-written config file is a typo that parses: `skill:` instead of `skills:` would
 * silently ship a role with no skills and nothing anywhere would say so. An unknown field is an error
 * that names the file.
 *
 * Everything except `id`, `name`, `summary` and `promptAppend` is optional, and an absent field means
 * "this role has no opinion" — not a value. That is what lets an explicit operator choice beat a
 * preset: a role with no `model` cannot be the reason an agent is on the wrong one.
 */
export const RoleSpec = z.object({
  id: RoleId,
  /** What the picker shows. Title case, a couple of words. */
  name: z.string().min(1).max(60),
  /** One line of "why would I pick this one", shown beside the name. */
  summary: z.string().min(1).max(200),
  /**
   * The charter, appended to the agent's system prompt. A charter and not a manual: it says what the
   * role owns, what it must not do, and how it hands off. Every turn that agent ever takes pays for
   * this text, so length here is a tax rather than a service.
   */
  promptAppend: z.string().min(1).max(4000),
  /**
   * The model this role wants. **Absent means the role has no opinion**, and a model the operator
   * chose explicitly always wins over one a preset suggested.
   */
  model: ModelId.optional(),
  /** Skills to install into the agent's folder, by directory name. */
  skills: z.array(RoleSkillName).max(20).default([]),
  /**
   * Extra MCP servers, by name. Merged with the factory's own in-process bus, which is never
   * removed — a name collision loses to the factory, not the other way round.
   */
  mcpServers: z.record(z.string().min(1).max(64), RoleMcpServer).default({}),
  /**
   * Tool names this role pre-approves. The SDK's `allowedTools` is an **auto-allow list**, not a
   * restriction: an entry here is a privilege grant that skips the approval card, so MCP tools must
   * be written in the namespaced form the model actually sees (`mcp__<server>__<tool>`). None of the
   * shipped presets uses it; it is the operator's own extension point.
   */
  allowedTools: z.array(z.string().min(1).max(120)).max(50).default([]),
  /**
   * How much rope this role wants. Applied **only when an agent is created and the operator named
   * none** — picking a role on a live agent never changes what it is allowed to do, because a
   * privilege level that moves as a side effect of a dropdown is not one the operator chose.
   */
  autonomy: AutonomyMode.optional(),
}).strict();
export type RoleSpec = z.infer<typeof RoleSpec>;

/**
 * A role file that could not be loaded, named so the operator can go and fix it.
 *
 * Reported rather than skipped, and this type exists to make that possible on the wire: a preset that
 * silently vanished because of a stray tab is the failure mode a config format has to design against.
 */
export const RoleProblem = z.object({
  /** Absolute path of the file. */
  file: z.string(),
  /** What is wrong with it, in the parser's own words. */
  message: z.string(),
});
export type RoleProblem = z.infer<typeof RoleProblem>;

// ---- M1c: onboarding ----

/**
 * The file whose presence at a project's root means the project has been onboarded.
 *
 * **This is the whole detection rule, and it is deliberately the only one.** Not "the folder looks
 * empty", not "there are fewer than N files", not "no git history" — those are guesses about a
 * repository the operator knows far better than we do, and a factory that offers to interview
 * someone about a project they documented last year is a factory that has not read it. A missing
 * `CLAUDE.md` is a fact, it is the file the interview produces, and an operator who wants the offer
 * back can delete it.
 *
 * Named here rather than in the server because both sides talk about it: the server stats it and the
 * UI explains it.
 */
export const PROJECT_CHARTER_FILE = "CLAUDE.md";

/**
 * A room the onboarding agent thinks this project should have — **a proposal, not a room**.
 *
 * The agent cannot create rooms. It records these, the operator reads them, edits the names it
 * disagrees with and approves the ones it wants; only then does the ordinary `createRoom` path run,
 * with every invariant it already has (name safety, containment, never overwriting a charter). A
 * factory that reorganised itself on the say-so of an interview is not what anyone wants on first
 * contact — so the suggestion is a durable row with a status rather than a side effect.
 */
export const RoomSuggestionStatus = z.enum(["proposed", "accepted", "dismissed"]);
export type RoomSuggestionStatus = z.infer<typeof RoomSuggestionStatus>;

export const RoomSuggestion = z.object({
  id: z.string(),
  projectId: z.string(),
  /** The folder this room would become. A `RoomName`, because that is what it has to survive being. */
  name: RoomName,
  /** One line: what this department would own. Goes into the new room's charter as its first line. */
  charter: z.string().min(1).max(300),
  status: RoomSuggestionStatus,
  /**
   * Why this one is not on the floor, when accepting it failed — the `createRoom` error, verbatim.
   * A suggestion that could not be created stays `proposed` with this set, so the operator can fix
   * the name and try again rather than watching one of five rooms silently not appear.
   */
  note: z.string().max(300).nullable().default(null),
  createdAt: z.number().int(),
});
export type RoomSuggestion = z.infer<typeof RoomSuggestion>;

/**
 * Where one project stands with onboarding: whether it has been done, who is doing it, and what the
 * interview has proposed so far.
 *
 * One message for the whole feature rather than a field bolted onto `ProjectInfo`, because it changes
 * for reasons a project listing never does — an agent writing a file, a tool recording a proposal —
 * and because the UI shows all three facts in one place or none of them.
 */
export const OnboardingState = z.object({
  projectId: z.string(),
  /** `CLAUDE.md` exists at the project root. See `PROJECT_CHARTER_FILE`. */
  onboarded: z.boolean(),
  /** The onboarding agent, while one is running. Null when none is. */
  sessionId: z.string().nullable(),
  /** Every proposal this project has, newest last. Accepted and dismissed ones stay for the record. */
  suggestions: z.array(RoomSuggestion),
});
export type OnboardingState = z.infer<typeof OnboardingState>;

/** How many rooms one `factory_suggest_rooms` call may propose. A first cut, not a department chart. */
export const MAX_ROOM_SUGGESTIONS = 12;

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

// ---- M3b: the chronicle ----

/**
 * One hit from the project's chronicle: enough to act on without opening anything.
 *
 * The chronicle spans two sources at once — the decisions someone wrote down, and what agents
 * actually said at the time — and a hit says which it is, because they carry different authority. A
 * `decision` is reasoning that was committed to a file in the repository (`path`); an `event` is a
 * line from a session's log, which is evidence rather than a ruling.
 *
 * The shape is the server's `Chronicle.search` result, declared here so the two cannot drift: the
 * server imports this type rather than describing the same fields a second time.
 */
export const ChronicleHit = z.object({
  kind: z.enum(["decision", "event"]),
  /** The decision's title, or the event's type. */
  title: z.string(),
  /** The matching part of the body, with an ellipsis where it was cut. */
  snippet: z.string(),
  /** Unix **seconds** — the resolution the chronicle's own timestamps have. */
  createdAt: z.number().int(),
  /** Decision id, or the session id whose log this came from. */
  ref: z.string(),
  /** Event seq within that session's log; 0 for a decision. */
  seq: z.number().int(),
  roomId: z.string().nullable(),
  /** Absolute path of the ADR file, for a decision. `null` for an event, which has no file. */
  path: z.string().nullable(),
});
export type ChronicleHit = z.infer<typeof ChronicleHit>;

/** How many hits a chronicle search answers with when the client does not say. */
export const CHRONICLE_SEARCH_LIMIT = 10;

// ---- M5: burn rate and cost ----

/**
 * How fast one account is spending its quota, and therefore how long it has left.
 *
 * **The number an operator acts on is `secondsToLimit`** — "at this rate you have about two hours" —
 * not a token total. Everything else on this type exists to say how much that projection is worth.
 *
 * It is computed from `usage_snapshots`, i.e. from **real utilisation history** read from Anthropic's
 * own endpoint, not from a cost model and not from a pricing table. That is what makes it a
 * measurement rather than an arithmetic exercise: two readings of the same window, minutes apart, are
 * a rate.
 *
 * **A projection nobody can make says so.** `secondsToLimit` is null and `unknown` carries the reason
 * in words whenever there is too little history, the readings span too little time, or utilisation is
 * not rising. A guess dressed as an hour figure would be worse than a blank, because the operator
 * would plan their afternoon around it.
 */
export const AccountBurn = z.object({
  accountId: z.string(),
  /**
   * The window this projection is about: the one that will be spent **soonest**, which is not always
   * the fullest one — a 5-hour window at 60 % and rising fast runs out before a weekly at 90 % that
   * has barely moved. Null when there is no projection.
   */
  windowKey: z.string().nullable(),
  windowLabel: z.string().nullable(),
  /** Percentage points per hour, from the least-squares slope of the readings. Null when unknown. */
  percentPerHour: z.number().nullable(),
  /**
   * Seconds from the newest reading until that window reaches the pause threshold
   * (`LIMIT_PAUSE_PERCENT`) at the current rate — the point at which the scheduler stops the agents,
   * which is what the operator actually cares about, not 100 %. Null when unknown. Zero when the
   * threshold is already reached.
   */
  secondsToLimit: z.number().int().nullable(),
  /**
   * The window rolls before this rate would exhaust it. Good news, and worth saying: an operator told
   * "two hours" would otherwise stop handing out work when in fact the quota refills first.
   */
  resetsFirst: z.boolean(),
  /**
   * The readings behind this rate were estimates, so the rate is one too. Carried separately from
   * `AccountUsage.approximate` because a projection can be built from a *mix* — one estimate anywhere
   * in the series is enough to mark the whole thing.
   */
  approximate: z.boolean(),
  /** How many readings the rate was computed from, and over how long. The projection's own footing. */
  samples: z.number().int().nonnegative(),
  spanSeconds: z.number().int().nonnegative(),
  /** Why there is no projection, in the operator's own words, or null when there is one. */
  unknown: z.string().nullable(),
});
export type AccountBurn = z.infer<typeof AccountBurn>;

/**
 * What some turns cost, as the provider reported it.
 *
 * **This is a cost-*equivalent*, and it is approximate for three separate reasons** — which is why
 * every surface showing it marks it, exactly as the limit meters mark an estimate:
 *
 * 1. On a subscription no money changes hands per turn. This is what the same work would have cost
 *    through the API, which is the only cost figure that exists.
 * 2. It is reconstructed from `turn_complete.costUsd`, which the CLI reports **cumulatively per
 *    `query()`** rather than per turn (see `packages/server/notes/agent-sdk-api.md`, "What
 *    `total_cost_usd` counts"), so a per-turn figure is a difference between consecutive readings.
 *    A turn whose result carried no cost contributes nothing.
 * 3. **No pricing table is involved anywhere.** SuperFabric never multiplies tokens by a rate — the
 *    number comes from Anthropic's own CLI. That is deliberate: a hard-coded per-model price would be
 *    wrong within weeks and there would be no way to tell.
 */
export const CostRollup = z.object({
  /** US dollars, summed from the provider's own figures. */
  usd: z.number().nonnegative(),
  /** Turns that reported a cost. Zero is "nothing was recorded", not "the work was free". */
  turns: z.number().int().nonnegative(),
});
export type CostRollup = z.infer<typeof CostRollup>;

/** The two windows the metrics surface shows. Fixed, because two numbers is what fits beside a meter. */
export const CostRollups = z.object({
  /** The last 24 hours. */
  day: CostRollup,
  /** The last 7 days, matching the weekly limit window's own shape. */
  week: CostRollup,
});
export type CostRollups = z.infer<typeof CostRollups>;

/** One account's metrics: the projection, and what its turns cost. */
export const AccountMetrics = z.object({
  accountId: z.string(),
  burn: AccountBurn,
  cost: CostRollups,
});
export type AccountMetrics = z.infer<typeof AccountMetrics>;

/** What one room's agents cost. The name is not carried: the client already holds the room list. */
export const RoomCost = z.object({
  roomId: z.string(),
  cost: CostRollups,
});
export type RoomCost = z.infer<typeof RoomCost>;

/**
 * The metrics frame: per account, per room, and the ambient `~/.claude`.
 *
 * **Addressed per project even though the account half is machine-wide.** Every other machine-wide
 * listing (`accounts`, `usage`, `roles`) goes to every socket unscoped, and this one carries a
 * per-project half — a room belongs to exactly one floor — so it has to be built per project. The
 * account figures are then identical on every floor, which is correct and costs one extra frame per
 * project rather than a second polling surface and a second message for one popover.
 */
export const FactoryMetrics = z.object({
  /** One entry per configured account, in the account list's own order. */
  accounts: z.array(AccountMetrics),
  /**
   * Spend by agents on the ambient `~/.claude` — the ones with no account bound, which is what every
   * session before M2 was and what a factory that has configured no accounts still is. Reported
   * separately rather than folded into `accounts`, because there is no account row to hang it on and
   * inventing one would put a subscription in the list that the operator never added.
   */
  ambient: CostRollups,
  /** This factory's rooms that have cost anything, most expensive week first. */
  rooms: z.array(RoomCost),
});
export type FactoryMetrics = z.infer<typeof FactoryMetrics>;

// ---- M5: exporting and importing a factory ----

/**
 * The `format` marker every export carries. Checked on import before anything else: a JSON file that
 * is not one of ours is refused by name rather than half-applied.
 */
export const FACTORY_EXPORT_FORMAT = "superfabric.factory";

/** The export schema's version. Bumped when the shape changes in a way an older reader would misread. */
export const FACTORY_EXPORT_VERSION = 1;

/**
 * The sentence the export file carries about itself, so someone reading the JSON — or receiving it
 * from a colleague — learns the two things that matter without opening the docs.
 */
export const FACTORY_EXPORT_NOTE =
  "This file describes a SuperFabric factory: its rooms, the agents that staffed them, its task "
  + "board and the index of its recorded decisions. It contains NO credentials: accounts appear only "
  + "as the labels you gave them, and importing this file asks you to re-bind each label to an "
  + "account on the importing machine. Agents are described, not started — an import rebuilds the "
  + "floor and leaves the staffing to you.";

/**
 * One agent as the export describes it: what it *was*, not a session that can be resumed.
 *
 * A session's `claude_session_id` is meaningless on another machine (the conversation lives in that
 * account's transcripts), so nothing here tries to carry one. This is the staffing of a room —
 * "there was an architect on Opus here" — which is the part worth moving.
 */
export const ExportedAgent = z.object({
  roleId: z.string().nullable(),
  model: z.string().nullable(),
  autonomy: AutonomyMode,
  /** The **label** of the account it ran on, or null for the ambient `~/.claude`. Never an id. */
  accountLabel: z.string().nullable(),
  isOrchestrator: z.boolean(),
});
export type ExportedAgent = z.infer<typeof ExportedAgent>;

export const ExportedRoom = z.object({
  name: RoomName,
  /** "project" is the central building, which an import never creates twice. */
  kind: z.enum(["project", "room"]),
  /**
   * The room's folder **relative to the project root**, POSIX-style — or null when the room's folder
   * was outside the root on the exporting machine.
   *
   * **No absolute path is exported, ever.** Not because a path is a secret, but because it is not
   * portable and because the operator's home directory is nobody else's business: a factory shared
   * with a colleague should describe a shape, not a filesystem. A room whose folder was outside the
   * root therefore cannot be reproduced, and the import says so instead of guessing.
   */
  relativePath: z.string().nullable(),
  position: ScenePosition,
  runtime: RoomRuntime,
  /** The **label** of the account new agents here defaulted to, or null. Re-bound on import. */
  accountLabel: z.string().nullable(),
  agents: z.array(ExportedAgent),
});
export type ExportedRoom = z.infer<typeof ExportedRoom>;

export const ExportedTask = z.object({
  title: z.string().min(1).max(200),
  detail: z.string().max(4000),
  status: TaskStatus,
  /** The room's **name**, or null for an unassigned card. Names are how an export refers to rooms. */
  roomName: z.string().nullable(),
});
export type ExportedTask = z.infer<typeof ExportedTask>;

/**
 * One entry of the decision index — **not** the decision.
 *
 * The ADR is a file in the repository (`docs/decisions/NNNN-<slug>.md`) and the row is an index over
 * it; that invariant does not stop being true because the factory moved. So the export carries the
 * index and the import re-creates rows only for files that are actually there, reporting the ones
 * that are not. Copying the ADR bodies in here would create a second source of truth for the one
 * thing in the product that is emphatically repo-native.
 */
export const ExportedDecision = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  /** The ADR's path relative to the project root, POSIX-style. */
  relativePath: z.string().min(1),
  /** The room it was recorded in, by name, or null. */
  roomName: z.string().nullable(),
  createdAt: z.number().int(),
});
export type ExportedDecision = z.infer<typeof ExportedDecision>;

/**
 * A whole factory, portably.
 *
 * **What is deliberately not in here**: any token, any path into an account's `CLAUDE_CONFIG_DIR`,
 * any absolute path at all, and any account id. `test/factoryPortability.test.ts` greps the serialised
 * bytes for the token shapes and for every configured config directory and fails if it finds one —
 * because a promise in a document is not a test.
 */
export const FactoryExport = z.object({
  format: z.literal(FACTORY_EXPORT_FORMAT),
  version: z.literal(FACTORY_EXPORT_VERSION),
  /** Unix seconds. */
  exportedAt: z.number().int(),
  /** What this file is and what it does not contain. See `FACTORY_EXPORT_NOTE`. */
  note: z.string(),
  project: z.object({ name: z.string().min(1).max(120) }),
  /**
   * Every account label this factory refers to, de-duplicated. The import's re-binding list: the
   * operator sees these names and either has an account with that label or is told which one is
   * missing.
   */
  accountLabels: z.array(z.string()),
  rooms: z.array(ExportedRoom),
  tasks: z.array(ExportedTask),
  decisions: z.array(ExportedDecision),
});
export type FactoryExport = z.infer<typeof FactoryExport>;

/**
 * What an import actually did, and — the half that matters — what it could not.
 *
 * **A partial import that claims to be complete is worse than a refused one.** Every room that
 * already existed, every account label this machine does not have, every ADR file that is not in this
 * repository and every agent that was described rather than started is named in `problems`. Nothing
 * is silently skipped.
 */
export const FactoryImportResult = z.object({
  projectId: z.string(),
  /** The project's name, so the UI can say where the factory landed without a second lookup. */
  projectName: z.string(),
  /** Whether the project row was created by this import or already existed for that root. */
  projectCreated: z.boolean(),
  /** Room names created, in the order they were created. */
  roomsCreated: z.array(z.string()),
  tasksCreated: z.number().int().nonnegative(),
  decisionsIndexed: z.number().int().nonnegative(),
  /** Agents the file described. Import never starts one — see `FACTORY_EXPORT_NOTE`. */
  agentsDescribed: z.number().int().nonnegative(),
  /** Everything the import could not do, one readable sentence each. */
  problems: z.array(z.string()),
});
export type FactoryImportResult = z.infer<typeof FactoryImportResult>;

/**
 * One agent CLI on the machine SuperFabric is running on.
 *
 * Machine-wide, like an account and for the same reason: a binary on `PATH` belongs to the operator,
 * not to a factory. The field that matters most is `runsAgents` — SuperFabric drives Claude Code and
 * nothing else today (one implementation behind the `Executor` seam; multi-provider is an After-v1
 * item), so a list that showed `codex` beside `claude` without saying so would imply a capability
 * that does not exist.
 */
export const AgentCliInfo = z.object({
  id: z.string(),
  /** Display name, e.g. "OpenAI Codex CLI". */
  name: z.string(),
  /** The binary as it is typed, e.g. `codex`. */
  command: z.string(),
  /** Where it was found on `PATH`, or `null` when it is not installed. */
  path: z.string().nullable(),
  /**
   * `true` / `false` where a credentials file on disk settles it, and **`null` when it cannot be
   * told from here** — a CLI that keeps its login in a keyring is not a CLI that is logged out, and
   * showing it as one would be a worse answer than no answer.
   */
  signedIn: z.boolean().nullable(),
  /** The file or directory that was looked at, so the operator can check the claim. */
  configPath: z.string().nullable(),
  /** Whether SuperFabric can staff a room with it. Exactly one entry is `true` today. */
  runsAgents: z.boolean(),
  detail: z.string().nullable(),
});
export type AgentCliInfo = z.infer<typeof AgentCliInfo>;

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
    /**
     * Run this agent on a particular account, overriding whatever its room defaults to. Omitted =>
     * the room's account; a roomless session, or a room with none, => the ambient `~/.claude`.
     */
    accountId: z.string().optional(),
    /**
     * Start this agent as a role: its charter, its skills, and — unless something above says
     * otherwise — its model and autonomy. Omitted => a plain agent, which is what every session
     * before M1c was.
     */
    roleId: RoleId.optional(),
    /**
     * Which CLI this agent runs on. Omitted => Claude Code, which is what every agent before this
     * ran on. There is no `set_provider`: see `AgentProvider`.
     */
    provider: AgentProvider.optional(),
  }),
  z.object({ kind: z.literal("set_autonomy"), sessionId: z.string(), autonomy: AutonomyMode }),
  /**
   * Switch a live agent's model. `null` hands it back to the CLI's default rather than pinning one.
   * Like `set_autonomy`, this restarts the session's executor (resuming the same provider session),
   * because the model is fixed for the lifetime of a `query()` — see `SessionManager.setModel`.
   */
  z.object({ kind: z.literal("set_model"), sessionId: z.string(), model: ModelId.nullable() }),
  /**
   * Move a live agent onto another account. `null` hands it back to the ambient `~/.claude`.
   *
   * The third member of the `set_autonomy`/`set_model` family and restarted for exactly the same
   * reason: `Options.env` — and therefore `CLAUDE_CONFIG_DIR` — is baked in when `query()` is called,
   * so the session's executor is torn down and resumed rather than mutated. The stored account and
   * the account actually in force can then never disagree.
   */
  z.object({ kind: z.literal("set_session_account"), sessionId: z.string(), accountId: z.string().nullable() }),
  /**
   * Give a live agent a role, or take it away (`null` => a plain agent again).
   *
   * The fourth member of the `set_autonomy`/`set_model`/`set_session_account` family and restarted for
   * the same reason: a role composes the system prompt, the model and the tool servers, all of which
   * are `Options` fields fixed for the lifetime of a `query()`. The conversation is resumed, so the
   * agent keeps what it knows and changes what it is.
   *
   * What it deliberately does **not** change is the agent's autonomy: a role's `autonomy` applies when
   * an agent is created, never afterwards. Escalating what a running agent may do from a dropdown
   * labelled with a job title is not a decision the operator made.
   */
  z.object({ kind: z.literal("set_role"), sessionId: z.string(), roleId: RoleId.nullable() }),
  /**
   * End an agent — at the next turn boundary, and for good.
   *
   * The counterpart of `interrupt`, which ends a *turn*: this ends the session. The executor is torn
   * down and the row moves to `done`, so `resumeAll` does not bring it back on the next boot. **Its
   * transcript is untouched** — the event log is append-only and the operator can still read
   * everything the agent did. That is the whole difference from `delete_session`, and it is why both
   * exist: "stop spending my quota" and "I never want to see this again" are different requests, and
   * answering the first with the second is unrecoverable.
   *
   * Not reversible, and the UI says so: a stopped agent is history rather than a paused one. Pausing
   * is the scheduler's, and it is what a *limit* does to an agent.
   *
   * The pause discipline applies: an agent with a turn in flight is stopped at the boundary it is
   * already heading for, never mid-thought — the tokens that turn has spent would otherwise be
   * thrown away.
   */
  z.object({ kind: z.literal("stop_session"), sessionId: z.string() }),
  /**
   * Remove an agent and everything it ever said.
   *
   * Stops it first if it is running (see `stop_session`), then deletes its row *and* its event log —
   * the transcript, the tool calls, the approvals, and the chronicle's index over them. This is the
   * one operation in SuperFabric that destroys history, so nothing else does it implicitly: deleting
   * a *room* deletes the agents standing in it, and that is stated where it is asked for.
   *
   * A task the agent owned is not deleted with it: the card is unassigned and stays on the board. The
   * work outlives whoever was doing it.
   */
  z.object({ kind: z.literal("delete_session"), sessionId: z.string() }),
  z.object({ kind: z.literal("list_sessions") }),
  /**
   * The role library: the presets this server shipped, plus the operator's own overrides, plus any
   * file that failed to load.
   *
   * Not scoped to a project — a role is a file on the machine, like an account is a directory on it —
   * so the answer is the same on every floor. Answered to the socket that asked, like every other
   * listing.
   */
  z.object({ kind: z.literal("list_roles") }),
  /**
   * Give this factory its orchestrator, or hand back the one it already has.
   *
   * Idempotent by design and deliberately argument-free: the orchestrator's room (the project room),
   * its role prompt and its tool surface are the server's to decide, not a client's — an operator
   * hand-building a session and hoping it lands in the right room with the right append is exactly
   * the failure this message exists to prevent. Answered with the fresh `sessions` list, in which
   * exactly one entry carries `isOrchestrator`.
   */
  z.object({ kind: z.literal("ensure_orchestrator") }),
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
  /**
   * The account agents created in this room start on. `null` means the ambient `~/.claude`.
   *
   * A default for *new* agents only. Agents already standing there keep the account their session was
   * started with — the environment of a live `query()` cannot be changed — so this is not a way to
   * move a running agent; `set_session_account` is.
   */
  z.object({ kind: z.literal("set_room_account"), roomId: z.string(), accountId: z.string().nullable() }),
  /**
   * Whether agents created in this room run on the host or in a container.
   *
   * A default for *new* agents and for the next restart of an existing one, said the same way the
   * room's folder and account are: an agent already working keeps the runtime its executor was
   * started in, because there is no way to move a running `query()` into a container.
   */
  z.object({ kind: z.literal("set_room_runtime"), roomId: z.string(), runtime: RoomRuntime }),
  /**
   * Take a building off the floor.
   *
   * **The folder is never touched.** Room = folder: the row is what SuperFabric adds to a directory,
   * so removing it hands the directory back exactly as it was — its files, its `CLAUDE.md`, its
   * `.claude/skills` — and a repository cloned without SuperFabric is unchanged either way. This is
   * the reason a delete here is a safe thing to offer at all.
   *
   * What it does destroy is the agents: every session standing in the room is stopped and deleted
   * with it, transcripts included, because a session's `cwd` *is* the room and an agent left behind
   * would be an agent in a department that no longer exists. The client says how many before asking.
   *
   * Two things deliberately survive: the room's **tasks**, which are unassigned rather than deleted
   * (the work outlives the department), and the bus **messages** it sent and received, which are the
   * record of what the factory did — `messages` has never had a foreign key for exactly this reason.
   *
   * The project room is refused: its folder is the project root, and a factory with no central
   * building is not a factory. Delete the project instead.
   */
  z.object({ kind: z.literal("delete_room"), roomId: z.string() }),
  z.object({ kind: z.literal("list_rooms") }),
  // Accounts. Machine-wide rather than project-scoped (see `AccountInfo`), so unlike every other
  // listing here these four take no project and their answer is the same on every floor.
  z.object({ kind: z.literal("list_accounts") }),
  /**
   * What agent CLIs are on this machine. Machine-wide like the accounts, answered to the socket that
   * asked, and read from the filesystem only — nothing is executed to produce it.
   */
  z.object({ kind: z.literal("list_toolchain") }),
  /**
   * What each account's limits look like right now. Machine-wide like `list_accounts`, and for the
   * same reason: a subscription's quota is the operator's, not a factory's.
   *
   * A *query* over state the server already holds — it never triggers a read of the usage endpoint,
   * because a client asking is not a reason to spend a request against a rate-limited API. The
   * poller owns when that happens; this hands back the newest snapshot it took.
   */
  z.object({ kind: z.literal("list_usage") }),
  /**
   * Burn rate and cost: how fast each account is spending, how long it has at that rate, and what
   * this floor's work has cost.
   *
   * A **query** over state the server already holds — like `list_usage`, it never triggers a read of
   * the usage endpoint. The projection comes from the readings the poller has already taken, and the
   * cost from the event log; asking cannot spend a request against a rate-limited API.
   *
   * Scoped to the asking socket's project, because the room half of the answer is (see
   * `FactoryMetrics`).
   */
  z.object({ kind: z.literal("list_metrics") }),
  z.object({
    kind: z.literal("create_account"),
    /** Which CLI this account is for. Omitted => Claude Code. */
    provider: AgentProvider.optional(),
    label: z.string().min(1).max(120),
    /**
     * Absolute path of this account's `CLAUDE_CONFIG_DIR`. Created if it is not there yet, and
     * refused if another account already claims it: one directory is one account, always.
     */
    configDir: z.string().min(1),
  }),
  /** Refused while any session still runs on it — an account is not removed out from under an agent. */
  z.object({ kind: z.literal("remove_account"), accountId: z.string() }),
  /**
   * Log this account in, in the app.
   *
   * The server runs `claude auth login` against that account's config directory over plain pipes and
   * reports what it prints: an OAuth URL for the operator to open, then a wait for the code that page
   * gives them (`submit_account_login_code`). No terminal emulator is involved — the command needs no
   * TTY, which is the measured finding this design rests on.
   */
  z.object({ kind: z.literal("begin_account_login"), accountId: z.string() }),
  z.object({
    kind: z.literal("submit_account_login_code"),
    accountId: z.string(),
    /** The code from the OAuth page, handed to the waiting CLI on its stdin. */
    code: z.string().min(1).max(2000),
  }),
  z.object({ kind: z.literal("cancel_account_login"), accountId: z.string() }),
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
  /**
   * Remove a factory from the switcher: its rooms, its agents and their transcripts, its board, its
   * bus traffic and its chronicle *index*.
   *
   * **Nothing on disk is touched** — not the project root, not a room's folder, and not the ADR files
   * in `docs/decisions/`, which are the decisions themselves and belong to the repository rather than
   * to us. What goes is everything SuperFabric wrote *about* the folder.
   *
   * Two refusals, both because the alternative would be a lie. The project whose root this server was
   * started in is re-created on the next boot, so deleting it would undo itself — point the server at
   * another folder (`SUPERFABRIC_PROJECT`) if it should not be there. And the last remaining project
   * is refused, because a server with no factory has no floor to show and would simply seed one back.
   *
   * Tabs looking at the deleted floor are moved to another one and told; they cannot be left holding
   * a project id that no longer resolves.
   */
  z.object({ kind: z.literal("delete_project"), projectId: z.string() }),
  // Onboarding. Four messages for one conversation with the factory itself: what is the state, start
  // the interview, approve what it proposed, drop what it got wrong. All scoped to the asking
  // socket's own project, like every other per-factory message here.
  z.object({ kind: z.literal("list_onboarding") }),
  /**
   * Put an onboarding agent in the project room and set it going.
   *
   * Idempotent, like `ensure_orchestrator` and for the same reason: it is a button, and a second
   * click must hand back the interview already in progress rather than start a rival one. It is
   * **not** refused on an already-onboarded project — an operator who wants the interview again on a
   * documented project is allowed to ask for it; what is missing then is only the prompting.
   */
  z.object({ kind: z.literal("start_onboarding") }),
  /**
   * Approve some of the rooms the interview proposed, optionally with the operator's own edits.
   *
   * The edits are the point: a proposal is something to correct, not a form to sign. Each accepted
   * entry then goes through the ordinary `createRoom` path, so a name that is not a usable folder
   * segment, or a room that already exists, fails *that* suggestion and says why — the others are
   * still created.
   */
  z.object({
    kind: z.literal("accept_room_suggestions"),
    rooms: z.array(z.object({
      id: z.string(),
      /** Replaces the proposed name. Omitted => the name as proposed. */
      name: RoomName.optional(),
      /** Replaces the proposed one-line charter. Omitted => the charter as proposed. */
      charter: z.string().min(1).max(300).optional(),
    })).min(1).max(MAX_ROOM_SUGGESTIONS),
  }),
  /** Drop one proposal. Nothing is created and nothing is deleted; it stops being offered. */
  z.object({ kind: z.literal("dismiss_room_suggestion"), suggestionId: z.string() }),
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
  /**
   * Ask the orchestrator where an unassigned task belongs — the board's "route it" affordance, and
   * the same round trip `create_task` starts on its own for a card created with no room.
   *
   * Explicit rather than implicit because routing is a *model* decision that may be slow or wrong:
   * an operator who has since created the orchestrator, or who wants the question asked again, needs
   * a way to say so. Nothing is assigned by this message — it sends a question, and the task stays
   * visibly unassigned until the orchestrator answers.
   */
  z.object({ kind: z.literal("route_task"), taskId: z.string() }),
  z.object({ kind: z.literal("list_tasks") }),
  /**
   * The bus's recent traffic. A client needs this on connect for two reasons: a message still
   * queued for a busy room is *state* the floor has to draw (the pile at its sender's door), and the
   * answer is the baseline against which later broadcasts are new — without it a tab either shows no
   * queue until something changes, or replays an hour of history as packages on the belt.
   */
  z.object({ kind: z.literal("list_messages") }),
  /**
   * Search this project's chronicle — the same index `factory_search_history` gives agents.
   *
   * A **query**, answered to the asking socket alone: two operators searching different words in two
   * tabs must not overwrite each other's results, and nobody else's screen should change because
   * someone typed in a search box.
   *
   * An empty query is not an error and not "match everything": it asks for the newest recorded
   * decisions, so opening the surface shows what this factory has decided rather than an empty box.
   * Anything an agent could type is accepted verbatim — FTS5 operators are neutralised server-side
   * (`ftsQuery`), so a stray quote is a search, not a syntax error.
   */
  z.object({
    kind: z.literal("search_chronicle"),
    query: z.string().max(500).default(""),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  // Portability. Two messages, and the asymmetry between them is deliberate: an export is a *read* of
  // the asking socket's own floor, while an import has to be told which folder to build in — a
  // factory arriving from elsewhere has no root of its own, and guessing one would create rooms in
  // whatever directory this server happened to be started from.
  /**
   * Hand back this factory as a portable file. Omitted `projectId` => the socket's active project.
   *
   * **No secrets are in the answer.** Accounts appear as labels, no absolute path is included, and
   * nothing from any `CLAUDE_CONFIG_DIR` is read. See `FactoryExport`.
   */
  z.object({ kind: z.literal("export_project"), projectId: z.string().optional() }),
  /**
   * Rebuild a factory from an exported file, in a folder the operator names.
   *
   * `root` must be an absolute path to an existing directory. A project already registered for that
   * root is used; otherwise one is created. Rooms are created through the ordinary
   * `RoomManager.createRoom`, so name safety, root containment and never-overwriting-a-charter all
   * still apply *because it is the same code path* — and everything the import could not do comes
   * back in `FactoryImportResult.problems` rather than being skipped in silence.
   *
   * `factory` is `unknown` on the wire on purpose: it is parsed with `FactoryExport` inside the
   * handler so a file that is not one of ours is refused with a message naming what is wrong with it,
   * rather than failing the whole frame as "bad message".
   */
  z.object({
    kind: z.literal("import_factory"),
    root: z.string().min(1),
    /** Display name for a project this import creates. Ignored when the root already has one. */
    name: z.string().min(1).max(120).optional(),
    factory: z.unknown(),
  }),
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
   * The role this agent arrived as, or `null` for a plain one.
   *
   * The id rather than the whole spec: roles are a machine-wide list the client already holds, and a
   * copy of the charter on every session row would go stale the moment the operator edited the file.
   * Persisted and re-applied on resume, like `autonomy`, `model` and `accountId` — an agent restarted
   * by a reboot comes back as the architect it was, not as a blank session in the architect's room.
   */
  roleId: z.string().nullable().default(null),
  /**
   * Which CLI this agent runs on.
   *
   * Defaulted rather than required so a client (or a database row) written before providers existed
   * still parses as what it was: Claude Code. Fixed at creation — see `AgentProvider` — so unlike
   * every other field here it never changes over a session's life.
   */
  provider: AgentProvider.default(DEFAULT_AGENT_PROVIDER),
  /**
   * This agent is the factory's orchestrator: the senior agent that routes work, unblocks rooms and
   * decides direction. It is an ordinary session in every other respect — same runtime, same event
   * log, same room (the project room) — so this is a flag on `SessionInfo` rather than a separate
   * kind of thing the client has to model. At most one per project.
   */
  isOrchestrator: z.boolean(),
  /**
   * The account this agent runs on — its `CLAUDE_CONFIG_DIR` — or `null` for the ambient `~/.claude`,
   * which is what every session before M2 ran on and still does.
   *
   * Resolved once when the agent is created (an explicit choice, else its room's default) and then
   * persisted here, so the room's default changing later never silently moves a running agent. Like
   * `autonomy` and `model` it is re-applied on resume: an agent restarted by a reboot comes back on
   * the same subscription, which is the property the whole multi-account feature rests on.
   */
  accountId: z.string().nullable().default(null),
  /**
   * When this agent is expected to come back, as unix **seconds** — non-null only while it is
   * paused, and only when something knows the answer.
   *
   * `null` on a paused agent is a real state rather than a missing value: an account marked by a 429
   * with no reading behind it has no known reset time, and the scheduler holds it until a reading
   * says the window rolled. The UI shows a countdown for the first and "waiting for the limit to
   * lift" for the second — inventing a time for the second would be a promise nobody made.
   */
  pausedUntil: z.number().int().nullable().default(null),
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
  /**
   * Where this agent's executor is **actually** running — not what its room is set to. `null` means
   * it is not running at all (stopped, paused, errored, or not yet resumed).
   *
   * Live rather than stored, and that is the whole point of it. A room's runtime is a default for
   * the next executor start, so an operator who switches a room to `container` while three agents
   * are working has three agents still on the host until each restarts. Everywhere else in the
   * product that lag is a mild surprise (an agent keeps its old folder, its old account); here it
   * would be the floor claiming an isolation that is not in force, which is the one kind of lie a
   * sandbox must never tell. So the room says what the next agent gets, and every agent says what
   * *it* got.
   */
  runtime: RoomRuntime.nullable().default(null),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const ServerMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), sessionId: z.string(), seq: z.number().int(), event: SessionEvent }),
  z.object({ kind: z.literal("sessions"), sessions: z.array(SessionInfo) }),
  z.object({ kind: z.literal("rooms"), rooms: z.array(RoomInfo) }),
  /**
   * Every account on this server — the one list here that is *not* scoped to a project, because a
   * subscription is the operator's and serves every floor (see `AccountInfo`). It therefore goes to
   * every attached socket rather than only to those looking at one factory.
   */
  z.object({ kind: z.literal("accounts"), accounts: z.array(AccountInfo) }),
  /**
   * Every account's limit meters. Machine-wide, so like `accounts` it goes to every attached socket
   * rather than only to those on one floor.
   *
   * A separate message from `accounts` on purpose: the account list changes when the operator
   * configures something, and the meters change on a three-minute poll. Folding the two together
   * would rebroadcast every account row (and every in-flight login's state) on every tick.
   */
  z.object({ kind: z.literal("usage"), usage: z.array(AccountUsage) }),
  /**
   * The role library. Machine-wide like `accounts`, and carrying its own failures: a preset that did
   * not load is a fact the operator has to be able to see, and the alternative — a list that is
   * quietly one entry shorter than the folder — is exactly the failure a hand-written config format
   * has to design against.
   */
  z.object({ kind: z.literal("roles"), roles: z.array(RoleSpec), problems: z.array(RoleProblem) }),
  /**
   * Where this factory stands with onboarding. Per-project like `rooms` and `sessions`, and pushed
   * rather than only answered: the fact it carries (`CLAUDE.md` exists now) is one an *agent* changes
   * by writing a file, which no client request would ever be the cause of.
   */
  z.object({ kind: z.literal("onboarding"), onboarding: OnboardingState }),
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
    /**
     * `null` when this server has no factory at all — a fresh install, and now the *normal* first
     * state rather than an impossible one.
     *
     * SuperFabric used to invent a project from the folder it happened to be started in, which meant
     * a first run always produced a factory over its own source tree that nothing could remove. A
     * project root is the operator's own repository and choosing one is the first real decision they
     * make, so the server no longer guesses: with nothing configured, the floor is empty, every
     * listing is empty, and the UI asks for a folder. `SUPERFABRIC_PROJECT` still seeds one, because
     * that is somebody saying it rather than the server assuming it.
     */
    activeProjectId: z.string().nullable(),
  }),
  /** The answer to `list_toolchain`: every CLI looked for, installed or not. */
  z.object({ kind: z.literal("toolchain"), tools: z.array(AgentCliInfo) }),
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
  /**
   * The answer to one `search_chronicle`, **carrying the query it answers**.
   *
   * The echo is load-bearing: a search box sends a request per keystroke-ish and the answers come
   * back over a socket in no guaranteed order, so a client that stored whatever arrived last would
   * show the results for a word the operator has already finished deleting. With the query on the
   * frame, an answer that is not the question currently being asked is simply dropped.
   */
  z.object({
    kind: z.literal("chronicle"),
    /** The query as asked. Empty means "the newest decisions", which is what an empty box shows. */
    query: z.string(),
    hits: z.array(ChronicleHit),
  }),
  /**
   * Burn rate and cost. Pushed on the same occasions as `usage` (a poll finished, a 429 landed) plus
   * on a turn boundary, because a turn is what changes the cost half.
   */
  z.object({ kind: z.literal("metrics"), metrics: FactoryMetrics }),
  /**
   * This factory, portably — the answer to one `export_project`, to the socket that asked. Not
   * broadcast: it is a download the operator started, and it is large.
   */
  z.object({ kind: z.literal("factory_export"), factory: FactoryExport }),
  /**
   * What an import did and did not do. A message of its own rather than a `notice`, because the
   * *problems* list is the important half and a one-line string could not carry it — an import that
   * created four of five rooms has to be able to say which one it refused and why.
   */
  z.object({ kind: z.literal("factory_import"), result: FactoryImportResult }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
