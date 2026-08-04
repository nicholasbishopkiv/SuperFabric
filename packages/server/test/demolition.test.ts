import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chronicle } from "../src/chronicle.js";
import { openDb } from "../src/db.js";
import { Demolition } from "../src/demolition.js";
import { EventStore } from "../src/eventStore.js";
import { FactoryBus } from "../src/factoryBus.js";
import { OnboardingManager } from "../src/onboarding.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { TaskStore } from "../src/taskStore.js";
import { FakeExecutor } from "../src/executors/fake.js";
import { WsHub, type SocketLike } from "../src/wsHub.js";
import { waitFor } from "./_waitFor.js";

/**
 * Taking things away.
 *
 * The cases here are mostly about what a delete does *not* do, because that is where the risk is: a
 * feature that removes a room from a 3D floor is one bad line away from removing the operator's
 * repository, and a feature that removes an agent is one missing statement away from leaving a task
 * nobody can move or an index that quotes a transcript that no longer exists.
 */

/** A whole server's worth of stores over one temp root, with a scripted fake executor. */
function make(root: string) {
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const exec = new FakeExecutor();
  const projects = new ProjectManager(db, root);
  const rooms = new RoomManager(db, projects);
  const tasks = new TaskStore(db, projects);
  const chronicle = new Chronicle(db, projects);
  let mgr!: SessionManager;
  const bus = new FactoryBus({
    db, rooms, projects,
    deliver: (sessionId, text) => mgr.prompt(sessionId, text),
    roomAgents: (roomId) => mgr.roomAgents(roomId),
  });
  mgr = new SessionManager(db, store, exec, rooms, projects, { tasks, bus, chronicle });
  const onboarding = new OnboardingManager({ db, projects, rooms, sessions: mgr });
  const demolition = new Demolition({
    sessions: mgr, rooms, projects, tasks, bus, chronicle, onboarding,
  });
  return { db, store, exec, projects, rooms, tasks, chronicle, bus, onboarding, mgr, demolition };
}

/** A throwaway project root, removed by the caller. */
function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "superfabric-demolition-"));
}

function rows(db: ReturnType<typeof openDb>, sql: string, ...args: unknown[]): unknown[] {
  return db.prepare(sql).all(...(args as never[]));
}

