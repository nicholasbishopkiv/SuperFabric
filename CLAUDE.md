# SuperFabric — agent context

Self-hosted visual orchestrator for multi-account Claude Code agent teams: a 3D factory
in the browser (react-three-fiber), rooms-as-folders, agents = Claude Code sessions
(TS Agent SDK, streaming input), an MCP bus between departments, an orchestrator agent,
and a subscription limit monitor with auto-pause/resume.

## Read before any work

1. **This file** — the invariants below are the ones that must not be broken.
2. `docs/ARCHITECTURE.md` — components and flows, read against the code at the end of M5.
3. `docs/ROADMAP.md` — what each milestone actually delivered, with the acceptance evidence,
   and **`## What is not built`** at the bottom. Read that section before assuming a feature
   exists.
4. `docs/RESEARCH.md` — facts about Claude Code / limits / prior art; don't rediscover. A
   **dated snapshot** with three conclusions marked `[superseded]`.
5. `docs/superpowers/specs/2026-08-03-fabrica-design.md` — the spec the product started from.
   **Historical**: it is where the shape came from, and where it and this file disagree, this
   file and `ARCHITECTURE.md` are right.
6. `packages/server/notes/agent-sdk-api.md` — verified Agent SDK API reference. Trust it over
   memory; it records what was measured, including two things whose obvious reading is wrong.

## Invariants (do not violate)

- The SQLite event log is the source of truth; WebSocket is a lossy tail with
  `afterSeq` replay.
- Room = folder; without SuperFabric the project remains an ordinary repository.
- **One `CLAUDE_CONFIG_DIR` = one account; never share across accounts** — and this is now enforced
  in code rather than only written down. The CLI rewrites its refresh token in place inside that
  directory, so two accounts sharing one would invalidate each other days later with nothing in any
  log to explain it. `AccountManager.create` refuses a duplicate, migration 9 puts UNIQUE on
  `accounts.config_dir` so a future write path cannot lose it, and the path is canonicalised through
  `realpath` first — the check is about the *directory*, not about the string that was typed.
- Message delivery to agents is push (inject a turn into the input stream), not polling.
- No account pooling/rotation to evade limits (hard ToS line) — only monitoring, pause,
  and resume of the user's own accounts.
- The server is a local privileged tool: bind 127.0.0.1 only, allow-list browser `Origin`s on
  the WebSocket handshake (`src/origin.ts`), and never trust a client-supplied session id for
  anything the log records (see `SessionManager.approve`).
- Autonomy is **per session**, persisted in `sessions.autonomy`, and re-applied on resume: a
  `bypass` agent comes back as `bypass`, an `attended` one as `attended`. A session's SDK
  permission mode is always set explicitly, so the operator's own Claude Code default can never
  decide what a factory agent may do.
- The **model is per session** in exactly the same way (`sessions.model`, NULL = the CLI's own
  default), re-applied on resume, and changed by restarting the session's executor with `resume` —
  so the stored model and the model actually in force can never disagree. Model *ids* are Anthropic's
  release schedule, not our protocol: the wire takes any non-empty string, `AGENT_MODELS` in
  `packages/shared` is a shortlist for the UI, and a free-text field covers everything else. Never
  hard-code an id you are not sure of — a wrong one is a 404 mid-turn.
- **An agent's tool servers are the factory's, not the operator's.** The executor sets
  `strictMcpConfig: true`, so a session's MCP servers are exactly what SuperFabric passes in
  `Options.mcpServers` — the room's factory bus today. The operator's own `~/.claude.json` servers,
  their plugins' servers and their claude.ai connectors are all out, by a documented flag rather than
  as a side effect of `settingSources` (`~/.claude.json` is not a settings *file*, so nothing
  promised that). Anything we pass is *trusted* — it skips the CLI's approval flow — so a future
  room-level MCP configuration has to answer the trust question itself. **This decides what the agent
  is *offered*; it is not isolation** — on a `host` room the session still runs as the operator, with
  their credentials and their whole filesystem. Isolation is the room's *runtime* (below). See
  `packages/server/notes/agent-sdk-api.md`, "How the SDK sources MCP servers", for the probe and the
  measurements.
- **A restart never eats an instruction.** `set_autonomy`/`set_model` restart a live session's
  executor, and a `prompt` landing in that window is *held* and delivered the moment the replacement
  is up — never dropped. The hold is bounded (`MAX_HELD_PROMPTS` in `sessionManager.ts`); past it the
  call throws and the hub answers with an `error`. If the restart never produces an executor
  (shutdown, a failed start) each held prompt is appended to the session's log as a `session_error`
  carrying its text, so the operator sees both that it did not land and what it said. Delivered, or
  refused out loud — never neither.
- **A room is never taken from tool input.** The room an agent speaks for comes from its session
  row, and `busTools` bakes it into the closures — an agent cannot send a bus message *as* another
  department, whatever it puts in the arguments. A roomless session gets no bus tools at all. The
  same holds for the orchestrator: `isOrchestrator` comes from the session row, so the two
  orchestrator-only tools are both absent from an ordinary agent's list *and* refused by their own
  handlers — being unadvertised is not being gated.
