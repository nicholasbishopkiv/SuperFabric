import { describe, it, expect } from "bun:test";
import { waitFor } from "./_waitFor.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { FakeExecutor } from "../src/executors/fake.js";
import { FactoryBus } from "../src/factoryBus.js";
import { TaskStore } from "../src/taskStore.js";
import type { Executor, ExecutorEvents, ExecutorHandle, ExecutorStartOptions } from "../src/executor.js";
import type { SessionEvent } from "@superfabric/shared";

function make(db = openDb(":memory:")) {
  const store = new EventStore(db);
  const exec = new FakeExecutor();
  const { projects, rooms } = factory(db);
  const mgr = new SessionManager(db, store, exec, rooms, projects);
  return { db, store, exec, projects, rooms, mgr };
}

/**
 * The project- and room-scoped managers, built together because they share one `ProjectManager`.
 * `root` is the default project's root, so a call that names no project lands there.
 */
function factory(db: ReturnType<typeof openDb>, root: string = tmpdir()) {
  const projects = new ProjectManager(db, root);
  return { projects, rooms: new RoomManager(db, projects) };
}

/**
 * The last two `SessionManager` arguments (`rooms`, `projects`) for a case that does not care about
 * either — spread, so a construction stays one line.
 */
function manager(db: ReturnType<typeof openDb>): [RoomManager, ProjectManager] {
  const { projects, rooms } = factory(db);
  return [rooms, projects];
}

