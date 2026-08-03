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
    `factory_report_status(summary)`. `factory_ask_orchestrator` arrives with the orchestrator
    (M3b). The model sees them namespaced as `mcp__factory__*`.
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
  bottom-edge board plus per-room badges. A task with no room is **unassigned**, which is the
  intended state until the orchestrator (M3b) can route it.
- **LimitMonitor** — per account: polls `GET https://api.anthropic.com/api/oauth/usage`
  (bearer from that account's `.credentials.json`, `anthropic-beta: oauth-2025-04-20`,
  claude-code User-Agent, ~180s interval). Reads `five_hour`, `seven_day`,
  `seven_day_opus/sonnet` → `utilization` + `resets_at`. Also catches 429/limit errors
  from sessions. **Scheduler policy**: warn agents at 80% (inject system-reminder turn),
  pause account at 95% (interrupt sessions, persist session_ids, show countdown), resume
  automatically at `resets_at` via `options.resume`. Endpoint is undocumented → wrap in
  an adapter with JSONL-estimation fallback (ccusage-style).
- **AccountManager** — registry of accounts. Each account = a dedicated
  `CLAUDE_CONFIG_DIR` (one volume/dir per account; never share across accounts, refresh
  tokens rewrite in place). **Login flow ("Add session" button)**: the UI opens an
  embedded terminal (xterm.js in the browser ↔ node-pty over the WS) running `claude`
  against a fresh profile dir; the user completes login exactly as in a normal
  terminal; the server watches for `.credentials.json` and registers the account.
  Fallback: `claude setup-token` → long-lived `CLAUDE_CODE_OAUTH_TOKEN`. When creating
  a room or agent, the user picks which registered account (session pool) it runs
  under.
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
  The UI shows a chronicle timeline and per-room decision lists.
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
  Camera: orthographic isometric with `MapControls` (pan/zoom). Perf discipline:
  instanced meshes for packages, zustand per-object selectors (never re-render the
  scene tree on a status tick), frameloop="demand" when idle.
- **2D overlay (DOM)** — React above the canvas, built on a component library rather than hand-rolled inline styles (see `docs/decisions/0003-ui-library.md`): **task panel** (manual task
  entry; leaving "department" empty routes the task to the orchestrator, which
  analyzes it, picks the room and assignee, and dispatches it), limit meters (per
  account: 5h + weekly + per-model, reset timers), approval cards, agent chat drawer,
  orchestrator console. Labels pinned to buildings use drei `<Html>`.

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
   be gated by it or need no frames at all — which is why the beacons' glow is a quad at a
   *constant* orientation (the camera cannot rotate) rather than a `<Billboard>`, and why soft
   shadows are a shadow-map property rather than a per-frame pass.

The camera frames the floor itself (`isoFraming`: the screen-space bounding box of every building,
fitted into the rectangle the HUD panels leave uncovered, whose widths the panels report into the
store) and **stops the first time the operator pans or zooms**. The `fit` control (and `f`) is the
one documented way to hand it back.

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
  written into the project (or the selected room's) folder under a predictable
  subdirectory. **The agent is given the path, never the bytes**: an attachment becomes a
  line in the injected turn pointing at a file on disk, which is what an agent with file
  tools actually wants and what keeps the event log small. Clipboard images get a
  generated name and a real extension sniffed from the payload.

## 3. Filesystem contract

```
<project-root>/
  CLAUDE.md                  # project-wide context (Onboarder creates if missing)
  .fabrica/                  # factory state: fabrica.db (SQLite), layout.json, accounts.json (no secrets)
  backend/                   # a room
    CLAUDE.md                # room charter: responsibility, interfaces, conventions
    .claude/agents/*.md      # room subagents, skills
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

**Manual task with auto-routing**: user adds a task in the task panel without picking a
room → server injects it into the orchestrator session → orchestrator analyzes it, calls
`factory_task_update` (room, assignee, priority) and `factory_send` to dispatch → a
package leaves the main building for the chosen workshop.

**Limit pause/resume**: LimitMonitor sees account B at 96% of 5h window → interrupts B's
sessions mid-turn-boundary, persists `{session_id, room, pending_inbox}`, UI shows
"paused until 14:30" → at `resets_at` server re-creates queries with `resume:
session_id`, injects "you were paused for rate limits, continue" turn.

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