- **Nothing fabricates an assignment.** A task with no room is routed by *asking the orchestrator*
  and waiting; with no orchestrator it stays unassigned and the board says so. A heuristic here
  (first room, most idle room, name similarity) would be the server inventing a decision it has no
  standing to make, and the operator could not tell it from a real one.
- **A decision is a file; the row is an index over it.** `factory_record_decision` writes
  `<project>/docs/decisions/NNNN-<slug>.md` *before* it inserts, so a failure leaves a greppable
  orphan ADR rather than an index entry pointing at nothing. Someone who clones the repository and
  never runs SuperFabric must still find the reasoning.
- **The factory's own bus tools are never gated.** `canUseTool` auto-allows tool names belonging
  to this session's own in-process (`type: "sdk"`) MCP servers — for a room, `mcp__factory__*` —
  in every autonomy mode, and still appends a `tool_use` event so the log records the call.
  Everything else keeps going through the operator. See
  `docs/decisions/0002-factory-tools-are-not-gated.md`.
- **The bus persists before it delivers, and delivers only at a turn boundary.** A message is a
  row before anyone is told about it, and an agent mid-turn is never interrupted: its queue drains
  one message per `turn_complete`.
- **Everything the operator looks at is scoped to one project, and the active project belongs to
  the socket.** Rooms, sessions, tasks and messages all carry a `project_id`; every listing takes
  one, and every broadcast is addressed by the asking socket's own scope. A second tab watching
  another factory must never see this one's rooms, board or belts — cross-project leakage is the
  bug to be most afraid of in this area, and the store-level tests exist to catch it. Room *names*
  are unique per project, not per server, so anything resolving a name (`busTools`) must scope it.

- **A room chooses where its agents run, and every agent says where it actually is.**
  `rooms.runtime` is `host` (the default, and what every room did before M4) or `container`, and
  `SessionManager` picks the executor from it — below that line **nothing branches**: the event log,
  approvals, the bus, limits, pause and resume are written once against the `Executor` interface that
  has existed since M0, and `test/containerEquivalence.test.ts` drives one scripted turn through both
  implementations and compares the logs rather than trusting the claim. On the *room* rather than on
  the session, unlike `autonomy`/`model`/`account_id`/`role_id`, because it is a property of the work:
  a factory where half the agents in one room were contained would be a factory whose security posture
  nobody could state. **But `SessionInfo.runtime` is per agent and live** (`null` when it is not
  running), because a runtime is fixed when a `query()` begins — a room switched to `container` while
  three agents work leaves three agents on the host — and everywhere else that lag is a mild surprise,
  whereas here it would be the floor claiming an isolation that is not in force.
- **A contained agent gets three mounts and no more**: the room's folder (rw), that account's
  `CLAUDE_CONFIG_DIR` (rw — the CLI rewrites its refresh token in place), the runner socket's
  directory (ro). Never the operator's `~/.claude`, never another account's directory, never the
  project root when the room lives elsewhere, never the docker socket. **A container room with no
  account is refused rather than run**: the fallback everywhere else in the product is the ambient
  `~/.claude`, and here that would mean bind-mounting the operator's home into the thing built to
  keep the agent out of it.
- **Containers reach the server over a unix socket, not a port**, and the *directory* holding it is
  what is mounted (read-only), so a container that outlived a server restart finds the new inode at
  the same path. It needs nothing from the host's network stack — the bridge-gateway route is dropped
  outright by `ufw` on a default host, and the rule that would fix it is the operator's to add, not
  ours — it adds no listener to a server that binds `127.0.0.1` on purpose, and it lets the
  container's egress allow-list stay strict because the container needs no route back to us at all.
  **Two gates:** the socket's `0600` stops another *user*; a per-container 256-bit token, compared
  timing-safely on `hello`, stops another *container of the same user*. `origin.ts` deliberately
  admits header-less non-browser clients, so it says nothing about a runner — this is a new surface,
  not an extension of an old one. `SUPERFABRIC_RUNNER_TCP_PORT` is the documented fallback.
- **Restarting the server must not cost the operator a working agent.** Shutdown calls
  `ExecutorHandle.detach()` where an executor has one, which for a container means letting go of the
  socket and leaving it running; the runner buffers its output and reconnects, and the next boot finds
  the container by its label, reads the token out of the container's *own environment* and
  re-attaches. **Docker is the store** — labels and env, no second record that could disagree with it.
  A container whose options the operator has since changed is replaced rather than adopted (the spec
  is a digest in a label), and `reapOrphans` at boot removes every container no live session claims,
  which `RestartPolicy: unless-stopped` makes mandatory rather than tidy.
