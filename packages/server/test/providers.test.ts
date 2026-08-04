import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { FakeExecutor } from "../src/executors/fake.js";
import type { Executor, ExecutorEvents, ExecutorHandle, ExecutorStartOptions } from "../src/executor.js";

/**
 * Which CLI an agent runs on — the property that decides *whose* conversation a session is.
 *
 * The point of these cases is the line the design draws: a provider is chosen once, at creation,
 * and everything below `SessionManager.startExecutor` is unchanged by it. A Codex agent is an
 * ordinary session — same row, same event log, same room, same board — that happens to be executed
 * by a different implementation of one interface.
 */

/** An executor that records what it was asked to start, and answers nothing. */
function recordingExecutor(name: string) {
  const starts: ExecutorStartOptions[] = [];
  const executor: Executor = {
    name,
    start(opts: ExecutorStartOptions, _events: ExecutorEvents): ExecutorHandle {
      starts.push(opts);
      return {
        providerSessionId: Promise.resolve(`${name}-thread`),
        send: () => {},
        interrupt: async () => {},
        stop: async () => {},
      };
    },
  };
  return { executor, starts };
}

function make(opts: { withCodex?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sf-providers-"));
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const projects = new ProjectManager(db, root);
  const rooms = new RoomManager(db, projects);
  const claude = recordingExecutor("claude");
  const codex = recordingExecutor("codex");
  const mgr = new SessionManager(db, store, claude.executor, rooms, projects,
    opts.withCodex === false ? {} : { providers: { codex: codex.executor } });
  return { root, db, store, projects, rooms, mgr, claude, codex, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("choosing a provider", () => {
  it("runs a codex agent on the codex executor and a claude one on the default", () => {
    const f = make();
    try {
      const a = f.mgr.createSession({ cwd: f.root });
      const b = f.mgr.createSession({ cwd: f.root, provider: "codex" });

      expect(f.claude.starts).toHaveLength(1);
      expect(f.codex.starts).toHaveLength(1);
      // And the row says which is which, so a reboot brings each back on the CLI it belongs to.
      const sessions = f.mgr.listSessions();
      expect(sessions.find((s) => s.id === a)!.provider).toBe("claude");
      expect(sessions.find((s) => s.id === b)!.provider).toBe("codex");
    } finally {
      f.cleanup();
    }
  });

  it("brings a codex agent back on codex after a restart", async () => {
    const f = make();
    try {
      const id = f.mgr.createSession({ cwd: f.root, provider: "codex" });
      expect(f.codex.starts).toHaveLength(1);
      // The provider-native id is written when the executor reports it, which is a microtask later.
      await Bun.sleep(0);

      // A restart: a second manager over the same database, as `resumeAll` runs at boot.
      const claude = recordingExecutor("claude");
      const codex = recordingExecutor("codex");
      const again = new SessionManager(f.db, f.store, claude.executor, f.rooms, f.projects, {
        providers: { codex: codex.executor },
      });
      expect(again.resumeAll()).toEqual([id]);

      expect(codex.starts).toHaveLength(1);
      expect(claude.starts).toHaveLength(0);
      // Resumed as a *continuation*: the thread id goes back to the CLI that owns it.
      expect(codex.starts[0]!.resumeSessionId).toBe("codex-thread");
    } finally {
      f.cleanup();
    }
  });

  it("refuses a provider this server has no executor for, and creates no agent", () => {
    const f = make({ withCodex: false });
    try {
      // Refused rather than quietly started on Claude Code: an operator who picked Codex and got
      // something else would have an agent whose behaviour has no visible explanation.
      expect(() => f.mgr.createSession({ cwd: f.root, provider: "codex" })).toThrow(/no executor for provider/);
      expect(f.mgr.listSessions()).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("leaves a stored agent stopped, loudly, when its provider is gone", () => {
    const f = make();
    try {
      const id = f.mgr.createSession({ cwd: f.root, provider: "codex" });

      // The operator uninstalled the CLI, or this build dropped the provider: a second manager with
      // no codex executor at all.
      const again = new SessionManager(f.db, f.store, recordingExecutor("claude").executor, f.rooms, f.projects);
      again.resumeAll();

      const events = f.store.listAfter(id, 0).map((e) => e.event);
      const error = events.find((e) => e.type === "session_error") as { message: string } | undefined;
      expect(error?.message).toMatch(/no executor for provider codex/);
      // Moved off 'active', so the next boot does not try again forever.
      expect(again.listSessions().find((s) => s.id === id)!.state).toBe("error");
    } finally {
      f.cleanup();
    }
  });

  it("is fixed at creation: nothing on the wire or the manager can change it", () => {
    const f = make();
    try {
      const id = f.mgr.createSession({ cwd: f.root, provider: "codex" });
      // There is no `setProvider`, deliberately — `claude_session_id` is provider-native, so moving
      // a conversation between CLIs would silently forget it. This asserts the *absence*.
      expect((f.mgr as unknown as Record<string, unknown>).setProvider).toBeUndefined();
      expect(f.mgr.listSessions().find((s) => s.id === id)!.provider).toBe("codex");
    } finally {
      f.cleanup();
    }
  });

  it("keeps a codex agent out of a container room, and says so in its own log", () => {
    const f = make();
    try {
      const contained = recordingExecutor("container");
      const codex = recordingExecutor("codex");
      const mgr = new SessionManager(f.db, f.store, recordingExecutor("claude").executor, f.rooms, f.projects, {
        providers: { codex: codex.executor },
        containerExecutor: contained.executor,
      });
      const room = f.rooms.createRoom("backend", { projectId: f.projects.defaultProject().id });
      f.rooms.setRuntime(room.id, "container");

      const id = mgr.createSession({ roomId: room.id, provider: "codex" });

      // The image hosts the Agent SDK, so there is nowhere to put this agent but the host — and an
      // operator who chose a sandbox has to be told they did not get one.
      expect(contained.starts).toHaveLength(0);
      expect(codex.starts).toHaveLength(1);
      const detail = f.store.listAfter(id, 0)
        .map((e) => e.event)
        .filter((e) => e.type === "session_status")
        .map((e) => (e as { detail?: string }).detail ?? "")
        .join(" ");
      expect(detail).toMatch(/container image only hosts claude/);
      expect(mgr.listSessions().find((s) => s.id === id)!.runtime).toBe("host");
    } finally {
      f.cleanup();
    }
  });

  it("does not change what a session created before providers existed is", () => {
    const f = make();
    try {
      // The column defaults to 'claude' (migration 18), which is what every row written before it was.
      f.db.prepare(
        "INSERT INTO sessions (id, project_id, cwd, autonomy, state) VALUES (?, ?, ?, 'auto', 'active')",
      ).run("old", f.projects.defaultProject().id, f.root);
      expect(f.mgr.listSessions().find((s) => s.id === "old")!.provider).toBe("claude");
      f.mgr.resumeAll();
      expect(f.claude.starts.length).toBeGreaterThan(0);
    } finally {
      f.cleanup();
    }
  });
});

describe("a codex agent is an ordinary session", () => {
  it("stands in a room, on the board, like any other", () => {
    const f = make();
    try {
      const room = f.rooms.createRoom("backend", { projectId: f.projects.defaultProject().id });
      const id = f.mgr.createSession({ roomId: room.id, provider: "codex" });

      // Nothing above the executor seam knows or cares which CLI this is.
      expect(f.rooms.getRoom(room.id)!.agentCount).toBe(1);
      expect(f.mgr.listSessions().find((s) => s.id === id)).toMatchObject({
        roomId: room.id, provider: "codex", state: "active",
      });
      expect(f.codex.starts[0]!.cwd).toBe(room.path);
    } finally {
      f.cleanup();
    }
  });

  it("is stopped and deleted by the same paths every other agent is", async () => {
    const f = make();
    try {
      const id = f.mgr.createSession({ cwd: f.root, provider: "codex" });
      expect(await f.mgr.stopSession(id, "stopped by the operator")).toBe("stopped");
      expect(f.mgr.listSessions().find((s) => s.id === id)!.state).toBe("done");

      await f.mgr.deleteSession(id);
      expect(f.mgr.listSessions()).toEqual([]);
    } finally {
      f.cleanup();
    }
  });
});
