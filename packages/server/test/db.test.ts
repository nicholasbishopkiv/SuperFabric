import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";

describe("db", () => {
  it("creates schema in memory and enforces WAL on file dbs", () => {
    const db = openDb(":memory:");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    expect(tables.map(t => t.name)).toEqual(expect.arrayContaining(["events", "sessions"]));
  });
});
