import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoomInfo, ServerMessage } from "@superfabric/shared";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { FakeExecutor } from "../src/executors/fake.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { WsHub, type SocketLike } from "../src/wsHub.js";

/**
 * `rooms.runtime`: the operator's choice of where a department's agents run, from the column up to
 * the frame the UI draws from.
 */

function build() {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-runtime-"));
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const projects = new ProjectManager(db, dir);
  projects.defaultProject(); // the floor this socket lands on — nothing is seeded from cwd any more
  const rooms = new RoomManager(db, projects);
  const mgr = new SessionManager(db, store, new FakeExecutor(), rooms, projects);
  const hub = new WsHub(store, mgr, rooms, projects, { sessionsDebounceMs: 1 });
  const sent: ServerMessage[] = [];
  const sock: SocketLike = { send: (raw) => sent.push(JSON.parse(raw) as ServerMessage) };
  hub.attach(sock);
  return { db, dir, rooms, mgr, hub, sock, sent, projects };
}

function roomsFrame(sent: ServerMessage[]): RoomInfo[] {
  const last = [...sent].reverse().find((m) => m.kind === "rooms");
  if (last === undefined) throw new Error("no rooms frame was sent");
  return last.rooms;
}

describe("a room's runtime", () => {
  it("is host until somebody says otherwise", () => {
    const h = build();
    const room = h.rooms.createRoom("payments");
    expect(room.runtime).toBe("host");
    // Including the central building, which nobody creates explicitly.
    expect(h.rooms.ensureProjectRoom().runtime).toBe("host");
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("can be set, is persisted, and comes back on the listing", () => {
    const h = build();
    const room = h.rooms.createRoom("payments");
    expect(h.rooms.setRuntime(room.id, "container").runtime).toBe("container");
    expect(h.rooms.getRoom(room.id)!.runtime).toBe("container");
    expect(h.rooms.listRooms().find((r) => r.id === room.id)!.runtime).toBe("container");
    expect(h.rooms.setRuntime(room.id, "host").runtime).toBe("host");
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("refuses an unknown room and an unknown runtime", () => {
    const h = build();
    const room = h.rooms.createRoom("payments");
    expect(() => h.rooms.setRuntime("nope", "container")).toThrow(/unknown room/);
    expect(() => h.rooms.setRuntime(room.id, "vm" as never)).toThrow(/unknown runtime/);
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("folds a hand-edited value to host rather than claiming an isolation nobody has", () => {
    const h = build();
    const room = h.rooms.createRoom("payments");
    // A downgraded build, a hand-edited row, a typo in a script: the safe reading is the one that
    // *under*-claims. A room that says "container" when it is not one is the only unacceptable
    // direction for this to fail in.
    h.db.prepare("UPDATE rooms SET runtime = ? WHERE id = ?").run("sandboxed-ish", room.id);
    expect(h.rooms.getRoom(room.id)!.runtime).toBe("host");
    rmSync(h.dir, { recursive: true, force: true });
  });
});

describe("set_room_runtime, over the wire", () => {
  it("changes the room, broadcasts the floor and says what it means in one line", () => {
    const h = build();
    const room = h.rooms.createRoom("payments");
    h.hub.handleMessage(h.sock, JSON.stringify({
      kind: "set_room_runtime", roomId: room.id, runtime: "container",
    }));
    expect(roomsFrame(h.sent).find((r) => r.id === room.id)!.runtime).toBe("container");
    const notice = h.sent.find((m) => m.kind === "notice");
    expect(notice!.kind === "notice" && notice.message).toContain("in a container");
    expect(notice!.kind === "notice" && notice.message).toContain("default-deny egress");
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("says out loud that agents already running here have not moved", () => {
    const h = build();
    const room = h.rooms.createRoom("payments");
    h.mgr.createSession({ roomId: room.id });
    h.sent.length = 0;
    h.hub.handleMessage(h.sock, JSON.stringify({
      kind: "set_room_runtime", roomId: room.id, runtime: "container",
    }));
    const notice = h.sent.find((m) => m.kind === "notice");
    const message = notice!.kind === "notice" ? notice.message : "";
    // The lag matters more here than anywhere else it exists in the product: what lags is an
    // isolation boundary, and an operator who read "done" would believe the wrong thing.
    expect(message).toContain("1 agent is already running here");
    expect(message).toContain("stays on the host runtime until restarted");
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("does not mention a lag when nobody is running", () => {
    const h = build();
    const room = h.rooms.createRoom("payments");
    h.hub.handleMessage(h.sock, JSON.stringify({
      kind: "set_room_runtime", roomId: room.id, runtime: "container",
    }));
    const notice = h.sent.find((m) => m.kind === "notice");
    expect(notice!.kind === "notice" && notice.message).not.toContain("already running");
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("refuses a room on another floor, like every other room message", () => {
    const h = build();
    const other = h.projects.create({ root: mkdtempSync(join(tmpdir(), "fabrica-other-")) });
    const room = h.rooms.createRoom("payments", { projectId: other.id });
    h.hub.handleMessage(h.sock, JSON.stringify({
      kind: "set_room_runtime", roomId: room.id, runtime: "container",
    }));
    const err = h.sent.find((m) => m.kind === "error");
    expect(err!.kind === "error" && err.message).toContain("belongs to another project");
    expect(h.rooms.getRoom(room.id)!.runtime).toBe("host");
    rmSync(h.dir, { recursive: true, force: true });
  });
});
