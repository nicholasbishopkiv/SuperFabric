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

  it("creates the rooms table with a per-project unique name and origin-defaulted position", () => {
    const db = openDb(":memory:");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map(t => t.name)).toContain("rooms");

    const insert = db.prepare("INSERT INTO rooms (id, project_id, name, path) VALUES (?, ?, ?, ?)");
    insert.run("r1", "p1", "backend", "/p1/backend");
    expect(db.prepare("SELECT kind, pos_x, pos_z FROM rooms WHERE id = 'r1'").get())
      .toEqual({ kind: "room", pos_x: 0, pos_z: 0 });
    // one folder, one room: within a project the name is the folder segment, so it cannot repeat
    expect(() => insert.run("r2", "p1", "backend", "/p1/other")).toThrow(/UNIQUE/);
    // but two factories may each have a "backend" — migration 5 moved the uniqueness onto the pair
    insert.run("r3", "p2", "backend", "/p2/backend");
    expect((db.prepare("SELECT COUNT(*) c FROM rooms WHERE name = 'backend'").get() as { c: number }).c).toBe(2);
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
      // and rooms are now available to fill (migration 5 added the project they stand on)
      db.prepare("INSERT INTO rooms (id, project_id, name, path, kind) VALUES (?, ?, ?, ?, ?)")
        .run("r1", "p1", "backend", "/m0/backend", "room");
      db.prepare("UPDATE sessions SET room_id = ? WHERE id = 'm0'").run("r1");
      expect(db.prepare("SELECT room_id FROM sessions WHERE id = 'm0'").get()).toEqual({ room_id: "r1" });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- migration 4: tasks and bus messages ----

  it("creates the tasks table with an unassigned, open default shape", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO tasks (id, title) VALUES (?, ?)").run("t1", "Expose a webhook");
    expect(db.prepare("SELECT detail, status, room_id, agent_id, blocked_on_message_id FROM tasks WHERE id = 't1'").get())
      .toEqual({ detail: "", status: "open", room_id: null, agent_id: null, blocked_on_message_id: null });
    const row = db.prepare("SELECT created_at, updated_at FROM tasks WHERE id = 't1'").get() as
      { created_at: number; updated_at: number };
    expect(row.created_at).toBeGreaterThan(0);
    expect(row.updated_at).toBeGreaterThan(0);
  });

  it("creates the messages table with delivered_at nullable and an undelivered index", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO messages (id, from_room_id, to_room_id, kind, body) VALUES (?, ?, ?, ?, ?)")
      .run("m1", "r1", "r2", "request", "please expose a webhook");
    expect(db.prepare("SELECT task_id, delivered_at FROM messages WHERE id = 'm1'").get())
      .toEqual({ task_id: null, delivered_at: null });

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'")
      .all() as { name: string }[];
    expect(indexes.map(i => i.name)).toContain("messages_undelivered");
    // the undelivered lookup is the one the bus runs at every turn boundary, so it must be indexed
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM messages WHERE to_room_id = ? AND delivered_at IS NULL")
      .all("r2") as { detail: string }[];
    expect(plan.map(p => p.detail).join(" ")).toContain("messages_undelivered");
  });

  it("upgrades a user_version = 3 database to tasks + messages, keeping its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-db-v3-"));
    try {
      const path = join(dir, "v3.db");
      // A database exactly as migration 3 left it.
      const v3 = new Database(path);
      v3.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, claude_session_id TEXT,
          state TEXT NOT NULL DEFAULT 'active', cwd TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          autonomy TEXT NOT NULL DEFAULT 'auto', room_id TEXT
        );
        CREATE TABLE events (
          session_id TEXT NOT NULL, seq INTEGER NOT NULL,
          ts INTEGER NOT NULL DEFAULT (unixepoch()),
          type TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (session_id, seq)
        );
        CREATE TABLE rooms (
          id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'room',
          pos_x REAL NOT NULL DEFAULT 0, pos_z REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `);
      v3.exec("PRAGMA user_version = 3");
      v3.prepare("INSERT INTO rooms (id, name, path) VALUES (?, ?, ?)").run("r1", "payments", "/m1/payments");
      v3.prepare("INSERT INTO sessions (id, cwd, room_id) VALUES (?, ?, ?)").run("m1", "/m1/payments", "r1");
      v3.close();

      const db = openDb(path);
      expect(userVersion(db)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(4);

      // the M1a room and its agent survived intact
      expect(db.prepare("SELECT room_id FROM sessions WHERE id = 'm1'").get()).toEqual({ room_id: "r1" });
      expect(db.prepare("SELECT name FROM rooms WHERE id = 'r1'").get()).toEqual({ name: "payments" });
      // and the new tables are there to fill
      db.prepare("INSERT INTO tasks (id, title, room_id) VALUES (?, ?, ?)").run("t1", "Expose a webhook", "r1");
      db.prepare("INSERT INTO messages (id, from_room_id, to_room_id, kind, body, task_id) VALUES (?, ?, ?, ?, ?, ?)")
        .run("m1", "r1", "r1", "request", "body", "t1");
      expect((db.prepare("SELECT COUNT(*) c FROM tasks").get() as { c: number }).c).toBe(1);
      expect((db.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number }).c).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- migration 5: projects ----

  /**
   * A database exactly as migration 4 left it, optionally holding a whole M3a factory. This is the
   * shape of the `.fabrica/fabrica.db` an operator already has, so the upgrade has to be tested
   * against it rather than against a fresh file.
   */
  function writeV4(path: string, fill?: (db: Database) => void): void {
    const v4 = new Database(path);
    v4.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, claude_session_id TEXT,
        state TEXT NOT NULL DEFAULT 'active', cwd TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        autonomy TEXT NOT NULL DEFAULT 'auto', room_id TEXT
      );
      CREATE TABLE events (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL,
        ts INTEGER NOT NULL DEFAULT (unixepoch()),
        type TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'room',
        pos_x REAL NOT NULL DEFAULT 0, pos_z REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open', room_id TEXT, agent_id TEXT,
        blocked_on_message_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, from_room_id TEXT NOT NULL, to_room_id TEXT NOT NULL,
        kind TEXT NOT NULL, body TEXT NOT NULL, task_id TEXT, delivered_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX messages_undelivered ON messages (to_room_id, delivered_at);
    `);
    v4.exec("PRAGMA user_version = 4");
    fill?.(v4);
    v4.close();
  }

  it("creates the projects table with a unique root and a nullable last_opened_at", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (id, name, root) VALUES (?, ?, ?)").run("p1", "shop", "/code/shop");
    expect(db.prepare("SELECT name, last_opened_at FROM projects WHERE id = 'p1'").get())
      .toEqual({ name: "shop", last_opened_at: null });
    // one folder is one factory
    expect(() => db.prepare("INSERT INTO projects (id, name, root) VALUES (?, ?, ?)").run("p2", "again", "/code/shop"))
      .toThrow(/UNIQUE/);
  });

  it("leaves a fresh database with no project at all", () => {
    // Nothing to backfill means nothing to invent: boot's ProjectManager.defaultProject() creates
    // the first project, and a migration seeding one from a test's cwd would be a surprise.
    const db = openDb(":memory:");
    expect((db.prepare("SELECT COUNT(*) c FROM projects").get() as { c: number }).c).toBe(0);
    for (const table of ["sessions", "tasks", "messages"]) {
      const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[];
      expect(cols.map(c => c.name)).toContain("project_id");
    }
  });

  it("upgrades an existing factory into a one-project world, backfilling every row", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-db-v4-"));
    try {
      const path = join(dir, "v4.db");
      writeV4(path, (v4) => {
        // The central building records the folder this factory was running on.
        v4.prepare("INSERT INTO rooms (id, name, path, kind) VALUES (?, ?, ?, ?)")
          .run("root", "shop", "/code/shop", "project");
        v4.prepare("INSERT INTO rooms (id, name, path) VALUES (?, ?, ?)").run("r1", "payments", "/code/shop/payments");
        v4.prepare("INSERT INTO sessions (id, cwd, room_id) VALUES (?, ?, ?)").run("s1", "/code/shop/payments", "r1");
        v4.prepare("INSERT INTO sessions (id, cwd) VALUES (?, ?)").run("s0", "/code/shop");
        v4.prepare("INSERT INTO tasks (id, title, room_id) VALUES (?, ?, ?)").run("t1", "Expose a webhook", "r1");
        v4.prepare("INSERT INTO messages (id, from_room_id, to_room_id, kind, body) VALUES (?, ?, ?, ?, ?)")
          .run("m1", "root", "r1", "request", "please expose a webhook");
      });

      const db = openDb(path);
      expect(userVersion(db)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(5);

      // exactly one project, named and rooted after the central building's folder — not after the
      // directory this test process happens to be running in
      const projects = db.prepare("SELECT id, name, root FROM projects").all() as
        { id: string; name: string; root: string }[];
      expect(projects).toHaveLength(1);
      expect(projects[0]!).toMatchObject({ name: "shop", root: "/code/shop" });
      const pid = projects[0]!.id;

      // and every row that existed now stands on it, including the roomless M0 session
      for (const [table, ids] of [
        ["rooms", ["root", "r1"]], ["sessions", ["s0", "s1"]], ["tasks", ["t1"]], ["messages", ["m1"]],
      ] as const) {
        for (const id of ids) {
          expect(db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(id))
            .toEqual({ project_id: pid });
        }
      }
      // the rest of each row survived the rooms rebuild
      expect(db.prepare("SELECT name, path, kind, pos_x FROM rooms WHERE id = 'r1'").get())
        .toEqual({ name: "payments", path: "/code/shop/payments", kind: "room", pos_x: 0 });
      expect(db.prepare("SELECT cwd, room_id FROM sessions WHERE id = 's1'").get())
        .toEqual({ cwd: "/code/shop/payments", room_id: "r1" });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to SUPERFABRIC_PROJECT for a file with no central building", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-db-v4-m0-"));
    const previous = process.env.SUPERFABRIC_PROJECT;
    try {
      const path = join(dir, "v4.db");
      // An M0-era file: sessions and events, no rooms at all, so there is nothing on disk that
      // records which folder this was. The environment the server runs in is the only answer left.
      writeV4(path, (v4) => {
        v4.prepare("INSERT INTO sessions (id, cwd) VALUES (?, ?)").run("s0", "/somewhere");
      });
      process.env.SUPERFABRIC_PROJECT = "/code/from-env";

      const db = openDb(path);
      expect(db.prepare("SELECT name, root FROM projects").get())
        .toEqual({ name: "from-env", root: "/code/from-env" });
      db.close();
    } finally {
      if (previous === undefined) delete process.env.SUPERFABRIC_PROJECT;
      else process.env.SUPERFABRIC_PROJECT = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- migration 6: per-agent model ----

  it("adds a nullable sessions.model, because NULL is the CLI's own default", () => {
    const db = openDb(":memory:");
    const cols = db.prepare("SELECT name, \"notnull\", dflt_value FROM pragma_table_info('sessions')")
      .all() as { name: string; notnull: number; dflt_value: string | null }[];
    const model = cols.find(c => c.name === "model");
    expect(model).toBeDefined();
    // Not NOT NULL and no default: "no model was chosen" is a real state, and it is not the same
    // fact as "this agent runs on <whatever we would have written here>".
    expect(model!.notnull).toBe(0);
    expect(model!.dflt_value).toBeNull();
    db.prepare("INSERT INTO sessions (id, cwd) VALUES (?, ?)").run("s1", "/tmp");
    expect(db.prepare("SELECT model FROM sessions WHERE id = 's1'").get()).toEqual({ model: null });
  });

  it("keeps a chosen model across a reopen, which is what resume re-applies", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-db-model-"));
    try {
      const path = join(dir, "test.db");
      const first = openDb(path);
      first.prepare("INSERT INTO sessions (id, cwd, model) VALUES (?, ?, ?)")
        .run("s1", "/tmp", "claude-haiku-4-5");
      first.close();
      const second = openDb(path);
      expect(second.prepare("SELECT model FROM sessions WHERE id = 's1'").get())
        .toEqual({ model: "claude-haiku-4-5" });
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upgrades a user_version = 5 database, leaving its agents on the default model", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-db-v5-"));
    try {
      const path = join(dir, "v5.db");
      // A database exactly as migration 5 left it.
      const v5 = new Database(path);
      v5.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, claude_session_id TEXT,
          state TEXT NOT NULL DEFAULT 'active', cwd TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          autonomy TEXT NOT NULL DEFAULT 'auto', room_id TEXT, project_id TEXT
        );
        CREATE TABLE events (
          session_id TEXT NOT NULL, seq INTEGER NOT NULL,
          ts INTEGER NOT NULL DEFAULT (unixepoch()),
          type TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (session_id, seq)
        );
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()), last_opened_at INTEGER
        );
        CREATE TABLE rooms (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'room',
          pos_x REAL NOT NULL DEFAULT 0, pos_z REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE (project_id, name)
        );
      `);
      v5.exec("PRAGMA user_version = 5");
      v5.prepare("INSERT INTO projects (id, name, root) VALUES (?, ?, ?)").run("p1", "shop", "/code/shop");
      v5.prepare("INSERT INTO rooms (id, project_id, name, path) VALUES (?, ?, ?, ?)")
        .run("r1", "p1", "payments", "/code/shop/payments");
      v5.prepare("INSERT INTO sessions (id, cwd, autonomy, room_id, project_id) VALUES (?, ?, ?, ?, ?)")
        .run("s1", "/code/shop/payments", "bypass", "r1", "p1");
      v5.close();

      const db = openDb(path);
      expect(userVersion(db)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
      // The existing agent is untouched and pinned to nothing: it ran on the CLI's default before
      // this column existed, and it must go on doing exactly that.
      expect(db.prepare("SELECT autonomy, room_id, project_id, model FROM sessions WHERE id = 's1'").get())
        .toEqual({ autonomy: "bypass", room_id: "r1", project_id: "p1", model: null });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- migration 7: the orchestrator flag ----

  it("adds sessions.is_orchestrator, defaulting every existing agent to 'ordinary'", () => {
    const db = openDb(":memory:");
    const cols = db.prepare("SELECT name, \"notnull\", dflt_value FROM pragma_table_info('sessions')")
      .all() as { name: string; notnull: number; dflt_value: string | null }[];
    const flag = cols.find(c => c.name === "is_orchestrator");
    expect(flag).toBeDefined();
    expect(flag!.notnull).toBe(1);
    expect(flag!.dflt_value).toBe("0");
    // an insert that says nothing about the role creates an ordinary agent
    db.prepare("INSERT INTO sessions (id, cwd) VALUES (?, ?)").run("s1", "/tmp");
    expect(db.prepare("SELECT is_orchestrator FROM sessions WHERE id = 's1'").get())
      .toEqual({ is_orchestrator: 0 });
  });

  it("indexes 'does this factory have an orchestrator', which routing asks per task", () => {
    const db = openDb(":memory:");
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'")
      .all() as { name: string }[]).map(i => i.name);
    expect(indexes).toContain("sessions_orchestrator");
    const plan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM sessions WHERE project_id = ? AND is_orchestrator = 1",
    ).all("p1") as { detail: string }[];
    expect(plan.map(p => p.detail).join(" ")).toMatch(/sessions_orchestrator|sessions_project/);
  });

  it("upgrades a user_version = 6 database, leaving every agent an ordinary one", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-db-v6-"));
    try {
      const path = join(dir, "v6.db");
      // A database exactly as migration 6 left it.
      const v6 = new Database(path);
      v6.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, claude_session_id TEXT,
          state TEXT NOT NULL DEFAULT 'active', cwd TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          autonomy TEXT NOT NULL DEFAULT 'auto', room_id TEXT, project_id TEXT, model TEXT
        );
        CREATE TABLE events (
          session_id TEXT NOT NULL, seq INTEGER NOT NULL,
          ts INTEGER NOT NULL DEFAULT (unixepoch()),
          type TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (session_id, seq)
        );
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()), last_opened_at INTEGER
        );
        CREATE TABLE rooms (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'room',
          pos_x REAL NOT NULL DEFAULT 0, pos_z REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE (project_id, name)
        );
      `);
      v6.exec("PRAGMA user_version = 6");
      v6.prepare("INSERT INTO projects (id, name, root) VALUES (?, ?, ?)").run("p1", "shop", "/code/shop");
      v6.prepare("INSERT INTO rooms (id, project_id, name, path) VALUES (?, ?, ?, ?)")
        .run("r1", "p1", "payments", "/code/shop/payments");
      v6.prepare("INSERT INTO sessions (id, cwd, autonomy, room_id, project_id, model) VALUES (?, ?, ?, ?, ?, ?)")
        .run("s1", "/code/shop/payments", "bypass", "r1", "p1", "claude-haiku-4-5");
      v6.close();

      const db = openDb(path);
      expect(userVersion(db)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(7);
      // The existing agent is untouched, and it is not promoted: a factory that had no orchestrator
      // before this column must still have none, rather than acquiring one by accident.
      expect(db.prepare("SELECT autonomy, room_id, project_id, model, is_orchestrator FROM sessions WHERE id = 's1'").get())
        .toEqual({ autonomy: "bypass", room_id: "r1", project_id: "p1", model: "claude-haiku-4-5", is_orchestrator: 0 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the orchestrator flag across a reopen, which is what resume re-applies", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-db-orchestrator-"));
    try {
      const path = join(dir, "test.db");
      const first = openDb(path);
      first.prepare("INSERT INTO sessions (id, cwd, is_orchestrator) VALUES (?, ?, 1)").run("s1", "/tmp");
      first.close();
      const second = openDb(path);
      expect(second.prepare("SELECT is_orchestrator FROM sessions WHERE id = 's1'").get())
        .toEqual({ is_orchestrator: 1 });
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- migration 8: the Chronicle ----

  it("creates decisions and an FTS5 index over it", () => {
    const db = openDb(":memory:");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as
      { name: string }[]).map(t => t.name);
    expect(tables).toEqual(expect.arrayContaining(["decisions", "chronicle_fts"]));
    // fts5 specifically — a silent fallback to a plain table would change the feature's shape
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chronicle_fts'").get() as { sql: string }).sql)
      .toMatch(/USING fts5/i);
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='decisions'")
      .all() as { name: string }[]).map(i => i.name)).toContain("decisions_project");
  });

  it("indexes a decision and an event's text through triggers, not through application code", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO projects (id, name, root) VALUES (?, ?, ?)").run("p1", "shop", "/code/shop");
    db.prepare("INSERT INTO rooms (id, project_id, name, path) VALUES (?, ?, ?, ?)")
      .run("r1", "p1", "payments", "/code/shop/payments");
    db.prepare("INSERT INTO sessions (id, cwd, room_id, project_id) VALUES (?, ?, ?, ?)")
      .run("s1", "/code/shop/payments", "r1", "p1");

    db.prepare(`
      INSERT INTO decisions (id, project_id, room_id, number, path, title, context, decision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("d1", "p1", "r1", 1, "/code/shop/docs/decisions/0001-x.md", "Retries", "idempotency key", "payments owns it");
    db.prepare("INSERT INTO events (session_id, seq, type, payload) VALUES (?, ?, ?, ?)")
      .run("s1", 1, "agent_text", JSON.stringify({ type: "agent_text", text: "the webhook uses hmac" }));
    // the bulk the index deliberately skips
    db.prepare("INSERT INTO events (session_id, seq, type, payload) VALUES (?, ?, ?, ?)")
      .run("s1", 2, "tool_result", JSON.stringify({ type: "tool_result", toolName: "Read", output: "capybara" }));

    const search = (q: string) =>
      db.prepare("SELECT kind, ref, project_id, room_id FROM chronicle_fts WHERE chronicle_fts MATCH ?").all(q);
    expect(search('"idempotency"')).toEqual([{ kind: "decision", ref: "d1", project_id: "p1", room_id: "r1" }]);
    expect(search('"hmac"')).toEqual([{ kind: "event", ref: "s1", project_id: "p1", room_id: "r1" }]);
    expect(search('"capybara"')).toEqual([]);
  });

  it("upgrades a user_version = 7 database and backfills the chronicle from its event log", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-db-v7-"));
    try {
      const path = join(dir, "v7.db");
      // A database exactly as migration 7 left it, with a factory already in it.
      const v7 = new Database(path);
      v7.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, claude_session_id TEXT,
          state TEXT NOT NULL DEFAULT 'active', cwd TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          autonomy TEXT NOT NULL DEFAULT 'auto', room_id TEXT, project_id TEXT, model TEXT,
          is_orchestrator INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE events (
          session_id TEXT NOT NULL, seq INTEGER NOT NULL,
          ts INTEGER NOT NULL DEFAULT (unixepoch()),
          type TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (session_id, seq)
        );
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()), last_opened_at INTEGER
        );
        CREATE TABLE rooms (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'room',
          pos_x REAL NOT NULL DEFAULT 0, pos_z REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE (project_id, name)
        );
      `);
      v7.exec("PRAGMA user_version = 7");
      v7.prepare("INSERT INTO projects (id, name, root) VALUES (?, ?, ?)").run("p1", "shop", "/code/shop");
      v7.prepare("INSERT INTO rooms (id, project_id, name, path) VALUES (?, ?, ?, ?)")
        .run("r1", "p1", "payments", "/code/shop/payments");
      v7.prepare("INSERT INTO sessions (id, cwd, room_id, project_id, is_orchestrator) VALUES (?, ?, ?, ?, 1)")
        .run("s1", "/code/shop/payments", "r1", "p1");
      v7.prepare("INSERT INTO events (session_id, seq, type, payload) VALUES (?, ?, ?, ?)")
        .run("s1", 1, "agent_text", JSON.stringify({ type: "agent_text", text: "we chose hmac-sha256" }));
      v7.prepare("INSERT INTO events (session_id, seq, type, payload) VALUES (?, ?, ?, ?)")
        .run("s1", 2, "tool_result", JSON.stringify({ type: "tool_result", toolName: "Read", output: "capybara" }));
      v7.close();

      const db = openDb(path);
      expect(userVersion(db)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(8);

      // the existing factory is untouched, orchestrator flag and all
      expect(db.prepare("SELECT room_id, project_id, is_orchestrator FROM sessions WHERE id = 's1'").get())
        .toEqual({ room_id: "r1", project_id: "p1", is_orchestrator: 1 });
      expect((db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c).toBe(2);

      // …and its history is searchable, so the chronicle does not begin on the day of the upgrade
      const hits = db.prepare("SELECT kind, ref, project_id FROM chronicle_fts WHERE chronicle_fts MATCH ?")
        .all('"hmac"') as { kind: string; ref: string; project_id: string }[];
      expect(hits).toEqual([{ kind: "event", ref: "s1", project_id: "p1" }]);
      // the mechanical bulk is still left out of the backfill, on the same predicate as the trigger
      expect(db.prepare("SELECT ref FROM chronicle_fts WHERE chronicle_fts MATCH ?").all('"capybara"')).toEqual([]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- migration 9: accounts ----

  it("creates the accounts table with a UNIQUE config_dir", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO accounts (id, label, config_dir) VALUES (?, ?, ?)")
      .run("a1", "Work", "/home/me/.claude-work");
    expect(db.prepare("SELECT id, label, config_dir, last_used_at FROM accounts").get())
      .toEqual({ id: "a1", label: "Work", config_dir: "/home/me/.claude-work", last_used_at: null });

    // The invariant, in the schema rather than only in code: one config directory is one account,
    // because the CLI rewrites its refresh token in place there.
    expect(() => db.prepare("INSERT INTO accounts (id, label, config_dir) VALUES (?, ?, ?)")
      .run("a2", "Personal", "/home/me/.claude-work")).toThrow(/UNIQUE/i);
  });

  it("adds a nullable account_id to sessions and rooms, because NULL is the ambient ~/.claude", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO sessions (id, cwd) VALUES (?, ?)").run("s1", "/tmp");
    db.prepare("INSERT INTO projects (id, name, root) VALUES (?, ?, ?)").run("p1", "shop", "/code/shop");
    db.prepare("INSERT INTO rooms (id, project_id, name, path) VALUES (?, ?, ?, ?)")
      .run("r1", "p1", "payments", "/code/shop/payments");
    expect(db.prepare("SELECT account_id FROM sessions WHERE id = 's1'").get()).toEqual({ account_id: null });
    expect(db.prepare("SELECT account_id FROM rooms WHERE id = 'r1'").get()).toEqual({ account_id: null });
  });

  it("upgrades a user_version = 8 database, leaving every agent on the ambient ~/.claude", () => {
    const dir = mkdtempSync(join(tmpdir(), "fabrica-db-"));
    try {
      const path = join(dir, "v8.db");
      const v8 = new Database(path);
      // A real pre-M2 file, brought up by the shipped migrations and then pinned.
      openDb(path).close();
      v8.exec("PRAGMA user_version = 8");
      // Unwind everything migrations 9 and after added, so the file really is what version 8 built.
      v8.exec("DROP INDEX sessions_account");
      v8.exec("ALTER TABLE sessions DROP COLUMN account_id");
      v8.exec("ALTER TABLE rooms DROP COLUMN account_id");
      v8.exec("DROP TABLE accounts");
      v8.exec("DROP TABLE usage_snapshots");
      v8.exec("ALTER TABLE sessions DROP COLUMN paused_at");
      v8.exec("ALTER TABLE sessions DROP COLUMN paused_until");
      v8.exec("ALTER TABLE sessions DROP COLUMN role_id");
      v8.prepare("INSERT INTO projects (id, name, root) VALUES (?, ?, ?)").run("p1", "shop", "/code/shop");
      v8.prepare("INSERT INTO rooms (id, project_id, name, path) VALUES (?, ?, ?, ?)")
        .run("r1", "p1", "payments", "/code/shop/payments");
      v8.prepare("INSERT INTO sessions (id, cwd, room_id, project_id, model) VALUES (?, ?, ?, ?, ?)")
        .run("s1", "/code/shop/payments", "r1", "p1", "claude-opus-5");
      v8.close();

      const db = openDb(path);
      expect(userVersion(db)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(9);
      // Nothing about the existing factory changed, and its one agent runs where it always did.
      expect(db.prepare("SELECT room_id, model, account_id FROM sessions WHERE id = 's1'").get())
        .toEqual({ room_id: "r1", model: "claude-opus-5", account_id: null });
      expect(db.prepare("SELECT account_id FROM rooms WHERE id = 'r1'").get()).toEqual({ account_id: null });
      expect((db.prepare("SELECT COUNT(*) c FROM accounts").get() as { c: number }).c).toBe(0);
      // And it is not paused: an upgrade must not hold an agent for a limit nobody has read yet.
      expect(db.prepare("SELECT state, paused_at, paused_until FROM sessions WHERE id = 's1'").get())
        .toEqual({ state: "active", paused_at: null, paused_until: null });
      expect((db.prepare("SELECT COUNT(*) c FROM usage_snapshots").get() as { c: number }).c).toBe(0);
      // And it is a plain agent, not a role: NULL is what every session written before roles existed
      // meant, and an upgrade must not invent one.
      expect(db.prepare("SELECT role_id FROM sessions WHERE id = 's1'").get()).toEqual({ role_id: null });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- migrations 10-11: the limit monitor and the scheduler ----

  it("keeps every usage reading, and indexes the newest-per-account lookup", () => {
    const db = openDb(":memory:");
    const insert = db.prepare(
      "INSERT INTO usage_snapshots (account_id, read_at, source, approximate, windows, limited)"
      + " VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("a1", 100, "endpoint", 0, "[]", 0);
    insert.run("a1", 200, "estimate", 1, "[]", 1);
    // Append-only history, not one row per account: "we were fine an hour ago" has to stay answerable.
    expect((db.prepare("SELECT COUNT(*) c FROM usage_snapshots WHERE account_id = 'a1'")
      .get() as { c: number }).c).toBe(2);
    expect(db.prepare("SELECT limited_by FROM usage_snapshots WHERE read_at = 200").get())
      .toEqual({ limited_by: null });
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = 'usage_snapshots'")
      .all() as { name: string }[]).map((i) => i.name);
    expect(indexes).toContain("usage_snapshots_account");
  });

  it("gives a session the two facts an unattended resume is made of, both NULL until it is paused", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO sessions (id, cwd) VALUES (?, ?)").run("s1", "/tmp");
    expect(db.prepare("SELECT state, paused_at, paused_until FROM sessions WHERE id = 's1'").get())
      .toEqual({ state: "active", paused_at: null, paused_until: null });
    // A pause with no known reset is a real state — that is what a 429 with no reading behind it
    // leaves — and it must be storable rather than needing a time to be invented for it.
    db.prepare("UPDATE sessions SET state = 'paused', paused_at = ?, paused_until = NULL WHERE id = 's1'")
      .run(1000);
    expect(db.prepare("SELECT state, paused_at, paused_until FROM sessions WHERE id = 's1'").get())
      .toEqual({ state: "paused", paused_at: 1000, paused_until: null });
  });

  it("indexes the project scope of every list the operator looks at", () => {
    const db = openDb(":memory:");
    const indexes = (table: string) =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ?").all(table) as
        { name: string }[]).map(i => i.name);
    expect(indexes("sessions")).toContain("sessions_project");
    expect(indexes("tasks")).toContain("tasks_project");
    expect(indexes("messages")).toEqual(expect.arrayContaining(["messages_project", "messages_undelivered"]));
    // the queue lookup the bus runs at every turn boundary still rides its own index
    const plan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE project_id = ? AND to_room_id = ? AND delivered_at IS NULL",
    ).all("p1", "r2") as { detail: string }[];
    expect(plan.map(p => p.detail).join(" ")).toMatch(/messages_undelivered|messages_project/);
  });
});