- **An account is per session, persisted, and re-applied on resume** — the third member of the
  `autonomy`/`model` family, and for the same mechanical reason: `CLAUDE_CONFIG_DIR` lives in
  `Options.env`, which is fixed for the lifetime of a `query()`, so `set_session_account` restarts
  the executor and resumes rather than mutating. `sessions.account_id` is resolved **once**, when the
  agent is created (its own choice, else its room's default), so a room's default changing later
  never silently moves someone already working. NULL means the ambient `~/.claude`, which is what
  every pre-M2 session ran on and still does.
- **A limit reading says how much it is worth.** `AccountUsage.approximate` is not decoration: the
  primary source is Anthropic's own undocumented `GET /api/oauth/usage` (authoritative, cross-device),
  the fallback counts tokens in this machine's transcripts (blind to other devices, ignorant of when
  the real window began, measured against a budget we assumed). Every surface that shows an estimate
  marks it — hatched bar, badge, `≈`, and the reason in words — and **the scheduler will never pause
  an agent on one.** A 429 is a different thing: `limitedBy: "rate_limit_error"` is the provider
  refusing a turn, not a meter reading, and it pauses whatever the meters say. An estimate presented
  as a fact is worse than an honest gap, because the operator would plan around it.
- **The usage endpoint is undocumented and has already moved under us.** It sits behind
  `UsageAdapter` for that reason. Verified live on 2026-08-04: `seven_day_opus`/`seven_day_sonnet`
  are now present-but-*null* and the per-model weekly figures have moved into a `limits[]` array
  (`kind`/`group`/`percent`/`severity`/`resets_at`/`scope.model.display_name`). `parseUsagePayload`
  reads both that and the shape `docs/RESEARCH.md` §2 documents, takes windows whose `kind` it has
  never heard of, and **degrades rather than crashing** — a half-understood body yields the meters it
  could read plus a note counting the fields it could not. Understanding *nothing* is the only
  failure, and it is what hands over to the estimate. Polling is floored at 180 s **per account**: a
  monitor that earns a 429 causes the condition it exists to watch for.
- **An agent is paused at a turn boundary, never mid-turn**, and is never moved to another account.
  The boundary is the one the runner already knows (`turn_complete`, where the bus flushes);
  interrupting a live turn would throw away the tokens it has already spent. The pause is persisted
  (`sessions.state='paused'` plus `paused_at`/`paused_until`), so `resumeAll` does not resurrect a
  held agent on the next boot and the countdown survives a restart; the resume goes through
  `options.resume` and tells the agent what happened to it. **If a subscription is exhausted, its
  agents wait for its window.** There is no "least-loaded account" anywhere in `scheduler.ts` for
  anything except the orchestrator's initial placement, and there must never be one — that is the ToS
  line (`docs/RESEARCH.md` §5).
- **An executor we have let go of may not write over the record of why we let it go.** Every
  `startExecutor` closes over a generation number and anything that releases an executor (pause,
  restart, shutdown) bumps it; events from a superseded incarnation are dropped. Without this the
  `idle` the SDK emits one line after `result` would overwrite the `paused` a boundary pause had just
  appended, and the row and the transcript would disagree about the same agent.
- **Accounts are machine-wide, not per project.** A subscription belongs to the operator, not to a
  repository: `accounts` is the one listing on the wire with no `project_id`, and its broadcast goes
  to every socket rather than only to those on one floor. The per-project choice is the *binding* —
  `rooms.account_id` (a default for new agents) and `sessions.account_id` (what an agent actually
  runs on). A per-project account table would have meant re-creating and re-logging-in the same
  account on every floor, which puts two rows on one directory: the invariant above, broken from the
  other side.
- **A projection with too little behind it says "unknown".** The burn rate (`metricsStore.ts`) is
  the least-squares slope of `usage_snapshots` taken to `LIMIT_PAUSE_PERCENT` — a *measurement*, from
  the same readings the meters draw — and it refuses to produce a figure from fewer than two
  readings, from a series spanning under `MIN_BURN_SPAN_SECONDS`, or from a window that is not
  filling. The reason travels in words to the place the number would have been. "At this rate you
  have about two hours" is the only output an operator acts on, so a guess there would be worse than
  a blank: they would plan an afternoon around it. A window that *rolled* restarts the series rather
  than flattening it — 96 % to 3 % is a new window, not a rate of minus ninety-three points an hour.
- **There is no pricing table anywhere in this product, and there must not be one.** Cost comes from
  `turn_complete.costUsd`, which is the CLI's own figure. Tokens are never multiplied by a rate we
  wrote down: such a table would be wrong within weeks and nothing would say so. The figure is
  marked approximate everywhere it appears, for three separate reasons named on `CostRollup` — it is
  a cost-*equivalent* (a subscription bills nothing per turn), a turn whose result carried no cost is
  not counted, and it is **reconstructed**: `total_cost_usd` accumulates **per `query()`**, not per
  turn (see `notes/agent-sdk-api.md`, "What `total_cost_usd` counts"), so a turn's cost is a delta
  and a counter that goes backwards is a restarted executor rather than a refund. Summing the field
  would over-count a long session several times over.
