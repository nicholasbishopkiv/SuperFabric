import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_ROOM_RUNTIME, PROJECT_CHARTER_FILE, RoomName, RoomRuntime, ringPosition,
  type RoomInfo, type ScenePosition,
} from "@superfabric/shared";
import type { Db } from "./db.js";
import type { ProjectManager } from "./projectManager.js";

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
function charter(name: string, summary?: string): string {
  // The one line the operator (or an onboarding proposal they approved) has already written about
  // this department, in the place the template otherwise asks for it. Absent, the placeholder stays:
  // an empty section that says "replace this line" is a prompt, and inventing prose here would be
  // the factory putting words in a department's mouth.
  const responsibility = summary === undefined || summary.trim() === ""
    ? "_What this department owns. Replace this line._"
    : summary.trim();
  return `# ${name}

## Responsibility

${responsibility}

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
- \`mcp__factory__factory_ask_orchestrator(question, task_id?)\` asks the factory's orchestrator —
  the senior agent in the project room — for a ruling on anything above this room's remit: where
  something belongs, which of two ways to go, a task that looks wrong for you. It answers as an
  ordinary bus message.
- Do not poll. \`mcp__factory__factory_inbox\` is for re-reading traffic you already have, never for
  checking whether any arrived — it arrives on its own.

## The chronicle

- **Search before you rework anything.** \`mcp__factory__factory_search_history(query)\` searches this
  project's recorded decisions *and* what agents have actually said. Run it before you replace,
  reverse or argue with something that already exists: the reason it is that way is usually written
  down, and rediscovering it costs more than reading it.
- **Record what you decide.** When a choice shapes how this project is built — an interface another
  room relies on, a technology, a convention — write it down with
  \`mcp__factory__factory_record_decision(title, context, decision, alternatives?, links?)\`. It
  becomes an ADR file in \`docs/decisions/\`, which is a file in this repository and is there for
  whoever works on it next, with or without SuperFabric running. Record the reasoning, not just the
  outcome.
`;
}

/** Row shape of the columns a room listing needs. */
interface RoomRow {
  id: string;
  project_id: string;
  name: string;
  path: string;
  kind: string;
  pos_x: number;
  pos_z: number;
  agent_count: number;
  /** The account new agents here start on; NULL is the ambient `~/.claude`. */
  account_id: string | null;
  /** `host` | `container`. A hand-edited value folds to `host` — see `asRuntime`. */
  runtime: string;
}

/**
 * The columns a room listing selects, with `r.` qualifiers. One list, used by both statements below,
 * so a column added for the listing cannot be remembered in one and forgotten in the other.
 */
const ROOM_COLUMNS = `
  r.id AS id, r.project_id AS project_id, r.name AS name, r.path AS path, r.kind AS kind,
  r.pos_x AS pos_x, r.pos_z AS pos_z, r.account_id AS account_id, r.runtime AS runtime,
  COUNT(s.id) AS agent_count
`;

/** What `createRoom` may be told beyond the name. */
export interface CreateRoomOptions {
  /** The factory this room stands on. Defaults to the default project. */
  projectId?: string;
  /**
   * The room's working folder, used **as given**. Omitted, the room is `<project root>/<name>` and
   * has to stay inside the root; given, it may point anywhere — a department is allowed to live in a
   * separate repository, and that is the one case where containment does not apply.
   */
  path?: string;
  /**
   * One line for the charter's "Responsibility" section, used **only when the charter is written from
   * scratch**. A folder that already has a `CLAUDE.md` is never touched, whatever this says — the
   * never-overwrite rule is not negotiable, and this is exactly the path an approved onboarding
   * proposal arrives on, where the temptation to "just add a line" would be strongest.
   */
  summary?: string;
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
  private readonly stmts;

