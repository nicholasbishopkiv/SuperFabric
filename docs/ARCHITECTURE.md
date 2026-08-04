# Fabrica — Architecture

Status: **draft for review** (2026-08-03). Canonical decisions live in the design spec
(`docs/superpowers/specs/2026-08-03-fabrica-design.md`); this file is the technical map.

## 1. System overview

```
┌──────────────────  Browser (React + react-three-fiber, 3D + DOM overlay)  ────────────┐
│  3D factory floor: project building, room workshops, conveyors carrying packages      │
│  2D overlay: task panel, per-account limit meters, approval cards, agent chat          │
└───────────────▲───────────────────────────────────────────────────────────────────────┘
                │ one WebSocket, {sessionId, seq} multiplexed; replay-then-tail
┌───────────────┴───────────────  Fabrica Server (Bun/TS)  ─────────────────────────────┐
│  Fastify + ws        SQLite (bun:sqlite, WAL)            dockerode (phase M4)         │
│                                                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │ SessionMgr  │  │ Factory Bus  │  │ TaskStore   │  │ LimitMonitor │  │ AccountMgr│ │
│  │ Agent SDK   │  │ in-proc MCP  │  │ tasks,      │  │ /api/oauth/  │  │ CLAUDE_   │ │
│  │ query() per │  │ send/inbox/  │  │ statuses,   │  │ usage poller │  │ CONFIG_DIR│ │
│  │ agent, WAL  │  │ report,      │  │ blockers    │  │ + 429 catch  │  │ per acct  │ │
│  │ event log   │  │ push-inject  │  │             │  │ + scheduler  │  │ + login   │ │
│  └──────┬──────┘  └──────────────┘  └─────────────┘  └──────────────┘  └───────────┘ │
└─────────┼─────────────────────────────────────────────────────────────────────────────┘
          │ M0–M3: host subprocesses (per-account CLAUDE_CONFIG_DIR)
          │ M4: docker containers (agent-runner image, firewall, resource limits)
          ▼
   Claude Code sessions (one per agent) ──► project workspace (rooms = subfolders)
```

## 2. Components

### 2.1 Server (`packages/server`)
Bun 1.3+, TypeScript, Fastify. Owns everything stateful. Bun runs the TypeScript entrypoint
directly (no build step), runs the tests (`bun test`), and provides the SQLite driver
(`bun:sqlite`); `src/db.ts` is the only file that names it. Rationale and the measured
evidence: `docs/decisions/0001-bun-runtime-keep-vite.md`.

- **SessionManager** — one `query()` from `@anthropic-ai/claude-agent-sdk` per agent, in
  **streaming-input mode** (AsyncIterable prompt): the session stays alive and the server
  feeds it turns (user messages, bus messages, orchestrator directives). Exposes
  `interrupt()`. (An autonomy change restarts the query with the new mode rather than
  calling the SDK's `setPermissionMode()`, because `bypass` needs a spawn-time flag that
  cannot be added to a running query.) Captures `session_id` from the init message and
  persists it → restart recovery via `options.resume`. `canUseTool` callback is forwarded
  to the browser as an approval card (with per-room auto-approve policies).
