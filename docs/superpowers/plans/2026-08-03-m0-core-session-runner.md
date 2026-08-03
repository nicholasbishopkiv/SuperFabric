# M0 — Core Session Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A server-managed, browser-driven Claude Code session that streams events over WebSocket, survives server restarts (resume), and routes tool-permission requests to the browser as approval cards.

**Architecture:** pnpm monorepo (`shared` → protocol types, `server` → Fastify+ws+SQLite+Agent SDK behind an `Executor` interface, `web` → minimal React chat). SQLite event log is the source of truth; the WebSocket is a lossy tail with `afterSeq` replay. All Claude interaction goes through `ClaudeCodeExecutor`; tests use `FakeExecutor`.

**Tech Stack:** Node 22+, TypeScript 5, pnpm workspaces, Fastify 5 + `ws`, better-sqlite3 (WAL), zod, `@anthropic-ai/claude-agent-sdk`, React 19 + Vite, zustand, vitest.

**Conventions for every task:** run commands from repo root; ESM everywhere (`"type": "module"`); vitest for tests (`pnpm -F <pkg> test`). Commit after every green step.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/src/index.ts`
- Create: `packages/web/package.json` (via Vite scaffold, Task 12)

- [ ] **Step 1: Root files**

`package.json`:
```json
{
  "name": "superfabric",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "pnpm -r --if-present test",
    "build": "pnpm -r --if-present build",
    "dev": "pnpm -r --parallel --if-present dev"
  },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^3.0.0" }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist"
  }
}
```

- [ ] **Step 2: `packages/shared` package**

`packages/shared/package.json`:
```json
{
  "name": "@superfabric/shared",
  "version": "0.0.1",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": { "build": "tsc", "test": "vitest run" },
  "dependencies": { "zod": "^3.24.0" }
}
```

`packages/shared/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/shared/src/index.ts`:
```ts
export * from "./protocol.js";
```
(Leave `protocol.ts` for Task 2 — create an empty `export {};` file so tsc passes.)

- [ ] **Step 3: `packages/server` package**

`packages/server/package.json`:
```json
{
  "name": "@superfabric/server",
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "node --watch --experimental-strip-types src/index.ts",
    "start": "node --experimental-strip-types src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "@superfabric/shared": "workspace:*",
    "better-sqlite3": "^11.0.0",
    "fastify": "^5.0.0",
    "@fastify/static": "^8.0.0",
    "ws": "^8.18.0",
    "zod": "^3.24.0"
  },
  "devDependencies": { "@types/better-sqlite3": "^7.6.0", "@types/ws": "^8.5.0", "@types/node": "^22.0.0" }
}
```

`packages/server/tsconfig.json`: same as shared. `src/index.ts`: `console.log("superfabric server");` placeholder (replaced in Task 11).

- [ ] **Step 4: Install and verify**

Run: `pnpm install && pnpm build`
Expected: both packages compile.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "chore: pnpm monorepo scaffold (shared, server)"`

---

### Task 2: Protocol schemas (shared)

**Files:**
- Create: `packages/shared/src/protocol.ts`
- Test: `packages/shared/test/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { ClientMessage, ServerMessage, SessionEvent } from "../src/protocol.js";

describe("protocol", () => {
  it("parses a subscribe message", () => {
    const m = ClientMessage.parse({ kind: "subscribe", sessionId: "s1", afterSeq: 0 });
    expect(m.kind).toBe("subscribe");
  });
  it("parses an event envelope round-trip", () => {
    const ev: unknown = {
      kind: "event",
      sessionId: "s1",
      seq: 42,
      event: { type: "agent_text", text: "hello" },
    };
    const parsed = ServerMessage.parse(ev);
    expect(parsed).toEqual(ev);
  });
  it("rejects unknown event types", () => {
    expect(() => SessionEvent.parse({ type: "nope" })).toThrow();
  });
});
```

- [ ] **Step 2: Run** `pnpm -F @superfabric/shared test` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `protocol.ts`**

```ts
import { z } from "zod";

// ---- events persisted in the event log and streamed to clients ----
export const SessionEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session_status"), status: z.enum(["starting", "working", "idle", "paused", "error", "done"]), detail: z.string().optional() }),
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

// ---- client -> server ----
export const ClientMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("subscribe"), sessionId: z.string(), afterSeq: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("prompt"), sessionId: z.string(), text: z.string().min(1) }),
  z.object({ kind: z.literal("approval"), sessionId: z.string(), approvalId: z.string(), behavior: z.enum(["allow", "deny"]) }),
  z.object({ kind: z.literal("interrupt"), sessionId: z.string() }),
  z.object({ kind: z.literal("create_session"), cwd: z.string().optional() }),
  z.object({ kind: z.literal("list_sessions") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- server -> client ----
export const SessionInfo = z.object({
  id: z.string(),
  state: z.enum(["active", "paused", "done"]),
  claudeSessionId: z.string().nullable(),
  lastSeq: z.number().int(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const ServerMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), sessionId: z.string(), seq: z.number().int(), event: SessionEvent }),
  z.object({ kind: z.literal("sessions"), sessions: z.array(SessionInfo) }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
```

- [ ] **Step 4: Run** `pnpm -F @superfabric/shared test` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(shared): WS protocol and session event schemas"`

---

### Task 3: SQLite bootstrap (server)

