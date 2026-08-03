# SuperFabric — Roadmap

> 🇷🇺 Русский оригинал: [ROADMAP.ru.md](ROADMAP.ru.md)

The project is too large for a single spec, so it is split into milestones. Each
milestone is a self-contained sub-project with its own "spec → plan → implementation"
cycle and a **working result at the end**. The order is chosen to burn down the biggest
risks first.

## M0 — Core: one server-managed session ✅ **complete** (2026-08-03)

Removes the main technical risk: a steerable long-lived session.

- [x] pnpm monorepo: `server`, `web`, `shared`.
- [x] SessionManager on the Agent SDK (streaming input): start, event streaming,
      interrupt, graceful stop, resume after a server restart.
- [x] SQLite event log + WebSocket replay-then-tail with per-session `afterSeq`.
- [x] Minimal web UI: chat with an agent, approval cards (`canUseTool`), connection
      state, interrupt.
- [x] Single account (the current `~/.claude`).

**Acceptance run**: an agent was told a secret word, the server was SIGTERM'd
mid-session, restarted (`resumed sessions: …`), the browser client replayed the
transcript from the event log, and the agent answered the secret word correctly
afterwards — conversation context genuinely survived the restart. Event `seq` values were
contiguous. 44 tests green (+1 live-quota test, run manually).

## M1 — The floor: 3D factory, project block, rooms

**M1a is complete (2026-08-03)** — rooms as folders and the 3D floor:

- [x] 3D scene (react-three-fiber, isometric orthographic camera, low-poly): the project
      block as headquarters, workshop buildings on a ring, a bounded concrete shell,
      conveyor belts that enter loading bays, animated package meshes, status beacons and
      agent figures with hard hats and status vests.
- [x] Rooms are folders: creating one makes `<root>/<name>/` with a `CLAUDE.md` charter,
      and an agent in that room runs with the room's folder as its cwd.
- [x] 2D overlay: room panel (create, select, per-room agents, per-agent autonomy,
      unassigned sessions) and the M0 console as a collapsible drawer.
- [x] Live status: `SessionInfo` carries a server-derived `status` and `blocked`, broadcast
      to every client with a 250 ms debounce, so the floor is correct after a reload
      without replaying transcripts.
- [x] Drag a building to move its room; the position persists. Camera frames the factory
      into the strip the HUD panels leave uncovered, and yields to manual pan/zoom.
- [x] `frameloop="demand"`: an idle factory does zero `requestAnimationFrame` calls.

Still open for M1:

- [x] Task panel with manual task entry — delivered with M3a (auto-routing still needs the
      orchestrator, so a task with no room stays unassigned and the board says so).
- [ ] Roles library v1: ~10 presets (role = prompt + skills/superpowers + plugins/MCP + model).
- [ ] Onboarding agent for an empty project (interview → CLAUDE.md / README).

## M2 — Multi-account and the limit monitor

- AccountManager: profiles via `CLAUDE_CONFIG_DIR`; **"Add session" button** opening an
  embedded terminal (xterm.js ↔ node-pty) where the user logs in; binding rooms/agents
  to a chosen account at creation time.
- LimitMonitor: polling the OAuth usage endpoint per account, 5h/weekly/per-model
  meters in the UI, catching 429s.
- Scheduler: warn agents at 80%, pause at 95%, auto-resume at `resets_at`.

**Done when**: 2+ accounts run in parallel; limit pause/resume needs no human.

## M3 — Factory bus and the orchestrator

**M3a is complete (2026-08-04)** — the bus, tasks, and packages that mean something:

- [x] Factory Bus (`factoryBus.ts`): messages are rows first (migration 4), delivery second.
      Delivery is push — a turn injected into the recipient's input stream, never a poll — and
      only at a turn boundary, so a busy agent is never interrupted mid-turn. A message for a
      room with nobody free stays queued, survives a restart, and is flushed at the next boundary
      (one message per boundary, so a queue of N takes N boundaries).
- [x] The bus as in-process MCP tools (`busTools.ts`): `factory_send`, `factory_inbox`,
      `factory_task_update`, `factory_report_status`, built per session from that session's room.
      The sending room comes from the session row and never from tool input. The model sees them
      as `mcp__factory__*`, and they are **never gated** — see
      `docs/decisions/0002-factory-tools-are-not-gated.md`.
- [x] `TaskStore` (`taskStore.ts`) with room/assignee/`blockedOnMessageId`, a bottom-edge task
      board grouped by status, per-room task badges, and a "new task" form whose default is
      unassigned.
- [x] Packages ride real messages: a delivery becomes a box on the belt keyed by the message id,
      an undelivered message is a still grey crate stacked at its sender's door, and the two are
      the same object in two states.
- [x] Room charters tell an agent it is a department with a bus, and what its own room is called.

**Acceptance run (live, one operator prompt)**: two rooms with one `auto` agent each. The chat
agent was told once to ask payments for a webhook's method and path; it called
`mcp__factory__factory_send` with no approval card; the payments agent received the message as an
injected turn **nobody prompted**, investigated, called `factory_report_status`, and answered with
`factory_send`; the reply arrived in the chat agent's session the same way. Both directions
persisted, both broadcast, and a package rode the belt each way. Separately, with a fake executor:
a message sent to a room whose agent was mid-turn stayed `delivered_at = NULL` on disk across a
hard kill, and after the restart the boot flush carried exactly one, the second draining at the
next boundary. 474 tests green (shared 33, server 247 + 1 skipped live-quota test, web 194).

Still open for M3 (M3b):

- Orchestrator: dedicated session (Opus) with an overview of all rooms, task
  distribution, blocker resolution; orchestrator console in the UI, `factory_ask_orchestrator`.
- **Task auto-routing**: a task from the task panel with no department chosen goes to
  the orchestrator — it analyzes, assigns room and assignee, and dispatches. Until then such a
  task is shown as unassigned and nothing pretends otherwise.
- **Chronicle v1**: `factory_record_decision` + `factory_search_history` tools,
  ADR files in `docs/decisions/`, FTS5 search over decisions + prompt/event history,
  chronicle timeline in the UI.

## M4 — Containerization

- `agent-runner` image (Node + SDK + claude), dockerode management.
- One container per room; account profile and workspace mounts; egress firewall per
  Anthropic's reference; resource limits.
- `--dangerously-skip-permissions` inside the sandbox + per-room auto-approval rules.

## M5 — Polish and the "living factory"

- Small animated agent characters in the workshops (glTF, reflecting real session
  activity), living-factory details (smoke, lights, movement).
- Direct chat with any agent from the UI (partially in M0 already), notifications
  (phone push desirable), event history/search.
- Roles library expansion (50+ presets, user-defined presets).
- Metrics: per-account burn rate, cost-equivalent analytics (ccusage math).
- Factory export/import, multi-project support (several factories).

## Planned after v1

- **Multi-provider executors**: Codex / ChatGPT agents, Antigravity (Gemini), and
  others behind the `Executor` interface (which exists from M0) — assign different
  providers/strengths to different tasks and rooms.

## Out of scope for v1
- Multi-tenancy, cloud deployment, team access.
- Automatic account rotation to dodge limits — deliberately NOT doing this (ToS risk);
  only pause/resume of your own accounts.