describe("removing an agent", () => {
  it("stops it, deletes its transcript, and takes it out of the chronicle", async () => {
    const root = tempRoot();
    try {
      const f = make(root);
      const room = f.rooms.createRoom("backend", { projectId: f.projects.defaultProject().id });
      const id = f.mgr.createSession({ roomId: room.id });
      f.mgr.prompt(id, "remember the alligator");
      await f.exec.settle();

      // Precondition: the words are in the log and findable through the index.
      expect(f.store.listAfter(id, 0).length).toBeGreaterThan(0);
      expect(f.chronicle.search(f.projects.defaultProject().id, "alligator").length).toBeGreaterThan(0);

      await f.demolition.deleteSession(id);

      expect(f.mgr.listSessions().find((s) => s.id === id)).toBeUndefined();
      expect(f.store.listAfter(id, 0)).toEqual([]);
      // The FTS index follows by trigger (migration 16) rather than by anyone remembering to sweep.
      expect(f.chronicle.search(f.projects.defaultProject().id, "alligator")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hands its tasks back to the board rather than deleting them", async () => {
    const root = tempRoot();
    try {
      const f = make(root);
      const room = f.rooms.createRoom("backend", { projectId: f.projects.defaultProject().id });
      const id = f.mgr.createSession({ roomId: room.id });
      const task = f.tasks.create({ title: "ship it", roomId: room.id });
      f.tasks.update(task.id, { agentId: id });

      const removed = await f.demolition.deleteSession(id);

      expect(removed.tasksUnassigned).toBe(1);
      const after = f.tasks.get(task.id);
      expect(after?.agentId).toBeNull();
      // Still owned by the room, still open: the work outlives whoever was doing it.
      expect(after?.roomId).toBe(room.id);
      // And still *movable*: a card naming a session that no longer exists is one `TaskStore.update`
      // refuses to write, which would leave the operator with a card they could not touch.
      expect(() => f.tasks.update(task.id, { status: "done" })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves a room suggestion it made, with nobody attached", async () => {
    const root = tempRoot();
    try {
      const f = make(root);
      const projectId = f.projects.defaultProject().id;
      const id = f.mgr.createSession({ cwd: root, projectId });
      f.onboarding.suggest(projectId, id, [{ name: "docs", charter: "the manual" }]);

      await f.demolition.deleteSession(id);

      const suggestions = f.onboarding.state(projectId).suggestions;
      expect(suggestions.map((s) => s.name)).toEqual(["docs"]);
      expect(suggestions[0]!.status).toBe("proposed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("stopping an agent", () => {
  it("ends it without touching what it said, and it does not come back", async () => {
    const root = tempRoot();
    try {
      const f = make(root);
      const id = f.mgr.createSession({ cwd: root });
      f.mgr.prompt(id, "say something");
      await f.exec.settle();
      const before = f.store.listAfter(id, 0).length;

      expect(await f.mgr.stopSession(id, "stopped by the operator")).toBe("stopped");

      expect(f.mgr.listSessions().find((s) => s.id === id)?.state).toBe("done");
      // The transcript is untouched — that is the whole difference from a delete — plus the one line
      // saying it stopped.
      const after = f.store.listAfter(id, 0);
      expect(after.length).toBe(before + 1);
      expect(after.at(-1)!.event).toMatchObject({ type: "session_status", status: "done" });
      // `resumeAll` only ever starts 'active' rows, so a stopped agent stays stopped across a boot.
      expect(f.mgr.resumeAll()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for the turn in flight rather than throwing its tokens away", async () => {
    const root = tempRoot();
    try {
      const f = make(root);
      const id = f.mgr.createSession({ cwd: root });
      f.mgr.prompt(id, "a long one");

      // Armed rather than applied: the agent is mid-turn, so the stop waits for the boundary.
      expect(await f.mgr.stopSession(id, "stopped by the operator")).toBe("at-turn-boundary");

      await f.exec.settle();
      await waitFor(() => {
        if (f.mgr.listSessions().find((s) => s.id === id)?.state !== "done") throw new Error("not yet");
      });
      // The turn ran to its end and *then* the agent stopped — which is the whole point of waiting.
      // Asserted as an order rather than as a set: "the events are there" would also hold for a stop
      // that had cut the turn short and let the executor finish writing afterwards.
      const types = f.store.listAfter(id, 0).map((e) => e.event.type);
      expect(types).toContain("agent_text");
      const stopped = f.store
        .listAfter(id, 0)
        .findIndex((e) => e.event.type === "session_status" && (e.event as { status: string }).status === "done");
      const completed = types.indexOf("turn_complete");
      expect(completed).toBeGreaterThanOrEqual(0);
      expect(stopped).toBeGreaterThan(completed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is idempotent", async () => {
    const root = tempRoot();
    try {
      const f = make(root);
      const id = f.mgr.createSession({ cwd: root });
      await f.mgr.stopSession(id, "stopped by the operator");
      expect(await f.mgr.stopSession(id, "stopped by the operator")).toBe("already-stopped");
      const stops = f.store
        .listAfter(id, 0)
        .filter((e) => e.event.type === "session_status" && (e.event as { status: string }).status === "done");
      expect(stops.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("removing a room", () => {
  it("leaves the folder and its charter exactly as they were", async () => {
    const root = tempRoot();
    try {
      const f = make(root);
      const room = f.rooms.createRoom("backend", { projectId: f.projects.defaultProject().id });
      const charter = join(room.path, "CLAUDE.md");
      writeFileSync(join(room.path, "server.ts"), "// the operator's own file\n");
      const charterBefore = readFileSync(charter, "utf8");

      await f.demolition.deleteRoom(room.id);

      expect(f.rooms.getRoom(room.id)).toBeUndefined();
      expect(existsSync(room.path)).toBe(true);
      expect(existsSync(join(room.path, "server.ts"))).toBe(true);
      expect(readFileSync(charter, "utf8")).toBe(charterBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("takes the agents standing in it, and unassigns its tasks", async () => {
    const root = tempRoot();
    try {
      const f = make(root);
      const room = f.rooms.createRoom("backend", { projectId: f.projects.defaultProject().id });
      const a = f.mgr.createSession({ roomId: room.id });
      const b = f.mgr.createSession({ roomId: room.id });
      f.mgr.prompt(a, "hello");
      await f.exec.settle();
      const task = f.tasks.create({ title: "ship it", roomId: room.id });

      const removed = await f.demolition.deleteRoom(room.id);

      expect(removed.agents).toBe(2);
      expect(f.mgr.listSessions().map((s) => s.id)).not.toContain(a);
      expect(f.mgr.listSessions().map((s) => s.id)).not.toContain(b);
      expect(f.store.listAfter(a, 0)).toEqual([]);
      // The card stays, unassigned — a room being reorganised is not a reason to forget the work.
      expect(f.tasks.get(task.id)).toMatchObject({ roomId: null, agentId: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the bus traffic it sent and received", async () => {
    const root = tempRoot();
    try {
      const f = make(root);
      const projectId = f.projects.defaultProject().id;
      const backend = f.rooms.createRoom("backend", { projectId });
      const web = f.rooms.createRoom("web", { projectId });
      const msg = f.bus.send({ fromRoomId: backend.id, toRoomId: web.id, kind: "request", body: "the schema" });

      await f.demolition.deleteRoom(backend.id);

      // `messages` has never had a foreign key precisely so this record outlives the department.
      expect(f.bus.get(msg.id)?.body).toBe("the schema");
      expect(f.bus.list(projectId).map((m) => m.id)).toContain(msg.id);
      // And nothing downstream trips over the sender that is no longer there.
      expect(() => f.bus.flushRoom(web.id)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses the project room, before it stops anything", async () => {
    const root = tempRoot();
    try {
      const f = make(root);
      const projectRoom = f.rooms.ensureProjectRoom();
      const id = f.mgr.createSession({ roomId: projectRoom.id });

      await expect(f.demolition.deleteRoom(projectRoom.id)).rejects.toThrow(/project room/i);

      expect(f.rooms.getRoom(projectRoom.id)).toBeDefined();
      // The refusal came first: the agent standing there is untouched.
      expect(f.mgr.listSessions().find((s) => s.id === id)?.state).toBe("active");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("removing a factory", () => {
  it("takes its rows and leaves its files", async () => {
    const boot = tempRoot();
    const other = tempRoot();
    try {
      const f = make(boot);
      const project = f.projects.create({ root: other, name: "other" });
      f.rooms.ensureProjectRoom(project.id);
      const room = f.rooms.createRoom("backend", { projectId: project.id });
      const agent = f.mgr.createSession({ roomId: room.id });
      f.tasks.create({ title: "ship it", roomId: room.id, projectId: project.id });
      f.bus.send({ fromRoomId: room.id, toRoomId: room.id, kind: "info", body: "note to self" });
      const decision = f.chronicle.record({
        projectId: project.id, title: "use SQLite", context: "we need a store", decision: "SQLite",
      });
      expect(existsSync(decision.path)).toBe(true);

      const removed = await f.demolition.deleteProject(project.id);

      expect(removed.rooms).toBe(2); // the project room and the one we made
      expect(removed.agents).toBe(1);
      expect(f.projects.get(project.id)).toBeUndefined();
      expect(f.rooms.listRooms(project.id)).toEqual([]);
      expect(f.mgr.listSessions(project.id)).toEqual([]);
      expect(f.tasks.list(project.id)).toEqual([]);
      expect(f.bus.list(project.id)).toEqual([]);
      expect(f.store.listAfter(agent, 0)).toEqual([]);
      // The ADR is the decision; the row was only an index over it. It belongs to the repository.
      expect(existsSync(decision.path)).toBe(true);
      expect(readFileSync(decision.path, "utf8")).toContain("use SQLite");
      // And the folders are all still there.
      expect(existsSync(other)).toBe(true);
      expect(existsSync(room.path)).toBe(true);
    } finally {
      rmSync(boot, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("leaves every other factory alone", async () => {
    const boot = tempRoot();
    const a = tempRoot();
    const b = tempRoot();
    try {
      const f = make(boot);
      const one = f.projects.create({ root: a, name: "one" });
      const two = f.projects.create({ root: b, name: "two" });
      const roomOne = f.rooms.createRoom("backend", { projectId: one.id, path: join(a, "backend") });
      const roomTwo = f.rooms.createRoom("backend", { projectId: two.id, path: join(b, "backend") });
      const agentTwo = f.mgr.createSession({ roomId: roomTwo.id });
      const taskTwo = f.tasks.create({ title: "keep me", roomId: roomTwo.id, projectId: two.id });

      await f.demolition.deleteProject(one.id);

      expect(f.rooms.getRoom(roomOne.id)).toBeUndefined();
      expect(f.rooms.getRoom(roomTwo.id)).toBeDefined();
      expect(f.mgr.listSessions(two.id).map((s) => s.id)).toEqual([agentTwo]);
      expect(f.tasks.get(taskTwo.id)?.title).toBe("keep me");
    } finally {
      for (const dir of [boot, a, b]) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses the one SUPERFABRIC_PROJECT re-creates, because that delete would undo itself", () => {
    const seeded = tempRoot();
    try {
      const db = openDb(":memory:");
      // A server told to seed a root: exactly what `SUPERFABRIC_PROJECT` produces.
      const projects = new ProjectManager(db, seeded, undefined, { reseedsDefaultRoot: true });
      const project = projects.defaultProject();

      expect(() => projects.remove(project.id)).toThrow(/SUPERFABRIC_PROJECT/);
      expect(projects.get(project.id)).toBeDefined();
    } finally {
      rmSync(seeded, { recursive: true, force: true });
    }
  });

  it("lets the operator delete every factory, because an empty server is a state", async () => {
    const boot = tempRoot();
    const other = tempRoot();
    try {
      // No `reseedsDefaultRoot`: an ordinary run, where nothing is created from the directory the
      // server happens to be in. Every project is one somebody asked for, so every one can go.
      const f = make(boot);
      const one = f.projects.create({ root: other });
      const two = f.projects.defaultProject();

      await f.demolition.deleteProject(one.id);
      await f.demolition.deleteProject(two.id);

      expect(f.projects.list()).toEqual([]);
      // And nothing seeds one back on the next question asked of it.
      expect(f.projects.lastOpened()).toBeUndefined();
      expect(f.projects.list()).toEqual([]);
    } finally {
      rmSync(boot, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
});

// ---- over the wire ---------------------------------------------------------------------------

function fakeSocket() {
  const sent: any[] = [];
  const sock: SocketLike = { send: (d: string) => sent.push(JSON.parse(d)) };
  return { sock, sent };
}

/** A hub with demolition wired, plus one attached socket on the default project. */
function makeHub(root: string) {
  const f = make(root);
  // The floor this socket lands on. Explicit: the server no longer invents a factory from the
  // directory it runs in, so a hub over an empty database leaves its sockets on no floor at all.
  f.projects.defaultProject();
  const hub = new WsHub(f.store, f.mgr, f.rooms, f.projects, {
    tasks: f.tasks, bus: f.bus, chronicle: f.chronicle, onboarding: f.onboarding,
    demolition: f.demolition, sessionsDebounceMs: 1,
  });
  const { sock, sent } = fakeSocket();
  hub.attach(sock);
  return { ...f, hub, sock, sent };
}

describe("the hub's deletes", () => {
  it("answers a room delete with the fresh floor and a notice naming the folder", async () => {
    const root = tempRoot();
    try {
      const h = makeHub(root);
      const room = h.rooms.createRoom("backend", { projectId: h.projects.defaultProject().id });
      h.hub.handleMessage(h.sock, JSON.stringify({ kind: "delete_room", roomId: room.id }));

      await waitFor(() => {
        if (!h.sent.some((m) => m.kind === "notice")) throw new Error("not yet");
      });
      const notice = h.sent.find((m) => m.kind === "notice");
      expect(notice.message).toContain(room.path);
      expect(h.sent.some((m) => m.kind === "rooms" && !m.rooms.some((r: any) => r.id === room.id)))
        .toBe(true);
      expect(existsSync(room.path)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an agent on another floor", async () => {
    const boot = tempRoot();
    const other = tempRoot();
    try {
      const h = makeHub(boot);
      const project = h.projects.create({ root: other });
      const room = h.rooms.createRoom("backend", { projectId: project.id, path: join(other, "backend") });
      const id = h.mgr.createSession({ roomId: room.id });

      // This socket is on the boot project, so the agent is not its business.
      h.hub.handleMessage(h.sock, JSON.stringify({ kind: "delete_session", sessionId: id }));

      expect(h.sent.some((m) => m.kind === "error" && /another project/.test(m.message))).toBe(true);
      expect(h.mgr.listSessions(project.id).map((s) => s.id)).toEqual([id]);
    } finally {
      rmSync(boot, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("moves a socket that was looking at the factory it just deleted", async () => {
    const boot = tempRoot();
    const other = tempRoot();
    try {
      const h = makeHub(boot);
      const project = h.projects.create({ root: other });
      h.rooms.ensureProjectRoom(project.id);
      h.hub.handleMessage(h.sock, JSON.stringify({ kind: "open_project", projectId: project.id }));
      h.sent.length = 0;

      h.hub.handleMessage(h.sock, JSON.stringify({ kind: "delete_project", projectId: project.id }));

      await waitFor(() => {
        if (!h.sent.some((m) => m.kind === "notice")) throw new Error("not yet");
      });
      const projectFrames = h.sent.filter((m) => m.kind === "projects");
      expect(projectFrames.length).toBeGreaterThan(0);
      // Not left holding an id that no longer resolves.
      const last = projectFrames.at(-1);
      expect(last.projects.some((p: any) => p.id === project.id)).toBe(false);
      expect(last.activeProjectId).not.toBe(project.id);
    } finally {
      rmSync(boot, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("refuses every delete on a server that has no demolition", () => {
    const root = tempRoot();
    try {
      const f = make(root);
      f.projects.defaultProject(); // the floor this socket lands on
      const hub = new WsHub(f.store, f.mgr, f.rooms, f.projects, { tasks: f.tasks, bus: f.bus });
      const { sock, sent } = fakeSocket();
      hub.attach(sock);
      const room = f.rooms.createRoom("backend", { projectId: f.projects.defaultProject().id });

      hub.handleMessage(sock, JSON.stringify({ kind: "delete_room", roomId: room.id }));

      expect(sent.some((m) => m.kind === "error" && /cannot remove/.test(m.message))).toBe(true);
      expect(f.rooms.getRoom(room.id)).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops an agent from the wire and says what happened", async () => {
    const root = tempRoot();
    try {
      const h = makeHub(root);
      const id = h.mgr.createSession({ cwd: root });
      h.hub.handleMessage(h.sock, JSON.stringify({ kind: "stop_session", sessionId: id }));

      await waitFor(() => {
        if (!h.sent.some((m) => m.kind === "notice")) throw new Error("not yet");
      });
      expect(h.sent.find((m) => m.kind === "notice").message).toContain("transcript stays");
      expect(h.mgr.listSessions().find((s) => s.id === id)?.state).toBe("done");
      // Nothing was destroyed: the row is still readable, which is what `rows` is asserting here.
      expect(rows(h.db, "SELECT id FROM sessions WHERE id = ?", id).length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
