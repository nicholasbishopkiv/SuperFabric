import { describe, it, expect } from "bun:test";
import { openDb, type Db } from "../src/db.js";
import { TaskStore } from "../src/taskStore.js";

/**
 * A store over an in-memory db with a clock the test drives. `unixepoch()` has one-second
 * resolution, so a real clock cannot tell "updatedAt moved" from "the test ran fast"; the seam
 * makes the ordering assertions about the code rather than about the machine.
 */
function makeStore(): { db: Db; tasks: TaskStore; tick: () => void } {
  const db = openDb(":memory:");
  let now = 1_000;
  const tasks = new TaskStore(db, () => now);
  return { db, tasks, tick: () => { now += 5; } };
}

/** A session row in a given room (or roomless), inserted directly — TaskStore only reads them. */
function addSession(db: Db, id: string, roomId: string | null): void {
  db.prepare("INSERT INTO sessions (id, cwd, room_id) VALUES (?, ?, ?)").run(id, "/tmp", roomId);
}

function addRoom(db: Db, id: string, name: string): void {
  db.prepare("INSERT INTO rooms (id, name, path) VALUES (?, ?, ?)").run(id, name, `/p/${name}`);
}

describe("TaskStore", () => {
  it("creates, lists and reads a task back", () => {
    const { db, tasks } = makeStore();
    addRoom(db, "r1", "payments");
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
    const { db, tasks } = makeStore();
    addRoom(db, "r1", "payments");
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
    const { db, tasks } = makeStore();
    addRoom(db, "r1", "payments");
    addSession(db, "s1", "r1");
    const t = tasks.create({ title: "Expose a webhook", roomId: "r1" });
    expect(tasks.update(t.id, { agentId: "s1" }).agentId).toBe("s1");
    expect(tasks.update(t.id, { agentId: null }).agentId).toBeNull();
  });

  it("refuses an agent whose session is not in the task's room", () => {
    const { db, tasks } = makeStore();
    addRoom(db, "r1", "payments");
    addRoom(db, "r2", "chat");
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
    const { db, tasks } = makeStore();
    addRoom(db, "r1", "payments");
    addSession(db, "s1", "r1");
    const t = tasks.create({ title: "Unassigned" });
    expect(() => tasks.update(t.id, { agentId: "s1" })).toThrow(/has no room/);
  });

  it("takes a room and an agent in the same patch", () => {
    const { db, tasks } = makeStore();
    addRoom(db, "r1", "payments");
    addSession(db, "s1", "r1");
    const t = tasks.create({ title: "Expose a webhook" });
    expect(tasks.update(t.id, { roomId: "r1", agentId: "s1" })).toMatchObject({ roomId: "r1", agentId: "s1" });
  });

  it("refuses to move a task to a room its assignee does not work in", () => {
    const { db, tasks } = makeStore();
    addRoom(db, "r1", "payments");
    addRoom(db, "r2", "chat");
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

  it("survives a reopen: tasks are rows, not process state", () => {
    const { db, tasks } = makeStore();
    const t = tasks.create({ title: "Expose a webhook" });
    const second = new TaskStore(db);
    expect(second.get(t.id)).toMatchObject({ title: "Expose a webhook" });
    expect(second.list()).toHaveLength(1);
  });
});
