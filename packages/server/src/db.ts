import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { Database } from "bun:sqlite";

/**
 * The only file in the package that names the SQLite driver. Everything else takes a `Db`, so
 * swapping the driver again stays a one-file change (see docs/decisions/0001-bun-runtime-keep-vite.md).
 */
export type Db = Database;

/**
 * A migration step. Plain SQL for everything that can be said in SQL; a function for the one thing
 * that cannot — step 5 has to *decide* which project existing rows belong to, which means reading
 * rows and the environment, and generating an id.
 */
type Migration = string | ((db: Db) => void);

/**
 * Ordered schema migrations. Step `i` takes the database from `user_version = i` to `i + 1`, so
 * `PRAGMA user_version` is always "how many steps have been applied". Rules:
 *
 * - never edit or reorder a shipped step — append a new one instead, or an existing
 *   `.fabrica/fabrica.db` and a fresh one end up with different schemas;
 * - every step is applied inside one transaction together with its version bump, so a crash
 *   mid-migration leaves the file at the previous version rather than half-upgraded.
 *
 * `CREATE TABLE IF NOT EXISTS` is kept in step 1 so databases created before migrations existed
 * (tables present, `user_version` still 0) upgrade cleanly instead of failing on re-create.
 */
const MIGRATIONS: readonly Migration[] = [
  // 1 — M0 baseline: sessions + append-only event log.
  `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      claude_session_id TEXT,
      state TEXT NOT NULL DEFAULT 'active',   -- active | paused | done | error
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    -- No foreign key to sessions(id) on purpose: this is an append-only audit log,
    -- and it must outlive the session row it describes so history survives deletion.
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL DEFAULT (unixepoch()),
      type TEXT NOT NULL,
      payload TEXT NOT NULL,                  -- JSON SessionEvent
      PRIMARY KEY (session_id, seq)
    );
  `,
  // 2 — per-agent autonomy (attended | auto | bypass). Existing rows inherit the product
  // default, so a database written before this column behaves exactly as it did.
  `
    ALTER TABLE sessions ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'auto';
  `,
  // 3 — M1a rooms. A room is a folder under the project root; the row is its identity on the
  // factory floor (position) and the name is the folder segment, hence UNIQUE. `sessions.room_id`
  // is deliberately nullable and without a foreign key: M0 sessions have no room, and a session's
  // history must not be destroyed by whatever happens to a room row.
  `
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'room',   -- project | room
      pos_x REAL NOT NULL DEFAULT 0,
      pos_z REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    ALTER TABLE sessions ADD COLUMN room_id TEXT;
  `,
  // 4 — M3a tasks and the factory bus. Both tables are deliberately free of foreign keys, for the
  // same reason `events` is: a task's card and a message's record must outlive whatever happens to
  // the room or session they name (a deleted room must not erase the history of what it asked for).
  // `tasks.room_id` NULL means unassigned — the orchestrator routes it (M3b).
  // `messages.delivered_at` NULL means "persisted, nobody has carried it yet"; the index is what
  // makes "what is still queued for this room" a lookup rather than a scan of all traffic, and it
  // is the query `FactoryBus.flushRoom` runs at every turn boundary.
  `
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      room_id TEXT,
      agent_id TEXT,
      blocked_on_message_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_room_id TEXT NOT NULL,
      to_room_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      task_id TEXT,
      delivered_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS messages_undelivered ON messages (to_room_id, delivered_at);
  `,
  // 5 — M1b projects. One SuperFabric serves several factories, so everything the operator looks at
  // is scoped by `project_id`: rooms, sessions, tasks and bus messages. See `migrateProjects`.
  migrateProjects,
  // 6 — per-agent model. NULL means "the CLI's own default", which is what every session written
  // before this column ran on — so existing rows keep behaving exactly as they did, and a row only
  // pins a model once someone chooses one. No CHECK and no enum: model ids are Anthropic's release
  // schedule, not our schema (see `ModelId` in the protocol).
  `
    ALTER TABLE sessions ADD COLUMN model TEXT;
  `,
];

