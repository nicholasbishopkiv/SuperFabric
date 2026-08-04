import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { FactoryBus } from "../src/factoryBus.js";
import { ORCHESTRATOR_SYSTEM_PROMPT, ensureOrchestrator } from "../src/orchestrator.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { TaskStore } from "../src/taskStore.js";
import { FakeExecutor } from "../src/executors/fake.js";
import type { Executor, ExecutorEvents, ExecutorHandle, ExecutorStartOptions } from "../src/executor.js";

/** Records every start(), so a test can assert the role and tool set an executor was handed. */
class RecordingExecutor implements Executor {
  readonly name = "recording";
  readonly starts: ExecutorStartOptions[] = [];
  start(opts: ExecutorStartOptions, ev: ExecutorEvents): ExecutorHandle {
    this.starts.push(opts);
    ev.onEvent({ type: "session_status", status: "idle" });
    return {
      providerSessionId: Promise.resolve(`claude-${this.starts.length}`),
      send: () => {},
      interrupt: async () => {},
      stop: async () => {},
    };
  }
}

/**
 * A whole factory over one in-memory db: a project room, two workshops, a real bus and board. The
 * orchestrator is created through `ensureOrchestrator` exactly as the hub does it, so what these
 * cases assert is the supported path rather than a hand-built session that happens to look right.
 */
