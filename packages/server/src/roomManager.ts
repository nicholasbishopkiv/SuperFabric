import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RoomName, ringPosition, type RoomInfo, type ScenePosition } from "@superfabric/shared";
import type { Db } from "./db.js";

/**
 * Charter template written into a new room's folder. Rooms are folders; this is the room's brief.
 *
 * The bus section is not decoration: a fresh agent has no other way to learn that it is a department
 * in a factory, what that department is called, or that the `mcp__factory__*` tools in its tool list
 * are how it reaches the other rooms. The tool names are the namespaced ones the model actually sees
 * (`mcp__<server>__<tool>` — see `notes/agent-sdk-api.md`), so an agent can copy them verbatim.
 *
 * Kept short on purpose. This is a charter the operator will rewrite, not a manual: everything here
 * has to survive being read once. An existing `CLAUDE.md` is never overwritten (see `createRoom`), so
 * a room adopted from a folder that already had one needs this paragraph added by hand.
 */
function charter(name: string): string {
  return `# ${name}

## Responsibility

_What this department owns. Replace this line._

## Interfaces

_What other rooms can rely on from this one, and what it needs from them._

## Conventions

_Anything an agent working here must follow._

## The factory bus

You are the **${name}** room of this factory. The other rooms are other agents working in other
folders of this project, and you can talk to them:

- \`mcp__factory__factory_send(to_room, kind, body)\` sends a message to another room, addressed by
  the name on its building. \`kind\` is \`request\` when you need something back, \`response\` when you
  are answering, \`info\` otherwise.
- Messages **to** this room arrive as ordinary turns in this session, framed \`[factory bus]\` and
  naming the room that sent them. Answer them as you would answer anyone — but reply with
  \`factory_send\`, not just by writing text.
- \`mcp__factory__factory_task_update(task_id, status)\` moves one of your tasks on the factory's
  board; \`mcp__factory__factory_report_status(summary)\` puts one line about what you are doing in
  front of the operator.
- Do not poll. \`mcp__factory__factory_inbox\` is for re-reading traffic you already have, never for
  checking whether any arrived — it arrives on its own.
`;
}

/** Row shape of the columns a room listing needs. */
interface RoomRow {
  id: string;
  name: string;
  path: string;
  kind: string;
  pos_x: number;
  pos_z: number;
  agent_count: number;
}

/**
 * Rooms as first-class objects: a row in `rooms` and a folder under the project root holding a
 * `CLAUDE.md` charter. Without SuperFabric the project stays an ordinary repository, so the folder
 * is the truth about *what* a room is and the row only adds what a folder cannot hold — its place
 * on the factory floor.
 *
 * Deliberately knows nothing about sessions beyond counting the ones that point at a room.
 */
export class RoomManager {
  /** Resolved once: every containment check compares against this exact string. */
  private readonly root: string;
  private readonly stmts;

  constructor(private db: Db, projectRoot: string) {
    this.root = path.resolve(projectRoot);
    this.stmts = {
      insert: db.prepare("INSERT INTO rooms (id, name, path, kind, pos_x, pos_z) VALUES (?, ?, ?, ?, ?, ?)"),
      byName: db.prepare("SELECT id FROM rooms WHERE name = ?"),
      projectRoom: db.prepare("SELECT id FROM rooms WHERE kind = 'project' ORDER BY created_at, rowid LIMIT 1"),
      countRooms: db.prepare("SELECT COUNT(*) c FROM rooms WHERE kind != 'project'"),
      move: db.prepare("UPDATE rooms SET pos_x = ?, pos_z = ? WHERE id = ?"),
      // One statement for the whole listing: the agent count is a join, not a query per room, and
      // it is the only thing this class ever asks about sessions.
      list: db.prepare(`
        SELECT r.id AS id, r.name AS name, r.path AS path, r.kind AS kind,
               r.pos_x AS pos_x, r.pos_z AS pos_z, COUNT(s.id) AS agent_count
        FROM rooms r LEFT JOIN sessions s ON s.room_id = r.id
        GROUP BY r.id
        ORDER BY (CASE WHEN r.kind = 'project' THEN 0 ELSE 1 END), r.created_at, r.rowid
      `),
      one: db.prepare(`
        SELECT r.id AS id, r.name AS name, r.path AS path, r.kind AS kind,
               r.pos_x AS pos_x, r.pos_z AS pos_z, COUNT(s.id) AS agent_count
        FROM rooms r LEFT JOIN sessions s ON s.room_id = r.id
        WHERE r.id = ?
        GROUP BY r.id
      `),
    };
  }