  /**
   * `projects` rather than a single root string: a room's default folder is resolved against *its*
   * project's root, and one manager serves every factory on the server.
   */
  constructor(private db: Db, private projects: ProjectManager) {
    this.stmts = {
      insert: db.prepare(
        "INSERT INTO rooms (id, project_id, name, path, kind, pos_x, pos_z) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ),
      // Per project: two factories may each have a room called "backend" (migration 5 made the
      // uniqueness UNIQUE(project_id, name) for exactly this reason).
      byName: db.prepare("SELECT id FROM rooms WHERE project_id = ? AND name = ?"),
      projectRoom: db.prepare(
        "SELECT id FROM rooms WHERE project_id = ? AND kind = 'project' ORDER BY created_at, rowid LIMIT 1",
      ),
      countRooms: db.prepare("SELECT COUNT(*) c FROM rooms WHERE project_id = ? AND kind != 'project'"),
      move: db.prepare("UPDATE rooms SET pos_x = ?, pos_z = ? WHERE id = ?"),
      setPath: db.prepare("UPDATE rooms SET path = ? WHERE id = ?"),
      setAccount: db.prepare("UPDATE rooms SET account_id = ? WHERE id = ?"),
      setRuntime: db.prepare("UPDATE rooms SET runtime = ? WHERE id = ?"),
      // One statement for the whole listing: the agent count is a join, not a query per room, and
      // it is the only thing this class ever asks about sessions.
      list: db.prepare(`
        SELECT ${ROOM_COLUMNS}
        FROM rooms r LEFT JOIN sessions s ON s.room_id = r.id
        WHERE r.project_id = ?
        GROUP BY r.id
        ORDER BY (CASE WHEN r.kind = 'project' THEN 0 ELSE 1 END), r.created_at, r.rowid
      `),
      one: db.prepare(`
        SELECT ${ROOM_COLUMNS}
        FROM rooms r LEFT JOIN sessions s ON s.room_id = r.id
        WHERE r.id = ?
        GROUP BY r.id
      `),
    };
  }

  /**
   * The single central building of one project, standing for its root folder. Idempotent: the row is
   * created once per project and every later call (including after a restart) returns the same one.
   * No folder is created — the root already exists, and writing a charter into it would touch the
   * user's repo.
   */
  ensureProjectRoom(projectId: string = this.defaultProjectId()): RoomInfo {
    const root = this.projects.root(projectId);
    // `!= null`, not `!== undefined`: "no such row" is `null` for the driver db.ts uses.
    const existing = this.stmts.projectRoom.get(projectId) as { id: string } | null;
    if (existing != null) return this.getRoom(existing.id)!;

    const id = randomUUID();
    this.stmts.insert.run(id, projectId, projectRoomName(root), root, "project", 0, 0);
    return this.getRoom(id)!;
  }

  /**
   * Create a room: the folder, its charter, and the row. The folder may already exist (adopting a
   * directory that is already part of the repo is the normal case), in which case only the row is
   * new and an existing `CLAUDE.md` is left exactly as it is.
   *
   * `opts.path` chooses the folder explicitly and is the *only* way past the containment check —
   * see `resolveRoomDir`.
   */
  createRoom(name: string, opts: CreateRoomOptions = {}): RoomInfo {
    const projectId = opts.projectId ?? this.defaultProjectId();
    const dir = this.resolveRoomDir(projectId, name, opts.path);

    if (this.stmts.byName.get(projectId, name) != null) {
      throw new Error(`room ${JSON.stringify(name)} already exists`);
    }

    this.adoptFolder(dir, name, opts.summary);

    const id = randomUUID();
    const pos = ringPosition((this.stmts.countRooms.get(projectId) as { c: number }).c);
    this.stmts.insert.run(id, projectId, name, dir, "room", pos.x, pos.z);
    return this.getRoom(id)!;
  }

  /**
   * Re-point a room at another folder. **Nothing on disk is moved**: this changes where the room *is*,
   * not where its files are, and the operator is the one who knows whether anything needs copying.
   *
   * Agents already running keep the `cwd` their SDK session was started with — the SDK owns a live
   * session's working directory and there is no way to change it under a running query — so only
   * agents created after this call work in the new folder. The UI says so next to the field; a silent
   * half-change would be the worst version of this feature.
   *
   * The project room is refused: its folder *is* the project root, and the two must not disagree.
   */
  setPath(roomId: string, newPath: string): RoomInfo {
    const room = this.getRoom(roomId);
    if (room === undefined) throw new Error(`unknown room ${roomId}`);
    if (room.kind === "project") {
      throw new Error("the project room's folder is the project root; create another project instead");
    }
    const dir = explicitDir(newPath, room.name);
    this.adoptFolder(dir, room.name);
    this.stmts.setPath.run(dir, roomId);
    return this.getRoom(roomId)!;
  }

  /**
   * Bind this room to an account, or to none (`null` = the ambient `~/.claude`).
   *
   * A **default for agents not yet created**, and nothing more: an agent resolves its account once,
   * at creation, and carries it on its own row from then on. Changing it here therefore never moves
   * someone who is already working — the SDK bakes `Options.env` in when `query()` is called, so a
   * live session's `CLAUDE_CONFIG_DIR` cannot be changed at all, and pretending otherwise would mean
   * the panel and the running process disagreeing about which subscription is being spent.
   *
   * The account id is *not* validated here. `WsHub` checks it against `AccountManager` before calling
   * — this class knows nothing about accounts beyond storing an id, and a second copy of that lookup
   * is a second place for it to be wrong.
   */
  setAccount(roomId: string, accountId: string | null): RoomInfo {
    const changed = this.stmts.setAccount.run(accountId, roomId).changes;
    if (changed === 0) throw new Error(`unknown room ${roomId}`);
    return this.getRoom(roomId)!;
  }

  /**
   * Choose whether agents here run on the host or in a container.
   *
   * A **default for the next executor start**, exactly as the room's account is: an agent's runtime
   * is fixed when its `query()` begins — a live session cannot be moved into a container, any more
   * than its `cwd` or its `CLAUDE_CONFIG_DIR` can be changed underneath it — so nobody already
   * working moves. `WsHub` says so out loud rather than leaving the operator to infer it from an
   * agent that did not change.
   *
   * The value is validated here as well as on the wire, because the column has a CHECK and a
   * rejected write would surface as a SQLite constraint error rather than as a sentence.
   */
  setRuntime(roomId: string, runtime: RoomRuntime): RoomInfo {
    const parsed = RoomRuntime.safeParse(runtime);
    if (!parsed.success) throw new Error(`unknown runtime ${JSON.stringify(runtime)}`);
    const changed = this.stmts.setRuntime.run(parsed.data, roomId).changes;
    if (changed === 0) throw new Error(`unknown room ${roomId}`);
    return this.getRoom(roomId)!;
  }

  /** One project's floor: its project room first, then its rooms in creation order. */
  listRooms(projectId: string = this.defaultProjectId()): RoomInfo[] {
    return (this.stmts.list.all(projectId) as RoomRow[]).map(toRoomInfo);
  }

  /** `undefined` for an unknown room: the absent-row shape the rest of the package speaks. */
  getRoom(roomId: string): RoomInfo | undefined {
    const row = this.stmts.one.get(roomId) as RoomRow | null;
    return row == null ? undefined : toRoomInfo(row);
  }

  /**
   * Which factory a room stands on, or `undefined` for an unknown room. Everything that has a room id
   * and needs a project id — the bus stamping a message, the board refusing a foreign room — asks
   * here rather than carrying a project through its own call chain.
   */
  projectOf(roomId: string): string | undefined {
    const row = this.stmts.one.get(roomId) as RoomRow | null;
    return row == null ? undefined : row.project_id;
  }

  /** Move a building on the floor. The layout is persisted, so it survives a reload and a restart. */
  moveRoom(roomId: string, position: ScenePosition): RoomInfo {
    const changed = this.stmts.move.run(position.x, position.z, roomId).changes;
    if (changed === 0) throw new Error(`unknown room ${roomId}`);
    return this.getRoom(roomId)!;
  }

  /**
   * Where a new room's folder is. Two cases, and the difference between them is the point:
   *
   * - **no explicit path** — `<project root>/<name>`, and the resolved directory must stay under the
   *   root. This is the case the traversal check protects and it is not relaxed: `..`, an absolute
   *   name, anything that climbs out is refused.
   * - **an explicit path** — used as given, anywhere on the filesystem. A department may live in a
   *   separate repository, so there is nothing to contain it to; the operator typed a path and the
   *   path is the answer.
   */
  private resolveRoomDir(projectId: string, name: string, explicit: string | undefined): string {
    const root = this.projects.root(projectId);
    if (explicit !== undefined) {
      // The name is still a folder segment (it is the label on the building and has to be usable in
      // a path), so it is checked either way — just not against the root.
      return explicitDir(explicit, name);
    }
    // Containment first, so a traversal attempt is reported as what it is even if it would also
    // fail the name rule. `path.resolve` collapses `..`, so this catches absolute paths too.
    const dir = path.resolve(root, name);
    if (dir !== root && !dir.startsWith(root + path.sep)) {
      throw new Error(`room ${JSON.stringify(name)} resolves outside the project root ${root}`);
    }
    requireRoomName(name);
    if (dir === root) throw new Error(`room ${JSON.stringify(name)} would be the project root itself`);
    return dir;
  }

  /**
   * Make sure the folder is there and has a charter, without ever touching one it already has: a room
   * may be an existing folder with its own `CLAUDE.md`, and that file is the operator's, not ours.
   * A room with no charter at all is worse than a surprising one — it is where an agent learns that
   * it is a department with a bus — so an adopted folder that has none gets ours.
   */
  private adoptFolder(dir: string, name: string, summary?: string): void {
    if (existsSync(dir) && !statSync(dir).isDirectory()) {
      throw new Error(`room folder is not a directory: ${dir}`);
    }
    mkdirSync(dir, { recursive: true });
    const claudeMd = path.join(dir, PROJECT_CHARTER_FILE);
    if (!existsSync(claudeMd)) writeFileSync(claudeMd, charter(name, summary));
  }

  private defaultProjectId(): string {
    return this.projects.defaultProject().id;
  }
}

/** A folder the operator chose by hand: absolute, and named by a usable room name. */
function explicitDir(given: string, name: string): string {
  requireRoomName(name);
  const trimmed = given.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`a room folder must be an absolute path: ${JSON.stringify(given)}`);
  }
  return path.resolve(trimmed);
}

