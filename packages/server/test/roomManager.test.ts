import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { ringPosition } from "@superfabric/shared";
import { openDb } from "../src/db.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";

/**
 * A throwaway project root plus a manager over an in-memory db, cleaned up afterwards. The root is
 * the *default* project's root, so a call that names no project (as most of these do) resolves its
 * folders against this directory.
 */
function withProject<T>(fn: (ctx: {
  root: string;
  db: ReturnType<typeof openDb>;
  projects: ProjectManager;
  projectId: string;
  mgr: RoomManager;
}) => T): T {
  const root = mkdtempSync(join(tmpdir(), "superfabric-rooms-"));
  const db = openDb(":memory:");
  try {
    const projects = new ProjectManager(db, root);
    return fn({
      root, db, projects,
      projectId: projects.defaultProject().id,
      mgr: new RoomManager(db, projects),
    });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** A second factory: a throwaway root, its project row, and the id to scope calls with. */
function addProject(projects: ProjectManager, label: string): { root: string; id: string } {
  const root = mkdtempSync(join(tmpdir(), `superfabric-rooms-${label}-`));
  return { root, id: projects.create({ root }).id };
}

const roomCount = (db: ReturnType<typeof openDb>, kind?: string) =>
  (kind === undefined
    ? db.prepare("SELECT COUNT(*) c FROM rooms").get()
    : db.prepare("SELECT COUNT(*) c FROM rooms WHERE kind = ?").get(kind)) as { c: number };

describe("RoomManager", () => {
  describe("ensureProjectRoom", () => {
    it("creates exactly one project room for the root and is idempotent", () => {
      withProject(({ root, db, mgr }) => {
        const first = mgr.ensureProjectRoom();
        expect(first).toMatchObject({
          kind: "project",
          path: root,
          position: { x: 0, z: 0 },
          agentCount: 0,
        });
        expect(first.name).toBe(basename(root).toLowerCase());

        const second = mgr.ensureProjectRoom();
        expect(second.id).toBe(first.id);
        // a fresh manager over the same db (a server restart) must not add another one
        expect(new RoomManager(db, new ProjectManager(db, root)).ensureProjectRoom().id).toBe(first.id);
        expect(roomCount(db, "project").c).toBe(1);
        expect(roomCount(db).c).toBe(1);
      });
    });

    it("names the project room after the root, folded into a protocol-valid label", () => {
      // A repository folder is not bound by RoomName — it may be capitalised or hold spaces — but
      // every RoomInfo that goes on the wire must still parse.
      const parent = mkdtempSync(join(tmpdir(), "superfabric-rooms-parent-"));
      try {
        for (const [folder, expected] of [["My Project", "my-project"], ["...", "project"]] as const) {
          const root = join(parent, folder);
          mkdirSync(root);
          const db = openDb(":memory:");
          expect(new RoomManager(db, new ProjectManager(db, root)).ensureProjectRoom().name).toBe(expected);
          db.close();
        }
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });

    it("does not create a folder for the project room: the root already exists", () => {
      withProject(({ root, mgr }) => {
        const info = mgr.ensureProjectRoom();
        expect(info.path).toBe(root);
        // nothing was written into the root — no charter, no nested folder named after it
        expect(existsSync(join(root, basename(root)))).toBe(false);
        expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
      });
    });
  });

  describe("createRoom", () => {
    it("creates the folder, writes a charter naming the room, and persists the row", () => {
      withProject(({ root, db, mgr }) => {
        mgr.ensureProjectRoom();
        const room = mgr.createRoom("backend");

        expect(room).toMatchObject({ name: "backend", kind: "room", path: join(root, "backend"), agentCount: 0 });
        expect(existsSync(join(root, "backend"))).toBe(true);
        const charter = readFileSync(join(root, "backend", "CLAUDE.md"), "utf8");
        expect(charter).toContain("backend");
        expect(charter).toMatch(/^# backend/);

        const row = db.prepare("SELECT name, path, kind FROM rooms WHERE id = ?").get(room.id);
        expect(row).toEqual({ name: "backend", path: join(root, "backend"), kind: "room" });
      });
    });

    it("tells the agent about the factory bus, by this room's own name", () => {
      withProject(({ root, mgr }) => {
        mgr.ensureProjectRoom();
        mgr.createRoom("payments");
        const charter = readFileSync(join(root, "payments", "CLAUDE.md"), "utf8");

        // Its own identity: an agent cannot address anyone if it does not know who it is.
        expect(charter).toContain("You are the **payments** room");
        // The tools, under the names the model actually sees (mcp__<server>__<tool>).
        expect(charter).toContain("mcp__factory__factory_send");
        expect(charter).toContain("mcp__factory__factory_task_update");
        expect(charter).toContain("mcp__factory__factory_inbox");
        // Incoming messages are turns, not something to fetch…
        expect(charter).toMatch(/arrive as ordinary turns/);
        // …so the one instruction that saves tokens on every turn is explicit.
        expect(charter).toMatch(/Do not poll/);
      });
    });

    it("puts the first rooms on a ring so the buildings do not stack", () => {
      withProject(({ mgr }) => {
        mgr.ensureProjectRoom();
        const a = mgr.createRoom("a");
        const b = mgr.createRoom("b");
        // shared `ringPosition`: radius RING_RADIUS + floor(n / 8) * RING_STEP, angle
        // RING_ANGLE_OFFSET + (n % 8) * (PI / 4)
        expect(a.position).toEqual(ringPosition(0));
        expect(b.position).toEqual(ringPosition(1));
        // The ring is rotated half a slot off the axes so no room stands on the camera's diagonal.
        expect(a.position).toEqual({ x: 12.934, z: 5.358 });
        expect(a.position).not.toEqual(b.position);
      });
    });

    it("rejects a duplicate name and leaves the existing folder's CLAUDE.md untouched", () => {
      withProject(({ root, db, mgr }) => {
        mgr.ensureProjectRoom();
        mgr.createRoom("backend");
        writeFileSync(join(root, "backend", "CLAUDE.md"), "# hand-written charter\n");

        expect(() => mgr.createRoom("backend")).toThrow(/backend/);
        expect(readFileSync(join(root, "backend", "CLAUDE.md"), "utf8")).toBe("# hand-written charter\n");
        expect(roomCount(db, "room").c).toBe(1);
      });
    });

    it("adopts an existing folder without clobbering its CLAUDE.md", () => {
      withProject(({ root, mgr }) => {
        mgr.ensureProjectRoom();
        mkdirSync(join(root, "legacy"));
        writeFileSync(join(root, "legacy", "CLAUDE.md"), "# pre-existing docs\n");
        writeFileSync(join(root, "legacy", "keep.txt"), "untouched\n");

        const room = mgr.createRoom("legacy");

        expect(room.path).toBe(join(root, "legacy"));
        expect(readFileSync(join(root, "legacy", "CLAUDE.md"), "utf8")).toBe("# pre-existing docs\n");
        expect(readFileSync(join(root, "legacy", "keep.txt"), "utf8")).toBe("untouched\n");
      });
    });

    it("refuses a name whose resolved path escapes the project root", () => {
      withProject(({ root, db, mgr }) => {
        mgr.ensureProjectRoom();
        // the zod layer rejects these on the wire; the manager must reject them on its own too
        for (const name of ["..", "../escape", "/etc", join("..", basename(root) + "-sibling")]) {
          expect(() => mgr.createRoom(name)).toThrow(/project root/);
        }
        // a separator that stays inside the root is still not a folder *segment*
        expect(() => mgr.createRoom("nested/deep")).toThrow();
        expect(existsSync(join(root, "..", "escape"))).toBe(false);
        expect(roomCount(db, "room").c).toBe(0);
      });
    });

    it("refuses a name that is not a safe folder segment", () => {
      withProject(({ db, mgr }) => {
        mgr.ensureProjectRoom();
        for (const name of ["", ".hidden", "Upper", "has space", "a".repeat(65), "back\\slash"]) {
          expect(() => mgr.createRoom(name)).toThrow();
        }
        expect(roomCount(db, "room").c).toBe(0);
      });
    });
  });

  describe("listRooms", () => {
    it("returns the project room first, then rooms in creation order", () => {
      withProject(({ mgr }) => {
        const project = mgr.ensureProjectRoom();
        const first = mgr.createRoom("first");
        const second = mgr.createRoom("second");
        expect(mgr.listRooms().map((r) => r.id)).toEqual([project.id, first.id, second.id]);
        expect(mgr.listRooms().map((r) => r.kind)).toEqual(["project", "room", "room"]);
      });
    });

    it("reports agentCount from the sessions that reference each room", () => {
      withProject(({ db, mgr }) => {
        const project = mgr.ensureProjectRoom();
        const backend = mgr.createRoom("backend");
        const web = mgr.createRoom("web");
        const insert = db.prepare("INSERT INTO sessions (id, cwd, room_id) VALUES (?, ?, ?)");
        insert.run("s1", backend.path, backend.id);
        insert.run("s2", backend.path, backend.id);
        insert.run("s3", web.path, null); // roomless: counts for nobody

        const counts = Object.fromEntries(mgr.listRooms().map((r) => [r.name, r.agentCount]));
        expect(counts).toEqual({ [project.name]: 0, backend: 2, web: 0 });
      });
    });

    it("is empty before ensureProjectRoom runs", () => {
      withProject(({ mgr }) => {
        expect(mgr.listRooms()).toEqual([]);
      });
    });
  });

  describe("moveRoom", () => {
    it("persists the new position and reflects it in listRooms", () => {
      withProject(({ db, root, mgr }) => {
        mgr.ensureProjectRoom();
        const room = mgr.createRoom("backend");
        const moved = mgr.moveRoom(room.id, { x: -12.5, z: 4 });

        expect(moved.position).toEqual({ x: -12.5, z: 4 });
        expect(mgr.listRooms().find((r) => r.id === room.id)!.position).toEqual({ x: -12.5, z: 4 });
        // and it survives a restart, because it is in the db and not in memory
        expect(new RoomManager(db, new ProjectManager(db, root)).listRooms().find((r) => r.id === room.id)!.position)
          .toEqual({ x: -12.5, z: 4 });
      });
    });

    it("throws on an unknown room id", () => {
      withProject(({ mgr }) => {
        mgr.ensureProjectRoom();
        expect(() => mgr.moveRoom("nope", { x: 1, z: 1 })).toThrow(/unknown room/);
      });
    });
  });

  describe("getRoom", () => {
    it("returns one room by id, or undefined for an unknown id", () => {
      withProject(({ mgr }) => {
        mgr.ensureProjectRoom();
        const room = mgr.createRoom("backend");
        expect(mgr.getRoom(room.id)).toMatchObject({ id: room.id, name: "backend", path: room.path });
        expect(mgr.getRoom("nope")).toBeUndefined();
      });
    });
  });

  // ---- M1b: several factories in one server ----

  describe("projects", () => {
    it("keeps each project's floor to itself, same room names and all", () => {
      withProject(({ projects, projectId, mgr }) => {
        const other = addProject(projects, "other");
        try {
          const homeProject = mgr.ensureProjectRoom(projectId);
          const homeBackend = mgr.createRoom("backend", { projectId });
          const awayProject = mgr.ensureProjectRoom(other.id);
          // The same name on two floors: uniqueness is per project, which is the whole point.
          const awayBackend = mgr.createRoom("backend", { projectId: other.id });

          expect(awayBackend.id).not.toBe(homeBackend.id);
          expect(mgr.listRooms(projectId).map((r) => r.id)).toEqual([homeProject.id, homeBackend.id]);
          expect(mgr.listRooms(other.id).map((r) => r.id)).toEqual([awayProject.id, awayBackend.id]);
          // …and each room's folder is under its own root, not the other's
          expect(homeBackend.path.startsWith(mgr.getRoom(homeProject.id)!.path)).toBe(true);
          expect(awayBackend.path.startsWith(other.root)).toBe(true);
          // a duplicate *within* one project is still refused
          expect(() => mgr.createRoom("backend", { projectId })).toThrow(/already exists/);
        } finally {
          rmSync(other.root, { recursive: true, force: true });
        }
      });
    });

    it("scopes the ring so a second factory's first room is not pushed outwards", () => {
      withProject(({ projects, projectId, mgr }) => {
        const other = addProject(projects, "ring");
        try {
          mgr.ensureProjectRoom(projectId);
          mgr.ensureProjectRoom(other.id);
          mgr.createRoom("a", { projectId });
          mgr.createRoom("b", { projectId });
          // Two rooms already exist — but not on *this* floor, so this one starts at slot 0.
          expect(mgr.createRoom("a", { projectId: other.id }).position).toEqual(ringPosition(0));
        } finally {
          rmSync(other.root, { recursive: true, force: true });
        }
      });
    });

    it("answers projectOf with the floor a room stands on", () => {
      withProject(({ projects, projectId, mgr }) => {
        const other = addProject(projects, "of");
        try {
          const here = mgr.createRoom("here", { projectId });
          const there = mgr.createRoom("there", { projectId: other.id });
          expect(mgr.projectOf(here.id)).toBe(projectId);
          expect(mgr.projectOf(there.id)).toBe(other.id);
          expect(mgr.projectOf("nope")).toBeUndefined();
        } finally {
          rmSync(other.root, { recursive: true, force: true });
        }
      });
    });
  });

});