/**
 * Migration 5: `projects`, a `project_id` on everything scoped to one, and a backfill.
 *
 * A function rather than SQL for three reasons: the project a pre-M1b database's rows belong to has
 * to be *worked out* (from the central building's folder, or failing that from the environment the
 * server runs in), ids are generated, and `rooms` has to be rebuilt rather than altered — its `name`
 * was globally UNIQUE, and two projects are each allowed a room called "backend".
 *
 * The backfill is what turns an existing `.fabrica/fabrica.db` into a one-project world instead of an
 * empty one: without it every room, agent, task and message in the file would belong to no project
 * and be invisible on every floor. A database with nothing in it gets no project here — boot's
 * `ProjectManager.defaultProject()` creates that one, and seeding a second row from a test's cwd
 * would be a surprise, not a service.
 */
function migrateProjects(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root TEXT NOT NULL UNIQUE,          -- one folder is one factory
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_opened_at INTEGER               -- NULL until a socket has switched to it
    );
  `);

  const legacyId = seedLegacyProject(db);

  // `rooms` is rebuilt, not altered: SQLite cannot drop the inline UNIQUE on `name`, and per-project
  // uniqueness is the whole point — two factories may each have a "backend". `project_id` is NOT NULL
  // here because a room without a floor to stand on is not a room; the other three tables take a
  // nullable column instead, since rebuilding the message and event-adjacent history to tighten a
  // constraint would rewrite the largest tables in the file for no gain.
  db.exec(`
    CREATE TABLE rooms_v5 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'room',
      pos_x REAL NOT NULL DEFAULT 0,
      pos_z REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE (project_id, name)
    );
  `);
  db.prepare(`
    INSERT INTO rooms_v5 (id, project_id, name, path, kind, pos_x, pos_z, created_at)
    SELECT id, ?, name, path, kind, pos_x, pos_z, created_at FROM rooms
  `).run(legacyId);
  db.exec("DROP TABLE rooms");
  db.exec("ALTER TABLE rooms_v5 RENAME TO rooms");

  db.exec(`
    ALTER TABLE sessions ADD COLUMN project_id TEXT;
    ALTER TABLE tasks ADD COLUMN project_id TEXT;
    ALTER TABLE messages ADD COLUMN project_id TEXT;
  `);
  if (legacyId !== null) {
    for (const table of ["sessions", "tasks", "messages"]) {
      db.prepare(`UPDATE ${table} SET project_id = ?`).run(legacyId);
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS sessions_project ON sessions (project_id);
    CREATE INDEX IF NOT EXISTS tasks_project ON tasks (project_id);
    CREATE INDEX IF NOT EXISTS messages_project ON messages (project_id, created_at);
  `);
}

/**
 * The project a pre-M1b database's rows belong to, or `null` when the file holds nothing to assign.
 *
 * The root is taken from the central building's folder when there is one: that row *is* the record of
 * which folder this factory was running on, and it beats the environment — a server started from
 * another directory must not end up with a project whose root does not contain its own rooms. With no
 * central building (an M0-era file: sessions and events only) there is nothing better than the root
 * this process was told about, which is what boot would use anyway.
 */
function seedLegacyProject(db: Db): string | null {
  const counts = ["sessions", "rooms", "tasks", "messages"].map(
    (t) => (db.query(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c,
  );
  if (counts.every((c) => c === 0)) return null;

  const projectRoom = db.query("SELECT path FROM rooms WHERE kind = 'project' ORDER BY created_at, rowid LIMIT 1")
    .get() as { path: string } | null;
  const root = resolve(projectRoom?.path ?? process.env.SUPERFABRIC_PROJECT ?? process.cwd());
  const id = randomUUID();
  db.prepare("INSERT INTO projects (id, name, root) VALUES (?, ?, ?)")
    .run(id, basename(root) || root, root);
  return id;
}

/** Schema version a freshly opened database is brought up to. */
export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(path: string): Db {
  const db = new Database(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

/** Current `PRAGMA user_version`, i.e. how many migration steps this file has seen. */
function userVersion(db: Db): number {
  const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
  return Number(row?.user_version ?? 0);
}

/** Apply every migration the database has not seen yet. Returns the resulting version. */
export function migrate(db: Db): number {
  const from = userVersion(db);
  if (from >= MIGRATIONS.length) return from;
  db.transaction(() => {
    for (let v = from; v < MIGRATIONS.length; v++) {
      const step = MIGRATIONS[v]!;
      if (typeof step === "string") db.exec(step);
      else step(db);
      // PRAGMA takes a literal, not a bound parameter; `v + 1` is a loop counter, not user input.
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
  })();
  return MIGRATIONS.length;
}