  /**
   * The single central building, standing for the project root itself. Idempotent: the row is
   * created once and every later call (including after a restart) returns the same one. No folder is
   * created — the root already exists, and writing a charter into it would touch the user's repo.
   */
  ensureProjectRoom(): RoomInfo {
    // `!= null`, not `!== undefined`: "no such row" is `null` for the driver db.ts uses.
    const existing = this.stmts.projectRoom.get() as { id: string } | null;
    if (existing != null) return this.getRoom(existing.id)!;

    const id = randomUUID();
    this.stmts.insert.run(id, this.projectRoomName(), this.root, "project", 0, 0);
    return this.getRoom(id)!;
  }

  /**
   * Create a room: the folder, its charter, and the row. The folder may already exist (adopting a
   * directory that is already part of the repo is the normal case), in which case only the row is
   * new and an existing `CLAUDE.md` is left exactly as it is.
   */
  createRoom(name: string): RoomInfo {
    // Containment first, so a traversal attempt is reported as what it is even if it would also
    // fail the name rule. `path.resolve` collapses `..`, so this catches absolute paths too.
    const dir = path.resolve(this.root, name);
    if (dir !== this.root && !dir.startsWith(this.root + path.sep)) {
      throw new Error(`room ${JSON.stringify(name)} resolves outside the project root ${this.root}`);
    }
    // Then the shape: a room name is one folder segment, used verbatim.
    const parsed = RoomName.safeParse(name);
    if (!parsed.success) {
      throw new Error(`invalid room name ${JSON.stringify(name)}: ${parsed.error.issues[0]?.message ?? "rejected"}`);
    }
    if (dir === this.root) throw new Error(`room ${JSON.stringify(name)} would be the project root itself`);
    if (this.stmts.byName.get(name) != null) throw new Error(`room ${JSON.stringify(name)} already exists`);

    mkdirSync(dir, { recursive: true });
    // Never clobber docs that are already there: a room may be an existing folder with its own
    // CLAUDE.md, and that file is the operator's, not ours.
    const claudeMd = path.join(dir, "CLAUDE.md");
    if (!existsSync(claudeMd)) writeFileSync(claudeMd, charter(name));

    const id = randomUUID();
    const pos = ringPosition((this.stmts.countRooms.get() as { c: number }).c);
    this.stmts.insert.run(id, name, dir, "room", pos.x, pos.z);
    return this.getRoom(id)!;
  }

  /** The project room first, then rooms in creation order. */
  listRooms(): RoomInfo[] {
    return (this.stmts.list.all() as RoomRow[]).map(toRoomInfo);
  }

  /** `undefined` for an unknown room: the absent-row shape the rest of the package speaks. */
  getRoom(roomId: string): RoomInfo | undefined {
    const row = this.stmts.one.get(roomId) as RoomRow | null;
    return row == null ? undefined : toRoomInfo(row);
  }

  /** Move a building on the floor. The layout is persisted, so it survives a reload and a restart. */
  moveRoom(roomId: string, position: ScenePosition): RoomInfo {
    const changed = this.stmts.move.run(position.x, position.z, roomId).changes;
    if (changed === 0) throw new Error(`unknown room ${roomId}`);
    return this.getRoom(roomId)!;
  }

  /**
   * The project room's display name is the root's basename. A repository folder is not bound by
   * `RoomName` (it may be capitalised, or hold spaces), but every `RoomInfo` on the wire must be
   * protocol-valid — so an unusable basename is folded into a safe label. The project room's name is
   * only a label anyway: its path is the root, never `root/name`.
   */
  private projectRoomName(): string {
    const base = path.basename(this.root);
    if (RoomName.safeParse(base).success) return base;
    const folded = base.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);
    return RoomName.safeParse(folded).success ? folded : "project";
  }
}

function toRoomInfo(row: RoomRow): RoomInfo {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    position: { x: row.pos_x, z: row.pos_z },
    kind: row.kind === "project" ? "project" : "room",
    agentCount: row.agent_count,
  };
}
