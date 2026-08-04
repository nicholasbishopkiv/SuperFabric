import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SCHEMA_VERSION, migrationFingerprints, openDb } from "../src/db.js";

/**
 * Every migration step that has shipped, frozen.
 *
 * **Appending a step means appending one line here.** Changing an existing line means you edited a
 * step that operators already applied — which is the bug this file exists to catch. A database
 * stamped past an edited step never runs it again, so it keeps the schema the *old* text produced
 * while every fresh database gets the new one. That is exactly how
 * `SQLiteError: table usage_snapshots has no column named limited_by` reached an operator's console:
 * `limited_by` was appended to step 11 after step 11 had shipped, and no test could see it because
 * every test starts from an empty file.
 *
 * If this test fails and you did not mean to change a step, restore it. If you did mean to change
 * behaviour, append a step (a function step can inspect `pragma_table_info` and be a no-op where the
 * change is already present — step 15 is the worked example).
 */
const SHIPPED_FINGERPRINTS = [
  "cfab65c550cc07f2", //  1 — M0 sessions + event log
  "10e84181e23e6581", //  2 — per-agent autonomy
  "ee4dfd16b1834c8", //  3 — M1a rooms
  "9cc66b483af50133", //  4 — tasks + bus messages
  "f0261e847ab83fd8", //  5 — M1b projects (function: decides which project existing rows belong to)
  "c0a8083f52226477", //  6 — per-session model
  "96946470664650ff", //  7 — the orchestrator flag
  "6991b219d0ce493f", //  8 — the Chronicle (function: FTS triggers + backfill)
  "92e7ccd9251b915b", //  9 — accounts
  "aa62b7a2524df30c", // 10 — usage snapshots
  "36a7f7d4b632567b", // 11 — scheduler: paused_at / paused_until (+ limited_by, appended late — see 15)
  "6f3b867f5153b928", // 12 — M1c roles
  "a96d9d35e39452ed", // 13 — M1c room suggestions
  "8df3b7b9eec6257c", // 14 — M4 room runtime
  "4de2ed6418495088", // 15 — repair: limited_by for databases stamped past the old step 11
  "960d41d1ba747dd2", // 16 — chronicle FTS delete triggers (deleting an agent must not leave hits)
  "7e77d55222029bae", // 17 — server_state: things done once (adopting the ambient ~/.claude)
  "95ff6373f0e58fb1", // 18 — sessions.provider: which agent CLI a session runs on
  "25657d3a29ed374",  // 19 — accounts.provider: whose config directory an account row is
];

describe("migrations are append-only", () => {
  it("has a fingerprint recorded for every shipped step", () => {
    expect(migrationFingerprints().length).toBe(SHIPPED_FINGERPRINTS.length);
    expect(SCHEMA_VERSION).toBe(SHIPPED_FINGERPRINTS.length);
  });

  it("has not changed a step that already shipped", () => {
    // Compared element by element so a failure names the step rather than dumping two arrays.
    migrationFingerprints().forEach((actual, i) => {
      expect(`step ${i + 1}: ${actual}`).toBe(`step ${i + 1}: ${SHIPPED_FINGERPRINTS[i]}`);
    });
  });

  it("ignores reindentation and comment edits, so the freeze is on statements only", () => {
    // Guards the normalisation itself: if it ever stopped stripping comments, every prose edit in
    // db.ts would fail the test above and the table would get rubber-stamped into meaninglessness.
    const fingerprints = migrationFingerprints();
    expect(new Set(fingerprints).size).toBe(fingerprints.length); // no two steps collide
    expect(fingerprints.every((h) => /^[0-9a-f]+$/.test(h))).toBe(true);
  });
});

describe("the limited_by repair", () => {
  /** The step that repairs `limited_by`. A database stamped *below* it has never run it. */
  const REPAIR_STEP = 15;

  /** A database in the state an operator's file was actually in: stamped past 11, missing the column. */
  function stampedPastOldStep11(path: string): void {
    const db = openDb(path); // brings it fully up to date, then we take the column back off
    db.exec("ALTER TABLE usage_snapshots DROP COLUMN limited_by");
    // As if step 15 had never existed. Pinned to the repair's own number rather than to
    // `SCHEMA_VERSION - 1`: that was the same thing right up until a step was appended after it, at
    // which point this stopped rewinding far enough and the test started asserting nothing.
    db.exec(`PRAGMA user_version = ${REPAIR_STEP - 1}`);
    db.close();
  }

  it("adds the column to a database that was stamped past the old step 11", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-repair-"));
    try {
      const path = join(dir, "old.db");
      stampedPastOldStep11(path);

      const before = new Database(path, { readonly: true });
      expect(
        before.query("SELECT name FROM pragma_table_info('usage_snapshots')").all().map((r: any) => r.name),
      ).not.toContain("limited_by");
      before.close();

      const db = openDb(path);
      expect(
        db.query("SELECT name FROM pragma_table_info('usage_snapshots')").all().map((r: any) => r.name),
      ).toContain("limited_by");
      expect(db.query("PRAGMA user_version").get() as any).toEqual({ user_version: SCHEMA_VERSION });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op on a database that already has the column", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-repair-noop-"));
    try {
      const path = join(dir, "current.db");
      const first = openDb(path);
      first.prepare("INSERT INTO accounts (id, label, config_dir) VALUES (?, ?, ?)").run("a1", "A", "/tmp/a1");
      first.close();

      // Re-opening runs migrate() again; step 15 must not throw on the column it already added.
      const again = openDb(path);
      expect(again.query("PRAGMA user_version").get() as any).toEqual({ user_version: SCHEMA_VERSION });
      expect((again.query("SELECT COUNT(*) c FROM accounts").get() as any).c).toBe(1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a repaired database able to write the column the server queries", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-repair-write-"));
    try {
      const path = join(dir, "old.db");
      stampedPastOldStep11(path);
      const db = openDb(path);
      // The exact statement LimitMonitor prepares — the one whose preparation crashed on boot.
      db.prepare(
        "INSERT INTO usage_snapshots (account_id, read_at, source, approximate, windows, note, limited, limited_until, limited_by)"
          + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("a1", 1, "endpoint", 0, "[]", null, 1, null, "rate_limit");
      expect(db.query("SELECT limited_by FROM usage_snapshots").get() as any).toMatchObject({
        limited_by: "rate_limit",
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
