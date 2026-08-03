# Fabrica — Design Spec

Date: 2026-08-03 · Status: **awaiting user approval** · Scope: whole product, with M0 as the first implementable sub-project.

## 1. Problem

A developer with 2–3 Claude subscription accounts wants to run a team of specialized
Claude Code agents against one project — with shared direction, inter-agent
communication, full visibility (tasks, statuses, blockers), and precise awareness of
each subscription's rate limits — without losing sessions to restarts or limit resets.

Existing tools cover fragments (session managers, kanban runners, usage monitors) but
nothing combines: self-hosted control, multi-account isolation + limit scheduling, a
spatial "factory floor" UI, and an inter-agent message bus. The cloud-runner category
was killed by Anthropic's first-party offerings; the self-hosted multi-account niche is
open (see docs/RESEARCH.md).

## 2. Goals / Non-goals

**Goals (v1):** multi-account parallel agents on one project; rooms-as-folders; factory
canvas UI with live statuses and animated message flows; inter-room bus + orchestrator
agent; precise per-account limit meters with warn/pause/auto-resume; session survival
across restarts; onboarding agent for empty projects; approval cards for gated actions.

**Non-goals (v1):** cloud/multi-tenant deployment; non-Claude executors; account
pooling/rotation to dodge limits (deliberate ToS line); mobile app.

## 3. Approaches considered

1. **PTY-wrapping the interactive CLI** (claude-squad/CCManager style): free "real
   terminal" fidelity, but state detection is scraping, no structured events, weak
   programmatic steering. Rejected as primary (kept as optional raw-terminal tab later).
2. **Headless CLI with stream-json flags** (Vibe Kanban style): structured, but
   process-per-turn and permission plumbing via stdio is clunkier than the SDK.
   Kept as fallback path behind an executor abstraction.
3. **TypeScript Agent SDK, streaming-input mode** — ✅ **chosen**: long-lived steerable
   sessions, `interrupt()`, `resume`, `canUseTool` → UI approvals, in-process MCP for
   the bus. Richest control surface with least glue.

Canvas: research recommended React Flow v12 for a 2D node graph, but the product
directive is a **true 3D living factory** (isometric scene: buildings, conveyor belts
carrying package-messages, later animated agent characters) with a 2D DOM overlay for
panels. Chosen: **react-three-fiber + drei (Three.js)** — MIT, React-native scene graph,
proven perf patterns (instancing, demand frameloop). tldraw rejected (license); React
Flow kept only as a fallback idea via a top-down "schematic" camera on the same scene.

Runtime placement: host subprocesses first (M0–M3), Docker per room at M4 — containers
add real isolation value only once `--dangerously-skip-permissions` autonomy is wanted,
and deferring them de-risks the core.

## 4. Architecture (summary — full map in docs/ARCHITECTURE.md)

pnpm monorepo: `server` (Fastify + ws + better-sqlite3 + Agent SDK + dockerode),
`web` (React + react-three-fiber/drei + zustand; 3D factory scene + 2D DOM overlay),
`shared` (zod protocol), later `agent-runner` (container image).

Product surfaces on top of the core:
- **Task panel** (2D overlay): manual task creation; if no room is chosen, the task is
  routed to the orchestrator, which analyzes it, assigns room + agent, and dispatches.
- **Role library**: shipped presets (`roles/*.yaml`, user overrides in
  `.fabrica/roles/`) bundling role prompt + recommended skills/superpowers +
  plugins/MCP + tool profile + model; one-click attach when creating an agent.

Core invariants:
- **Event log is the source of truth**; WebSocket is a lossy tail with
  `{sessionId, afterSeq}` replay.
- **Room = folder**; killing Fabrica leaves a normal repo. Room charter lives in the
  room's CLAUDE.md; agents run with cwd = room.
- **One `CLAUDE_CONFIG_DIR` per account**, never shared across accounts; login happens
  on the host (hidden-PTY OAuth or `setup-token`), containers only mount ready profiles.
- **Bus delivery is push**: server injects turns into the recipient session's input
  stream; messages persist in SQLite first.
- **LimitMonitor** polls the OAuth usage endpoint per account (adapter + JSONL
  fallback); scheduler warns at 80%, pauses at 95%, auto-resumes at `resets_at` via
  `options.resume`.

### Data model (SQLite)

```
accounts(id, label, config_dir, status)
rooms(id, name, path, account_id, charter_summary, position_xy)
agents(id, room_id, role_id, model, system_prompt_append, allowed_tools, mcp_config, status)
roles(id, name, prompt_append, skills[], plugins[], mcp[], tool_profile, model_hint)  -- seeded from roles/*.yaml
sessions(id, agent_id, claude_session_id, state{active|paused|done}, started_at)
events(session_id, seq, ts, type, payload)          -- append-only
messages(id, from_room, to_room, kind, body, task_id, delivered_at)
tasks(id, room_id, title, status{open|in_progress|blocked|review|done}, assignee_agent_id, blocked_on_message_id)
usage_snapshots(account_id, ts, window{5h|7d|7d_opus|7d_sonnet}, utilization, resets_at)
```

### Error handling

- Session crash → event `session_error`, auto-resume once, then mark blocked + notify.
- Rate limit (429 / limit error) → treat as pause signal even if monitor lagged.
- Usage endpoint failure → fall back to JSONL estimation, badge meters as "approximate".
- Approval timeout → configurable default (deny in autonomous mode, hold in attended).
- Server restart → resume all `state=active` sessions from persisted claude_session_ids.

### Testing

- `shared` protocol: unit tests (zod schemas, envelope round-trip).
- SessionManager: integration tests against a fake executor (scripted stream-json), plus
  one gated live smoke test (real account, tiny prompt).
- Bus/TaskStore/LimitMonitor scheduler: unit tests over SQLite in-memory; limit endpoint
  behind an adapter with recorded fixtures.
- UI: Playwright smoke (canvas renders, approval card round-trip via mocked WS).

## 5. Delivery plan

Milestones M0–M5 as in docs/ROADMAP.md; each gets its own implementation plan. First
plan to write: **M0 — core session runner** (monorepo scaffold, SessionManager,
event log + WS replay, minimal chat UI with approval cards, resume-after-restart).

## 6. Open questions (defaults chosen, flag if wrong)

1. **Room↔account binding** — default: account is set per room (all agents in a room
   share it), overridable per agent.
2. **Orchestrator model** — default: Opus on the least-loaded account, re-evaluated by
   the scheduler.
3. **Git strategy per room** — default v1: rooms are folders in one repo on one shared
   branch; worktrees/branch-per-room deferred (revisit at M3 when parallel writes bite).
4. **Autonomy default** — attended mode (approval cards) until M4 sandboxing, then
   per-room autonomous mode allowed.
5. **Role presets sourcing** — default: start with ~10 hand-written presets referencing
   existing public skill packs (superpowers, impeccable, etc.); grow to 50+ and allow
   user-defined presets in M5. Skills install into the room's `.claude/` for
   self-containment.
6. **3D art style** — default: procedural low-poly primitives first (no asset pipeline);
   glTF assets and agent characters arrive incrementally (M5).