/** A room name is one folder segment, used verbatim. The wire checks it too; this is the second layer. */
function requireRoomName(name: string): void {
  const parsed = RoomName.safeParse(name);
  if (!parsed.success) {
    throw new Error(`invalid room name ${JSON.stringify(name)}: ${parsed.error.issues[0]?.message ?? "rejected"}`);
  }
}

/**
 * The project room's display name is the root's basename. A repository folder is not bound by
 * `RoomName` (it may be capitalised, or hold spaces), but every `RoomInfo` on the wire must be
 * protocol-valid — so an unusable basename is folded into a safe label. The project room's name is
 * only a label anyway: its path is the root, never `root/name`.
 */
function projectRoomName(root: string): string {
  const base = path.basename(root);
  if (RoomName.safeParse(base).success) return base;
  const folded = base.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);
  return RoomName.safeParse(folded).success ? folded : "project";
}

function toRoomInfo(row: RoomRow): RoomInfo {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    position: { x: row.pos_x, z: row.pos_z },
    kind: row.kind === "project" ? "project" : "room",
    agentCount: row.agent_count,
    accountId: row.account_id,
    runtime: asRuntime(row.runtime),
  };
}

/**
 * `rooms.runtime` is a TEXT column, so a hand-edited or downgraded database could hold anything. An
 * unparseable value folds to `host` — the pre-M4 behaviour, and the reading that can never
 * *silently* claim an isolation the operator is not getting. A row that says nothing must not be
 * shown as sandboxed.
 */
function asRuntime(value: string | null | undefined): RoomRuntime {
  const parsed = RoomRuntime.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_ROOM_RUNTIME;
}