- **Event log** — append-only SQLite table `events(session_id, seq, ts, type, payload)`.
  Source of truth for the UI; the WebSocket is a lossy tail. Client reconnect sends
  `{sessionId, afterSeq}` and replays. (Pattern proven by Vibe Kanban's MsgStore and
  Crystal's SQLite buffering.)
- **Factory Bus** (`src/factoryBus.ts`, built in M3a) — inter-room messaging. Messages persist in
  SQLite (`messages`, migration 4) **before** anything is delivered, so a message survives a crash
  mid-delivery. **Delivery is push**: a message for an available agent is injected as a turn
  immediately; one for a busy agent waits until `SessionManager` calls `flushRoom` at that room's
  next `turn_complete`. No polling loops burning tokens. One message drains per boundary, so a
  queue of N takes N boundaries. The bus knows nothing about `SessionManager` — it takes a
  `deliver(sessionId, text)` callback and a `roomAgents(roomId)` lookup, which keeps the
  dependency one-way and the delivery rules unit-testable without a session runner.
  - The tool surface is separate (`src/busTools.ts`): an **in-process MCP server**
    (`createSdkMcpServer`) built **per session from that session's room** and passed through
    `ExecutorStartOptions.mcpServers`. Tools: `factory_send(to_room, kind, body, task_id?)`,
    `factory_inbox()`, `factory_task_update(task_id, status?, detail?)`,
    `factory_report_status(summary)`, `factory_ask_orchestrator(question, task_id?)`, plus the
    Chronicle's `factory_record_decision(...)` and `factory_search_history(query)` (M3b). The
    orchestrator's session gets two more (`factory_assign_task`, `factory_list_rooms`), so a room
    agent is offered seven `mcp__factory__*` tools and the orchestrator nine. The model sees them
    namespaced as `mcp__factory__*`.
  - **The sending room is never read from tool input** — it comes from the session row, so an
    agent cannot send a message *as* another department. A roomless session gets no bus tools.
  - These tools are **not gated**: `canUseTool` allows anything belonging to this session's own
    in-process servers without asking the operator, and records the call as a `tool_use` event.
    Everything else still raises a card. See `docs/decisions/0002-factory-tools-are-not-gated.md`.
- **TaskStore** (`src/taskStore.ts`) — `tasks(id, title, detail, status, room_id, agent_id,
  blocked_on_message_id, …)`, migration 4. Refuses a card that would lie: an unknown room, or an
  assignee who does not work in the task's room. Agents mutate it through the bus tools and the
  operator through `create_task`/`update_task`; either way the store announces its own changes and
  the hub broadcasts the board, because most changes never pass through the hub. The UI renders a
  bottom-edge board plus per-room badges. A task with no room is **unassigned**; with an
  orchestrator on the floor the card carries a "route it" affordance and `create_task` starts the
  round trip on its own, and without one it stays unassigned and says so. Nothing fabricates an
  assignment.
- **Orchestrator** (`src/orchestrator.ts`, `src/router.ts`, M3b) — **a session with a role, not a
  new runtime**: an ordinary session in the project room with `sessions.is_orchestrator = 1`
  (migration 7), one per project, its own system-prompt append (`ORCHESTRATOR_SYSTEM_PROMPT`) and
  the two extra tools. `ensure_orchestrator` is the only supported way to make one — a hand-built
  session in the right room would still be missing the role prompt and the tool surface.
  **Routing is a bus round trip**: a task with no room becomes a `request` from the project room to
  itself describing the task and every room's charter summary; the orchestrator answers with
  `factory_assign_task`, which moves the card and delivers an `info` message to the receiving room.
  With no orchestrator nothing is sent and nothing changes.
- **LimitMonitor** (`limitMonitor.ts`) + **the usage adapters** (`usageAdapters.ts`) — per account,
  behind a seam, because **the source is undocumented and has already changed under us**.
  - *Primary*: `GET https://api.anthropic.com/api/oauth/usage` with that account's bearer from
    `.credentials.json`, `anthropic-beta: oauth-2025-04-20` and a `claude-code/<version>`
    User-Agent, **floored at 180 s per account** — a monitor that earns a 429 causes the condition
    it exists to watch for. Verified live on 2026-08-04: `five_hour` and `seven_day` carry
    `{utilization, resets_at}`; `seven_day_opus`/`seven_day_sonnet` are *present and null*; the
    per-model weekly figures now live in `limits[]` as
    `{kind, group, percent, severity, resets_at, scope: {model: {display_name}}}`, alongside a
    dozen nullable code-named buckets. `parseUsagePayload` reads both that and the shape
    `docs/RESEARCH.md` §2 documents, takes windows whose `kind` it has never heard of, and
    **degrades rather than crashing**: a half-understood body yields the meters it could read plus
    a note counting the fields it could not. Understanding nothing is the only failure.
  - *Fallback*: an estimate counted from the account's own JSONL transcripts. Marked
    `approximate` on the wire and on screen — it cannot see other devices, does not know when the
    real window began, and is measured against a budget we assumed.
  - Readings persist to `usage_snapshots` (migration 10), so a restart does not blank the meters —
    an empty meter reads as a fresh window, which is the wrong direction to be wrong in. A 429 from
    any live session marks the account immediately (`limitedBy: "rate_limit_error"`) rather than
    waiting up to three minutes for the poller.
- **LimitScheduler** (`scheduler.ts`) — utilisation into action. Warn at **80 %** with a short
  system-style turn to that account's agents; pause at **95 %** at the agent's next
  `turn_complete` (never mid-turn: the turn's tokens are already spent), persisting
  `sessions.state='paused'` + `paused_at`/`paused_until` (migration 11) so `resumeAll` does not
  resurrect a held agent and the countdown survives a restart; resume at `resets_at` through
  `options.resume`, and tell the agent it was paused. Each threshold fires once per *window
  instance* (`account|window|resets_at`), not per poll.
  **Two refusals**: it never pauses on an approximate reading (a guess must not stop an agent that
  had quota left — a 429 is not a guess and does pause), and it **never moves an agent to another
  account**. An exhausted subscription's agents wait for its window; rotation is the ToS line
  (§6, `docs/RESEARCH.md` §5).
- **AccountManager** (`accountManager.ts`) — registry of accounts, **machine-wide rather than
  per project**: a subscription is the operator's and serves every floor, so the per-project choice
  is the *binding* (`rooms.account_id` as a default for new agents, `sessions.account_id` as what an
  agent actually runs on). Each account = a dedicated `CLAUDE_CONFIG_DIR`; **one directory is one
  account**, refused by `create` and by a UNIQUE column, with the path canonicalised through
  `realpath` first (refresh tokens rewrite in place, so two accounts sharing a directory would log
  each other out days later with nothing in any log to explain it).
  **Login flow** (`accountLogin.ts`) — *not* the embedded terminal this document originally
  planned. Probing found `claude auth login` needs no TTY at all: over plain pipes it prints its
  OAuth URL and reads the code from stdin, so the flow is a link and a text box — no `node-pty`, no
  xterm.js, no `node-gyp`. `claude setup-token` was rejected: it needs a TTY *and* issues a
  `user:inference`-only token that would not carry the usage endpoint. `CredentialsWatcher` lights
  an account up when `.credentials.json` appears, which also covers an operator who logs in from
  their own shell. See `docs/decisions/0004-account-login-over-a-pipe.md`.
- **Executor abstraction** — SessionManager talks to agents through an `Executor`
  interface (start/steer/interrupt/resume/events), not to the Agent SDK directly.
  v1 ships `ClaudeCodeExecutor` only; the interface exists from M0 so that post-v1
  executors (Codex / ChatGPT agents, Antigravity / Gemini, etc.) plug in without
  reworking the core — different providers for different tasks. (Pattern proven by
  Vibe Kanban's executor profiles.)
- **Onboarder** — special short-lived session that interviews the user (via UI chat) and
  writes CLAUDE.md / README / room docs for a fresh project.
- **Chronicle** — the project's decision memory: a persistent, queryable record of
  *why* things were done one way and not another. Two layers:
  1. **Decision records as files** — `docs/decisions/NNNN-<slug>.md` (ADR-style: title,
     context, decision, alternatives rejected + why, links to tasks/files/commits).
     Repo-native: readable and greppable by any agent (or human) even without
     SuperFabric running.
  2. **SQLite index with FTS5** — `decisions` table + full-text search over decisions
     *and* the prompt/event history (every prompt and agent turn already persists in
     the event log; Chronicle makes it searchable).
  Agents interact via bus tools: `factory_record_decision(...)` (role prompts instruct
  agents to record at meaningful choice points; the orchestrator records direction
  decisions) and `factory_search_history(query)` (consult before reworking anything).
  Built in M3b (`src/chronicle.ts`, migration 8). The ADR file is written **before** the row, and
  its number is claimed by creating the file with `wx` — so two decisions in the same second cost a
  number rather than a file, and the numbering continues from whatever is already in the folder
  (a repository whose humans wrote 0001–0003 by hand continues at 0004). The FTS5 index is kept in
  step by triggers on `decisions` and `events`, not by this class, so every write path is covered
  by construction — including an `EventStore.append` that has never heard of the Chronicle.
  The operator searches the same index over the wire (`search_chronicle` → `chronicle`), shown in a
  popover off the top strip; an empty query answers with the newest decisions.
- **RoleLibrary** — catalog of role presets shipping with Fabrica (architect, designer,
  backend dev, QA, DevOps, tech writer, …). A preset bundles: role system-prompt append,
  recommended skills (e.g. superpowers, impeccable for UI roles), plugins/MCP servers,
  allowed-tools profile, and a recommended model. Assigning a role to an agent offers
  one-click attachment of the bundle; presets are plain files (`roles/*.yaml` in the
  Fabrica repo + user overrides in `.fabrica/roles/`), customizable and shareable.
  Skills/plugins install into the room's `.claude/` so the repo stays self-contained.
- **Per-agent autonomy** — alongside the role bundle, every session carries an `autonomy` field
  (`attended` | `auto` | `bypass`, persisted in `sessions.autonomy` and re-applied on resume) that
  maps to the Agent SDK's `permissionMode` inside the executor. `auto` is the default: the CLI's
  classifier decides, and only escalated calls raise an approval card. `bypass` gates nothing and
  is a deliberate per-agent opt-in — the M4 container sandbox (below) is the precondition for using
  it routinely, since it is exactly the `--dangerously-skip-permissions` posture that only becomes
  safe inside a sandboxed room.

### 2.2 Web (`packages/web`)
React 19 + Vite + **react-three-fiber (Three.js) + drei** (all MIT) + zustand.

Two layers, by explicit product decision — the factory must *look like a factory*:

- **3D scene (WebGL)** — isometric factory floor: the project block is the main
  building, rooms are workshop buildings, inter-room links are **conveyor paths**
  (`CatmullRomCurve3` splines) with package meshes animating along them when messages
  flow. Agent status renders on the buildings (lights/smoke/badges); later milestones
  add small animated agent characters (glTF + AnimationMixer) working inside rooms.
  Camera: orthographic, opening on an isometric view, with `MapControls` — pan, zoom
  (2…400), orbit and tilt, the tilt clamped just above the horizon so the camera can
  never go under the floor. Perf discipline:
  instanced meshes for packages, zustand per-object selectors (never re-render the
  scene tree on a status tick), frameloop="demand" when idle.
- **2D overlay (DOM)** — React above the canvas, on Tailwind v4 and Radix primitives vendored into
  `packages/web/src/ui/` (see `docs/decisions/0003-ui-library.md`). Dark, translucent and blurred,
  because it floats over a live floor; each of the three edge panels is the same collapsible shell
  (`hud/Panel.tsx`) and reports its own size into `hudInsets`, which is what the camera frames into.
  Semantic colour is not the overlay's to invent: `hud/tokens.ts` publishes `scene/palette.ts` as
  CSS variables, so a panel and a beacon cannot disagree. Surfaces: **task panel** (manual task
  entry; leaving "department" empty routes the task to the orchestrator, which
  analyzes it, picks the room and assignee, and dispatches it), **chronicle search** (a popover in
  the free top strip, mirroring the project switcher — not a fourth edge panel, because the middle
  of the screen is the product), limit meters (per
  account: 5h + weekly + per-model, reset countdowns; an estimate is hatched and carries a `≈`,
  a badge and its reason, because a guess shown as a measurement is worse than a gap), approval
  cards, agent chat drawer,
  orchestrator console. Labels pinned to buildings use drei `<Html>`.
  The **orchestrator is marked on the floor rather than in a widget of its own**: it is an agent in
  the project room, so its figure carries a standard, its helmet is the project block's slate, the
  building's label says "orchestrator" and the room row flags it. The marker is a *shape* — the
  floor's colour vocabulary (four statuses, bypass magenta, selection cyan) is full, and a seventh
  meaning would slow down reading the four that matter.

React Flow was the initial 2D recommendation from research; superseded by the 3D
directive. If a lightweight "schematic mode" is ever wanted, it can be a camera-top-down
rendering of the same scene graph — not a second UI stack.

#### Art direction contracts (M1a)

Four rules the scene is built on. They exist because "it works" and "it looks like a factory"
turned out to be different problems, and the second one is easy to lose one commit at a time.

1. **One palette.** `scene/palette.ts` is the only place a colour is written down — the concrete,
   the buildings, the lighting rig's warm/cool split, the belts, the packages and the status table.
   A hex in a component is a bug.
2. **Status wins every read.** The four `FactoryStatus` colours are load-bearing semantics.
   Everything else on the floor is decoration and must lose to them: the status colours are the
   only saturated colours in the scene, and per-room accent hues are constrained to 190°–300° —
   a band containing no status hue and nothing confusable with one — at well under any status
   colour's saturation. Both claims are asserted against the status table in
   `web/test/scene.test.ts`, so widening the accent band into a semantic fails a test.
3. **Selection adds, never replaces.** A selected building keeps its own colour and gains a rim,
   a ground ring and a label border. Repainting it destroys the information it was selected to read.
4. **The frameloop gate is absolute.** `hasMotion` (any working agent, any package in flight, any
   drag) is the only thing that may put the canvas on `"always"`. Anything decorative must either
   be gated by it or need no frames at all — which is why the beacons' glow is a `THREE.Sprite`
   (billboarded by the renderer, correct at every camera angle, zero per-frame JavaScript) rather
   than a `<Billboard>`, and why soft shadows are a shadow-map property rather than a per-frame
   pass. Camera input is the one thing outside `hasMotion` that needs frames, and it asks for them
   itself: the controls' `change` event calls `invalidate()`, one frame per change.

The camera frames the floor itself (`isoFraming`: the screen-space bounding box of every building,
fitted into the rectangle the HUD panels leave uncovered, whose widths the panels report into the
store) and **stops the first time the operator touches the camera** — pan, zoom, orbit or tilt. The
`fit` control (and `f`) is the one documented way to hand it back, and it restores the opening
*orientation* as well as the framing: `isoFraming` solves the fit for the default isometric angle,
so fitting is deliberately "put the floor plan back" rather than "keep my angle". The ground plane
and the slab are sized for the widest zoom, so the edge of the world is never the thing on screen.

### 2.3 Shared (`packages/shared`)
Protocol types: WS envelopes, event payloads, bus message schema, task schema. Zod.

### 2.4 Agent runtime placement
- **M0–M3**: sessions run as host subprocesses under the server. Isolation = per-account
  `CLAUDE_CONFIG_DIR` + per-room cwd + permission modes. Fast to build, easy to debug.
- **M4**: `agent-runner` Docker image (Node + Agent SDK + claude), one container per room
  (or per agent), driven by dockerode; account config dir mounted read-write (one
  account's volume only), project workspace bind-mounted, default-deny egress firewall
  from Anthropic's reference devcontainer (`init-firewall.sh`), `Memory/NanoCpus/
  PidsLimit` caps, `--dangerously-skip-permissions` becomes safe inside the sandbox.
  Runner speaks WS back to the server (same event protocol).

### 2.5 Projects, room folders and attachments (M1b)

- **ProjectManager** — a `projects` table (`id`, `name`, `root`, `last_opened_at`) and a
  `project_id` on rooms, sessions, tasks and messages. One SuperFabric serves many
  factories; switching is a client-side scope change plus a re-scoped set of broadcasts,
  not a server restart. `SUPERFABRIC_PROJECT` seeds the first project and stops being the
  only one that can exist. Everything the operator sees — floor, board, chronicle — is
  filtered by the active project.
- **Room folders are settable.** A room still defaults to `<project>/<name>/`, but its
  `path` may point anywhere, so a department can live in a separate repository. The
  containment check that protects the default case does not apply to an explicitly chosen
  folder; adopting one never overwrites an existing `CLAUDE.md`.
- **AttachmentStore** — files arrive from the browser by paste, drop or upload and are
  written into `<project or room folder>/attachments/`. **The agent is given the path, never
  the bytes**: an attachment becomes a line in the injected turn (`Attached file: <absolute
  path>`) pointing at a file on disk, which is what an agent with file tools actually wants
  and what keeps the event log small. Clipboard images get a generated name
  (`pasted-<timestamp>.<ext>`) with a real extension taken from the declared MIME type.
  Details that are decisions, not implementation:
  - **Transport is `POST /attachments`, not the WebSocket.** The socket's protocol is JSON
    and its `maxPayload` is deliberately 1 MiB, so binary there would mean base64 in one
    giant frame. Fastify is already listening on the same port.
  - **The endpoint is gated exactly as hard as the WebSocket handshake**: the same
    `origin.ts` allow-list (403 on a disallowed browser `Origin`, checked in `onRequest`
    before the body is read), a 25 MB per-file cap enforced three times (`content-length`,
    the streaming multipart limit, the real byte count), an untrusted filename folded to one
    safe path segment, the resolved path re-checked against the destination root, and no
    overwriting ever — a taken name is uniquified (`shot-2.png`).
  - **Containment is against the room's own root.** A room folder may live outside the
    project root, so there is no single directory to validate against; each write is checked
    against the root it is going into.
  - **Multipart is parsed by `@fastify/multipart`**, not by Bun's own `Request.formData()`:
    Bun's discards each part's `Content-Type` and re-derives it from the filename extension,
    which is exactly backwards for a clipboard image (no filename, type is all there is).
- **`notice` on the wire.** The protocol had one channel for talking to the operator —
  `error` — so every "this worked, here is what happened" either travelled on it (a
  successful `set_room_path` once did, painted red) or was guessed at by the UI. A
  `notice {message}` server message now carries both that and "attachment saved to `<path>`".
  Not persisted: it is a fact about the request that just completed, not an event in a log.

## 3. Filesystem contract

```
<project-root>/
  CLAUDE.md                  # project-wide context (Onboarder creates if missing)
  .fabrica/                  # factory state: fabrica.db (SQLite), layout.json, accounts.json (no secrets)
  attachments/               # files the operator pasted, dropped or uploaded at the project
  backend/                   # a room
    CLAUDE.md                # room charter: responsibility, interfaces, conventions
    .claude/agents/*.md      # room subagents, skills
    attachments/             # …or at this room, when it was the selected one
    ...code...
  frontend/ ...
```

Room = folder. Deleting Fabrica leaves a normal repo. Room agents run with `cwd` =
room folder and `--add-dir` for explicitly shared paths.

## 4. Key flows

**Inter-room request** (built and run live in M3a): chat-agent calls
`factory_send("payments", "request", "need webhook X for push notifications")` → row in
`messages` → server injects the turn into the payments agent's input (immediately if it is free,
otherwise at its next turn boundary) → payments agent works and replies
`factory_send("chat", "response", ...)` → each delivery is broadcast and the web store turns it
into a package mesh travelling the conveyor, keyed by the message id; an undelivered message is
drawn instead as a still crate stacked at the sender's door. A `request` naming a `task_id` sets
that task `blocked` on the message and a `response` releases it.

**Manual task with auto-routing** (built and run live in M3b): user adds a task in the task panel
without picking a room (or presses "route it" on an unassigned card) → `TaskRouter` sends the
project room a `request` describing the task and every room's charter → the orchestrator reads it
as an injected turn, calls `mcp__factory__factory_assign_task(task_id, room)` → the card moves on
the board and an `info` message is delivered as a turn in the receiving room → a package leaves the
main building for that workshop. The card stays visibly unassigned until the orchestrator actually
answers; routing is a model decision, so nothing pretends it has been made.

**Limit warn/pause/resume**: LimitMonitor reads account B at 84 % → the scheduler injects one
short turn into every agent on B ("bring what you are doing to a safe stopping point"), once for
that window instance. At 96 % it *arms* a pause on each of them; an agent mid-turn keeps running and
the log says so, and the pause lands on its `turn_complete` — `state='paused'`, `paused_until` = the
window's `resets_at`, executor stopped, the floor's beacon goes to the `paused` slate and the agent's
row counts down. Agents on account A are untouched: a different subscription is a different quota,
and nobody is moved. At `resets_at` (or as soon as a reading *taken after the pause* says the window
rolled) the scheduler restarts exactly those sessions with `options.resume` on the same config dir
and injects "you were paused… this is the same conversation, carry on".

**Crash recovery**: on boot, server reads `sessions` table, resumes every session marked
active (`options.resume` + JSONL transcripts persisted in each account's config dir).

## 5. Stack summary

| Concern | Choice | Why |
|---|---|---|
| Canvas | react-three-fiber + drei (Three.js) | MIT; true 3D factory (buildings, conveyors, packages, later agent characters) + DOM overlay for 2D panels; React Flow superseded by the 3D directive, tldraw rejected (license) |
| Agent driving | TS Agent SDK, streaming-input | multi-turn steering, interrupt, resume, canUseTool, in-process MCP |
| Transport | WebSocket (ws), multiplexed | bidirectional (approvals/interrupts), unanimous in prior art |
| Server runtime | Bun 1.3+ (web stays on Node 22+ / Vite) | runs TS directly and ships SQLite, so no `tsx` and no native module; vitest is Vite-native so the web keeps Vite — see decision 0001 |
| State | SQLite via `bun:sqlite`, WAL | single-node self-hosted; event-log replay pattern; built into the runtime, so nothing to compile |
| Containers | dockerode + Anthropic devcontainer firewall | official blessed pattern for `--dangerously-skip-permissions` |
| Limits | OAuth usage endpoint + 429 + JSONL fallback | authoritative cross-device data; est.-only tools proven inaccurate |
| Monorepo | pnpm workspaces | server/web/shared/agent-runner |

## 6. Risks

| Risk | Mitigation |
|---|---|
| `/api/oauth/usage` is undocumented, may change | Adapter interface; JSONL estimation fallback; feature-flag |
| ToS: headless subscription use | Personal accounts only, no pooling/rotation-as-a-service, no shared credentials; document clearly; API-key fallback exists |
| Headless OAuth login impossible in container | Login happens out-of-band on host (hidden PTY flow); containers only mount ready profiles |
| Concurrent token refresh across sessions of one account | One config dir per account shared by its sessions; serialize refresh via server-side lock; monitor for invalidation |
| SDK/CLI breaking changes (fast-moving) | Pin versions; executor abstraction layer (Vibe Kanban pattern) so CLI-flags path can replace SDK if needed |
| 3D scene perf with many live updates | instanced meshes, zustand per-object selectors, demand frameloop; art style is low-poly stylized (cheap to render and to produce) |
| 3D asset production (buildings, packages, characters) | start with primitive/procedural low-poly geometry, introduce glTF assets incrementally; overlay panels carry the information load so the scene can stay simple |
