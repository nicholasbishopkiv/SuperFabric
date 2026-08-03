# M3a — The Factory Bus and Tasks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents in different rooms actually talk to each other. A chat-room agent asks the payments room for a webhook; the message is durable, delivery is push (a turn injected into the recipient's input stream, never a polling loop), a package rides the conveyor between those two buildings while it is in flight, and both sides show up in a task board the operator can read. This is what turns the factory metaphor into function — today packages move on a manual button.

**Architecture:** Two new server modules. `TaskStore` owns `tasks` (migration 4). `FactoryBus` owns `messages` (migration 4) and exposes itself to every session as an **in-process MCP server** (`createSdkMcpServer` from the Agent SDK), injected through `ExecutorStartOptions`. The bus persists first, then delivers by injecting a turn — busy agents get their message at the next turn boundary. Message and task changes broadcast over the existing debounced WebSocket path; the web store turns a delivered message into a real package on the belt.

**Tech Stack:** unchanged — Bun + `bun:sqlite` + `@anthropic-ai/claude-agent-sdk` on the server, Vite + vitest + react-three-fiber on the web, zod in shared.

**Conventions:** server tests run under `bun test`, web/shared under vitest; installs are pnpm. **Never set `SUPERFABRIC_LIVE_TEST=1` and never prompt a real agent except where a task explicitly says so — that spends the user's subscription quota.** Use `FakeExecutor` and the injected `query` seam. Commit per task; no scratch files in the repo.

---

### Task 1: Tasks and messages in the protocol

**Files:** modify `packages/shared/src/protocol.ts`; test `packages/shared/test/protocol.test.ts`

- [ ] **Step 1: failing tests** for each shape below (parse a valid one, reject a bad one).
- [ ] **Step 2: implement**

```ts
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

export const MessageKind = z.enum(["request", "response", "info"]);

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
```

Client messages to add: `create_task {title, detail?, roomId?}`, `update_task {taskId, status?, roomId?, agentId?}`, `list_tasks`. Server messages to add: `tasks {tasks: TaskInfo[]}` and `messages {messages: MessageInfo[]}` (the latter is what drives the belt animation, so it must carry `deliveredAt`).

- [ ] **Step 3: run** `pnpm -F @superfabric/shared test` → PASS. **Commit** `feat(shared): tasks and bus messages in the protocol`

---

### Task 2: TaskStore

**Files:** modify `packages/server/src/db.ts` (migration 4); create `packages/server/src/taskStore.ts`; test `packages/server/test/taskStore.test.ts`, extend `db.test.ts`

- [ ] **Step 1: failing tests** — create/list/update round-trip; `updatedAt` moves on update and `createdAt` does not; an unknown task id throws; a task may be created unassigned (`roomId: null`); listing is newest-first; `blockedOnMessageId` is settable and clearable; assigning an `agentId` whose session is not in the task's room throws (the board must not lie about who owns what).
- [ ] **Step 2: migration 4** (append — never edit steps 1–3):

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  room_id TEXT,
  agent_id TEXT,
  blocked_on_message_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_room_id TEXT NOT NULL,
  to_room_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  task_id TEXT,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS messages_undelivered ON messages (to_room_id, delivered_at);