- **An exported factory contains no credentials, and that is a test rather than a sentence.** The
  export refers to an account only by the **label** the operator typed, carries nothing read from any
  `CLAUDE_CONFIG_DIR`, no account id, and **no absolute path at all** — a room's folder is described
  relative to the project root, which is both what makes the file portable and what keeps someone's
  home directory out of a factory they shared. `test/factoryPortability.test.ts` serialises a
  populated export and greps the bytes for the token shapes, for every configured config directory,
  for every account id and for the project root, and fails on a hit. **Import goes through the
  ordinary `RoomManager.createRoom`** so every invariant it already has still applies, and it
  **reports what it could not do** — a colliding room, a label this machine lacks, an ADR the
  repository does not hold, the agents it described rather than started. A partial import that
  claimed to be complete is worse than a refused one. Two deliberate refusals: an import never starts
  an agent (a conversation does not travel with a file, and spawning a CLI per described agent when
  someone opens one is not a thing they asked for), and `Chronicle.indexImported` writes an index row
  **only when the ADR file is actually present** — the decision is the file, still.

## Autonomy (per-agent permission mode)

Three modes, in our own vocabulary (`AutonomyMode` in `packages/shared/src/protocol.ts`):

| Mode | Meaning | SDK `permissionMode` |
|---|---|---|
| `attended` | every gated tool call raises an approval card | `"default"` |
| `auto` | **default** — the CLI's classifier decides; cards become rare, not impossible | `"auto"` |
| `bypass` | nothing is gated at all; explicit per-agent opt-in | `"bypassPermissions"` |

The wire protocol never speaks SDK: the mapping lives in the executor
(`sdkPermissionMode()` in `src/executors/claudeCode.ts`) and, identically, in the runner, so an SDK
rename touches two tables that are tested against each other rather than one that is quietly wrong
in a container. `canUseTool` stays wired in every mode, so the attended mode and any
classifier-escalated call still reach the operator. **`bypass` means two different things and the UI
says which**: on a host room an ungated agent *is* the operator (badge: `ungated · uncontained`); in a
container room it reaches one folder and one account (badge: `ungated`). It stays available on host
rooms — the operator's machine, their choice — and nothing an operator already configured was changed
when the runtime picker arrived.
`create_session` carries an optional `autonomy`; `set_autonomy` toggles a live agent (the SDK's
mode is fixed per `query()`, so the session's executor is restarted, resuming from the stored
`claude_session_id`).

## Model (per agent)

`create_session` carries an optional `model`; `set_model {sessionId, model}` switches a live agent,
with `null` handing it back to the CLI's default. It is the worked twin of `set_autonomy` —
`Options.model` is fixed per `query()`, so the executor is restarted and resumed from
`claude_session_id` rather than mutated (`Query.setModel()` exists, but a restart is what makes the
stored model, the running model and the model a reboot would use one thing). Stored in
`sessions.model`; NULL means "no choice was made", which is *not* the same fact as any particular id.

The picker's shortlist is `AGENT_MODELS` in `packages/shared/src/protocol.ts` and the wire type is a
plain non-empty string, so an id we have never heard of still works. `Query.supportedModels()` (see
`server/notes/agent-sdk-api.md`) is the authoritative list for the installed CLI and could populate
this dynamically later.

## Roles (per agent)

A **role** is what an agent arrives as, and it is a **file** rather than a row: `roles/*.yaml` at the
repo root are the shipped presets (ten job roles plus `onboarding`, the one the factory puts on an
agent itself), `<data dir>/roles/*.yaml` override them by `id`, and an edited
file is picked up without a restart. `roles/README.md` is the format; `RoleSpec` in
`packages/shared/src/protocol.ts` is the schema and it is **`.strict()`** — an unknown field is an
error naming the file, because `skill:` for `skills:` would otherwise ship a preset whose whole point
silently never arrives. A malformed file is reported next to the list (`{kind:"roles", roles,
problems}`), never dropped from it.

`sessions.role_id` is the fourth member of the `autonomy`/`model`/`account_id` family — persisted,
re-applied on resume, changed by restarting the executor (`set_role`), and holding the *id* rather
than the charter so an edited preset is not frozen onto every agent created before it. Applying one
composes, in `SessionManager.startExecutor`:

- **prompt** — the role's `promptAppend`; an orchestrator keeps its own charter too, joined seat-first.
  (The room's own charter is its folder's `CLAUDE.md` and reaches the agent through
  `settingSources: ["project","local"]`, so nothing composes it here.)
- **model** — the role's, *only* when `sessions.model` is NULL. **An explicit operator choice always
  beats a preset**, and the role's model is never written onto the row: it is a suggestion, and
  freezing it would turn it into a choice nobody made. Same for `autonomy`, except that it is applied
  **only at creation** — raising what a running agent may do because someone picked a job title from a
  dropdown is not a decision the operator made.
- **tools** — the role's `mcpServers` merged with the factory's in-process bus, which is spread last
  and therefore **can never be removed or shadowed by a role**; an agent deaf to its own factory would
  look like an agent that simply never replies. `allowedTools` is the SDK's *auto-allow* list, i.e. a
  privilege grant, and none of the shipped presets uses it.
