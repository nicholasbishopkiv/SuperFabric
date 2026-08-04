import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { ProjectInfo } from "@superfabric/shared";
import type { Db } from "./db.js";

/** Row shape of `projects`. */
interface ProjectRow {
  id: string;
  name: string;
  root: string;
  last_opened_at: number | null;
}

export interface CreateProjectOptions {
  /** Absolute path of an existing directory. */
  root: string;
  /** Display label. Defaults to the root's basename. */
  name?: string;
}

/**
 * Projects as first-class objects: one row per factory floor, and the scope every other listing in
 * the server is filtered by. `SUPERFABRIC_PROJECT ?? cwd` seeds the first one and stops being the
 * only one that can exist.
 *
 * Two things it deliberately does *not* do. It never creates a directory: a project root is the
 * operator's own repository, and "I mistyped the path" must be an error rather than an empty folder
 * appearing somewhere in their home directory. And it never deletes: nothing in M1b removes a
 * project, and a delete that left rooms, sessions and history pointing at a missing row would be a
 * worse state than any it fixed.
 */
export class ProjectManager {
  /** The root the server was started on: `defaultProject()` is the project for this folder. */
  private readonly defaultRoot: string;
  private readonly now: () => number;
  private readonly stmts;

  constructor(private db: Db, defaultRoot: string, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.defaultRoot = path.resolve(defaultRoot);
    this.now = now;
    this.stmts = {
      insert: db.prepare("INSERT INTO projects (id, name, root) VALUES (?, ?, ?)"),
      one: db.prepare("SELECT id, name, root, last_opened_at FROM projects WHERE id = ?"),
      byRoot: db.prepare("SELECT id, name, root, last_opened_at FROM projects WHERE root = ?"),
      // Creation order, not last-opened order: a switcher whose entries reshuffle every time you use
      // it is a switcher you have to re-read every time you use it.
      list: db.prepare("SELECT id, name, root, last_opened_at FROM projects ORDER BY created_at, rowid"),
      touch: db.prepare("UPDATE projects SET last_opened_at = ? WHERE id = ?"),
      lastOpened: db.prepare(`
        SELECT id, name, root, last_opened_at FROM projects
        WHERE last_opened_at IS NOT NULL
        ORDER BY last_opened_at DESC, rowid DESC LIMIT 1
      `),
    };
  }

  /**
   * Add a project. The root has to be an absolute path to a directory that already exists, and no
   * other project may claim it: two factories on one folder would share rooms on disk while
   * disagreeing about which floor they stand on.
   */
  create(opts: CreateProjectOptions): ProjectInfo {
    const given = opts.root.trim();
    if (!path.isAbsolute(given)) {
      throw new Error(`project root must be an absolute path: ${JSON.stringify(opts.root)}`);
    }
    const root = path.resolve(given);

    let isDir = false;
    try { isDir = statSync(root).isDirectory(); }
    catch { throw new Error(`project root does not exist: ${root}`); }
    if (!isDir) throw new Error(`project root is not a directory: ${root}`);

    // `== null`, not `=== undefined`: "no such row" is `null` for the driver db.ts uses.
    if (this.stmts.byRoot.get(root) != null) {
      throw new Error(`a project already exists for ${root}`);
    }

    const name = (opts.name ?? "").trim() || path.basename(root) || root;
    const id = randomUUID();
    // Validate through the protocol's own shape: what the store accepts and what the wire accepts
    // are the same thing, and only one of them should own the limits.
    const draft = ProjectInfo.parse({ id, name, root, lastOpenedAt: null });
    this.stmts.insert.run(draft.id, draft.name, draft.root);
    return draft;
  }

  /** Every project, in creation order. */
  list(): ProjectInfo[] {
    return (this.stmts.list.all() as ProjectRow[]).map(toProjectInfo);
  }

  /** `undefined` for an unknown id — the absent-row shape the rest of the package speaks. */
  get(id: string): ProjectInfo | undefined {
    const row = this.stmts.one.get(id) as ProjectRow | null;
    return row == null ? undefined : toProjectInfo(row);
  }

  /**
   * The project registered for a folder, or `undefined` when none is.
   *
   * One folder is one factory (`projects.root` is UNIQUE), so this is how a caller holding a path
   * rather than an id — importing a factory into a root the operator typed — finds out whether it is
   * adopting an existing floor or creating one. The path is resolved first, so `/a/b`, `/a/b/` and
   * `/a/./b` are the one folder they are.
   */
  byRoot(root: string): ProjectInfo | undefined {
    const row = this.stmts.byRoot.get(path.resolve(root.trim())) as ProjectRow | null;
    return row == null ? undefined : toProjectInfo(row);
  }

  /** The same, as an assertion: callers that must have a project say so once, here. */
  require(id: string): ProjectInfo {
    const project = this.get(id);
    if (project === undefined) throw new Error(`unknown project ${id}`);
    return project;
  }

  /** A project's root folder — what `RoomManager` resolves a default room folder against. */
  root(id: string): string {
    return this.require(id).root;
  }

  /** Switch to a project: stamps `last_opened_at`, which is what a fresh tab lands on. */
  open(id: string): ProjectInfo {
    this.require(id);
    this.stmts.touch.run(this.now(), id);
    return this.get(id)!;
  }

  /**
   * The project for the root this server was started on, created if it is not there yet. Idempotent,
   * and the fallback scope for every listing whose caller does not name a project — a single-project
   * caller (boot, a test) should not have to know that projects exist.
   */
  defaultProject(): ProjectInfo {
    const existing = this.stmts.byRoot.get(this.defaultRoot) as ProjectRow | null;
    if (existing != null) return toProjectInfo(existing);
    return this.create({ root: this.defaultRoot });
  }

  /**
   * The project a newly attached socket should be looking at: the one most recently opened, falling
   * back to the boot project. Reloading a tab therefore returns the operator to the factory they were
   * in, rather than to whichever folder the server happened to be started from.
   */
  lastOpened(): ProjectInfo {
    const row = this.stmts.lastOpened.get() as ProjectRow | null;
    return row == null ? this.defaultProject() : toProjectInfo(row);
  }
}

function toProjectInfo(row: ProjectRow): ProjectInfo {
  return ProjectInfo.parse({
    id: row.id,
    name: row.name,
    root: row.root,
    lastOpenedAt: row.last_opened_at,
  });
}