**Files:**
- Create: `packages/server/src/db.ts`
- Test: `packages/server/test/db.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";

describe("db", () => {
  it("creates schema in memory and enforces WAL on file dbs", () => {
    const db = openDb(":memory:");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    expect(tables.map(t => t.name)).toEqual(expect.arrayContaining(["events", "sessions"]));
  });
});
```

- [ ] **Step 2: Run** `pnpm -F @superfabric/server test` — Expected: FAIL.

- [ ] **Step 3: Implement `db.ts`**

```ts
import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      claude_session_id TEXT,
      state TEXT NOT NULL DEFAULT 'active',   -- active | paused | done
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL DEFAULT (unixepoch()),
      type TEXT NOT NULL,
      payload TEXT NOT NULL,                  -- JSON SessionEvent
      PRIMARY KEY (session_id, seq)
    );
  `);
  return db;
}
```

- [ ] **Step 4: Run test** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): sqlite bootstrap with sessions/events schema"`

---

### Task 4: EventStore (append + replay)

**Files:**
- Create: `packages/server/src/eventStore.ts`
- Test: `packages/server/test/eventStore.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";

describe("EventStore", () => {
  it("appends with monotonic seq per session and replays after a given seq", () => {
    const store = new EventStore(openDb(":memory:"));
    const a1 = store.append("A", { type: "agent_text", text: "one" });
    const a2 = store.append("A", { type: "agent_text", text: "two" });
    const b1 = store.append("B", { type: "agent_text", text: "other" });
    expect([a1, a2, b1]).toEqual([1, 2, 1]);
    const replay = store.listAfter("A", 1);
    expect(replay).toEqual([{ seq: 2, event: { type: "agent_text", text: "two" } }]);
  });
  it("notifies subscribers on append", () => {
    const store = new EventStore(openDb(":memory:"));
    const seen: number[] = [];
    store.onAppend((sessionId, seq) => { if (sessionId === "A") seen.push(seq); });
    store.append("A", { type: "agent_thinking" });
    expect(seen).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement `eventStore.ts`**

```ts
import type { Db } from "./db.js";
import type { SessionEvent } from "@superfabric/shared";

export type AppendListener = (sessionId: string, seq: number, event: SessionEvent) => void;

export class EventStore {
  private listeners = new Set<AppendListener>();
  private insert; private maxSeq; private after;

  constructor(private db: Db) {
    this.insert = db.prepare("INSERT INTO events (session_id, seq, type, payload) VALUES (?, ?, ?, ?)");
    this.maxSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_id = ?");
    this.after = db.prepare("SELECT seq, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq");
  }

  append(sessionId: string, event: SessionEvent): number {
    const seq = (this.maxSeq.get(sessionId) as { m: number }).m + 1;
    this.insert.run(sessionId, seq, event.type, JSON.stringify(event));
    for (const l of this.listeners) l(sessionId, seq, event);
    return seq;
  }

  listAfter(sessionId: string, afterSeq: number): { seq: number; event: SessionEvent }[] {
    return (this.after.all(sessionId, afterSeq) as { seq: number; payload: string }[])
      .map(r => ({ seq: r.seq, event: JSON.parse(r.payload) as SessionEvent }));
  }

