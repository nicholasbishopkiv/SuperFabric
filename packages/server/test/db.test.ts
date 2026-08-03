import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { SCHEMA_VERSION, openDb } from "../src/db.js";

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
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves in-memory databases on their default journal mode", () => {
    const db = openDb(":memory:");
    expect(db.pragma("journal_mode", { simple: true })).toBe("memory");
  });

  it("stamps a fresh database with the current schema version", () => {
    const db = openDb(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
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
      expect(second.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
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
      old.pragma("user_version = 0");
      old.prepare("INSERT INTO sessions (id, cwd) VALUES (?, ?)").run("legacy", "/legacy/cwd");
      old.prepare("INSERT INTO events (session_id, seq, type, payload) VALUES (?, ?, ?, ?)")
        .run("legacy", 1, "agent_text", JSON.stringify({ type: "agent_text", text: "from before" }));
      old.close();

      const db = openDb(path);
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      expect(db.prepare("SELECT cwd FROM sessions WHERE id = 'legacy'").get()).toEqual({ cwd: "/legacy/cwd" });
      expect((db.prepare("SELECT payload FROM events WHERE session_id='legacy' AND seq=1").get() as { payload: string }).payload)
        .toContain("from before");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
