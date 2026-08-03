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

- 3D scene (react-three-fiber, isometric camera, low-poly): the main building = the
  project (click → CLAUDE.md/README), creating workshop rooms → folders, conveyor paths
  between buildings.
- 2D overlay: **task panel** (manual task creation, department picked manually for
  now), room panel (charter, per-agent model/skills/MCP), working/idle/blocked statuses
  on the buildings.
- **Roles library v1**: ~10 starter presets (architect, backend, frontend, designer,
  QA, DevOps…) — role = prompt + skills/superpowers + plugins/MCP + model; one-click
  assignment, file format `roles/*.yaml` (growing to 50+ roles and user presets in M5).
- Onboarding agent for an empty project (interview → documents).
- Scene layout persisted to `.fabrica/layout.json`.

## M2 — Multi-account and the limit monitor

- AccountManager: profiles via `CLAUDE_CONFIG_DIR`; **"Add session" button** opening an
  embedded terminal (xterm.js ↔ node-pty) where the user logs in; binding rooms/agents
  to a chosen account at creation time.
- LimitMonitor: polling the OAuth usage endpoint per account, 5h/weekly/per-model
  meters in the UI, catching 429s.
- Scheduler: warn agents at 80%, pause at 95%, auto-resume at `resets_at`.

**Done when**: 2+ accounts run in parallel; limit pause/resume needs no human.

## M3 — Factory bus and the orchestrator

- Factory Bus: in-process MCP tools (`factory_send`, `factory_inbox`,
  `factory_report_status`, `factory_task_update`, `factory_ask_orchestrator`),
  push delivery by injecting a turn.
- TaskStore + kanban panel + task badges on rooms.
- Orchestrator: dedicated session (Opus) with an overview of all rooms, task
  distribution, blocker resolution; orchestrator console in the UI.
- **Task auto-routing**: a task from the task panel with no department chosen goes to
  the orchestrator — it analyzes, assigns room and assignee, and dispatches.
- **Chronicle v1**: `factory_record_decision` + `factory_search_history` tools,
  ADR files in `docs/decisions/`, FTS5 search over decisions + prompt/event history,
  chronicle timeline in the UI.
- Package meshes travel the conveyors between workshops (spline animation).

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
