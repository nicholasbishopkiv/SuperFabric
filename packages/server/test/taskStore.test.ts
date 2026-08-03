import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import { openDb, type Db } from "../src/db.js";
import { ProjectManager } from "../src/projectManager.js";
import { TaskStore } from "../src/taskStore.js";

/**
 * A store over an in-memory db with a clock the test drives. `unixepoch()` has one-second
 * resolution, so a real clock cannot tell "updatedAt moved" from "the test ran fast"; the seam
 * makes the ordering assertions about the code rather than about the machine.
 *
 * `projectId` is the default project's: a `create` that names no project lands there, which is what
 * every case below relies on unless it is specifically about two factories.
 */
function makeStore(): { db: Db; projects: ProjectManager; projectId: string; tasks: TaskStore; tick: () => void } {
  const db = openDb(":memory:");
  let now = 1_000;
  const projects = new ProjectManager(db, tmpdir());
  const tasks = new TaskStore(db, projects, () => now);
  return { db, projects, projectId: projects.defaultProject().id, tasks, tick: () => { now += 5; } };
}

/** A session row in a given room (or roomless), inserted directly — TaskStore only reads them. */
function addSession(db: Db, id: string, roomId: string | null): void {
  db.prepare("INSERT INTO sessions (id, cwd, room_id) VALUES (?, ?, ?)").run(id, "/tmp", roomId);
}

/** A room row on a given floor, inserted directly — TaskStore only reads them. */
function addRoom(db: Db, id: string, name: string, projectId: string): void {
  db.prepare("INSERT INTO rooms (id, project_id, name, path) VALUES (?, ?, ?, ?)")
    .run(id, projectId, name, `/p/${name}`);
}

