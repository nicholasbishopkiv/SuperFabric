import { describe, it, expect, vi } from "vitest";
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

  it("prompt throws on unknown session id, approve no-ops on unknown approvalId", () => {
    const { mgr } = make();
    expect(() => mgr.prompt("nope", "hi")).toThrow();
    expect(() => mgr.approve("nope", "also-nope", "allow")).not.toThrow();
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