function withFactory<T>(fn: (ctx: {
  db: ReturnType<typeof openDb>; store: EventStore; exec: RecordingExecutor; rooms: RoomManager;
  projects: ProjectManager; mgr: SessionManager; bus: FactoryBus; tasks: TaskStore; root: string;
  projectId: string;
}) => T): T {
  const root = mkdtempSync(join(tmpdir(), "superfabric-orchestrator-"));
  try {
    const db = openDb(":memory:");
    const store = new EventStore(db);
    const exec = new RecordingExecutor();
    const projects = new ProjectManager(db, root);
    const rooms = new RoomManager(db, projects);
    const tasks = new TaskStore(db, projects);
    const bus = new FactoryBus({ db, rooms, projects, deliver: () => {}, roomAgents: () => [] });
    const mgr = new SessionManager(db, store, exec, rooms, projects, { bus, tasks });
    rooms.ensureProjectRoom();
    rooms.createRoom("backend");
    rooms.createRoom("payments");
    return fn({ db, store, exec, rooms, projects, mgr, bus, tasks, root, projectId: projects.defaultProject().id });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the orchestrator", () => {
  it("is created in the project room, on the central building", () => {
    withFactory(({ mgr, rooms, projectId }) => {
      const { sessionId, created } = ensureOrchestrator({ sessions: mgr, rooms }, projectId);
      expect(created).toBe(true);

      const projectRoom = rooms.listRooms(projectId).find((r) => r.kind === "project")!;
      const session = mgr.listSessions(projectId).find((s) => s.id === sessionId)!;
      expect(session.roomId).toBe(projectRoom.id);
      expect(session.isOrchestrator).toBe(true);
      // it stands on the floor like any other agent, so the building counts it
      expect(rooms.getRoom(projectRoom.id)!.agentCount).toBe(1);
    });
  });

  it("is a session with a role, not a new runtime: same manager, same executor, one event log", () => {
    withFactory(({ mgr, rooms, store, exec, projectId }) => {
      const { sessionId } = ensureOrchestrator({ sessions: mgr, rooms }, projectId);
      // one ordinary start() on the one executor the whole factory runs on
      expect(exec.starts).toHaveLength(1);
      expect(store.listAfter(sessionId, 0).map((e) => e.event.type)).toContain("session_status");
    });
  });

  it("carries the orchestrator charter as a system-prompt append", () => {
    withFactory(({ mgr, rooms, exec, projectId }) => {
      ensureOrchestrator({ sessions: mgr, rooms }, projectId);
      expect(exec.starts[0]!.appendSystemPrompt).toBe(ORCHESTRATOR_SYSTEM_PROMPT);
    });
  });

  it("gives an ordinary room agent no role append at all", () => {
    withFactory(({ mgr, rooms, exec, projectId }) => {
      const backend = rooms.listRooms(projectId).find((r) => r.name === "backend")!;
      mgr.createSession({ roomId: backend.id });
      expect(exec.starts[0]!.appendSystemPrompt).toBeUndefined();
    });
  });

  it("is idempotent: a second call hands back the same session and creates nothing", () => {
    withFactory(({ mgr, rooms, projectId }) => {
      const first = ensureOrchestrator({ sessions: mgr, rooms }, projectId);
      const second = ensureOrchestrator({ sessions: mgr, rooms }, projectId);
      expect(second).toEqual({ sessionId: first.sessionId, created: false });
      expect(mgr.listSessions(projectId).filter((s) => s.isOrchestrator)).toHaveLength(1);
    });
  });

  it("refuses a second orchestrator for the same factory", () => {
    withFactory(({ mgr, rooms, projectId }) => {
      ensureOrchestrator({ sessions: mgr, rooms }, projectId);
      const projectRoom = rooms.listRooms(projectId).find((r) => r.kind === "project")!;
      // the raw path, bypassing ensureOrchestrator's own idempotence: the rule lives in the manager
      expect(() => mgr.createSession({ roomId: projectRoom.id, isOrchestrator: true }))
        .toThrow(/already has an orchestrator/);
      expect(mgr.listSessions(projectId).filter((s) => s.isOrchestrator)).toHaveLength(1);
    });
  });

  it("reports the flag on listSessions, and only for the orchestrator", () => {
    withFactory(({ mgr, rooms, projectId }) => {
      const backend = rooms.listRooms(projectId).find((r) => r.name === "backend")!;
      const junior = mgr.createSession({ roomId: backend.id });
      const { sessionId } = ensureOrchestrator({ sessions: mgr, rooms }, projectId);

      const byId = new Map(mgr.listSessions(projectId).map((s) => [s.id, s]));
      expect(byId.get(sessionId)!.isOrchestrator).toBe(true);
      expect(byId.get(junior)!.isOrchestrator).toBe(false);
    });
  });

  it("survives a restart with the flag, its room and its charter", () => {
    withFactory(({ db, store, rooms, projects, bus, tasks, mgr, projectId }) => {
      const { sessionId } = ensureOrchestrator({ sessions: mgr, rooms }, projectId);
      const projectRoom = rooms.listRooms(projectId).find((r) => r.kind === "project")!;

      // a fresh process over the same database
      const exec2 = new RecordingExecutor();
      const mgr2 = new SessionManager(db, store, exec2, rooms, projects, { bus, tasks });
      expect(mgr2.resumeAll()).toEqual([sessionId]);
      expect(mgr2.orchestratorFor(projectId)).toBe(sessionId);
      expect(mgr2.listSessions(projectId).find((s) => s.id === sessionId)!.isOrchestrator).toBe(true);
      expect(exec2.starts[0]!.appendSystemPrompt).toBe(ORCHESTRATOR_SYSTEM_PROMPT);
      expect(exec2.starts[0]!.cwd).toBe(projectRoom.path);
    });
  });

  it("is per factory: each project gets its own, and neither sees the other's", () => {
    withFactory(({ mgr, rooms, projects, projectId }) => {
      const otherRoot = mkdtempSync(join(tmpdir(), "superfabric-orchestrator-other-"));
      try {
        const other = projects.create({ root: otherRoot }).id;
        rooms.ensureProjectRoom(other);

        const mine = ensureOrchestrator({ sessions: mgr, rooms }, projectId);
        const theirs = ensureOrchestrator({ sessions: mgr, rooms }, other);
        expect(theirs.created).toBe(true);
        expect(theirs.sessionId).not.toBe(mine.sessionId);

        expect(mgr.orchestratorFor(projectId)).toBe(mine.sessionId);
        expect(mgr.orchestratorFor(other)).toBe(theirs.sessionId);
        // and neither factory's listing mentions the other's senior agent
        expect(mgr.listSessions(projectId).map((s) => s.id)).toEqual([mine.sessionId]);
        expect(mgr.listSessions(other).map((s) => s.id)).toEqual([theirs.sessionId]);
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    });
  });

  it("reports no orchestrator for a factory that has none, rather than inventing one", () => {
    withFactory(({ mgr, projectId }) => {
      expect(mgr.orchestratorFor(projectId)).toBeUndefined();
      expect(mgr.orchestratorFor("no-such-project")).toBeUndefined();
    });
  });

  describe("its charter", () => {
    it("says what it is, what it must do, and what it must not do", () => {
      // A charter, not a manual: the four things an orchestrator cannot learn from a tool list.
      expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/orchestrator/i);
      expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/route/i);
      expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/unblock/i);
      expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/direction/i);
      expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/do not do the rooms' work/i);
      // and it names the tools by the names the model actually sees
      expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("mcp__factory__factory_assign_task");
      expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain("mcp__factory__factory_record_decision");
    });

    it("stays short enough to be read once", () => {
      expect(ORCHESTRATOR_SYSTEM_PROMPT.length).toBeLessThan(3000);
    });
  });

  it("runs on the ordinary executor path, so a scripted fake drives it like any agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "superfabric-orchestrator-fake-"));
    try {
      const db = openDb(":memory:");
      const store = new EventStore(db);
      const exec = new FakeExecutor();
      const projects = new ProjectManager(db, root);
      const rooms = new RoomManager(db, projects);
      const mgr = new SessionManager(db, store, exec, rooms, projects);
      rooms.ensureProjectRoom();

      const { sessionId } = ensureOrchestrator({ sessions: mgr, rooms }, projects.defaultProject().id);
      mgr.prompt(sessionId, "where does this go?");
      await exec.settle();
      expect(store.listAfter(sessionId, 0).map((e) => e.event.type)).toContain("agent_text");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