- **skills** — copied into `<room>/.claude/skills/<name>/` so the repository stays self-contained and a
  plain `claude` session in that folder gets them too. **A directory already there is never touched**
  (the charter's never-overwrite rule, applied to a folder), and a name that resolves to nothing on
  this machine is said out loud in the agent's own log rather than being a silent no-op.

## Onboarding (first contact)

Point the factory at a folder nobody has written down and an agent interviews you about it, writes its
`CLAUDE.md` and `README.md`, and proposes the first rooms. Four things decide the whole shape:

- **Un-onboarded means no `CLAUDE.md` at the project root.** That is the only test (`PROJECT_CHARTER_FILE`
  in the protocol; `OnboardingManager.isOnboarded` re-stats it on every ask, because the thing that
  changes it is an agent writing a file). No folder-contents heuristic, no file count — a guess would
  offer to interview someone about a repository they documented last year, and they could not correct
  it. Deleting the file is how you ask for the offer back.
- **The onboarder is an ordinary session with a role and a one-shot job**, exactly as the orchestrator
  is: `roles/onboarding.yaml` carries the charter, `start_onboarding` creates a session with that role
  in the project room and sends it one turn. No parallel runtime, same event log, same console. The
  charter says **one question per turn** in as many words — an agent that dumps twelve questions into
  one turn has failed the job the role exists for.
- **The rooms are a proposal.** `factory_suggest_rooms` — offered only to a session whose row carries
  the onboarding role — records a list and creates nothing: no folder, no row, no charter. The UI shows
  an accept/edit list; approving calls the ordinary `RoomManager.createRoom`, so name safety, root
  containment and never-overwriting-a-charter still hold *because it is the same code path*. A factory
  that reorganised itself on an interview's say-so is not what an operator wants on first contact. One
  refused name does not sink the rest: that suggestion stays `proposed` with the reason on it.
- **The docs are the agent's own work**, written with its own file tools into its own cwd (the project
  room's folder is the project root). There is no special write path, and there should not be one.

The UI surfaces it prominently **only** while the project is un-onboarded — plus an outstanding
proposal, which outranks everything because the interview writes the docs *before* it proposes rooms.
Once `CLAUDE.md` exists and nothing is waiting on a decision, the surface is gone.

**Do not invent skill names.** `SkillLibrary` resolves a name against the machine's own skill
directories (`~/.claude/skills`, the plugin caches; `SUPERFABRIC_SKILL_PATH` replaces the search path)
and a role referencing something that does not exist is worse than one referencing nothing.
`test/shippedRoles.test.ts` holds a verified list; adding a reference means adding an entry to it.

**The role files are YAML and cost no dependency**: Bun 1.3+ ships `Bun.YAML.parse`, typed by
`bun-types`, and the loader is server-side only. YAML rather than JSON because a charter written as a
JSON string literal with `\n` for every line break is a file nobody edits twice.

## Accounts and logging one in

An account is a `CLAUDE_CONFIG_DIR` on disk plus a row. Adding one creates the folder; logging in
fills it.

**The login is not a terminal, and that is a measurement rather than a preference.** The M2 plan
expected xterm.js over a PTY and expected `node-pty` to be unusable under Bun. Probing found
`node-pty` *does* work under Bun (N-API) but ships no Linux prebuild, so it would put `node-gyp`
back into `pnpm install`; that `script -qec` gives a PTY with no native module anyway; that
`claude setup-token` needs a TTY and issues an inference-only token the limit monitor could not use;
and that **`claude auth login` needs no TTY at all** — over plain pipes it prints its OAuth URL as
plain text and reads the code from stdin. So the flow is two fields: a link to open and a box for
the code. See `docs/decisions/0004-account-login-over-a-pipe.md` for the transcripts.

`AccountLoginManager` owns that conversation (`SpawnLogin` is the test seam — no test ever runs the
real CLI). `CredentialsWatcher` watches each config directory and lights an account up when
`.credentials.json` appears, so an operator who prefers `CLAUDE_CONFIG_DIR=… claude auth login` in
their own shell is served by the same mechanism; the UI shows that command, quoted and copyable,
next to the button. `credentialsPresent` is a **hint**, not a proof — on macOS the tokens may go to
the keychain instead — so a clean exit from the CLI counts as success too.

## Stack

pnpm workspaces (installs are always `pnpm`) · TypeScript · **Bun 1.3+ runs, tests and
stores for the server** (`bun src/index.ts`, `bun test`, `bun:sqlite` in WAL) · Fastify + ws ·
`@anthropic-ai/claude-agent-sdk` · zod 4 · **React 19 + Vite + vitest for the web** ·
react-three-fiber + drei · zustand · dockerode (M4). Node 22+ is still required — the web
toolchain and pnpm run on it.

Why two runtimes: `docs/decisions/0001-bun-runtime-keep-vite.md`. In short, Bun deletes the
native-module build step (`better-sqlite3`) and the `tsx`/`tsc && node dist` workarounds, while
Vite/vitest stay because vitest is Vite-native and the web bundle is small. Do not switch
installs to `bun install`, and do not introduce a second test runner inside a package: the
server package is `bun test`, `packages/shared` and `packages/web` are vitest.

**Dependency license policy**: third-party libraries **that ship in a build artifact**
must be MIT/Apache-2.0/BSD/ISC — no copyleft (GPL/AGPL/SSPL). Build-time-only tooling is
judged on whether its licence reaches our users: `lightningcss` (MPL-2.0, pulled by
`@tailwindcss/vite`) is accepted because it is an unmodified CSS transformer that ships
nothing into the bundle. File-level copyleft on a tool we do not modify obliges us
nothing; a copyleft library linked into the product would. One deliberate exception: Anthropic's own
`@anthropic-ai/claude-agent-sdk` (and the `claude` CLI it drives) are proprietary
("© Anthropic PBC, all rights reserved", governed by Anthropic's legal agreements). They
are the engine this product orchestrates, so the dependency is intrinsic; it is called
out in the README so users know what they're installing.

## Conventions

- Code, comments, commits, docs — English. Russian doc originals are `*.ru.md`.
- Spec-first: substantive design changes update the spec/architecture docs in the same
  PR as the code.

## Status

Design approved 2026-08-03. **Every milestone is complete as of 2026-08-04**: **M0** (core session
runner), **M1a** (rooms as folders and the 3D floor), **M1b** (several projects in one server,
settable room folders, attachments, and the HUD rebuilt on Tailwind v4 + Radix —
`docs/decisions/0003-ui-library.md`), **M1c** (the roles library and the onboarding agent), **M2**
(multi-account, the in-app login, the limit monitor and the pause/resume scheduler), **M3a** (the
factory bus, tasks, and packages that ride real messages), **M3b** (the orchestrator, task
auto-routing and the Chronicle), **M4** (a sandbox per room: the `agent-runner` image,
`ContainerExecutor`, and `rooms.runtime`) and **M5** (agents that fetch packages, an inhabited
factory, burn-rate metrics and factory export/import — **not** the glTF characters the roadmap
originally sketched; that was consciously changed and the reason is recorded in M5's section).
See `docs/ROADMAP.md` for the acceptance evidence of each, including the live onboarding
transcript and M4's isolation proofs from inside a running container.

**1355 tests green** (shared 88, server 813 + 1 skipped live-quota test, web 424, agent-runner 30).

**What is *not* built is listed at the end of `docs/ROADMAP.md`** and is worth reading before you
add a doc sentence that implies otherwise — there are no notifications off the browser tab, eleven
role presets rather than fifty, one provider behind the `Executor` seam, no folder picker, no
per-turn token counts, and no serialised OAuth refresh within a single account.

## Running it

```bash
pnpm install                      # pnpm, not bun install
pnpm -F @superfabric/server dev   # Fastify + ws on 127.0.0.1:4620 (bun --watch, no build step)
pnpm -F @superfabric/web dev      # Vite dev server, proxies /ws to the server
pnpm test                         # whole workspace (bun test for the server, vitest for the rest)
pnpm build                        # tsc everywhere + the web bundle; type-checks the server
SUPERFABRIC_LIVE_TEST=1 pnpm -F @superfabric/server test claudeExecutor.live  # real quota
```

`bun test` does not type-check, so `pnpm -F @superfabric/server build` (plain `tsc`) is what
catches type errors in the server — run it, not just the tests.

Server state lives in `.fabrica/fabrica.db` (override the directory with
`SUPERFABRIC_DATA`); port via `PORT`.

Container rooms additionally need the image, built once: `pnpm -F @superfabric/agent-runner image`
(a few minutes). Containers attach over `<data dir>/run/runner.sock` —
`SUPERFABRIC_RUNNER_SOCKET_DIR` moves it, which is what a data directory whose path exceeds a unix
socket's 100-odd characters needs. `SUPERFABRIC_CONTAINER_MEMORY_MB` / `_CPUS` / `_PIDS` change the
caps; `SUPERFABRIC_RUNNER_TCP_PORT` switches to the TCP fallback (and then needs the `ufw` rule the
README names).

### Bun gotchas worth knowing before you write server code

- **A missing row is `null`, not `undefined`.** `bun:sqlite`'s `stmt.get()` returns `null`
  when nothing matched (`better-sqlite3` returned `undefined`). Test row presence with
  `== null` / `!= null`, and type the cast `as Row | null`. Public helpers that return "not
  found" (e.g. `RoomManager.getRoom`) keep speaking `undefined`, so only the code touching a
  statement directly has to care.
- **There is no `db.pragma()`.** Read with `db.query("PRAGMA user_version").get()` (a one-row
  result object), write with `db.exec("PRAGMA journal_mode = WAL")`.
- **`bun:test`'s `vi` shim has no `vi.waitFor`** — use `test/_waitFor.ts`.
- **Bun's `ws` compatibility shim drops the client `origin` option** and never emits
  `unexpected-response`. Anything that must send an `Origin` uses Bun's native `WebSocket`
  with `{ headers: { Origin } }`, and anything that must see the handshake's HTTP status
  writes the upgrade request by hand (see `test/wsOrigin.test.ts`).

### Scene gotchas worth knowing before you touch the floor

- **A drei `<Html>` swallows the pointer, and `pointerEvents: "none"` on your own div does not
  stop it.** In non-transform mode drei renders three nested elements and only the innermost is
  yours: the wrapper it appends to the canvas container (whose `style.cssText` it assigns itself,
  with no `pointer-events`) and a div of its own carrying the `style` *prop*. Two hit-testable
  elements above your content mean a press on a label never reaches the canvas, so no raycast runs
  and the building under it cannot be selected or dragged — which is exactly how "перетаскивание
  сломано" happened once already. **Use `scene/SceneOverlay.tsx` for every DOM overlay in the
  scene**; a test in `test/sceneOverlay.test.ts` fails if a raw `<Html>` comes back. Anything in the
  scene that genuinely wants clicks belongs in the HUD.
- **No `distanceFactor` on this camera.** It is orthographic, so drei multiplies the overlay's
  scale by `camera.zoom`; at the opening zoom of 38 a 13 px label became a white rectangle over the
  whole floor.
- **Anything that moves must be in `hasMotion`,** or `frameloop="demand"` never renders it. The
  converse bites too: a status that is *not* motion (`starting` was one) pins the loop to `always`
  forever and an idle factory burns a core.
- **Debugging the scene in an automated browser: a hidden tab never sizes the canvas.** r3f measures
  with a `ResizeObserver`, which delivers nothing while `document.hidden`, so the canvas stays at
  its intrinsic 300×150 and every pointer coordinate lands somewhere else. Dispatch one
  `window.dispatchEvent(new Event("resize"))` before measuring anything. This is a property of the
  harness, not a bug in the app — do not go looking for it in `FactoryScene`.

## Layout

- `roles/` — the shipped role presets, one YAML file each (ten job roles plus `onboarding`), plus
  `roles/README.md` (the format, and how to write your own). Content, not code: an operator is meant
  to read and fork these.
- `packages/shared` — zod protocol shared by server and web (`SessionEvent`,
  `ClientMessage`, `ServerMessage`), plus `runner.ts` — the container↔server envelope, declared here
  because *both* ends validate it from one schema and `sdkEvents.ts` — the one SDK→`SessionEvent`
  mapping, here because there are now two hosts for a session and their transcripts must be
  byte-identical.
- `packages/agent-runner` — the program inside the container: one SDK `query()`, a bounded outbox
  that survives the socket going away, and the Dockerfile plus `init-firewall.sh` (whose allow-list
  is *ours*, not the reference devcontainer's — see its README).
- `packages/server` — `db.ts` (schema + `PRAGMA user_version` migrations; **the only file that
  names the SQLite driver** — everything else takes its `Db` type, so a driver swap stays a
  one-file change) · `origin.ts` (WebSocket
  origin allow-list) · `eventStore.ts` (append-only log + subscriptions)
  · `executor.ts` (provider seam) · `executors/claudeCode.ts` (Agent SDK, streaming input)
  · `executors/fake.ts` (scripted, for tests) · `projectManager.ts` (projects: the scope every
  listing is filtered by) · `roomManager.ts` (rooms as folders, charters, settable folders)
  · `accountManager.ts` (accounts: one `CLAUDE_CONFIG_DIR` each, machine-wide, duplicate directories
  refused) · `accountLogin.ts` (`claude auth login` over plain pipes — no PTY, no native module —
  plus the `.credentials.json` watcher)
  · `usageAdapters.ts` (the limit-reading seam: the OAuth usage endpoint, and the
  honestly-approximate JSONL estimate behind it) · `limitMonitor.ts` (per-account polling at the
  180 s floor, persisted snapshots, and the immediate mark from a 429) · `scheduler.ts` (80 % warn,
  95 % pause at a turn boundary, resume at `resets_at` — and no rotation, ever)
  · `roleLibrary.ts` (roles as files: the shipped `roles/*.yaml`, the operator's overrides, and a
  signature-based reload so an edited preset needs no restart) · `skills.ts` (resolving a skill name
  against the machine's own skill directories, and copying one into a room's `.claude/skills/`
  without ever overwriting what is there)
  · `runnerHub.ts` (the server end of the runner protocol: the token check, frames applied once,
  approvals idempotent by `requestId`) · `runnerListener.ts` (the unix socket, and the opt-in TCP
  fallback) · `executors/container.ts` (`ContainerExecutor`: the mounts, the caps, re-attaching to a
  container that outlived the server, and the orphan reaper)
  · `sessionManager.ts` (sessions, approvals, resume/stopAll, per-session bus tools, flush at
  each turn boundary, and choosing an executor from the room's runtime) · `factoryBus.ts` (durable inter-room messages, push delivery) ·
  `busTools.ts` (the bus as an in-process MCP server, one per session's room — seven tools for a
  room, nine for the orchestrator) · `orchestrator.ts` (the role prompt, and `ensureOrchestrator`:
  the only supported way to make one) · `onboarding.ts` (first contact: whether a project has been
  written down, the interview as an ordinary roled session in the project room, and the room
  *proposals* — recorded by a tool, turned into folders only by the operator, through `createRoom`)
  · `router.ts` (routing as a bus round trip — ask, and move
  the card only when it answers) · `chronicle.ts` (ADR files in the project's own
  `docs/decisions/`, plus one FTS5 query spanning decisions **and** the event log; the triggers in
  `db.ts` keep the index in step, not this class) ·
  `metricsStore.ts` (M5: the burn rate as the least-squares slope of `usage_snapshots`, and
  cost reconstructed from a **cumulative** `costUsd` — no pricing table anywhere, and "unknown"
  rather than a guess when there is too little history) ·
  `factoryPortability.ts` (M5: a factory as one portable file with no credential and no absolute
  path in it, and an import that goes through `createRoom` and reports what it could not do) ·
  `taskStore.ts` (the task board; announces its own changes) ·
  `attachmentStore.ts` (files in, paths out: filename sanitising, MIME→extension, containment
  against whichever root the file is going into, and never overwriting) ·
  `attachmentRoutes.ts` (`POST /attachments`, multipart, behind the **same** origin allow-list as
  the WebSocket handshake) · `wsHub.ts` (replay-then-tail plus
  debounced `sessions`/`rooms`/`tasks`/`messages`/`accounts`/`usage`/`metrics`/`onboarding`
  broadcasts, and `notice` for "it worked") ·
  `index.ts` (wiring only) ·
  `notes/agent-sdk-api.md` (verified SDK API reference — trust it over memory).
  Its tests run under `bun test` (`test/_waitFor.ts` replaces `vi.waitFor`); `packages/shared`
  and `packages/web` stay on vitest.
- `packages/web` — `store.ts` (zustand: dedupes replays, and turns the bus's message snapshot into
  packages and waiting crates) · `wsClient.ts` (reconnect + resubscribe from `lastSeq`) ·
  `attachments.ts` (upload over HTTP, stage the returned paths, and `composeTurn` — the pure
  function that decides what an agent is actually told about a file) ·
  `gist.ts` (one line about a tool call — **one** summariser, shared by the console's transcript
  and the thought bubble over a figure's head, so the same `Bash` call cannot read two ways) ·
  `App.tsx` (the 3D floor plus three HUD edges) ·
  `scene/*` (the floor: `Building`/`Buildings`, `Conveyor` + `conveyorPath.ts`, `Packages`,
  `StatusBeacon`, `Agents`, `Floor`, `lighting`, `CameraFraming`, `RoomDrag`, `palette.ts`,
  `layout.ts` — plus M5's `errands.ts` (which agent fetches a crate, where the path runs, and what
  happens when nobody is free — pure, so it is tested without a canvas), `BayPile.tsx` (the crates a
  room with nobody home visibly stacks), `Chimney.tsx` + `atmosphere.ts` (a plume while a room
  works, fading after it stops), `props.ts`/`Props.tsx` (per-room props that reflect the work),
  `roleLook.ts` (a distinct figure per role) and `bubble.ts` (what an agent is doing, over its
  head)) ·
  `hud/*` (room panel,
  console drawer, task board, the chronicle popover, the account switcher and its login flow
  (`TopLeftBar` places it beside the project switcher), the per-account limit meters inside that
  popover (`UsageMeters.tsx` — hatched bars and a `≈` wherever a figure is a guess) and the
  burn rate and cost-equivalent under them plus this factory's spend by room (`BurnRate.tsx` —
  a duration at a resolution the readings support, and "Time left: unknown" with the server's
  reason in the place the figure would have been),
  export/import in the project switcher (`FactoryTransfer.tsx` — the import's *problems* list is
  the point of the surface and stays up until dismissed; the download happens in an effect,
  because writing a file is a DOM side effect and the store is a reducer),
  window-wide paste/drop target, the one `NoticeBar`, and `Panel.tsx`
  — the shared collapsible edge-panel chrome all three edges are built from) ·
  the role picker (`RoleSelect.tsx` — name plus its one-line summary, on the room panel's
  "New agents arrive as" line and on every agent row),
  `Onboarding.tsx` (first contact, over the floor: the offer on an un-onboarded project, the
  "under way" strip, and the accept/edit room list — `onboardingSurface` is the one pure function
  that decides which of the four, so "prominent only when un-onboarded" is testable),
  `ui/*` (shadcn components vendored as our own source: button, input, select, popover, badge).
  **Styling is Tailwind v4** (`src/index.css`, `@theme`, no config file). Chrome colours are
  declared there and are deliberately neutral; every colour that *means* something —
  the five statuses, selection, bypass — is generated from `scene/palette.ts` by
  `hud/tokens.ts` and referenced as a CSS variable, so the HUD and the floor cannot disagree.
  Never re-type one of those hexes. `paused` is the fifth and is deliberately *quiet* — a cold dark
  slate read against `idle` by temperature and value, not a fourth alarm colour — but it outranks
  `working` in a room's beacon, because a half-stopped room is the half nobody would otherwise
  notice.