describe("TaskStore", () => {
  it("creates, lists and reads a task back", () => {
    const { db, tasks, projectId } = makeStore();
    addRoom(db, "r1", "payments", projectId);
    const created = tasks.create({ title: "Expose a webhook", detail: "for the chat room", roomId: "r1" });

    expect(created).toMatchObject({
      title: "Expose a webhook", detail: "for the chat room", status: "open",
      roomId: "r1", agentId: null, blockedOnMessageId: null,
    });
    expect(created.createdAt).toBe(1_000);
    expect(created.updatedAt).toBe(1_000);
    expect(tasks.get(created.id)).toEqual(created);
    expect(tasks.list()).toEqual([created]);
  });

  it("defaults detail to an empty string and the status to open", () => {
    const { tasks } = makeStore();
    const t = tasks.create({ title: "Nothing else said" });
    expect(t.detail).toBe("");
    expect(t.status).toBe("open");
  });

  it("creates a task unassigned: no room is the intended path, not an error", () => {
    const { tasks } = makeStore();
    const t = tasks.create({ title: "Someone should do this" });
    expect(t.roomId).toBeNull();
    expect(t.agentId).toBeNull();
    expect(tasks.list()[0]!.roomId).toBeNull();
  });

  it("moves updatedAt on an update and leaves createdAt alone", () => {
    const { tasks, tick } = makeStore();
    const t = tasks.create({ title: "Expose a webhook" });
    tick();
    const updated = tasks.update(t.id, { status: "in_progress" });

    expect(updated.status).toBe("in_progress");
    expect(updated.createdAt).toBe(t.createdAt);
    expect(updated.updatedAt).toBeGreaterThan(t.updatedAt);
    // and the row, not just the returned object
    expect(tasks.get(t.id)!.updatedAt).toBe(updated.updatedAt);
  });

  it("leaves fields the patch does not mention exactly as they were", () => {
    const { db, tasks, projectId } = makeStore();
    addRoom(db, "r1", "payments", projectId);
    const t = tasks.create({ title: "Expose a webhook", detail: "with a signature", roomId: "r1" });
    const updated = tasks.update(t.id, { status: "review" });
    expect(updated).toMatchObject({ title: "Expose a webhook", detail: "with a signature", roomId: "r1" });
  });

  it("throws for an unknown task id", () => {
    const { tasks } = makeStore();
    expect(() => tasks.update("nope", { status: "done" })).toThrow(/unknown task nope/);
    expect(tasks.get("nope")).toBeUndefined();
  });

  it("lists newest first", () => {
    const { tasks, tick } = makeStore();
    const first = tasks.create({ title: "first" });
    tick();
    const second = tasks.create({ title: "second" });
    tick();
    const third = tasks.create({ title: "third" });
    expect(tasks.list().map(t => t.id)).toEqual([third.id, second.id, first.id]);
  });

  it("lists tasks created in the same second newest first as well", () => {
    // `unixepoch()`-resolution timestamps tie constantly; insertion order has to break the tie.
    const { tasks } = makeStore();
    const ids = ["a", "b", "c"].map(title => tasks.create({ title }).id);
    expect(tasks.list().map(t => t.id)).toEqual([...ids].reverse());
  });

  it("sets and clears blockedOnMessageId", () => {
    const { tasks } = makeStore();
    const t = tasks.create({ title: "Waiting on payments" });
    const blocked = tasks.update(t.id, { status: "blocked", blockedOnMessageId: "m1" });
    expect(blocked).toMatchObject({ status: "blocked", blockedOnMessageId: "m1" });

    const unblocked = tasks.update(t.id, { status: "in_progress", blockedOnMessageId: null });
    expect(unblocked.blockedOnMessageId).toBeNull();
    expect(tasks.get(t.id)!.blockedOnMessageId).toBeNull();
  });

  it("assigns an agent that works in the task's room", () => {
    const { db, tasks, projectId } = makeStore();
    addRoom(db, "r1", "payments", projectId);
    addSession(db, "s1", "r1");
    const t = tasks.create({ title: "Expose a webhook", roomId: "r1" });
    expect(tasks.update(t.id, { agentId: "s1" }).agentId).toBe("s1");
    expect(tasks.update(t.id, { agentId: null }).agentId).toBeNull();
  });

  it("refuses an agent whose session is not in the task's room", () => {
    const { db, tasks, projectId } = makeStore();
    addRoom(db, "r1", "payments", projectId);
    addRoom(db, "r2", "chat", projectId);
    addSession(db, "elsewhere", "r2");
    addSession(db, "roomless", null);
    const t = tasks.create({ title: "Expose a webhook", roomId: "r1" });

    // the board must not claim an agent owns work in a room it does not stand in
    expect(() => tasks.update(t.id, { agentId: "elsewhere" })).toThrow(/does not work in room r1/);
    expect(() => tasks.update(t.id, { agentId: "roomless" })).toThrow(/does not work in room r1/);
    expect(() => tasks.update(t.id, { agentId: "ghost" })).toThrow(/unknown session ghost/);
    expect(tasks.get(t.id)!.agentId).toBeNull();
  });

  it("refuses an agent on a task that has no room", () => {
    const { db, tasks, projectId } = makeStore();
    addRoom(db, "r1", "payments", projectId);
    addSession(db, "s1", "r1");
    const t = tasks.create({ title: "Unassigned" });
    expect(() => tasks.update(t.id, { agentId: "s1" })).toThrow(/has no room/);
  });

  it("takes a room and an agent in the same patch", () => {
    const { db, tasks, projectId } = makeStore();
    addRoom(db, "r1", "payments", projectId);
    addSession(db, "s1", "r1");
    const t = tasks.create({ title: "Expose a webhook" });
    expect(tasks.update(t.id, { roomId: "r1", agentId: "s1" })).toMatchObject({ roomId: "r1", agentId: "s1" });
  });

  it("refuses to move a task to a room its assignee does not work in", () => {
    const { db, tasks, projectId } = makeStore();
    addRoom(db, "r1", "payments", projectId);
    addRoom(db, "r2", "chat", projectId);
    addSession(db, "s1", "r1");
    const t = tasks.create({ title: "Expose a webhook", roomId: "r1" });
    tasks.update(t.id, { agentId: "s1" });
    // reassigning the room silently would leave an assignee from the old room on the card
    expect(() => tasks.update(t.id, { roomId: "r2" })).toThrow(/does not work in room r2/);
    expect(tasks.update(t.id, { roomId: "r2", agentId: null })).toMatchObject({ roomId: "r2", agentId: null });
  });

  it("refuses an unknown room", () => {
    const { tasks } = makeStore();
    expect(() => tasks.create({ title: "Expose a webhook", roomId: "nope" })).toThrow(/unknown room nope/);
    const t = tasks.create({ title: "Expose a webhook" });
    expect(() => tasks.update(t.id, { roomId: "nope" })).toThrow(/unknown room nope/);
  });

  it("rejects a title the protocol would reject", () => {
    const { tasks } = makeStore();
    expect(() => tasks.create({ title: "" })).toThrow();
    expect(() => tasks.create({ title: "t".repeat(201) })).toThrow();
    expect(() => tasks.create({ title: "ok", detail: "d".repeat(4001) })).toThrow();
  });

  it("announces its own changes, because most of them never pass through the hub", () => {
    const { tasks } = makeStore();
    const seen: string[] = [];
    const off = tasks.onChange(() => seen.push("changed"));

    // An agent's `factory_task_update`, and the bus blocking a task on a request, both land here
    // directly: if the store stayed quiet the board would be stale until someone reloaded.
    const t = tasks.create({ title: "Expose a webhook" });
    expect(seen).toHaveLength(1);
    tasks.update(t.id, { status: "in_progress" });
    expect(seen).toHaveLength(2);

    off();
    tasks.update(t.id, { status: "done" });
    expect(seen).toHaveLength(2);
  });

  it("does not announce a read", () => {
    const { tasks } = makeStore();
    const t = tasks.create({ title: "Expose a webhook" });
    let changes = 0;
    tasks.onChange(() => { changes++; });
    tasks.get(t.id);
    tasks.list();
    expect(changes).toBe(0);
  });

  // ---- M1b: one board per factory ----

  describe("projects", () => {
    /** Two factories over one db, each with a room of the same name. */
    function twoProjects() {
      const ctx = makeStore();
      const other = ctx.projects.create({ root: tmpdir() === "/tmp" ? "/usr" : "/tmp" }).id;
      addRoom(ctx.db, "r1", "payments", ctx.projectId);
      addRoom(ctx.db, "r2", "payments", other);
      return { ...ctx, other };
    }

    it("lists only the asked-for project's board", () => {
      const { tasks, projectId, other } = twoProjects();
      const here = tasks.create({ title: "ours", roomId: "r1", projectId });
      const there = tasks.create({ title: "theirs", roomId: "r2", projectId: other });

      expect(tasks.list(projectId).map((t) => t.id)).toEqual([here.id]);
      expect(tasks.list(other).map((t) => t.id)).toEqual([there.id]);
      // and the unscoped call is the *default* project, not everything
      expect(tasks.list().map((t) => t.id)).toEqual([here.id]);
    });

    it("refuses a card hung off another factory's room", () => {
      const { tasks, projectId, other } = twoProjects();
      // A room id is globally unique, so this is the mistake that would otherwise put work in front
      // of an operator who cannot see the task asking for it.
      expect(() => tasks.create({ title: "wrong floor", roomId: "r2", projectId }))
        .toThrow(/belongs to another project/);
      expect(() => tasks.create({ title: "wrong floor", roomId: "r1", projectId: other }))
        .toThrow(/belongs to another project/);
      expect(tasks.list(projectId)).toEqual([]);
      expect(tasks.list(other)).toEqual([]);
    });

    it("refuses to move a card onto another factory's room", () => {
      const { tasks, projectId } = twoProjects();
      const t = tasks.create({ title: "ours", roomId: "r1", projectId });
      expect(() => tasks.update(t.id, { roomId: "r2" })).toThrow(/belongs to another project/);
      expect(tasks.get(t.id)!.roomId).toBe("r1");
    });
  });

  it("survives a reopen: tasks are rows, not process state", () => {
    const { db, projects, tasks } = makeStore();
    const t = tasks.create({ title: "Expose a webhook" });
    const second = new TaskStore(db, projects);
    expect(second.get(t.id)).toMatchObject({ title: "Expose a webhook" });
    expect(second.list()).toHaveLength(1);
  });
});