  onAppend(l: AppendListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
```

- [ ] **Step 4: Run test** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): append-only event store with replay and subscriptions"`

---

### Task 5: Executor interface + FakeExecutor

**Files:**
- Create: `packages/server/src/executor.ts`
- Create: `packages/server/src/executors/fake.ts`
- Test: `packages/server/test/fakeExecutor.test.ts`

- [ ] **Step 1: Define the interface (`executor.ts`)** — the multi-provider seam (spec decision #7):

```ts
import type { SessionEvent } from "@superfabric/shared";

export interface ExecutorEvents {
  onEvent: (event: SessionEvent) => void;
  /** Ask the operator to approve a tool call. Resolves allow/deny. */
  requestApproval: (toolName: string, input: unknown) => Promise<"allow" | "deny">;
}

export interface ExecutorStartOptions {
  cwd: string;
  /** Provider-native session id to resume, if any. */
  resumeSessionId?: string | null;
}

export interface ExecutorHandle {
  /** Provider-native session id, available after start. */
  readonly providerSessionId: Promise<string>;
  send(text: string): void;          // queue a user turn into the live session
  interrupt(): Promise<void>;
  stop(): Promise<void>;             // graceful shutdown, session stays resumable
}

export interface Executor {
  readonly name: string;             // "claude-code", later "codex", ...
  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorHandle;
}
```

- [ ] **Step 2: Failing test for FakeExecutor**

```ts
import { describe, it, expect } from "vitest";
import { FakeExecutor } from "../src/executors/fake.js";
import type { SessionEvent } from "@superfabric/shared";

describe("FakeExecutor", () => {
  it("replies to every prompt and emits turn_complete", async () => {
    const events: SessionEvent[] = [];
    const exec = new FakeExecutor();
    const h = exec.start({ cwd: "/tmp" }, {
      onEvent: e => events.push(e),
      requestApproval: async () => "allow",
    });
    h.send("hello");
    await exec.settle();
    expect(await h.providerSessionId).toMatch(/^fake-/);
    expect(events.map(e => e.type)).toEqual(["session_status", "user_prompt", "agent_text", "turn_complete", "session_status"]);
  });
  it("routes gated tools through requestApproval", async () => {
    const exec = new FakeExecutor({ script: [{ tool: "Bash", input: { cmd: "rm -rf" } }] });
    const decisions: string[] = [];
    const h = exec.start({ cwd: "/tmp" }, {
      onEvent: () => {},
      requestApproval: async (tool) => { decisions.push(tool); return "deny"; },
    });
    h.send("do something dangerous");
    await exec.settle();
    expect(decisions).toEqual(["Bash"]);
  });
});
```

- [ ] **Step 3: Run** — Expected: FAIL.

- [ ] **Step 4: Implement `executors/fake.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { Executor, ExecutorEvents, ExecutorHandle, ExecutorStartOptions } from "../executor.js";

type ScriptedTool = { tool: string; input: unknown };

export class FakeExecutor implements Executor {
  readonly name = "fake";
  private pending: Promise<void> = Promise.resolve();
  constructor(private opts: { script?: ScriptedTool[] } = {}) {}

  /** Await all in-flight turns (test helper). */
  settle(): Promise<void> { return this.pending; }

  start(_opts: ExecutorStartOptions, ev: ExecutorEvents): ExecutorHandle {
    const id = _opts.resumeSessionId ?? `fake-${randomUUID()}`;
    ev.onEvent({ type: "session_status", status: "idle" });
    const send = (text: string) => {
      this.pending = this.pending.then(async () => {
        ev.onEvent({ type: "user_prompt", text });
        for (const t of this.opts.script ?? []) {
          const behavior = await ev.requestApproval(t.tool, t.input);
          ev.onEvent({ type: "approval_resolved", approvalId: "n/a", behavior });
        }
        ev.onEvent({ type: "agent_text", text: `echo: ${text}` });
        ev.onEvent({ type: "turn_complete" });
        ev.onEvent({ type: "session_status", status: "idle" });
      });
    };
    return {
      providerSessionId: Promise.resolve(id),
      send: (t) => { ev.onEvent({ type: "session_status", status: "working" }); send(t); },
      interrupt: async () => {},
      stop: async () => {},
    };
  }
}
```

Note: the first test expects `session_status(working)` **before** `user_prompt`? No — expected order is `["session_status", "user_prompt", ...]` where the first `session_status` is the initial `idle` emitted on start. The `working` status emitted in `send` happens after start's `idle`... **Adjust the test expectation to**: `["session_status", "session_status", "user_prompt", "agent_text", "turn_complete", "session_status"]` (idle → working → prompt → text → turn_complete → idle). Use this corrected expectation in Step 2.

- [ ] **Step 5: Run test** — Expected: PASS. Commit: `git commit -am "feat(server): executor interface and scripted fake executor"`

---

### Task 6: SessionManager (create, prompt, approvals, persistence)

**Files:**
- Create: `packages/server/src/sessionManager.ts`
- Test: `packages/server/test/sessionManager.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { SessionManager } from "../src/sessionManager.js";
import { FakeExecutor } from "../src/executors/fake.js";

function make(db = openDb(":memory:")) {
  const store = new EventStore(db);
  const exec = new FakeExecutor();
  const mgr = new SessionManager(db, store, exec);
  return { db, store, exec, mgr };
}

describe("SessionManager", () => {
  it("creates a session, persists it, and logs prompt+reply events", async () => {
    const { store, exec, mgr } = make();
    const id = mgr.createSession("/tmp");
    mgr.prompt(id, "hi");
    await exec.settle();
    const types = store.listAfter(id, 0).map(e => e.event.type);
    expect(types).toContain("user_prompt");
    expect(types).toContain("agent_text");
    expect(mgr.listSessions()[0]).toMatchObject({ id, state: "active" });
  });

  it("logs approval_request and resolves it via approve()", async () => {
    const db = openDb(":memory:");
    const store = new EventStore(db);
    const exec = new FakeExecutor({ script: [{ tool: "Bash", input: {} }] });
    const mgr = new SessionManager(db, store, exec);
    const id = mgr.createSession("/tmp");
    mgr.prompt(id, "run it");
    // wait until the approval_request event lands in the store
    await vi.waitFor(() => {
      if (!store.listAfter(id, 0).some(e => e.event.type === "approval_request")) throw new Error("not yet");
    });
    const req = store.listAfter(id, 0).find(e => e.event.type === "approval_request")!;
    mgr.approve(id, (req.event as any).approvalId, "deny");
    await exec.settle();
    const resolved = store.listAfter(id, 0).find(e => e.event.type === "approval_resolved" && (e.event as any).behavior === "deny");
    expect(resolved).toBeTruthy();
  });

  it("resumeAll restarts active sessions with the stored provider session id", async () => {
    const db = openDb(":memory:");
    const { mgr, exec, store } = { ...make(db) };
    const id = mgr.createSession("/tmp");
    mgr.prompt(id, "hi");
    await exec.settle();
    // new manager over the same db simulates a server restart
    const mgr2 = new SessionManager(db, store, exec);
    const resumed = mgr2.resumeAll();
    expect(resumed).toEqual([id]);
    mgr2.prompt(id, "again");
    await exec.settle();
    expect(store.listAfter(id, 0).filter(e => e.event.type === "user_prompt").length).toBe(2);
  });
});
```

Add `import { vi } from "vitest";` at the top.

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement `sessionManager.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { EventStore } from "./eventStore.js";
import type { Executor, ExecutorHandle } from "./executor.js";
import type { SessionInfo } from "@superfabric/shared";

export class SessionManager {
  private handles = new Map<string, ExecutorHandle>();
  private approvals = new Map<string, (b: "allow" | "deny") => void>(); // approvalId -> resolver

  constructor(private db: Db, private store: EventStore, private executor: Executor) {}

  createSession(cwd: string): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO sessions (id, cwd) VALUES (?, ?)").run(id, cwd);
    this.startExecutor(id, cwd, null);
    return id;
  }

  /** Restart executors for all sessions marked active. Returns resumed ids. */
  resumeAll(): string[] {
    const rows = this.db.prepare("SELECT id, cwd, claude_session_id FROM sessions WHERE state = 'active'").all() as
      { id: string; cwd: string; claude_session_id: string | null }[];
    for (const r of rows) if (!this.handles.has(r.id)) this.startExecutor(r.id, r.cwd, r.claude_session_id);
    return rows.map(r => r.id);
  }

  private startExecutor(id: string, cwd: string, resume: string | null) {
    const handle = this.executor.start(
      { cwd, resumeSessionId: resume },
      {
        onEvent: (event) => this.store.append(id, event),
        requestApproval: (toolName, input) =>
          new Promise((resolve) => {
            const approvalId = randomUUID();
            this.approvals.set(approvalId, resolve);
            this.store.append(id, { type: "approval_request", approvalId, toolName, input });
          }),
      },
    );
    this.handles.set(id, handle);
    void handle.providerSessionId.then((psid) =>
      this.db.prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?").run(psid, id));
  }

  prompt(id: string, text: string): void {
    const h = this.handles.get(id);
    if (!h) throw new Error(`no live session ${id}`);
    h.send(text);
  }

  approve(id: string, approvalId: string, behavior: "allow" | "deny"): void {
    const resolve = this.approvals.get(approvalId);
    if (!resolve) return;
    this.approvals.delete(approvalId);
    this.store.append(id, { type: "approval_resolved", approvalId, behavior });
    resolve(behavior);
  }

  async interrupt(id: string): Promise<void> { await this.handles.get(id)?.interrupt(); }

  listSessions(): SessionInfo[] {
    return (this.db.prepare("SELECT id, state, claude_session_id FROM sessions ORDER BY created_at").all() as
      { id: string; state: "active" | "paused" | "done"; claude_session_id: string | null }[])
      .map(r => ({
        id: r.id, state: r.state, claudeSessionId: r.claude_session_id,
        lastSeq: (this.db.prepare("SELECT COALESCE(MAX(seq),0) m FROM events WHERE session_id=?").get(r.id) as { m: number }).m,
      }));
  }
}
```

Note: FakeExecutor's scripted approval path emits its own `approval_resolved` with `approvalId: "n/a"` — the manager also appends one with the real id. That's fine for M0 tests (the test filters by `behavior === "deny"`); keep FakeExecutor's duplicate for executor-level tests only. If the duplicate bothers the test, drop the `approval_resolved` emission from FakeExecutor and keep it manager-side only — manager-side is canonical.

- [ ] **Step 4: Run tests** — Expected: PASS (adjust FakeExecutor per the note if needed).
- [ ] **Step 5: Commit** — `git commit -am "feat(server): session manager with approvals and resume-all"`

---

### Task 7: WebSocket layer (subscribe/replay/route)

**Files:**
- Create: `packages/server/src/wsHub.ts`
- Test: `packages/server/test/wsHub.test.ts`

- [ ] **Step 1: Failing test** (drive `wsHub` with a fake socket object — no network):

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { SessionManager } from "../src/sessionManager.js";
import { FakeExecutor } from "../src/executors/fake.js";
import { WsHub, type SocketLike } from "../src/wsHub.js";

function fakeSocket() {
  const sent: any[] = [];
  const sock: SocketLike = { send: (d: string) => sent.push(JSON.parse(d)) };
  return { sock, sent };
}

describe("WsHub", () => {
  it("replays events after subscribe and tails new ones", async () => {
    const db = openDb(":memory:");
    const store = new EventStore(db);
    const exec = new FakeExecutor();
    const mgr = new SessionManager(db, store, exec);
    const hub = new WsHub(store, mgr);
    const id = mgr.createSession("/tmp");
    mgr.prompt(id, "first");
    await exec.settle();

    const { sock, sent } = fakeSocket();
    hub.attach(sock);
    hub.handleMessage(sock, JSON.stringify({ kind: "subscribe", sessionId: id, afterSeq: 0 }));
    const replayed = sent.filter(m => m.kind === "event").length;
    expect(replayed).toBeGreaterThan(0);

    hub.handleMessage(sock, JSON.stringify({ kind: "prompt", sessionId: id, text: "second" }));
    await exec.settle();
    const total = sent.filter(m => m.kind === "event").length;
    expect(total).toBeGreaterThan(replayed);
    // seq strictly increasing, no duplicates
    const seqs = sent.filter(m => m.kind === "event").map(m => m.seq);
    expect([...new Set(seqs)].length).toBe(seqs.length);
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement `wsHub.ts`**

```ts
import { ClientMessage, type ServerMessage } from "@superfabric/shared";
import type { EventStore } from "./eventStore.js";
import type { SessionManager } from "./sessionManager.js";

export interface SocketLike { send(data: string): void; }

export class WsHub {
  /** socket -> subscribed sessionIds with last sent seq */
  private subs = new Map<SocketLike, Map<string, number>>();

  constructor(private store: EventStore, private mgr: SessionManager) {
    store.onAppend((sessionId, seq, event) => {
      const msg: ServerMessage = { kind: "event", sessionId, seq, event };
      for (const [sock, sessions] of this.subs) {
        const last = sessions.get(sessionId);
        if (last !== undefined && seq > last) { sessions.set(sessionId, seq); this.safeSend(sock, msg); }
      }
    });
  }

  attach(sock: SocketLike): void { this.subs.set(sock, new Map()); }
  detach(sock: SocketLike): void { this.subs.delete(sock); }

  handleMessage(sock: SocketLike, raw: string): void {
    let msg: ClientMessage;
    try { msg = ClientMessage.parse(JSON.parse(raw)); }
    catch { return this.safeSend(sock, { kind: "error", message: "bad message" }); }

    switch (msg.kind) {
      case "subscribe": {
        const sessions = this.subs.get(sock) ?? new Map();
        let last = msg.afterSeq;
        for (const { seq, event } of this.store.listAfter(msg.sessionId, msg.afterSeq)) {
          this.safeSend(sock, { kind: "event", sessionId: msg.sessionId, seq, event });
          last = seq;
        }
        sessions.set(msg.sessionId, last);
        this.subs.set(sock, sessions);
        break;
      }
      case "prompt": this.mgr.prompt(msg.sessionId, msg.text); break;
      case "approval": this.mgr.approve(msg.sessionId, msg.approvalId, msg.behavior); break;
      case "interrupt": void this.mgr.interrupt(msg.sessionId); break;
      case "create_session": {
        const id = this.mgr.createSession(msg.cwd ?? process.cwd());
        this.safeSend(sock, { kind: "sessions", sessions: this.mgr.listSessions() });
        // auto-subscribe creator from seq 0
        this.handleMessage(sock, JSON.stringify({ kind: "subscribe", sessionId: id, afterSeq: 0 }));
        break;
      }
      case "list_sessions": this.safeSend(sock, { kind: "sessions", sessions: this.mgr.listSessions() }); break;
    }
  }

  private safeSend(sock: SocketLike, msg: ServerMessage): void {
    try { sock.send(JSON.stringify(msg)); } catch { /* dead socket; detach on close */ }
  }
}
```

- [ ] **Step 4: Run test** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): ws hub with replay-then-tail subscriptions"`

---

### Task 8: ClaudeCodeExecutor — SDK types reconnaissance

**Files:**
- Create: `packages/server/notes/agent-sdk-api.md` (working notes, committed)

- [ ] **Step 1: Inspect the installed SDK's actual API.**

Run: `ls node_modules/@anthropic-ai/claude-agent-sdk/ && cat node_modules/@anthropic-ai/claude-agent-sdk/package.json | head -30`
Then read the type declarations (entry `.d.ts`), specifically confirming:
- `query({ prompt, options })` signature; whether `prompt` accepts `AsyncIterable` of user messages (streaming input mode).
- The message union yielded by the generator: init message carrying `session_id`; assistant text; tool-use events; `result` message (cost, usage).
- `options`: `resume`, `model`, `cwd`, `permissionMode`, `allowedTools`, `canUseTool` (exact name and return shape — e.g. `{ behavior: "allow" | "deny" }`), `mcpServers`, `env`, `appendSystemPrompt` (or `systemPrompt` variants).
- How `interrupt()` is exposed (method on the returned generator or a controller).

- [ ] **Step 2: Write `notes/agent-sdk-api.md`** summarizing the confirmed names/signatures with the exact SDK version pinned. If any assumption from Task 9's code differs from reality, **fix Task 9's code before implementing it** — the notes file is the authority.

- [ ] **Step 3: Commit** — `git commit -am "docs(server): agent-sdk API reconnaissance notes"`

---

### Task 9: ClaudeCodeExecutor implementation

**Files:**
- Create: `packages/server/src/executors/claudeCode.ts`
- Test: `packages/server/test/claudeExecutor.live.test.ts` (gated live smoke test)

The code below is the expected shape — **verify every SDK symbol against Task 8's notes and adjust there, not here.**

- [ ] **Step 1: Implement `executors/claudeCode.ts`**

```ts
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Executor, ExecutorEvents, ExecutorHandle, ExecutorStartOptions } from "../executor.js";

/** Unbounded async queue used as the streaming-input prompt. */
class TurnQueue implements AsyncIterable<SDKUserMessage> {
  private waiting: ((m: SDKUserMessage) => void)[] = [];
  private buffer: SDKUserMessage[] = [];
  push(text: string) {
    const m = { type: "user", message: { role: "user", content: text } } as SDKUserMessage;
    const w = this.waiting.shift();
    if (w) w(m); else this.buffer.push(m);
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const m = this.buffer.shift() ?? await new Promise<SDKUserMessage>(r => this.waiting.push(r));
      yield m;
    }
  }
}

export class ClaudeCodeExecutor implements Executor {
  readonly name = "claude-code";
  constructor(private defaults: { model?: string; configDir?: string } = {}) {}

  start(opts: ExecutorStartOptions, ev: ExecutorEvents): ExecutorHandle {
    const turns = new TurnQueue();
    let resolveSid!: (s: string) => void;
    const providerSessionId = new Promise<string>(r => { resolveSid = r; });

    const q = query({
      prompt: turns,
      options: {
        cwd: opts.cwd,
        ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
        ...(this.defaults.model ? { model: this.defaults.model } : {}),
        ...(this.defaults.configDir ? { env: { ...process.env, CLAUDE_CONFIG_DIR: this.defaults.configDir } } : {}),
        permissionMode: "default",
        canUseTool: async (toolName: string, input: unknown) => {
          const behavior = await ev.requestApproval(toolName, input);
          return behavior === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "denied by operator" };
        },
      },
    });

    ev.onEvent({ type: "session_status", status: "starting" });

    const pump = (async () => {
      try {
        for await (const msg of q) {
          switch (msg.type) {
            case "system":
              if ("session_id" in msg && msg.session_id) resolveSid(msg.session_id as string);
              break;
            case "assistant": {
              // msg.message.content is an array of blocks
              for (const block of (msg as any).message?.content ?? []) {
                if (block.type === "text") ev.onEvent({ type: "agent_text", text: block.text });
                if (block.type === "thinking") ev.onEvent({ type: "agent_thinking" });
                if (block.type === "tool_use") ev.onEvent({ type: "tool_use", toolName: block.name, input: block.input });
              }
              break;
            }
            case "result":
              ev.onEvent({ type: "turn_complete", costUsd: (msg as any).total_cost_usd });
              ev.onEvent({ type: "session_status", status: "idle" });
              break;
          }
        }
      } catch (err) {
        ev.onEvent({ type: "session_error", message: String(err) });
        ev.onEvent({ type: "session_status", status: "error" });
      }
    })();
    void pump;

    return {
      providerSessionId,
      send: (text) => {
        ev.onEvent({ type: "session_status", status: "working" });
        ev.onEvent({ type: "user_prompt", text });
        turns.push(text);
      },
      interrupt: async () => { await (q as any).interrupt?.(); },
      stop: async () => { await (q as any).interrupt?.(); },
    };
  }
}
```

- [ ] **Step 2: Gated live smoke test** (skipped unless env var set):

```ts
import { describe, it, expect } from "vitest";
import { ClaudeCodeExecutor } from "../src/executors/claudeCode.js";
import type { SessionEvent } from "@superfabric/shared";

const live = process.env.SUPERFABRIC_LIVE_TEST === "1";

describe.skipIf(!live)("ClaudeCodeExecutor (live)", () => {
  it("answers a trivial prompt and reports a session id", { timeout: 120_000 }, async () => {
    const events: SessionEvent[] = [];
    const exec = new ClaudeCodeExecutor();
    const h = exec.start({ cwd: process.cwd() }, {
      onEvent: e => events.push(e),
      requestApproval: async () => "deny",   // no tools needed for this prompt
    });
    h.send("Reply with exactly the word: pong");
    const sid = await h.providerSessionId;
    expect(sid.length).toBeGreaterThan(8);
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (events.some(e => e.type === "turn_complete")) { clearInterval(t); resolve(); }
      }, 500);
    });
    const text = events.filter(e => e.type === "agent_text").map(e => (e as any).text).join(" ");
    expect(text.toLowerCase()).toContain("pong");
    await h.stop();
  });
});
```

- [ ] **Step 3: Run unit suite** `pnpm -F @superfabric/server test` — Expected: PASS (live test skipped).
- [ ] **Step 4: Run live once** `SUPERFABRIC_LIVE_TEST=1 pnpm -F @superfabric/server test -- claudeExecutor` — Expected: PASS against the logged-in `~/.claude` account. Record the observed message shapes in `notes/agent-sdk-api.md` if they differ.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): claude-code executor over agent sdk streaming input"`

---

### Task 10: Rate-limit/error surfacing in executor errors

**Files:**
- Modify: `packages/server/src/executors/claudeCode.ts` (catch block)
- Test: `packages/server/test/limitDetect.test.ts`

- [ ] **Step 1: Failing test** for the classifier helper:

```ts
import { describe, it, expect } from "vitest";
import { classifyExecutorError } from "../src/executors/claudeCode.js";

describe("classifyExecutorError", () => {
  it("detects rate-limit-ish errors", () => {
    expect(classifyExecutorError(new Error("429 rate_limit_error: exceeded"))).toBe("rate_limited");
    expect(classifyExecutorError(new Error("Claude usage limit reached|1754269200"))).toBe("rate_limited");
    expect(classifyExecutorError(new Error("boom"))).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement** — export from `claudeCode.ts`:

```ts
export function classifyExecutorError(err: unknown): "rate_limited" | "unknown" {
  const s = String(err).toLowerCase();
  return /429|rate.?limit|usage limit reached/.test(s) ? "rate_limited" : "unknown";
}
```

And in the executor's catch block, prefix the event:
```ts
const kind = classifyExecutorError(err);
ev.onEvent({ type: "session_error", message: `${kind}: ${String(err)}` });
```
(M2's LimitMonitor will consume this; M0 only surfaces it.)

- [ ] **Step 4: Run test** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(server): classify rate-limit errors from executor failures"`

---

### Task 11: Server entrypoint (Fastify + ws + resume-on-boot)

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Implement**

```ts
import Fastify from "fastify";
import { WebSocketServer } from "ws";
import path from "node:path";
import fs from "node:fs";
import { openDb } from "./db.js";
import { EventStore } from "./eventStore.js";
import { SessionManager } from "./sessionManager.js";
import { ClaudeCodeExecutor } from "./executors/claudeCode.js";
import { WsHub } from "./wsHub.js";

const DATA_DIR = process.env.SUPERFABRIC_DATA ?? path.join(process.cwd(), ".fabrica");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = openDb(path.join(DATA_DIR, "fabrica.db"));
const store = new EventStore(db);
const mgr = new SessionManager(db, store, new ClaudeCodeExecutor());
const hub = new WsHub(store, mgr);

const resumed = mgr.resumeAll();
if (resumed.length) console.log(`resumed sessions: ${resumed.join(", ")}`);

const app = Fastify();
app.get("/healthz", async () => ({ ok: true }));

const server = await app.listen({ port: Number(process.env.PORT ?? 4620), host: "127.0.0.1" });
const wss = new WebSocketServer({ server: app.server, path: "/ws" });
wss.on("connection", (sock) => {
  hub.attach(sock);
  sock.on("message", (raw) => hub.handleMessage(sock, raw.toString()));
  sock.on("close", () => hub.detach(sock));
});
console.log(`superfabric server on ${server} (ws: /ws)`);
```

Note: `ws`'s `WebSocket` structurally satisfies `SocketLike` (`send(string)`).

- [ ] **Step 2: Manual check** — `pnpm -F @superfabric/server dev`, then `curl -s localhost:4620/healthz` → `{"ok":true}`.
- [ ] **Step 3: Commit** — `git commit -am "feat(server): fastify entrypoint with ws endpoint and resume-on-boot"`

---

### Task 12: Web scaffold (Vite + React + zustand)

**Files:**
- Create: `packages/web/*` via scaffold, then `packages/web/src/store.ts`, `packages/web/src/wsClient.ts`

- [ ] **Step 1: Scaffold** — `pnpm create vite packages/web --template react-ts`, set package name `@superfabric/web`, add deps: `pnpm -F @superfabric/web add zustand zod @superfabric/shared@workspace:*`. Add `"test": "vitest run"` script and `vite.config.ts` proxy:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/ws": { target: "ws://127.0.0.1:4620", ws: true } } },
});
```

- [ ] **Step 2: Store (`src/store.ts`)**

```ts
import { create } from "zustand";
import type { ServerMessage, SessionEvent, SessionInfo } from "@superfabric/shared";

export interface EventRow { seq: number; event: SessionEvent; }

interface FabricState {
  sessions: SessionInfo[];
  events: Record<string, EventRow[]>;          // sessionId -> ordered events
  lastSeq: Record<string, number>;
  apply(msg: ServerMessage): void;
}

export const useFabric = create<FabricState>((set) => ({
  sessions: [],
  events: {},
  lastSeq: {},
  apply: (msg) => set((s) => {
    if (msg.kind === "sessions") return { sessions: msg.sessions };
    if (msg.kind !== "event") return s;
    const rows = s.events[msg.sessionId] ?? [];
    if ((s.lastSeq[msg.sessionId] ?? 0) >= msg.seq) return s;      // dedupe replays
    return {
      events: { ...s.events, [msg.sessionId]: [...rows, { seq: msg.seq, event: msg.event }] },
      lastSeq: { ...s.lastSeq, [msg.sessionId]: msg.seq },
    };
  }),
}));
```

- [ ] **Step 3: WS client (`src/wsClient.ts`)** — reconnect with replay:

```ts
import { useFabric } from "./store.js";
import type { ClientMessage } from "@superfabric/shared";

let sock: WebSocket | null = null;
const subscribed = new Set<string>();

export function send(msg: ClientMessage) { sock?.send(JSON.stringify(msg)); }

export function connect(): void {
  sock = new WebSocket(`ws://${location.host}/ws`);
  sock.onopen = () => {
    send({ kind: "list_sessions" });
    const { lastSeq } = useFabric.getState();
    for (const id of subscribed) send({ kind: "subscribe", sessionId: id, afterSeq: lastSeq[id] ?? 0 });
  };
  sock.onmessage = (e) => useFabric.getState().apply(JSON.parse(e.data));
  sock.onclose = () => setTimeout(connect, 1000);
}

export function subscribe(sessionId: string): void {
  subscribed.add(sessionId);
  const { lastSeq } = useFabric.getState();
  send({ kind: "subscribe", sessionId, afterSeq: lastSeq[sessionId] ?? 0 });
}
```

- [ ] **Step 4: Unit test the store dedupe** (`packages/web/test/store.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { useFabric } from "../src/store.js";

describe("store", () => {
  it("ignores duplicate/older seqs on replay", () => {
    const apply = useFabric.getState().apply;
    apply({ kind: "event", sessionId: "s", seq: 1, event: { type: "agent_text", text: "a" } });
    apply({ kind: "event", sessionId: "s", seq: 1, event: { type: "agent_text", text: "a" } });
    apply({ kind: "event", sessionId: "s", seq: 2, event: { type: "agent_text", text: "b" } });
    expect(useFabric.getState().events["s"].length).toBe(2);
  });
});
```

Run: `pnpm -F @superfabric/web test` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(web): vite scaffold, zustand event store, reconnecting ws client"`

---

### Task 13: Chat UI with approval cards

**Files:**
- Modify: `packages/web/src/App.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useState } from "react";
import { useFabric } from "./store.js";
import { connect, send, subscribe } from "./wsClient.js";

export default function App() {
  const { sessions, events } = useFabric();
  const [active, setActive] = useState<string | null>(null);
  const [input, setInput] = useState("");

  useEffect(() => { connect(); }, []);
  useEffect(() => { if (!active && sessions[0]) { setActive(sessions[0].id); subscribe(sessions[0].id); } }, [sessions, active]);

  const rows = active ? events[active] ?? [] : [];
  const resolved = new Set(rows.filter(r => r.event.type === "approval_resolved").map(r => (r.event as any).approvalId));
  const pending = rows.filter(r => r.event.type === "approval_request" && !resolved.has((r.event as any).approvalId));

  return (
    <div style={{ fontFamily: "system-ui", maxWidth: 720, margin: "2rem auto" }}>
      <h1>SuperFabric — M0 console</h1>
      <p>
        <button onClick={() => send({ kind: "create_session" })}>New session</button>{" "}
        {sessions.map(s => (
          <button key={s.id} onClick={() => { setActive(s.id); subscribe(s.id); }}
                  style={{ fontWeight: s.id === active ? "bold" : "normal" }}>
            {s.id.slice(0, 8)} [{s.state}]
          </button>
        ))}
      </p>
      <div style={{ border: "1px solid #ccc", padding: 12, minHeight: 300 }}>
        {rows.map(({ seq, event }) => {
          if (event.type === "user_prompt") return <p key={seq}><b>you:</b> {event.text}</p>;
          if (event.type === "agent_text") return <p key={seq}><b>agent:</b> {event.text}</p>;
          if (event.type === "tool_use") return <p key={seq} style={{ color: "#666" }}>⚙ {event.toolName}</p>;
          if (event.type === "session_status") return <p key={seq} style={{ color: "#999" }}>· {event.status}</p>;
          if (event.type === "session_error") return <p key={seq} style={{ color: "red" }}>✖ {event.message}</p>;
          return null;
        })}
        {pending.map(({ seq, event }) => {
          const e = event as Extract<typeof event, { type: "approval_request" }>;
          return (
            <div key={seq} style={{ border: "2px solid orange", padding: 8, margin: "8px 0" }}>
              <b>Approve {e.toolName}?</b>
              <pre>{JSON.stringify(e.input, null, 2)}</pre>
              <button onClick={() => active && send({ kind: "approval", sessionId: active, approvalId: e.approvalId, behavior: "allow" })}>Allow</button>{" "}
              <button onClick={() => active && send({ kind: "approval", sessionId: active, approvalId: e.approvalId, behavior: "deny" })}>Deny</button>
            </div>
          );
        })}
      </div>
      <form onSubmit={(ev) => { ev.preventDefault(); if (active && input.trim()) { send({ kind: "prompt", sessionId: active, text: input }); setInput(""); } }}>
        <input value={input} onChange={e => setInput(e.target.value)} style={{ width: "80%" }} placeholder="Message the agent…" />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Manual run** — terminal A: `pnpm -F @superfabric/server dev`; terminal B: `pnpm -F @superfabric/web dev`; open the Vite URL. Create a session, send "Reply with the word pong", see streamed reply. Trigger a tool (e.g. "run `ls` in this directory") and Allow/Deny via the card.
- [ ] **Step 3: Commit** — `git commit -am "feat(web): m0 chat console with approval cards"`

---

### Task 14: M0 acceptance — restart survival

- [ ] **Step 1: Manual acceptance script** (also record it in `docs/superpowers/plans/` as done):
  1. Start server + web; create a session; exchange 2+ turns.
  2. Kill the server (Ctrl-C). Web shows reconnect attempts.
  3. Start the server again — boot log prints `resumed sessions: <id>`.
  4. Send another prompt in the same chat: the agent still has the earlier conversation context (ask "what word did I ask you to reply with earlier?" → it should recall).
  5. `sqlite3 .fabrica/fabrica.db 'SELECT COUNT(*) FROM events'` — count grows monotonically; no gaps in seq per session.
- [ ] **Step 2: Fix anything the acceptance run surfaces; commit fixes individually.**
- [ ] **Step 3: Update `CLAUDE.md` status line** to "M0 complete; next: M1" and `docs/ROADMAP.md` checkmarks. Commit: `git commit -am "docs: mark M0 complete"`.

---

## Self-review notes

- **Spec coverage (M0 scope)**: monorepo ✔ (T1), SessionManager/streaming ✔ (T5–T6, T9), event log + replay ✔ (T4, T7), minimal UI + approvals ✔ (T13), single account ✔ (default `~/.claude`), resume-after-restart ✔ (T6, T11, T14), limit-error surfacing groundwork ✔ (T10), executor seam for multi-provider ✔ (T5).
- **Known risk**: exact Agent SDK symbol names (Task 8 exists precisely to reconcile Task 9 before it's written; the live smoke test in Task 9 validates end-to-end).
- **Deliberately not in M0**: multi-account, 3D UI, bus, orchestrator, containers, chronicle — see ROADMAP.
