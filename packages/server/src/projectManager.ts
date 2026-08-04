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

/** What a `ProjectManager` needs to know beyond its tables. */
export interface ProjectManagerOptions {
  /**
   * Whether this server **seeds** `defaultRoot` at boot — i.e. whether the operator set
   * `SUPERFABRIC_PROJECT`.
   *
   * Only `remove` reads it, and only to decide whether deleting that project would undo itself: a
   * root the next boot re-creates cannot honestly be removed from a switcher. Default `false`,
   * because a server started without that variable no longer invents a project from its own working
   * directory at all — so there is nothing that would come back.
   */
  reseedsDefaultRoot?: boolean;
}

/**
 * Projects as first-class objects: one row per factory floor, and the scope every other listing in
 * the server is filtered by.
 *
 * **A server may have none, and that is the state a fresh one starts in.** Nothing is seeded from the
 * directory the server happens to run in; `SUPERFABRIC_PROJECT` seeds one because that is somebody
 * saying it. Everything else is the operator pointing the UI at a folder.
 *
 * It never creates a directory: a project root is the operator's own repository, and "I mistyped the
 * path" must be an error rather than an empty folder appearing somewhere in their home directory.
 * Removing one deletes the *row* and nothing on disk, for the same reason — see `remove`, and
 * `Demolition` for the cascade that has to run first.
 */
export class ProjectManager {
  /** The root the server was started on: `defaultProject()` is the project for this folder. */
  private readonly defaultRoot: string;
  private readonly now: () => number;
  private readonly reseeds: boolean;
  private readonly stmts;

  constructor(
    private db: Db,
    defaultRoot: string,
    now: () => number = () => Math.floor(Date.now() / 1000),
    opts: ProjectManagerOptions = {},
  ) {
    this.defaultRoot = path.resolve(defaultRoot);
    this.now = now;
    this.reseeds = opts.reseedsDefaultRoot === true;
    this.stmts = {
      insert: db.prepare("INSERT INTO projects (id, name, root) VALUES (?, ?, ?)"),
      one: db.prepare("SELECT id, name, root, last_opened_at FROM projects WHERE id = ?"),
      byRoot: db.prepare("SELECT id, name, root, last_opened_at FROM projects WHERE root = ?"),
      // Creation order, not last-opened order: a switcher whose entries reshuffle every time you use
      // it is a switcher you have to re-read every time you use it.
      list: db.prepare("SELECT id, name, root, last_opened_at FROM projects ORDER BY created_at, rowid"),
      touch: db.prepare("UPDATE projects SET last_opened_at = ? WHERE id = ?"),
      remove: db.prepare("DELETE FROM projects WHERE id = ?"),
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

  /**
   * Remove a factory from the switcher. **The row, never the folder** — a project root is the
   * operator's repository and this feature does not delete repositories.
   *
   * One refusal, and it is about a delete that would not stay done: a server told to seed a root
   * (`SUPERFABRIC_PROJECT`) re-creates that project on the next boot, so removing it would look like
   * it worked and then quietly come back. Nothing else is protected — **removing the last factory is
   * allowed**, because "no factory yet" is a real state this server starts in and knows how to show.
   *
   * Everything the project *contains* is somebody else's to remove first — see `Demolition`. This
   * deletes a row whose dependents are already gone.
   */
  remove(id: string): ProjectInfo {
    const project = this.requireDeletable(id);
    this.stmts.remove.run(id);
    return project;
  }

  /**
   * The project, or a throw saying why it may not be removed.
   *
   * Separate from `remove` for the same reason `RoomManager.requireDeletable` is: the cascade that
   * empties a factory has to be able to refuse **before** it starts stopping agents, not after.
   */
  requireDeletable(id: string): ProjectInfo {
    const project = this.require(id);
    // Only when this server actually re-seeds that root — i.e. the operator set
    // `SUPERFABRIC_PROJECT`. Without it nothing is seeded at all, so every project is one somebody
    // asked for and every one of them can be removed again.
    if (this.reseeds && project.root === this.defaultRoot) {
      throw new Error(
        `${project.name} is the folder SUPERFABRIC_PROJECT points at, so this server re-creates it on `
        + "every boot — unset that variable (or point it elsewhere) rather than deleting it here",
      );
    }
    return project;
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
   * The project for `defaultRoot`, created if it is not there yet.
   *
   * **Boot no longer calls this.** SuperFabric used to open with a factory invented from whatever
   * directory the server happened to be started in, which on a first run meant a factory over its own
   * source tree — one nobody asked for and, once deletion existed, one that came back every boot. A
   * project root is the operator's repository and picking it is the first real decision they make, so
   * the server asks instead of guessing (see `index.ts`, and `ProjectInfo`/`activeProjectId` on the
   * wire for what an empty server looks like).
   *
   * What it still is: the answer for an explicit `SUPERFABRIC_PROJECT`, and the fallback scope for a
   * caller that names no project — a single-project caller (a test) should not have to know that
   * projects exist. Idempotent either way.
   */
  defaultProject(): ProjectInfo {
    const existing = this.stmts.byRoot.get(this.defaultRoot) as ProjectRow | null;
    if (existing != null) return toProjectInfo(existing);
    return this.create({ root: this.defaultRoot });
  }

  /**
   * The project a newly attached socket should be looking at: the one most recently opened, else the
   * oldest one there is, else **`undefined`** — a server with no factory yet.
   *
   * Reloading a tab returns the operator to the factory they were in rather than to whichever folder
   * the server was started from. It deliberately **creates nothing**: this runs on every socket
   * attaching, and a listing that seeds a project as a side effect of someone opening a browser tab
   * is how the invented-from-cwd factory got in in the first place.
   */
  lastOpened(): ProjectInfo | undefined {
    const row = this.stmts.lastOpened.get() as ProjectRow | null;
    if (row != null) return toProjectInfo(row);
    return this.list()[0];
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
