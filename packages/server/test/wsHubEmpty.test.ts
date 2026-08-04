import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { Demolition } from "../src/demolition.js";
import { EventStore } from "../src/eventStore.js";
import { FactoryBus } from "../src/factoryBus.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { TaskStore } from "../src/taskStore.js";
import { FakeExecutor } from "../src/executors/fake.js";
import { WsHub, type SocketLike } from "../src/wsHub.js";

/**
 * A server with no factory at all — a fresh install, and now the normal first state.
 *
 * SuperFabric used to open on a factory invented from whatever directory the server was started in,
 * which meant a first run produced a floor over its own source tree that nothing could remove (the
 * next boot put it straight back). Nothing is seeded now unless `SUPERFABRIC_PROJECT` says so, which
 * makes "no project" a state every listing and every broadcast has to survive.
 */

function fakeSocket() {
  const sent: any[] = [];
  const sock: SocketLike = { send: (d: string) => sent.push(JSON.parse(d)) };
  return { sock, sent };
}

/** A hub over an empty database: no projects, nothing seeded. */
function makeHub() {
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const projects = new ProjectManager(db, tmpdir());
  const rooms = new RoomManager(db, projects);
  const tasks = new TaskStore(db, projects);
  let mgr!: SessionManager;
  const bus = new FactoryBus({
    db, rooms, projects,
    deliver: (sessionId, text) => mgr.prompt(sessionId, text),
    roomAgents: (roomId) => mgr.roomAgents(roomId),
  });
  mgr = new SessionManager(db, store, new FakeExecutor(), rooms, projects, { tasks, bus });
  const hub = new WsHub(store, mgr, rooms, projects, { tasks, bus, sessionsDebounceMs: 1 });
  const { sock, sent } = fakeSocket();
  hub.attach(sock);
  return { db, projects, rooms, mgr, hub, sock, sent };
}

const ask = (h: ReturnType<typeof makeHub>, msg: unknown): void =>
  h.hub.handleMessage(h.sock, JSON.stringify(msg));

describe("a server with no factory", () => {
  it("invents nothing when a tab attaches", () => {
    const h = makeHub();
    // The bug this replaces: `attach` used to resolve the active project by *creating* one for the
    // server's own working directory. Opening a browser tab is not a decision about which folder an
    // operator works in.
    expect(h.projects.list()).toEqual([]);
    ask(h, { kind: "list_projects" });
    expect(h.sent.at(-1)).toMatchObject({ kind: "projects", projects: [], activeProjectId: null });
    expect(h.projects.list()).toEqual([]);
  });

  it("answers the connect handshake with empty lists rather than a wall of errors", () => {
    const h = makeHub();
    for (const kind of ["list_rooms", "list_sessions", "list_tasks", "list_messages"]) ask(h, { kind });

    expect(h.sent.filter((m) => m.kind === "error")).toEqual([]);
    expect(h.sent.find((m) => m.kind === "rooms").rooms).toEqual([]);
    expect(h.sent.find((m) => m.kind === "sessions").sessions).toEqual([]);
    expect(h.sent.find((m) => m.kind === "tasks").tasks).toEqual([]);
    expect(h.sent.find((m) => m.kind === "messages").messages).toEqual([]);
  });

  it("refuses to build anything, in words that say what to do", () => {
    const h = makeHub();
    ask(h, { kind: "create_room", name: "backend" });
    const error = h.sent.find((m) => m.kind === "error");
    expect(error.message).toMatch(/no factory yet/);
    // Actionable rather than merely true: it names both ways out.
    expect(error.message).toMatch(/SUPERFABRIC_PROJECT/);
    // And it built nothing on the way to refusing: no project appeared, so no room could have.
    expect(h.projects.list()).toEqual([]);
  });

  it("comes to life the moment a folder is chosen", () => {
    const root = mkdtempSync(join(tmpdir(), "superfabric-first-run-"));
    try {
      const h = makeHub();
      ask(h, { kind: "create_project", root, name: "Payments" });

      const projects = h.sent.filter((m) => m.kind === "projects").at(-1);
      expect(projects.projects).toHaveLength(1);
      expect(projects.activeProjectId).toBe(projects.projects[0].id);
      // And the floor it answers with is the new one, central building included.
      const rooms = h.sent.filter((m) => m.kind === "rooms").at(-1);
      expect(rooms.rooms).toHaveLength(1);
      expect(rooms.rooms[0]).toMatchObject({ kind: "project", path: root });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("puts a tab back on the empty floor when its last factory is deleted", async () => {
    const root = mkdtempSync(join(tmpdir(), "superfabric-first-run-"));
    try {
      const db = openDb(":memory:");
      const store = new EventStore(db);
      const projects = new ProjectManager(db, tmpdir());
      const rooms = new RoomManager(db, projects);
      const mgr = new SessionManager(db, store, new FakeExecutor(), rooms, projects);
      const hub = new WsHub(store, mgr, rooms, projects, {
        demolition: new Demolition({ sessions: mgr, rooms, projects }),
        sessionsDebounceMs: 1,
      });
      const { sock, sent } = fakeSocket();
      hub.attach(sock);
      hub.handleMessage(sock, JSON.stringify({ kind: "create_project", root }));
      const created = sent.filter((m) => m.kind === "projects").at(-1).projects[0].id;
      sent.length = 0;

      hub.handleMessage(sock, JSON.stringify({ kind: "delete_project", projectId: created }));
      await Bun.sleep(20);

      const projects_ = sent.filter((m) => m.kind === "projects").at(-1);
      expect(projects_.projects).toEqual([]);
      // Not left holding an id that no longer resolves — the UI shows its first-run screen again.
      expect(projects_.activeProjectId).toBeNull();
      expect(sent.find((m) => m.kind === "rooms").rooms).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
