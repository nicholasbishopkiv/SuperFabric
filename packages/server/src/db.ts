import { Database } from "bun:sqlite";

/**
 * The only file in the package that names the SQLite driver. Everything else takes a `Db`, so
 * swapping the driver again stays a one-file change (see docs/decisions/0001-bun-runtime-keep-vite.md).
 */
export type Db = Database;

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
const MIGRATIONS: readonly string[] = [
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
];

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
      db.exec(MIGRATIONS[v]!);
      // PRAGMA takes a literal, not a bound parameter; `v + 1` is a loop counter, not user input.
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
  })();
  return MIGRATIONS.length;
}
