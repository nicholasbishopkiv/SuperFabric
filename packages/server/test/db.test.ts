import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { SCHEMA_VERSION, openDb } from "../src/db.js";

// `bun:sqlite` has no `db.pragma()` helper — a pragma is read as an ordinary one-row query.
const userVersion = (db: Database): number =>
  (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
const journalMode = (db: Database): string =>
  (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;

describe("db", () => {
  it("creates the sessions and events tables", () => {
    const db = openDb(":memory:");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    expect(tables.map(t => t.name)).toEqual(expect.arrayContaining(["events", "sessions"]));
  });

  it("enables WAL journaling for file-backed databases", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-db-"));
    try {
      const db = openDb(join(dir, "test.db"));
      expect(journalMode(db)).toBe("wal");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves in-memory databases on their default journal mode", () => {
    const db = openDb(":memory:");
    expect(journalMode(db)).toBe("memory");
  });

  it("stamps a fresh database with the current schema version", () => {
    const db = openDb(":memory:");
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it("is idempotent: reopening an up-to-date database changes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-db-"));
    try {
      const path = join(dir, "test.db");
      const first = openDb(path);
      first.prepare("INSERT INTO sessions (id, cwd) VALUES (?, ?)").run("s1", "/tmp");
      first.close();
      const second = openDb(path);
      expect(userVersion(second)).toBe(SCHEMA_VERSION);
      expect((second.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c).toBe(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates a pre-migrations database and preserves its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-db-old-"));
    try {
      const path = join(dir, "old.db");
      // An old-shape file: v0 tables created by hand, user_version never stamped.
      const old = new Database(path);
      old.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, claude_session_id TEXT,
          state TEXT NOT NULL DEFAULT 'active', cwd TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE events (
          session_id TEXT NOT NULL, seq INTEGER NOT NULL,
          ts INTEGER NOT NULL DEFAULT (unixepoch()),
          type TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (session_id, seq)
        );
      `);
      old.exec("PRAGMA user_version = 0");
      old.prepare("INSERT INTO sessions (id, cwd) VALUES (?, ?)").run("legacy", "/legacy/cwd");
      old.prepare("INSERT INTO events (session_id, seq, type, payload) VALUES (?, ?, ?, ?)")
        .run("legacy", 1, "agent_text", JSON.stringify({ type: "agent_text", text: "from before" }));
      old.close();

      const db = openDb(path);
      expect(userVersion(db)).toBe(SCHEMA_VERSION);
      expect(db.prepare("SELECT cwd FROM sessions WHERE id = 'legacy'").get()).toEqual({ cwd: "/legacy/cwd" });
      expect((db.prepare("SELECT payload FROM events WHERE session_id='legacy' AND seq=1").get() as { payload: string }).payload)
        .toContain("from before");
      // migration 2: the pre-existing row inherits the product default instead of a NULL
      expect(db.prepare("SELECT autonomy FROM sessions WHERE id = 'legacy'").get()).toEqual({ autonomy: "auto" });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- migration 2: per-agent autonomy ----

  it("adds sessions.autonomy defaulting to 'auto'", () => {
    const db = openDb(":memory:");
    const cols = db.prepare("SELECT name, \"notnull\", dflt_value FROM pragma_table_info('sessions')")
      .all() as { name: string; notnull: number; dflt_value: string | null }[];
    const autonomy = cols.find(c => c.name === "autonomy");
    expect(autonomy).toBeDefined();
    expect(autonomy!.notnull).toBe(1);
    expect(autonomy!.dflt_value).toBe("'auto'");
    // an insert that says nothing about autonomy lands on the default
    db.prepare("INSERT INTO sessions (id, cwd) VALUES (?, ?)").run("s1", "/tmp");
    expect(db.prepare("SELECT autonomy FROM sessions WHERE id = 's1'").get()).toEqual({ autonomy: "auto" });
  });

  it("preserves an explicitly stored autonomy across a reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-db-autonomy-"));
    try {
      const path = join(dir, "test.db");
      const first = openDb(path);
      first.prepare("INSERT INTO sessions (id, cwd, autonomy) VALUES (?, ?, ?)").run("s1", "/tmp", "bypass");
      first.close();
      const second = openDb(path);
      expect(second.prepare("SELECT autonomy FROM sessions WHERE id = 's1'").get()).toEqual({ autonomy: "bypass" });
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- migration 3: rooms ----

  it("creates the rooms table with a unique name and origin-defaulted position", () => {
    const db = openDb(":memory:");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map(t => t.name)).toContain("rooms");

    db.prepare("INSERT INTO rooms (id, name, path) VALUES (?, ?, ?)").run("r1", "backend", "/p/backend");
    expect(db.prepare("SELECT kind, pos_x, pos_z FROM rooms WHERE id = 'r1'").get())
      .toEqual({ kind: "room", pos_x: 0, pos_z: 0 });
    // one folder, one room: the name is the folder segment, so it cannot repeat
    expect(() => db.prepare("INSERT INTO rooms (id, name, path) VALUES (?, ?, ?)").run("r2", "backend", "/other"))
      .toThrow(/UNIQUE/);
  });

  it("upgrades a user_version = 2 database to rooms + sessions.room_id, keeping its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-db-v2-"));
    try {
      const path = join(dir, "v2.db");
      // A database exactly as migration 2 left it.
      const v2 = new Database(path);
      v2.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, claude_session_id TEXT,
          state TEXT NOT NULL DEFAULT 'active', cwd TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          autonomy TEXT NOT NULL DEFAULT 'auto'
        );
        CREATE TABLE events (
          session_id TEXT NOT NULL, seq INTEGER NOT NULL,
          ts INTEGER NOT NULL DEFAULT (unixepoch()),
          type TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (session_id, seq)
        );
      `);
      v2.exec("PRAGMA user_version = 2");
      v2.prepare("INSERT INTO sessions (id, cwd, autonomy) VALUES (?, ?, ?)").run("m0", "/m0/cwd", "bypass");
      v2.prepare("INSERT INTO events (session_id, seq, type, payload) VALUES (?, ?, ?, ?)")
        .run("m0", 1, "agent_text", JSON.stringify({ type: "agent_text", text: "from M0" }));
      v2.close();

      const db = openDb(path);
      expect(userVersion(db)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3);

      // the M0 session survived intact, and is roomless
      expect(db.prepare("SELECT cwd, autonomy, room_id FROM sessions WHERE id = 'm0'").get())
        .toEqual({ cwd: "/m0/cwd", autonomy: "bypass", room_id: null });
      expect((db.prepare("SELECT payload FROM events WHERE session_id='m0' AND seq=1").get() as { payload: string }).payload)
        .toContain("from M0");
      // and rooms are now available to fill
      db.prepare("INSERT INTO rooms (id, name, path, kind) VALUES (?, ?, ?, ?)")
        .run("r1", "backend", "/m0/backend", "room");
      db.prepare("UPDATE sessions SET room_id = ? WHERE id = 'm0'").run("r1");
      expect(db.prepare("SELECT room_id FROM sessions WHERE id = 'm0'").get()).toEqual({ room_id: "r1" });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
