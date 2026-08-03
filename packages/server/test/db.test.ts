import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";

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
});
