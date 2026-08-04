# M3b — The Orchestrator and the Chronicle

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The main building gets its senior agent. Unassigned tasks are analysed and routed to a room and an assignee; junior agents can ask it for a ruling; and every meaningful decision — its own and theirs — lands in a searchable chronicle so the next agent can find out *why* something is the way it is before changing it.

**Architecture:** The orchestrator is an ordinary session bound to the project room, marked `is_orchestrator`, with its own system-prompt append and a larger tool surface. It is not a new runtime: it is a session with a role. Routing is a bus round trip — a task with no room becomes a message to the orchestrator, whose reply moves the task. The Chronicle is ADR files on disk plus an FTS5 index over decisions and the prompt/event history.

**Tech Stack:** unchanged. Server = Bun + `bun:sqlite`; web = Vite + vitest; zod in shared.

**Conventions:** server tests `bun test`, web/shared vitest, installs pnpm. **Never set `SUPERFABRIC_LIVE_TEST=1` and never prompt a real agent except in the acceptance task.** Commit per task.

---

### Task 1: The orchestrator is a session with a role

**Files:** `packages/shared/src/protocol.ts`; `packages/server/src/{db,sessionManager,roomManager}.ts`; new `packages/server/src/orchestrator.ts`; tests alongside.

- [ ] Migration 7 (**append**): `sessions.is_orchestrator INTEGER NOT NULL DEFAULT 0`. At most one per project — enforce it in code and test the second attempt throws.
- [ ] `SessionInfo.isOrchestrator: boolean`. Client message `ensure_orchestrator {}` creates it if absent and returns it; the UI calls this rather than the operator hand-building one.
- [ ] The orchestrator is created in the **project room** (the central building), so it appears there on the floor.
- [ ] Its system-prompt append (a constant in `orchestrator.ts`, not scattered) states: it is the factory's orchestrator; it sees every room and its charter; its job is to route work, unblock, and decide direction; it must record direction decisions with `factory_record_decision`; it must not do rooms' work itself. Keep it short — a charter, not a manual.
- [ ] Tests: created in the project room; only one per project; survives restart with the flag; `listSessions` reports it.

### Task 2: `factory_ask_orchestrator` and routing

**Files:** `packages/server/src/{busTools,factoryBus,taskStore}.ts`; new `packages/server/src/router.ts`; tests.

- [ ] `factory_ask_orchestrator(question, task_id?)` in the room tool set: a bus message to the project room, kind `request`. The orchestrator answers with `factory_send` like anyone else — no special channel.
- [ ] Orchestrator-only tools (present only when the session has the flag): `factory_assign_task(task_id, room, agent_id?)` and `factory_list_rooms()` returning each room's name, charter summary, agent count and live status. An ordinary agent calling `factory_assign_task` must get a tool error, and that must be tested.
- [ ] **Routing**: when a task is created with `roomId: null`, `router.ts` sends the orchestrator a message describing the task and the available rooms. Its `factory_assign_task` reply moves the task and notifies the receiving room. If there is no orchestrator, the task simply stays unassigned — the board already says routing needs one, and nothing may silently invent an assignment.
- [ ] Tests: unassigned task → a message to the project room; `factory_assign_task` moves it and messages the target room; an unknown room name is a tool error, not a crash; no orchestrator means no message and no change.

### Task 3: The Chronicle

**Files:** new `packages/server/src/chronicle.ts`; `packages/server/src/busTools.ts`; migration 8; tests.

- [ ] Migration 8 (**append**): `decisions(id, project_id, room_id, agent_id, task_id, title, context, decision, alternatives, links, created_at)` plus an FTS5 virtual table indexing `title/context/decision/alternatives` **and** the `events` payload text, so one query searches decisions and what was actually said.
- [ ] `factory_record_decision({title, context, decision, alternatives?, links?})` — writes the row **and** an ADR file at `<project>/docs/decisions/NNNN-<slug>.md` in the same style as this repo's own `docs/decisions/`. Repo-native first: the file must be readable and greppable without SuperFabric running.
- [ ] `factory_search_history(query, limit?)` — FTS5 over both sources, newest first, returning enough context to act on (title, when, who, and a snippet).
- [ ] Role prompts (orchestrator's append, and the room charter template) instruct: record at meaningful choice points; **search before reworking anything**.
- [ ] Tests: a decision writes both row and file; the file is valid ADR-shaped markdown; numbering does not collide when two land in the same second; search finds a decision by a word in its `context`; search finds an event by a word in an agent's message; searching an empty chronicle returns nothing rather than throwing.

### Task 4: UI

**Files:** `packages/web/src/hud/*`, store, protocol as needed.

- [ ] The project building shows the orchestrator distinctly (it is an agent in the project room — give it a visible marker, not a separate widget).
- [ ] A "Chronicle" surface: search box + results, reachable from the HUD. Keep it in the existing shadcn idiom; do not invent a fourth edge panel — a popover or a tab inside the console drawer is enough.
- [ ] The task board's unassigned group gets a working "route it" affordance when an orchestrator exists, and keeps the explanatory note when it does not.
- [ ] Register any new panel with `hudInsets` so the camera keeps framing correctly.

### Task 5: Acceptance

- [ ] **One live run.** A project with two rooms plus an orchestrator. Create a task with no room. Observe: the orchestrator receives it, calls `factory_assign_task`, the task lands in a room, that room's agent is notified, and a decision is recorded. Report verbatim.
- [ ] Verify the ADR file exists on disk and `factory_search_history` finds it.
- [ ] Update `docs/ROADMAP.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`.

---

## Self-review notes

- **Covers**: the orchestrator described in the vision (routes work, unblocks, decides direction, answerable by juniors), the task panel's promised auto-routing, and the Chronicle.
- **Deferred**: roles library and the onboarding agent (their own chunk), multi-account and limits (M2), containers (M4).
- **Risk**: routing is a *model* decision, so it can be wrong or slow. The design keeps it honest — the task visibly stays unassigned until the orchestrator actually answers, and nothing fabricates an assignment.