describe("SessionManager", () => {
  it("creates a session, persists it, and logs prompt+reply events", async () => {
    const { store, exec, mgr } = make();
    const id = mgr.createSession({ cwd: "/tmp" });
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
    const mgr = new SessionManager(db, store, exec, ...manager(db));
    const id = mgr.createSession({ cwd: "/tmp" });
    mgr.prompt(id, "run it");
    // wait until the approval_request event lands in the store
    await waitFor(() => {
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
    const id = mgr.createSession({ cwd: "/tmp" });
    mgr.prompt(id, "hi");
    await exec.settle();
    // new manager over the same db simulates a server restart
    const mgr2 = new SessionManager(db, store, exec, ...manager(db));
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
    expect(() => mgr.createSession({ cwd: "/definitely/not/a/real/path" })).toThrow(/does not exist/);
    expect(() => mgr.createSession({ cwd: join(tmpdir(), "not-a-dir-file") })).toThrow();
    expect((db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c).toBe(0);
  });

  it("rejects a cwd that exists but is a file", () => {
    const { mgr } = make();
    const file = join(mkdtempSync(join(tmpdir(), "superfabric-cwd-")), "f.txt");
    writeFileSync(file, "x");
    expect(() => mgr.createSession({ cwd: file })).toThrow(/not a directory/);
  });

  // ---- approvals are bound to their session (C3/I3) ----

  describe("approvals", () => {
    async function withPendingApproval() {
      const db = openDb(":memory:");
      const store = new EventStore(db);
      const exec = new FakeExecutor({ script: [{ tool: "Bash", input: {} }] });
      const mgr = new SessionManager(db, store, exec, ...manager(db));
      const id = mgr.createSession({ cwd: "/tmp" });
      mgr.prompt(id, "run it");
      await waitFor(() => {
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
      const revived = new SessionManager(db, store, exec, ...manager(db));
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
    const mgr = new SessionManager(db, store, new FailingExecutor(), ...manager(db));
    const id = mgr.createSession({ cwd: "/tmp" });
    expect(mgr.listSessions()[0]).toMatchObject({ id, state: "error" });
    // a fresh manager (server restart) must not re-spawn a known-broken session
    expect(new SessionManager(db, store, new FailingExecutor(), ...manager(db)).resumeAll()).toEqual([]);
  });

  it("resumeAll reports only the sessions it actually started", async () => {
    const db = openDb(":memory:");
    const { mgr, store, exec } = make(db);
    const id = mgr.createSession({ cwd: "/tmp" });
    // the same manager already holds a live handle for it
    expect(mgr.resumeAll()).toEqual([]);
    const mgr2 = new SessionManager(db, store, exec, ...manager(db));
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
    const mgr = new SessionManager(db, store, exec1, ...manager(db));
    const id = mgr.createSession({ cwd });
    expect(exec1.starts).toHaveLength(1);
    expect(exec1.starts[0].cwd).toBe(cwd);
    expect(exec1.starts[0].resumeSessionId ?? null).toBeNull();

    // the id lands in the db asynchronously, off providerSessionId
    await waitFor(() => {
      const row = db.prepare("SELECT claude_session_id c FROM sessions WHERE id = ?").get(id) as { c: string | null };
      if (row.c !== providerId) throw new Error(`not persisted yet: ${row.c}`);
    });

    // restart: a second manager over the same db must hand the stored id back to the executor
    const exec2 = new RecordingExecutor(providerId);
    const mgr2 = new SessionManager(db, store, exec2, ...manager(db));
    expect(mgr2.resumeAll()).toEqual([id]);
    expect(exec2.starts).toHaveLength(1);
    expect(exec2.starts[0].resumeSessionId).toBe(providerId);
    expect(exec2.starts[0].cwd).toBe(cwd);
  });

  // ---- per-agent autonomy: persisted, passed to the executor, survives resume ----

  describe("autonomy", () => {
    /** Records every start() so a test can assert the mode the executor was handed. */
    class RecordingExecutor implements Executor {
      readonly name = "recording";
      readonly starts: ExecutorStartOptions[] = [];
      readonly stops: number[] = [];
      constructor(private readonly providerId = "claude-session-auto") {}
      start(opts: ExecutorStartOptions, ev: ExecutorEvents): ExecutorHandle {
        this.starts.push(opts);
        ev.onEvent({ type: "session_status", status: "idle" });
        return {
          providerSessionId: Promise.resolve(this.providerId),
          send: () => {},
          interrupt: async () => {},
          stop: async () => { this.stops.push(Date.now()); },
        };
      }
    }

    const setup = (db = openDb(":memory:")) => {
      const store = new EventStore(db);
      const exec = new RecordingExecutor();
      return { db, store, exec, mgr: new SessionManager(db, store, exec, ...manager(db)) };
    };

    const stored = (db: ReturnType<typeof openDb>, id: string) =>
      (db.prepare("SELECT autonomy FROM sessions WHERE id = ?").get(id) as { autonomy: string }).autonomy;

    it("defaults a new session to auto and passes it to the executor", () => {
      const { db, exec, mgr } = setup();
      const id = mgr.createSession({ cwd: "/tmp" });
      expect(stored(db, id)).toBe("auto");
      expect(exec.starts[0].autonomy).toBe("auto");
      expect(mgr.listSessions()[0].autonomy).toBe("auto");
    });

    it("createSession with bypass persists it and hands it to the executor", () => {
      const { db, exec, mgr } = setup();
      const id = mgr.createSession({ cwd: "/tmp", autonomy: "bypass" });
      expect(stored(db, id)).toBe("bypass");
      expect(exec.starts).toHaveLength(1);
      expect(exec.starts[0].autonomy).toBe("bypass");
      expect(mgr.listSessions()[0].autonomy).toBe("bypass");
    });

    it("setAutonomy persists, restarts the live executor with the new mode, and logs it", async () => {
      const { db, store, exec, mgr } = setup();
      const id = mgr.createSession({ cwd: "/tmp", autonomy: "auto" });
      // the provider session id lands asynchronously; the restart must resume from it
      await waitFor(() => {
        const row = db.prepare("SELECT claude_session_id c FROM sessions WHERE id = ?").get(id) as { c: string | null };
        if (row.c === null) throw new Error("not persisted yet");
      });

      await mgr.setAutonomy(id, "bypass");

      expect(stored(db, id)).toBe("bypass");
      expect(mgr.listSessions().find(s => s.id === id)!.autonomy).toBe("bypass");
      // the old executor was stopped and a new one started under the new mode, resuming the
      // provider session so the conversation is preserved
      expect(exec.stops).toHaveLength(1);
      expect(exec.starts).toHaveLength(2);
      expect(exec.starts[1].autonomy).toBe("bypass");
      expect(exec.starts[1].resumeSessionId).toBe("claude-session-auto");
      // the change is visible in the transcript, and the log records it
      const detail = store.listAfter(id, 0)
        .map(e => e.event)
        .filter(e => e.type === "session_status")
        .map(e => (e as { detail?: string }).detail)
        .find(d => d !== undefined && d.includes("bypass"));
      expect(detail).toContain("autonomy: bypass");
      // prompting still works against the freshly started executor
      expect(() => mgr.prompt(id, "still here")).not.toThrow();
    });

    it("persists without restarting when the session is not live", async () => {
      const { db, store, exec, mgr } = setup();
      const id = mgr.createSession({ cwd: "/tmp", autonomy: "auto" });
      await mgr.stopAll();
      const startsBefore = exec.starts.length;

      await mgr.setAutonomy(id, "attended");

      expect(stored(db, id)).toBe("attended");
      expect(exec.starts).toHaveLength(startsBefore);
      const statuses = store.listAfter(id, 0).map(e => e.event).filter(e => e.type === "session_status");
      expect((statuses.at(-1) as { detail?: string }).detail).toContain("autonomy: attended");
    });

    it("does not spawn a replacement executor when shutdown starts mid-toggle", async () => {
      const { db, exec, mgr } = setup();
      const id = mgr.createSession({ cwd: "/tmp", autonomy: "auto" });
      // the toggle suspends while stopping the old executor; shutdown begins in the meantime
      const toggling = mgr.setAutonomy(id, "bypass");
      await mgr.stopAll();
      await toggling;
      // nothing was restarted, but the mode is stored for the next boot
      expect(exec.starts).toHaveLength(1);
      expect(stored(db, id)).toBe("bypass");
    });

    it("rejects an unknown session instead of persisting anything", async () => {
      const { db, mgr } = setup();
      await expect(mgr.setAutonomy("nope", "bypass")).rejects.toThrow(/unknown session/);
      expect((db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c).toBe(0);
    });

    it("resumeAll restarts a session with its stored mode, so bypass stays bypass", async () => {
      const db = openDb(":memory:");
      const { store, mgr } = setup(db);
      const id = mgr.createSession({ cwd: "/tmp", autonomy: "bypass" });
      await mgr.stopAll();

      // a second manager over the same db simulates a server restart
      const exec2 = new RecordingExecutor();
      const mgr2 = new SessionManager(db, store, exec2, ...manager(db));
      expect(mgr2.resumeAll()).toEqual([id]);
      expect(exec2.starts[0].autonomy).toBe("bypass");
      expect(mgr2.listSessions().find(s => s.id === id)!.autonomy).toBe("bypass");
    });

    it("falls back to auto for an unparseable stored mode", () => {
      const db = openDb(":memory:");
      const { store, mgr } = setup(db);
      const id = mgr.createSession({ cwd: "/tmp", autonomy: "bypass" });
      db.prepare("UPDATE sessions SET autonomy = ? WHERE id = ?").run("nonsense", id);
      expect(mgr.listSessions()[0].autonomy).toBe("auto");
      const exec2 = new RecordingExecutor();
      const mgr2 = new SessionManager(db, store, exec2, ...manager(db));
      mgr2.resumeAll();
      expect(exec2.starts[0].autonomy).toBe("auto");
    });
  });

  // ---- per-agent model: persisted, passed to the executor, survives resume ----

  describe("model", () => {
    /** Records every start() so a test can assert the model the executor was handed. */
    class RecordingExecutor implements Executor {
      readonly name = "recording";
      readonly starts: ExecutorStartOptions[] = [];
      readonly stops: number[] = [];
      constructor(private readonly providerId = "claude-session-model") {}
      start(opts: ExecutorStartOptions, ev: ExecutorEvents): ExecutorHandle {
        this.starts.push(opts);
        ev.onEvent({ type: "session_status", status: "idle" });
        return {
          providerSessionId: Promise.resolve(this.providerId),
          send: () => {},
          interrupt: async () => {},
          stop: async () => { this.stops.push(Date.now()); },
        };
      }
    }

    const setup = (db = openDb(":memory:")) => {
      const store = new EventStore(db);
      const exec = new RecordingExecutor();
      return { db, store, exec, mgr: new SessionManager(db, store, exec, ...manager(db)) };
    };

    const stored = (db: ReturnType<typeof openDb>, id: string) =>
      (db.prepare("SELECT model FROM sessions WHERE id = ?").get(id) as { model: string | null }).model;

    it("pins nothing by default, so the CLI's own default applies", () => {
      const { db, exec, mgr } = setup();
      const id = mgr.createSession({ cwd: "/tmp" });
      expect(stored(db, id)).toBeNull();
      expect(exec.starts[0].model).toBeNull();
      expect(mgr.listSessions()[0].model).toBeNull();
    });

    it("createSession with a model persists it and hands it to the executor", () => {
      const { db, exec, mgr } = setup();
      const id = mgr.createSession({ cwd: "/tmp", model: "claude-haiku-4-5" });
      expect(stored(db, id)).toBe("claude-haiku-4-5");
      expect(exec.starts).toHaveLength(1);
      expect(exec.starts[0].model).toBe("claude-haiku-4-5");
      expect(mgr.listSessions()[0].model).toBe("claude-haiku-4-5");
    });

    it("setModel persists, restarts the live executor on the new model, and logs it", async () => {
      const { db, store, exec, mgr } = setup();
      const id = mgr.createSession({ cwd: "/tmp", model: "claude-sonnet-5" });
      // the provider session id lands asynchronously; the restart must resume from it
      await waitFor(() => {
        const row = db.prepare("SELECT claude_session_id c FROM sessions WHERE id = ?").get(id) as { c: string | null };
        if (row.c === null) throw new Error("not persisted yet");
      });

      await mgr.setModel(id, "claude-opus-5");

      expect(stored(db, id)).toBe("claude-opus-5");
      expect(mgr.listSessions().find(s => s.id === id)!.model).toBe("claude-opus-5");
      // the stored model and the running one cannot disagree: the old executor is stopped and a new
      // one resumes the same provider session on the new model
      expect(exec.stops).toHaveLength(1);
      expect(exec.starts).toHaveLength(2);
      expect(exec.starts[1].model).toBe("claude-opus-5");
      expect(exec.starts[1].resumeSessionId).toBe("claude-session-model");
      // the autonomy the session was created with survives the model change
      expect(exec.starts[1].autonomy).toBe("auto");
      const detail = store.listAfter(id, 0)
        .map(e => e.event)
        .filter(e => e.type === "session_status")
        .map(e => (e as { detail?: string }).detail)
        .find(d => d !== undefined && d.includes("model"));
      expect(detail).toContain("model: claude-opus-5");
      expect(() => mgr.prompt(id, "still here")).not.toThrow();
    });

    it("un-pins a session back to the CLI default with null", async () => {
      const { db, exec, mgr } = setup();
      const id = mgr.createSession({ cwd: "/tmp", model: "claude-haiku-4-5" });
      await mgr.setModel(id, null);
      expect(stored(db, id)).toBeNull();
      expect(exec.starts[1].model).toBeNull();
      expect(mgr.listSessions()[0].model).toBeNull();
    });

    it("persists without restarting when the session is not live", async () => {
      const { db, store, exec, mgr } = setup();
      const id = mgr.createSession({ cwd: "/tmp" });
      await mgr.stopAll();
      const startsBefore = exec.starts.length;

      await mgr.setModel(id, "claude-haiku-4-5");

      expect(stored(db, id)).toBe("claude-haiku-4-5");
      expect(exec.starts).toHaveLength(startsBefore);
      const statuses = store.listAfter(id, 0).map(e => e.event).filter(e => e.type === "session_status");
      expect((statuses.at(-1) as { detail?: string }).detail).toContain("claude-haiku-4-5");
    });

    it("does not spawn a replacement executor when shutdown starts mid-switch", async () => {
      const { db, exec, mgr } = setup();
      const id = mgr.createSession({ cwd: "/tmp" });
      const switching = mgr.setModel(id, "claude-haiku-4-5");
      await mgr.stopAll();
      await switching;
      expect(exec.starts).toHaveLength(1);
      expect(stored(db, id)).toBe("claude-haiku-4-5");
    });

    it("rejects an unknown session instead of persisting anything", async () => {
      const { db, mgr } = setup();
      await expect(mgr.setModel("nope", "claude-opus-5")).rejects.toThrow(/unknown session/);
      expect((db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c).toBe(0);
    });

    it("resumeAll restarts a session on its stored model, so a restart changes nothing", async () => {
      const db = openDb(":memory:");
      const { store, mgr } = setup(db);
      const pinned = mgr.createSession({ cwd: "/tmp", model: "claude-haiku-4-5" });
      const unpinned = mgr.createSession({ cwd: "/tmp" });
      await mgr.stopAll();

      // a second manager over the same db simulates a server restart
      const exec2 = new RecordingExecutor();
      const mgr2 = new SessionManager(db, store, exec2, ...manager(db));
      expect(mgr2.resumeAll().sort()).toEqual([pinned, unpinned].sort());
      const byModel = new Map(exec2.starts.map(o => [o.model ?? "default", o]));
      expect([...byModel.keys()].sort()).toEqual(["claude-haiku-4-5", "default"]);
      expect(mgr2.listSessions().find(s => s.id === pinned)!.model).toBe("claude-haiku-4-5");
      expect(mgr2.listSessions().find(s => s.id === unpinned)!.model).toBeNull();
    });

    it("reports whatever id is stored, including one this build has never heard of", () => {
      // Model ids are Anthropic's release schedule, not our schema: an id we do not know about is
      // a valid choice by an operator with a newer CLI, not a row to sanitise.
      const { db, mgr } = setup();
      const id = mgr.createSession({ cwd: "/tmp" });
      db.prepare("UPDATE sessions SET model = ? WHERE id = ?").run("claude-something-7", id);
      expect(mgr.listSessions()[0].model).toBe("claude-something-7");
    });
  });

  // ---- M1a: a session belongs to a room and runs in that room's folder ----

  describe("rooms", () => {
    /** Records every start() so a test can assert the cwd the executor was handed. */
    class RecordingExecutor implements Executor {
      readonly name = "recording";
      readonly starts: ExecutorStartOptions[] = [];
      start(opts: ExecutorStartOptions, ev: ExecutorEvents): ExecutorHandle {
        this.starts.push(opts);
        ev.onEvent({ type: "session_status", status: "idle" });
        return {
          providerSessionId: Promise.resolve("claude-session-room"),
          send: () => {},
          interrupt: async () => {},
          stop: async () => {},
        };
      }
    }

    /** A project root with one real room folder, plus a manager wired to it. */
    function withRoom<T>(fn: (ctx: {
      db: ReturnType<typeof openDb>; store: EventStore; exec: RecordingExecutor;
      rooms: RoomManager; projects: ProjectManager; mgr: SessionManager;
      room: ReturnType<RoomManager["createRoom"]>;
    }) => T): T {
      const root = mkdtempSync(join(tmpdir(), "superfabric-session-room-"));
      const db = openDb(":memory:");
      try {
        const store = new EventStore(db);
        const exec = new RecordingExecutor();
        const { projects, rooms } = factory(db, root);
        rooms.ensureProjectRoom();
        const room = rooms.createRoom("backend");
        return fn({
          db, store, exec, rooms, projects, room,
          mgr: new SessionManager(db, store, exec, rooms, projects),
        });
      } finally {
        // The db is in-memory and deliberately left open: a session's providerSessionId lands on a
        // later microtask, and closing underneath it turns a passing test into a stray rejection.
        rmSync(root, { recursive: true, force: true });
      }
    }

    it("persists a session's room and reports it in listSessions", () => {
      withRoom(({ db, mgr, room }) => {
        const id = mgr.createSession({ roomId: room.id });
        expect(db.prepare("SELECT room_id FROM sessions WHERE id = ?").get(id)).toEqual({ room_id: room.id });
        expect(mgr.listSessions().find((s) => s.id === id)!.roomId).toBe(room.id);
      });
    });

    it("leaves a session without a room as roomless", () => {
      withRoom(({ db, mgr }) => {
        const id = mgr.createSession({ cwd: tmpdir() });
        expect(db.prepare("SELECT room_id FROM sessions WHERE id = ?").get(id)).toEqual({ room_id: null });
        expect(mgr.listSessions().find((s) => s.id === id)!.roomId).toBeNull();
      });
    });

    it("runs an agent in a room with that room's folder as its cwd", () => {
      withRoom(({ exec, mgr, room }) => {
        mgr.createSession({ roomId: room.id });
        expect(exec.starts).toHaveLength(1);
        expect(exec.starts[0].cwd).toBe(room.path);
      });
    });

    it("lets the room's folder win over a cwd sent alongside it", () => {
      withRoom(({ db, exec, mgr, room }) => {
        const id = mgr.createSession({ cwd: tmpdir(), roomId: room.id });
        expect(exec.starts[0].cwd).toBe(room.path);
        // and the stored cwd is the room's too, so a resume comes back in the same folder
        expect(db.prepare("SELECT cwd FROM sessions WHERE id = ?").get(id)).toEqual({ cwd: room.path });
      });
    });

    it("keeps the room across a restart", () => {
      withRoom(({ db, store, rooms, projects, mgr, room }) => {
        const id = mgr.createSession({ roomId: room.id });
        const exec2 = new RecordingExecutor();
        const revived = new SessionManager(db, store, exec2, rooms, projects);
        expect(revived.resumeAll()).toEqual([id]);
        expect(exec2.starts[0].cwd).toBe(room.path);
        expect(revived.listSessions().find((s) => s.id === id)!.roomId).toBe(room.id);
      });
    });

    it("rejects an unknown roomId instead of persisting a session nobody can place", () => {
      withRoom(({ db, exec, mgr }) => {
        expect(() => mgr.createSession({ roomId: "nope" })).toThrow(/unknown room/);
        expect((db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c).toBe(0);
        expect(exec.starts).toHaveLength(0);
      });
    });

    it("counts a room's agents once the session exists", () => {
      withRoom(({ rooms, mgr, room }) => {
        expect(rooms.listRooms().find((r) => r.id === room.id)!.agentCount).toBe(0);
        mgr.createSession({ roomId: room.id });
        mgr.createSession({ roomId: room.id });
        expect(rooms.listRooms().find((r) => r.id === room.id)!.agentCount).toBe(2);
      });
    });
  });

  // ---- M3a: the factory bus as a per-session tool set ----

  describe("bus tools", () => {
    /** Records every start(), so a test can assert the tool servers the executor was handed. */
    class RecordingExecutor implements Executor {
      readonly name = "recording";
      readonly starts: ExecutorStartOptions[] = [];
      start(opts: ExecutorStartOptions, ev: ExecutorEvents): ExecutorHandle {
        this.starts.push(opts);
        ev.onEvent({ type: "session_status", status: "idle" });
        return {
          providerSessionId: Promise.resolve("claude-session-bus"),
          send: () => {},
          interrupt: async () => {},
          stop: async () => {},
        };
      }
    }

    /** A manager wired to a real bus and task store over two real rooms. */
    function withBus<T>(fn: (ctx: {
      db: ReturnType<typeof openDb>; store: EventStore; exec: RecordingExecutor; rooms: RoomManager;
      projects: ProjectManager; mgr: SessionManager; bus: FactoryBus; tasks: TaskStore;
      chat: ReturnType<RoomManager["createRoom"]>; payments: ReturnType<RoomManager["createRoom"]>;
      delivered: { sessionId: string; text: string }[];
    }) => T): T {
      const root = mkdtempSync(join(tmpdir(), "superfabric-session-bus-"));
      const db = openDb(":memory:");
      try {
        const store = new EventStore(db);
        const exec = new RecordingExecutor();
        const { projects, rooms } = factory(db, root);
        rooms.ensureProjectRoom();
        const chat = rooms.createRoom("chat");
        const payments = rooms.createRoom("payments");
        const delivered: { sessionId: string; text: string }[] = [];
        const tasks = new TaskStore(db, projects);
        const bus = new FactoryBus({
          db, rooms, projects,
          deliver: (sessionId, text) => { delivered.push({ sessionId, text }); },
          roomAgents: () => [],
        });
        const mgr = new SessionManager(db, store, exec, rooms, projects, { bus, tasks });
        return fn({ db, store, exec, rooms, projects, mgr, bus, tasks, chat, payments, delivered });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    /** A tool as the MCP server holds it: what the SDK will actually offer the model. */
    interface Registered {
      handler: (args: unknown, extra: unknown) => Promise<unknown>;
    }

    /**
     * The tools registered on the in-process MCP server a start() was handed. `_registeredTools` is
     * the MCP SDK's own private map; reaching into it is the only way to assert what the *server*
     * carries rather than what our builder returned, which is the point of these cases.
     */
    function registeredTools(opts: ExecutorStartOptions): Record<string, Registered> {
      const server = opts.mcpServers?.factory as { instance?: { _registeredTools?: Record<string, Registered> } };
      return server?.instance?._registeredTools ?? {};
    }

    function toolsOf(opts: ExecutorStartOptions): string[] {
      return Object.keys(registeredTools(opts));
    }

    it("gives a session in a room the factory MCP server", () => {
      withBus(({ exec, mgr, chat }) => {
        mgr.createSession({ roomId: chat.id });
        const opts = exec.starts[0]!;
        expect(Object.keys(opts.mcpServers ?? {})).toEqual(["factory"]);
        expect(toolsOf(opts)).toEqual([
          "factory_send", "factory_inbox", "factory_task_update", "factory_report_status",
          "factory_ask_orchestrator",
        ]);
      });
    });

    it("gives a roomless session no bus tools: it has no department to speak for", () => {
      withBus(({ exec, mgr }) => {
        mgr.createSession({ cwd: tmpdir() });
        expect(exec.starts[0]!.mcpServers).toEqual({});
      });
    });

    it("gives no bus tools at all when the manager was built without a bus", () => {
      const root = mkdtempSync(join(tmpdir(), "superfabric-session-nobus-"));
      try {
        const db = openDb(":memory:");
        const store = new EventStore(db);
        const exec = new RecordingExecutor();
        const { projects, rooms } = factory(db, root);
        rooms.ensureProjectRoom();
        const room = rooms.createRoom("chat");
        // an M0-shaped server: no bus, no task store, and rooms that simply have no tools
        new SessionManager(db, store, exec, rooms, projects).createSession({ roomId: room.id });
        expect(exec.starts[0]!.mcpServers).toEqual({});
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("scopes the tool set to the session's own room, not to one an agent could name", async () => {
      await withBus(async ({ exec, mgr, bus, chat, payments }) => {
        mgr.createSession({ roomId: chat.id });
        const send = registeredTools(exec.starts[0]!).factory_send!;

        // the arguments claim to be the payments room; the message must still come from chat
        await send.handler(
          { to_room: "payments", kind: "request", body: "who is speaking?", from_room: "payments" },
          {},
        );
        expect(bus.list()[0]).toMatchObject({ fromRoomId: chat.id, toRoomId: payments.id });
      });
    });

    it("keeps the tool set across a restart, built from the stored room", () => {
      withBus(({ db, store, rooms, projects, bus, tasks, mgr, chat }) => {
        mgr.createSession({ roomId: chat.id });
        const exec2 = new RecordingExecutor();
        const mgr2 = new SessionManager(db, store, exec2, rooms, projects, { bus, tasks });
        expect(mgr2.resumeAll()).toHaveLength(1);
        expect(Object.keys(exec2.starts[0]!.mcpServers ?? {})).toEqual(["factory"]);
      });
    });

    it("rebuilds the tool set when a live session's autonomy is switched", async () => {
      await withBus(async ({ exec, mgr, chat }) => {
        const id = mgr.createSession({ roomId: chat.id });
        await mgr.setAutonomy(id, "bypass");
        expect(exec.starts).toHaveLength(2);
        // the restarted executor must still have the bus, or a mode toggle would silently mute an agent
        expect(Object.keys(exec.starts[1]!.mcpServers ?? {})).toEqual(["factory"]);
      });
    });

    /**
     * The wiring `index.ts` builds: a bus whose `deliver`/`roomAgents` point at the manager, and a
     * manager that holds the bus. A scripted `FakeExecutor` supplies the turn boundaries, which is
     * the whole subject of these cases.
     */
    function withWiredBus<T>(fn: (ctx: {
      store: EventStore; exec: FakeExecutor; mgr: SessionManager; bus: FactoryBus;
      chat: ReturnType<RoomManager["createRoom"]>; payments: ReturnType<RoomManager["createRoom"]>;
    }) => T): T {
      const root = mkdtempSync(join(tmpdir(), "superfabric-session-flush-"));
      const db = openDb(":memory:");
      try {
        const store = new EventStore(db);
        const { projects, rooms } = factory(db, root);
        rooms.ensureProjectRoom();
        const chat = rooms.createRoom("chat");
        const payments = rooms.createRoom("payments");
        const exec = new FakeExecutor();
        const tasks = new TaskStore(db, projects);
        // `mgr` is only read inside the callbacks, which cannot run before it is assigned — the same
        // knot index.ts unties, and the reason the bus takes callbacks at all.
        let mgr!: SessionManager;
        const bus = new FactoryBus({
          db, rooms, projects,
          deliver: (sessionId, text) => mgr.prompt(sessionId, text),
          roomAgents: (roomId) => mgr.roomAgents(roomId),
        });
        mgr = new SessionManager(db, store, exec, rooms, projects, { bus, tasks });
        return fn({ store, exec, mgr, bus, chat, payments });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    it("reports a room's live agents to the bus, and only the live ones", async () => {
      await withWiredBus(async ({ exec, mgr, chat, payments }) => {
        const id = mgr.createSession({ roomId: chat.id });

        expect(mgr.roomAgents(chat.id)).toEqual([{ sessionId: id, status: "idle" }]);
        expect(mgr.roomAgents(payments.id)).toEqual([]);

        mgr.prompt(id, "get to work");
        expect(mgr.roomAgents(chat.id)).toEqual([{ sessionId: id, status: "working" }]);
        await exec.settle();
        expect(mgr.roomAgents(chat.id)).toEqual([{ sessionId: id, status: "idle" }]);

        // a session whose executor is gone cannot carry anything, so it must not be offered
        await mgr.stopAll();
        expect(mgr.roomAgents(chat.id)).toEqual([]);
      });
    });

    it("delivers a message queued for a busy room at that room's next turn boundary", async () => {
      await withWiredBus(async ({ store, exec, mgr, bus, chat, payments }) => {
        const id = mgr.createSession({ roomId: payments.id });

        mgr.prompt(id, "get to work");
        const queued = bus.send({
          fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "Please expose a webhook",
        });
        // mid-turn: persisted, not injected
        expect(queued.deliveredAt).toBeNull();

        await exec.settle();
        expect(bus.get(queued.id)!.deliveredAt).not.toBeNull();
        // the injected turn is queued into the executor by the flush, so it runs one turn later
        await exec.settle();
        const prompts = store.listAfter(id, 0)
          .map((e) => e.event)
          .filter((e): e is Extract<SessionEvent, { type: "user_prompt" }> => e.type === "user_prompt");
        expect(prompts.some((p) => p.text.includes("Please expose a webhook"))).toBe(true);
        expect(prompts.some((p) => p.text.includes("chat"))).toBe(true);
      });
    });

    it("does not deliver the same message again at the next turn boundary", async () => {
      await withWiredBus(async ({ store, exec, mgr, bus, chat, payments }) => {
        const id = mgr.createSession({ roomId: payments.id });

        mgr.prompt(id, "get to work");
        bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "exactly once" });
        await exec.settle();
        await exec.settle();
        mgr.prompt(id, "another turn");
        await exec.settle();
        await exec.settle();

        const carried = store.listAfter(id, 0)
          .map((e) => e.event)
          .filter((e) => e.type === "user_prompt" && e.text.includes("exactly once"));
        expect(carried).toHaveLength(1);
      });
    });

    it("does not flush anything for a roomless session's turn boundary", async () => {
      await withWiredBus(async ({ store, exec, mgr, bus, chat, payments }) => {
        // an agent standing in payments, but busy, so the message stays queued
        const busyAgent = mgr.createSession({ roomId: payments.id });
        mgr.prompt(busyAgent, "busy");
        bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "for payments only" });

        const roomless = mgr.createSession({ cwd: tmpdir() });
        mgr.prompt(roomless, "hello");
        await exec.settle();

        // the roomless session's boundary must not have carried payments' mail
        const gotIt = store.listAfter(roomless, 0)
          .map((e) => e.event)
          .some((e) => e.type === "user_prompt" && e.text.includes("for payments only"));
        expect(gotIt).toBe(false);
      });
    });

    it("factory_report_status lands in the session's own log", async () => {
      await withBus(async ({ exec, mgr, store, chat }) => {
        const id = mgr.createSession({ roomId: chat.id });
        await registeredTools(exec.starts[0]!).factory_report_status!
          .handler({ summary: "reading the charter" }, {});

        const reported = store.listAfter(id, 0)
          .map((e) => e.event)
          .find((e) => e.type === "session_status" && e.detail === "reading the charter");
        expect(reported).toBeTruthy();
      });
    });
  });

  // ---- M1a: the derived status and blocked flag the 3D floor reads off listSessions() ----

  describe("derived status", () => {
    /** An executor that emits nothing on start, so a test controls the log exactly. */
    class SilentExecutor implements Executor {
      readonly name = "silent";
      start(): ExecutorHandle {
        return {
          providerSessionId: Promise.resolve("silent-session"),
          send: () => {},
          interrupt: async () => {},
          stop: async () => {},
        };
      }
    }

    function silent() {
      const db = openDb(":memory:");
      const store = new EventStore(db);
      const mgr = new SessionManager(db, store, new SilentExecutor(), ...manager(db));
      return { db, store, mgr };
    }

    const info = (mgr: SessionManager, id: string) => mgr.listSessions().find((s) => s.id === id)!;

    it("reports idle for a session whose log holds no status at all", () => {
      const { mgr } = silent();
      const id = mgr.createSession({ cwd: "/tmp" });
      expect(info(mgr, id).status).toBe("idle");
      expect(info(mgr, id).blocked).toBe(false);
    });

    it("reports idle when the log holds events but no session_status", () => {
      const { store, mgr } = silent();
      const id = mgr.createSession({ cwd: "/tmp" });
      store.append(id, { type: "user_prompt", text: "hi" });
      store.append(id, { type: "agent_text", text: "hello" });
      expect(info(mgr, id).status).toBe("idle");
    });

    it("reports the latest session_status, not the first", () => {
      const { store, mgr } = silent();
      const id = mgr.createSession({ cwd: "/tmp" });
      for (const status of ["starting", "working", "idle", "working"] as const) {
        store.append(id, { type: "session_status", status });
      }
      expect(info(mgr, id).status).toBe("working");
      store.append(id, { type: "session_status", status: "idle" });
      expect(info(mgr, id).status).toBe("idle");
    });

    it("reports every status in the enum, error included", () => {
      for (const status of ["starting", "working", "idle", "paused", "error", "done"] as const) {
        const { store, mgr } = silent();
        const id = mgr.createSession({ cwd: "/tmp" });
        store.append(id, { type: "session_status", status });
        expect(info(mgr, id).status).toBe(status);
      }
    });

    it("does not let a later non-status event mask the status", () => {
      const { store, mgr } = silent();
      const id = mgr.createSession({ cwd: "/tmp" });
      store.append(id, { type: "session_status", status: "working" });
      store.append(id, { type: "agent_text", text: "still going" });
      store.append(id, { type: "turn_complete" });
      expect(info(mgr, id).status).toBe("working");
    });

    it("keeps each session's status to itself", () => {
      const { store, mgr } = silent();
      const a = mgr.createSession({ cwd: "/tmp" });
      const b = mgr.createSession({ cwd: "/tmp" });
      store.append(a, { type: "session_status", status: "working" });
      store.append(b, { type: "session_status", status: "error" });
      expect(info(mgr, a).status).toBe("working");
      expect(info(mgr, b).status).toBe("error");
    });

    it("blocks only while an approval is unresolved", () => {
      const { store, mgr } = silent();
      const id = mgr.createSession({ cwd: "/tmp" });
      expect(info(mgr, id).blocked).toBe(false);

      store.append(id, { type: "approval_request", approvalId: "a1", toolName: "Bash", input: {} });
      expect(info(mgr, id).blocked).toBe(true);
      store.append(id, { type: "approval_resolved", approvalId: "a1", behavior: "allow" });
      expect(info(mgr, id).blocked).toBe(false);
    });

    it("stays blocked while any one of several approvals is open", () => {
      const { store, mgr } = silent();
      const id = mgr.createSession({ cwd: "/tmp" });
      store.append(id, { type: "approval_request", approvalId: "a1", toolName: "Bash", input: {} });
      store.append(id, { type: "approval_request", approvalId: "a2", toolName: "Write", input: {} });
      store.append(id, { type: "approval_resolved", approvalId: "a1", behavior: "deny" });
      expect(info(mgr, id).blocked).toBe(true);
      store.append(id, { type: "approval_resolved", approvalId: "a2", behavior: "allow" });
      expect(info(mgr, id).blocked).toBe(false);
    });

    it("does not let one session's resolution clear another's approval", () => {
      const { store, mgr } = silent();
      const a = mgr.createSession({ cwd: "/tmp" });
      const b = mgr.createSession({ cwd: "/tmp" });
      store.append(a, { type: "approval_request", approvalId: "shared-id", toolName: "Bash", input: {} });
      store.append(b, { type: "approval_resolved", approvalId: "shared-id", behavior: "allow" });
      expect(info(mgr, a).blocked).toBe(true);
      expect(info(mgr, b).blocked).toBe(false);
    });

    it("reports blocked alongside working — waiting on the operator is not idling", () => {
      const { store, mgr } = silent();
      const id = mgr.createSession({ cwd: "/tmp" });
      store.append(id, { type: "session_status", status: "working" });
      store.append(id, { type: "approval_request", approvalId: "a1", toolName: "Bash", input: {} });
      expect(info(mgr, id)).toMatchObject({ status: "working", blocked: true });
    });

    it("derives status and blocked in one statement, however many sessions there are", () => {
      const { store, mgr } = silent();
      const ids = Array.from({ length: 5 }, () => mgr.createSession({ cwd: "/tmp" }));
      for (const id of ids) store.append(id, { type: "session_status", status: "working" });
      // The guard is the query count, which is not observable here; what is observable is that one
      // call answers for every session, which is what listSessions() has to keep doing.
      const all = mgr.listSessions();
      expect(all).toHaveLength(5);
      expect(all.every((s) => s.status === "working" && !s.blocked)).toBe(true);
    });
  });

  describe("stopAll", () => {
    it("stops every live executor; prompt() on a stopped session then throws", async () => {
      const { mgr } = make();
      const id = mgr.createSession({ cwd: "/tmp" });
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
      const mgr = new SessionManager(db, store, new HangingExecutor(), ...manager(db));
      const id = mgr.createSession({ cwd: "/tmp" });

      const start = Date.now();
      await mgr.stopAll(50);
      expect(Date.now() - start).toBeLessThan(2000);
      expect(() => mgr.prompt(id, "hi")).toThrow();
    });

    it("is safe to call twice", async () => {
      const { mgr } = make();
      mgr.createSession({ cwd: "/tmp" });
      await mgr.stopAll();
      await expect(mgr.stopAll()).resolves.toBeUndefined();
    });
  });

  // ---- M1b: agents belong to a factory ----

  describe("projects", () => {
    /** Two factories over one db, each with a room called "backend". */
    function twoFactories<T>(fn: (ctx: {
      mgr: SessionManager;
      rooms: RoomManager;
      home: string;
      away: string;
      homeRoom: ReturnType<RoomManager["createRoom"]>;
      awayRoom: ReturnType<RoomManager["createRoom"]>;
    }) => T): T {
      const homeRoot = mkdtempSync(join(tmpdir(), "superfabric-session-home-"));
      const awayRoot = mkdtempSync(join(tmpdir(), "superfabric-session-away-"));
      const db = openDb(":memory:");
      try {
        const store = new EventStore(db);
        const { projects, rooms } = factory(db, homeRoot);
        const home = projects.defaultProject().id;
        const away = projects.create({ root: awayRoot }).id;
        rooms.ensureProjectRoom(home);
        rooms.ensureProjectRoom(away);
        return fn({
          mgr: new SessionManager(db, store, new FakeExecutor(), rooms, projects),
          rooms, home, away,
          homeRoom: rooms.createRoom("backend", { projectId: home }),
          awayRoom: rooms.createRoom("backend", { projectId: away }),
        });
      } finally {
        rmSync(homeRoot, { recursive: true, force: true });
        rmSync(awayRoot, { recursive: true, force: true });
      }
    }

    it("lists only one factory's agents", () => {
      twoFactories(({ mgr, home, away, homeRoom, awayRoom }) => {
        const here = mgr.createSession({ roomId: homeRoom.id });
        const there = mgr.createSession({ roomId: awayRoom.id });
        // and a roomless agent, which still belongs to whichever floor created it
        const loose = mgr.createSession({ cwd: homeRoom.path, projectId: away });

        expect(mgr.listSessions(home).map((s) => s.id)).toEqual([here]);
        expect(mgr.listSessions(away).map((s) => s.id).sort()).toEqual([there, loose].sort());
      });
    });

    it("takes the project from the room, and refuses a room on another floor", () => {
      twoFactories(({ mgr, home, away, homeRoom, awayRoom }) => {
        // No project named: the room decides, so an agent can never end up on a floor its own
        // building does not stand on.
        mgr.createSession({ roomId: awayRoom.id });
        expect(mgr.listSessions(away)).toHaveLength(1);
        expect(mgr.listSessions(home)).toHaveLength(0);

        // Both named and disagreeing: refused rather than silently believing one of them.
        expect(() => mgr.createSession({ roomId: awayRoom.id, projectId: home }))
          .toThrow(/belongs to another project/);
        expect(() => mgr.createSession({ roomId: homeRoom.id, projectId: away }))
          .toThrow(/belongs to another project/);
        expect(mgr.listSessions(away)).toHaveLength(1);
        expect(mgr.listSessions(home)).toHaveLength(0);
      });
    });

    it("reports a room's agents from that room alone, not from a same-named room elsewhere", () => {
      twoFactories(({ mgr, homeRoom, awayRoom }) => {
        const here = mgr.createSession({ roomId: homeRoom.id });
        mgr.createSession({ roomId: awayRoom.id });
        // The bus asks this at every turn boundary; a room id is unique, so the answer must be too.
        expect(mgr.roomAgents(homeRoom.id).map((a) => a.sessionId)).toEqual([here]);
        expect(mgr.roomAgents(awayRoom.id).map((a) => a.sessionId)).not.toContain(here);
      });
    });
  });
});
