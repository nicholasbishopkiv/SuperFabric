import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { SessionManager } from "../src/sessionManager.js";
import { FakeExecutor } from "../src/executors/fake.js";
import type { Executor, ExecutorEvents, ExecutorHandle, ExecutorStartOptions } from "../src/executor.js";

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
    expect((req.event as any).toolName).toBe("Bash");
    mgr.approve(id, (req.event as any).approvalId, "deny");
    await exec.settle();
    const resolved = store.listAfter(id, 0).find(e => e.event.type === "approval_resolved" && (e.event as any).behavior === "deny");
    expect(resolved).toBeTruthy();
    // exactly one approval_resolved was logged (SessionManager is the sole appender)
    expect(store.listAfter(id, 0).filter(e => e.event.type === "approval_resolved").length).toBe(1);
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

  it("prompt and approve throw on unknown ids so the caller can report them", () => {
    const { mgr } = make();
    expect(() => mgr.prompt("nope", "hi")).toThrow(/no live session/);
    expect(() => mgr.approve("nope", "also-nope", "allow")).toThrow(/unknown approval/);
  });

  it("rejects a non-existent cwd instead of persisting a broken session", () => {
    const { mgr, db } = make();
    expect(() => mgr.createSession("/definitely/not/a/real/path")).toThrow(/does not exist/);
    expect(() => mgr.createSession(join(tmpdir(), "not-a-dir-file"))).toThrow();
    expect((db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c).toBe(0);
  });

  it("rejects a cwd that exists but is a file", () => {
    const { mgr } = make();
    const file = join(mkdtempSync(join(tmpdir(), "superfabric-cwd-")), "f.txt");
    writeFileSync(file, "x");
    expect(() => mgr.createSession(file)).toThrow(/not a directory/);
  });

  // ---- approvals are bound to their session (C3/I3) ----

  describe("approvals", () => {
    async function withPendingApproval() {
      const db = openDb(":memory:");
      const store = new EventStore(db);
      const exec = new FakeExecutor({ script: [{ tool: "Bash", input: {} }] });
      const mgr = new SessionManager(db, store, exec);
      const id = mgr.createSession("/tmp");
      mgr.prompt(id, "run it");
      await vi.waitFor(() => {
        if (!store.listAfter(id, 0).some(e => e.event.type === "approval_request")) throw new Error("not yet");
      });
      const req = store.listAfter(id, 0).find(e => e.event.type === "approval_request")!;
      return { db, store, exec, mgr, id, approvalId: (req.event as any).approvalId as string };
    }

    const resolutions = (store: EventStore, id: string) =>
      store.listAfter(id, 0).filter(e => e.event.type === "approval_resolved");

    it("refuses an approval whose session id does not match the one that asked", async () => {
      const { store, mgr, id, approvalId } = await withPendingApproval();
      expect(() => mgr.approve("bogus-session", approvalId, "allow")).toThrow(/does not belong/);
      // nothing written under the bogus id, and the real session is still undecided
      expect(store.listAfter("bogus-session", 0)).toEqual([]);
      expect(resolutions(store, id)).toEqual([]);
    });

    it("records exactly one approval_resolved, under the session that asked", async () => {
      const { store, exec, mgr, id, approvalId } = await withPendingApproval();
      mgr.approve(id, approvalId, "allow");
      await exec.settle();
      const rows = resolutions(store, id);
      expect(rows).toHaveLength(1);
      expect(rows[0].event).toMatchObject({ approvalId, behavior: "allow" });
      // and the same decision cannot be replayed
      expect(() => mgr.approve(id, approvalId, "deny")).toThrow(/already resolved/);
      expect(resolutions(store, id)).toHaveLength(1);
    });

    it("stopAll denies and logs every still-pending approval", async () => {
      const { store, mgr, id, approvalId } = await withPendingApproval();
      await mgr.stopAll();
      const rows = resolutions(store, id);
      expect(rows).toHaveLength(1);
      expect(rows[0].event).toMatchObject({ approvalId, behavior: "deny" });
      // the executor's canUseTool promise settled too, so the turn is not wedged
      expect(() => mgr.approve(id, approvalId, "allow")).toThrow(/already resolved/);
    });

    it("closes out an approval replayed after a restart instead of silently doing nothing", async () => {
      const { db, store, exec, id, approvalId } = await withPendingApproval();
      // A fresh manager over the same db: the log still holds approval_request, but the resolver
      // died with the previous process.
      const revived = new SessionManager(db, store, exec);
      revived.resumeAll();
      expect(() => revived.approve(id, approvalId, "allow")).toThrow(/expired with the previous process/);
      const rows = resolutions(store, id);
      expect(rows).toHaveLength(1);
      expect(rows[0].event).toMatchObject({ approvalId, behavior: "deny" });
    });
  });

  // ---- terminal executor failures take the session off 'active' (I7) ----

  it("marks a session 'error' on session_error and stops resuming it", () => {
    class FailingExecutor implements Executor {
      readonly name = "failing";
      start(_opts: ExecutorStartOptions, ev: ExecutorEvents): ExecutorHandle {
        ev.onEvent({ type: "session_error", message: "unknown: boom" });
        return {
          providerSessionId: new Promise<string>(() => {}),
          send: () => {},
          interrupt: async () => {},
          stop: async () => {},
        };
      }
    }
    const db = openDb(":memory:");
    const store = new EventStore(db);
    const mgr = new SessionManager(db, store, new FailingExecutor());
    const id = mgr.createSession("/tmp");
    expect(mgr.listSessions()[0]).toMatchObject({ id, state: "error" });
    // a fresh manager (server restart) must not re-spawn a known-broken session
    expect(new SessionManager(db, store, new FailingExecutor()).resumeAll()).toEqual([]);
  });

  it("resumeAll reports only the sessions it actually started", async () => {
    const db = openDb(":memory:");
    const { mgr, store, exec } = make(db);
    const id = mgr.createSession("/tmp");
    // the same manager already holds a live handle for it
    expect(mgr.resumeAll()).toEqual([]);
    const mgr2 = new SessionManager(db, store, exec);
    expect(mgr2.resumeAll()).toEqual([id]);
    expect(mgr2.resumeAll()).toEqual([]);
  });

  // ---- the persisted provider session id is what a restart resumes from ----

  it("feeds the persisted claude_session_id back into the executor on resume", async () => {
    /** Records every start() so the test can assert what resume actually passed through. */
    class RecordingExecutor implements Executor {
      readonly name = "recording";
      readonly starts: ExecutorStartOptions[] = [];
      constructor(private readonly providerId: string) {}
      start(opts: ExecutorStartOptions, ev: ExecutorEvents): ExecutorHandle {
        this.starts.push(opts);
        ev.onEvent({ type: "session_status", status: "idle" });
        return {
          providerSessionId: Promise.resolve(this.providerId),
          send: () => {},
          interrupt: async () => {},
          stop: async () => {},
        };
      }
    }
    const providerId = "claude-session-abcdef";
    const db = openDb(":memory:");
    const store = new EventStore(db);
    const cwd = mkdtempSync(join(tmpdir(), "superfabric-resume-"));

    const exec1 = new RecordingExecutor(providerId);
    const mgr = new SessionManager(db, store, exec1);
    const id = mgr.createSession(cwd);
    expect(exec1.starts).toHaveLength(1);
    expect(exec1.starts[0].cwd).toBe(cwd);
    expect(exec1.starts[0].resumeSessionId ?? null).toBeNull();

    // the id lands in the db asynchronously, off providerSessionId
    await vi.waitFor(() => {
      const row = db.prepare("SELECT claude_session_id c FROM sessions WHERE id = ?").get(id) as { c: string | null };
      if (row.c !== providerId) throw new Error(`not persisted yet: ${row.c}`);
    });

    // restart: a second manager over the same db must hand the stored id back to the executor
    const exec2 = new RecordingExecutor(providerId);
    const mgr2 = new SessionManager(db, store, exec2);
    expect(mgr2.resumeAll()).toEqual([id]);
    expect(exec2.starts).toHaveLength(1);
    expect(exec2.starts[0].resumeSessionId).toBe(providerId);
    expect(exec2.starts[0].cwd).toBe(cwd);
  });

  describe("stopAll", () => {
    it("stops every live executor; prompt() on a stopped session then throws", async () => {
      const { mgr } = make();
      const id = mgr.createSession("/tmp");
      await mgr.stopAll();
      expect(() => mgr.prompt(id, "hi")).toThrow();
    });

    it("a hanging stop() does not prevent stopAll() from resolving", async () => {
      class HangingExecutor implements Executor {
        readonly name = "hanging";
        start(_opts: ExecutorStartOptions, ev: ExecutorEvents): ExecutorHandle {
          ev.onEvent({ type: "session_status", status: "idle" });
          return {
            providerSessionId: Promise.resolve("hanging-session"),
            send: () => {},
            interrupt: async () => {},
            stop: () => new Promise<void>(() => {}), // never settles
          };
        }
      }
      const db = openDb(":memory:");
      const store = new EventStore(db);
      const mgr = new SessionManager(db, store, new HangingExecutor());
      const id = mgr.createSession("/tmp");

      const start = Date.now();
      await mgr.stopAll(50);
      expect(Date.now() - start).toBeLessThan(2000);
      expect(() => mgr.prompt(id, "hi")).toThrow();
    });

    it("is safe to call twice", async () => {
      const { mgr } = make();
      mgr.createSession("/tmp");
      await mgr.stopAll();
      await expect(mgr.stopAll()).resolves.toBeUndefined();
    });
  });
});