```

- [ ] **Step 3: implement** `TaskStore` with `create({title, detail?, roomId?})`, `update(taskId, patch)`, `list()`, `get(id)`. Cache prepared statements the way `EventStore` does. Remember the Bun gotcha in `CLAUDE.md`: `stmt.get()` returns **`null`**, not `undefined`, for a missing row.
- [ ] **Step 4: run** → PASS. **Commit** `feat(server): task store with a tasks migration`

---

### Task 3: FactoryBus — persistence and delivery

**Files:** create `packages/server/src/factoryBus.ts`; test `packages/server/test/factoryBus.test.ts`

The bus is deliberately split from its MCP surface (Task 4) so delivery is testable without the SDK.

- [ ] **Step 1: failing tests**
  - `send()` persists a message with `deliveredAt: null` and returns it.
  - `send()` to a room with an idle agent delivers immediately: the injected text reaches that agent's executor (assert via the recording/fake executor's received turns) and `deliveredAt` is set.
  - `send()` to a room whose agents are all `working` does **not** inject mid-turn; the message stays undelivered until `flushRoom(roomId)` is called (which `SessionManager` will call at a turn boundary), and then it is delivered exactly once.
  - Two messages queued for a busy room are delivered in creation order.
  - `send()` to a room with no agents leaves the message undelivered and does not throw — it must be visible in `list()` so the operator can see the pile-up.
  - Delivery is idempotent: calling `flushRoom` twice does not deliver the same message twice or inject twice.
  - `undeliveredFor(roomId)` returns only that room's undelivered messages.
  - The injected turn is **clearly framed as an inter-room message**, not as the operator speaking: assert the text contains the sending room's name and the message body, and reads as a message from another department. (Exact wording is yours; assert the parts, not the whole string.)

- [ ] **Step 2: implement.** Constructor takes the `Db`, the `RoomManager`, and a `deliver(sessionId, text) => void` callback (`SessionManager.prompt` wired in by `index.ts`) plus a `roomAgents(roomId) => {sessionId, status}[]` lookup. Do not import `SessionManager` — the callbacks keep the dependency one-way and the module unit-testable.
- [ ] **Step 3: run** → PASS. **Commit** `feat(server): factory bus with push delivery at turn boundaries`

---

### Task 4: Expose the bus to agents as in-process MCP tools

**Files:** create `packages/server/src/busTools.ts`; modify `packages/server/src/executor.ts`, `packages/server/src/executors/claudeCode.ts`, `packages/server/src/sessionManager.ts`; test `packages/server/test/busTools.test.ts`, extend `claudeExecutor.test.ts`

- [ ] **Step 1: read the SDK notes.** `packages/server/notes/agent-sdk-api.md` documents `createSdkMcpServer` and `tool()`. **Verify the exact signatures there before writing code** — the notes are authoritative over memory. If they are thin on `createSdkMcpServer`, read the SDK's `.d.ts` and extend the notes file as part of this task.
- [ ] **Step 2: failing tests** — build the tool set with a stub bus and assert: each tool's name and input schema; calling `factory_send` reaches `bus.send` with the right arguments; `factory_inbox` returns that room's undelivered-then-delivered recent messages; `factory_task_update` reaches `TaskStore.update`; a tool called with a bad room name returns a tool error rather than throwing; and the tool set is scoped to the calling room (an agent cannot claim to be another room — the room comes from the session, never from tool input).
- [ ] **Step 3: implement** `busTools({ bus, tasks, roomId })` returning an SDK MCP server with:
  - `factory_send(to_room, kind, body, task_id?)`
  - `factory_inbox()`
  - `factory_task_update(task_id, status?, detail?)`
  - `factory_report_status(summary)` — appends a `session_status` detail so the operator sees a human-readable line
  Add `mcpServers` (or the SDK's exact option name — check the notes) to `ExecutorStartOptions` and thread it through `ClaudeCodeExecutor` into `Options`. `SessionManager` builds the tool set per session from that session's room. A roomless session gets no bus tools.
- [ ] **Step 4: run** → PASS. **Commit** `feat(server): factory bus exposed to agents as in-process MCP tools`

---

### Task 5: Hub wiring and broadcasts

**Files:** modify `packages/server/src/wsHub.ts`, `packages/server/src/index.ts`; test extend `wsHub.test.ts`

- [ ] **Step 1: failing tests** — `create_task` / `update_task` / `list_tasks` route correctly and broadcast a `tasks` message; a message send (simulated through the bus) broadcasts a `messages` message; unknown ids reply `{kind:"error"}` without throwing (the dispatch guard must keep holding); `tasks`/`messages` broadcasts are debounced on the same 250 ms coalescing path as `sessions`, and a burst produces one broadcast carrying the newest state.
- [ ] **Step 2: implement**, then wire `index.ts`: construct `TaskStore` and `FactoryBus`, pass the bus into `SessionManager` so it can build per-session tools and call `flushRoom` at each turn boundary (a `turn_complete` event is the boundary), and give the hub both stores.
- [ ] **Step 3: run** → PASS; root `pnpm build && pnpm test` green. **Commit** `feat(server): task and message routing with debounced broadcasts`

---

### Task 6: Packages ride real messages

**Files:** modify `packages/web/src/store.ts`, `packages/web/src/wsClient.ts`, `packages/web/src/scene/Packages.tsx`; test extend `packages/web/test/store.test.ts`

- [ ] **Step 1: failing tests** — applying a `messages` server message creates a package for each message whose `deliveredAt` is newer than what the store has already animated; a message already animated is not re-animated (dedupe by id); an undelivered message shows as a **waiting** marker at the sender rather than a package in flight (a message nobody has picked up must look different from one in transit); `hasMotion` is true while a real package is in flight.
- [ ] **Step 2: implement.** Keep the manual `sendPackage` action for demos but mark it clearly as such; the real path is `applyMessages`. A conveyor between two rooms is earned by a real message as well as by the manual control.
- [ ] **Step 3: manual browser check** — with two rooms and one agent each, send a message **through the bus** by driving the tool from a /tmp WS script (or, if that is not possible without a live agent, by calling the bus directly through a small server-side script), and confirm a package rides the belt and the task board updates. Screenshot it.
- [ ] **Step 4: commit** `feat(web): packages ride real bus messages`

---

### Task 7: Task board in the HUD

**Files:** create `packages/web/src/hud/TaskPanel.tsx`; modify `packages/web/src/App.tsx`; test extend web store tests

- [ ] **Step 1: implement** a bottom-edge collapsible panel (the left and right edges are taken):
  - Columns or grouped rows by `TaskStatus`; each task shows its title, its room (or "unassigned"), its assignee and a `blocked` indicator when it is waiting on a message.
  - "New task" input: title, optional detail, optional room. **Leaving the room empty is the intended path** — it means "the orchestrator decides" (M3b); until the orchestrator exists, show such tasks in an "unassigned" group with a note saying routing arrives with the orchestrator. Do not fake the routing.
  - Clicking a task's room selects that room (same `selectedRoomId` the floor uses).
  - A count badge per room shown on the room panel rows.
- [ ] **Step 2: keep the camera framing honest** — a third panel changes the uncovered strip. `hudInsets` already measures panels with a `ResizeObserver`; register this one too so the camera keeps framing the factory into what is actually visible.
- [ ] **Step 3: manual browser check** — create tasks, assign one to a room, confirm the board and the room-panel badges agree and the camera reframes when the panel opens. Screenshot.
- [ ] **Step 4: commit** `feat(web): task board with room assignment`

---

### Task 8: Acceptance

- [ ] **Step 1:** Fresh data dir. Two rooms, one agent each, autonomy `auto`. Give the first agent **one** live prompt telling it to ask the other room for something specific via its `factory_send` tool (this is the one live turn this plan spends). Observe: the message persists, a package rides the belt, the second agent receives it as an injected turn without being prompted by the operator, it replies with `factory_send`, and a package rides back. Confirm the task board and the event log both record it. Report verbatim what you saw.
- [ ] **Step 2:** Restart the server mid-flight (with an undelivered message queued) and confirm the message is still queued and gets delivered after resume — durability is the whole point of persisting first.
- [ ] **Step 3:** Update `docs/ROADMAP.md` (M3 items delivered), `CLAUDE.md` (new modules + the invariant that a room is never taken from tool input), and `docs/ARCHITECTURE.md` if the bus differs from what it describes.
- [ ] **Step 4: commit** `docs: mark the factory bus complete`

---

## Self-review notes

- **Covers**: durable inter-room messaging with push delivery, the MCP tool surface agents actually call, tasks with room/agent assignment and blocked-on-message, packages animating on real traffic, and a task board.
- **Deferred by design**: the orchestrator and auto-routing (M3b — Task 7 deliberately shows unassigned tasks as unassigned rather than faking it), the Chronicle decision log (its own chunk), multi-account and limits (M2), containers (M4).
- **Biggest risk**: `createSdkMcpServer`'s exact shape. Task 4 step 1 exists to settle it from the SDK's own types before any code is written, and to extend the notes file if it is thin.
- **Second risk**: injecting a turn into a busy agent. The design sidesteps it — persist first, deliver at a `turn_complete` boundary — and Task 3 tests exactly that ordering.
