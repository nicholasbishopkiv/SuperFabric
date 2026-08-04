import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMIT_PAUSE_PERCENT, USAGE_POLL_INTERVAL_MS } from "@superfabric/shared";
import { AccountManager } from "../src/accountManager.js";
import { openDb, type Db } from "../src/db.js";
import { LimitMonitor, worstWindow } from "../src/limitMonitor.js";
import type { UsageAdapter, UsageReading } from "../src/usageAdapters.js";

/**
 * The limit monitor: what it reads, how often it is willing to read it, and what it does when the
 * source it depends on is not there any more.
 *
 * Everything here runs on a fake clock and a stub adapter. **No test in this file makes a network
 * request, and none of them touches a real subscription** — the point of the adapter seam is that
 * the polling discipline can be proved without spending a single request against an endpoint nobody
 * documented.
 */

/** An adapter that answers with whatever it is told to, and counts how often it was asked. */
function stubAdapter(answer: () => UsageReading | Promise<UsageReading>) {
  let calls = 0;
  const adapter: UsageAdapter = {
    name: "stub",
    read: async () => { calls++; return await answer(); },
  };
  return { adapter, reads: () => calls };
}

function reading(windows: { key: string; utilization: number; resetsAt?: string }[]): UsageReading {
  return {
    source: "endpoint",
    approximate: false,
    windows: windows.map((w) => ({
      key: w.key, label: w.key, utilization: w.utilization,
      resetsAt: w.resetsAt ?? "2026-08-04T18:00:00Z", detail: null,
    })),
    note: null,
  };
}

interface Harness {
  db: Db;
  accounts: AccountManager;
  root: string;
  /** Milliseconds, moved by the test. */
  clock: { ms: number };
  cleanup(): void;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "sf-limits-"));
  const db = openDb(":memory:");
  const accounts = new AccountManager(db);
  return {
    db, accounts, root,
    clock: { ms: Date.parse("2026-08-04T12:00:00Z") },
    cleanup: () => { rmSync(root, { recursive: true, force: true }); },
  };
}

/** An account whose directory holds credentials, so the monitor is willing to poll it. */
function loggedInAccount(h: Harness, label: string) {
  const account = h.accounts.create({ label, configDir: join(h.root, `cfg-${label}`) });
  writeFileSync(join(account.configDir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: `token-${label}` },
  }));
  return account;
}

describe("LimitMonitor — reading", () => {
  it("polls each logged-in account and reports its windows", async () => {
    const h = harness();
    try {
      const alpha = loggedInAccount(h, "alpha");
      const { adapter } = stubAdapter(() => reading([
        { key: "five_hour", utilization: 43 },
        { key: "seven_day", utilization: 87 },
      ]));
      const monitor = new LimitMonitor(h.db, h.accounts, {
        primary: adapter, now: () => h.clock.ms,
      });
      await monitor.pollAll();

      const usage = monitor.usageOf(alpha.id)!;
      expect(usage.source).toBe("endpoint");
      expect(usage.approximate).toBe(false);
      expect(usage.windows.map((w) => w.utilization)).toEqual([43, 87]);
      expect(usage.readAt).toBe(Math.floor(h.clock.ms / 1000));
      expect(usage.limited).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it("never reads an account whose directory holds no credentials", async () => {
    const h = harness();
    try {
      // Added but not logged in: there is nothing to authenticate with, and asking anyway would be a
      // request we know will be refused.
      h.accounts.create({ label: "fresh", configDir: join(h.root, "cfg-fresh") });
      const { adapter, reads } = stubAdapter(() => reading([{ key: "five_hour", utilization: 1 }]));
      const monitor = new LimitMonitor(h.db, h.accounts, { primary: adapter, now: () => h.clock.ms });
      await monitor.pollAll();
      expect(reads()).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it("lists an account that has never been read as empty rather than as zero usage", () => {
    const h = harness();
    try {
      const alpha = loggedInAccount(h, "alpha");
      const monitor = new LimitMonitor(h.db, h.accounts, { now: () => h.clock.ms });
      const [usage] = monitor.list();
      // Not `utilization: 0` on a meter — "nothing is known" and "you have used nothing" are
      // different facts and only one of them is safe to plan around.
      expect(usage!.accountId).toBe(alpha.id);
      expect(usage!.windows).toEqual([]);
      expect(usage!.readAt).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

describe("LimitMonitor — the polling floor", () => {
  it("will not read one account faster than the interval, however often it is asked", async () => {
    const h = harness();
    try {
      loggedInAccount(h, "alpha");
      const { adapter, reads } = stubAdapter(() => reading([{ key: "five_hour", utilization: 5 }]));
      const monitor = new LimitMonitor(h.db, h.accounts, { primary: adapter, now: () => h.clock.ms });

      await monitor.pollAll();
      expect(reads()).toBe(1);

      // Four more sweeps inside the window — a busy UI, a credentials file that keeps changing, a
      // reconnecting tab. None of them may become a request.
      h.clock.ms += 1000;
      for (let i = 0; i < 4; i++) await monitor.pollAll();
      expect(reads()).toBe(1);

      // One millisecond short is still short.
      h.clock.ms += USAGE_POLL_INTERVAL_MS - 1000 - 1;
      await monitor.pollAll();
      expect(reads()).toBe(1);

      h.clock.ms += 1;
      await monitor.pollAll();
      expect(reads()).toBe(2);
    } finally {
      h.cleanup();
    }
  });

  it("spends the interval on a failed read too, so a broken endpoint is not retried in a loop", async () => {
    const h = harness();
    try {
      loggedInAccount(h, "alpha");
      const { adapter, reads } = stubAdapter(() => { throw new Error("gone"); });
      const failing: UsageAdapter = { name: "no", read: async () => { throw new Error("no estimate either"); } };
      const monitor = new LimitMonitor(h.db, h.accounts, {
        primary: adapter, fallback: failing, now: () => h.clock.ms,
      });
      await monitor.pollAll();
      await monitor.pollAll();
      await monitor.pollAll();
      expect(reads()).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it("keeps the floor per account, so a second account does not slow the first down", async () => {
    const h = harness();
    try {
      loggedInAccount(h, "alpha");
      const { adapter, reads } = stubAdapter(() => reading([{ key: "five_hour", utilization: 5 }]));
      const monitor = new LimitMonitor(h.db, h.accounts, { primary: adapter, now: () => h.clock.ms });
      await monitor.pollAll();
      expect(reads()).toBe(1);

      loggedInAccount(h, "beta");
      await monitor.pollAll();
      // The new one was read; alpha was not read again.
      expect(reads()).toBe(2);
    } finally {
      h.cleanup();
    }
  });
});

describe("LimitMonitor — degrading", () => {
  it("falls back to the estimate when the endpoint fails, and marks the reading approximate", async () => {
    const h = harness();
    try {
      const alpha = loggedInAccount(h, "alpha");
      const { adapter } = stubAdapter(() => { throw new Error("the usage endpoint answered 404"); });
      const estimate: UsageAdapter = {
        name: "estimate",
        read: async () => ({
          source: "estimate", approximate: true, note: "a guess",
          windows: [{ key: "five_hour", label: "5-hour (estimated)", utilization: 20, resetsAt: null, detail: null }],
        }),
      };
      const monitor = new LimitMonitor(h.db, h.accounts, {
        primary: adapter, fallback: estimate, now: () => h.clock.ms,
      });
      await monitor.pollAll();

      const usage = monitor.usageOf(alpha.id)!;
      expect(usage.approximate).toBe(true);
      expect(usage.source).toBe("estimate");
      // Both halves: what failed, and what is standing in for it.
      expect(usage.note).toContain("404");
      expect(usage.note).toContain("falling back to a local estimate");
      expect(usage.note).toContain("a guess");
    } finally {
      h.cleanup();
    }
  });

  it("keeps the last reading standing, with a reason, when both sources fail", async () => {
    const h = harness();
    try {
      const alpha = loggedInAccount(h, "alpha");
      let broken = false;
      const primary: UsageAdapter = {
        name: "p",
        read: async () => {
          if (broken) throw new Error("endpoint gone");
          return reading([{ key: "five_hour", utilization: 61 }]);
        },
      };
      const fallback: UsageAdapter = { name: "f", read: async () => { throw new Error("no transcripts"); } };
      const monitor = new LimitMonitor(h.db, h.accounts, {
        primary, fallback, now: () => h.clock.ms,
      });
      await monitor.pollAll();
      expect(monitor.usageOf(alpha.id)!.windows[0]!.utilization).toBe(61);

      broken = true;
      h.clock.ms += USAGE_POLL_INTERVAL_MS;
      await monitor.pollAll();

      const usage = monitor.usageOf(alpha.id)!;
      // The number the operator can see is the last one that was true, and it is labelled stale
      // rather than replaced by a blank.
      expect(usage.windows[0]!.utilization).toBe(61);
      expect(usage.note).toContain("no usage could be read");
      expect(usage.note).toContain("no transcripts");
    } finally {
      h.cleanup();
    }
  });
});

describe("LimitMonitor — being at the limit", () => {
  it("marks an account limited when a window reaches the pause threshold", async () => {
    const h = harness();
    try {
      const alpha = loggedInAccount(h, "alpha");
      const { adapter } = stubAdapter(() => reading([
        { key: "five_hour", utilization: 12 },
        { key: "seven_day", utilization: LIMIT_PAUSE_PERCENT, resetsAt: "2026-08-06T20:00:00Z" },
      ]));
      const monitor = new LimitMonitor(h.db, h.accounts, { primary: adapter, now: () => h.clock.ms });
      await monitor.pollAll();

      const usage = monitor.usageOf(alpha.id)!;
      expect(usage.limited).toBe(true);
      // The reset of the window that is actually full, not of the first one listed.
      expect(usage.limitedUntil).toBe("2026-08-06T20:00:00Z");
    } finally {
      h.cleanup();
    }
  });

  it("a 429 marks the account at once, without waiting for the poller", async () => {
    const h = harness();
    try {
      const alpha = loggedInAccount(h, "alpha");
      const { adapter } = stubAdapter(() => reading([
        { key: "five_hour", utilization: 40, resetsAt: "2026-08-04T18:00:00Z" },
      ]));
      let announced = 0;
      const monitor = new LimitMonitor(h.db, h.accounts, {
        primary: adapter, now: () => h.clock.ms, onChange: () => { announced++; },
      });
      await monitor.pollAll();
      expect(monitor.usageOf(alpha.id)!.limited).toBe(false);
      const before = announced;

      monitor.markLimited(alpha.id, "a session was refused with a rate-limit error");

      const usage = monitor.usageOf(alpha.id)!;
      expect(usage.limited).toBe(true);
      expect(usage.note).toContain("rate-limit error");
      // The best time anything currently knows: the reset of the fullest window we last saw.
      expect(usage.limitedUntil).toBe("2026-08-04T18:00:00Z");
      // And every tab is told, because nothing else is going to tell them for up to three minutes.
      expect(announced).toBeGreaterThan(before);
    } finally {
      h.cleanup();
    }
  });

  it("a 429 on an account that has never been read still marks it, with no reset time invented", () => {
    const h = harness();
    try {
      const alpha = loggedInAccount(h, "alpha");
      const monitor = new LimitMonitor(h.db, h.accounts, { now: () => h.clock.ms });
      monitor.markLimited(alpha.id, "refused");
      const usage = monitor.usageOf(alpha.id)!;
      expect(usage.limited).toBe(true);
      // Null, not a guess. The scheduler reads it as "hold until a reading says otherwise", which is
      // the only safe reading of "we do not know when this lifts".
      expect(usage.limitedUntil).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("does not re-announce a 429 that says nothing new", () => {
    const h = harness();
    try {
      const alpha = loggedInAccount(h, "alpha");
      let announced = 0;
      const monitor = new LimitMonitor(h.db, h.accounts, {
        now: () => h.clock.ms, onChange: () => { announced++; },
      });
      monitor.markLimited(alpha.id, "refused");
      expect(announced).toBe(1);
      // Five agents on one account all hit the same wall in the same second.
      for (let i = 0; i < 5; i++) monitor.markLimited(alpha.id, "refused");
      expect(announced).toBe(1);
    } finally {
      h.cleanup();
    }
  });
});

describe("LimitMonitor — persistence", () => {
  it("keeps every reading, and comes back with the last one after a restart", async () => {
    const h = harness();
    try {
      const alpha = loggedInAccount(h, "alpha");
      let utilization = 30;
      const { adapter } = stubAdapter(() => reading([
        { key: "five_hour", utilization, resetsAt: "2026-08-04T18:00:00Z" },
      ]));
      const monitor = new LimitMonitor(h.db, h.accounts, { primary: adapter, now: () => h.clock.ms });
      await monitor.pollAll();
      utilization = 55;
      h.clock.ms += USAGE_POLL_INTERVAL_MS;
      await monitor.pollAll();
      expect(monitor.snapshotCount(alpha.id)).toBe(2);

      // A reboot: same database, a fresh monitor, nothing in memory.
      h.clock.ms += USAGE_POLL_INTERVAL_MS;
      const rebooted = new LimitMonitor(h.db, h.accounts, { now: () => h.clock.ms });
      const usage = rebooted.usageOf(alpha.id)!;
      // Not blank. A blank meter after a reboot reads as a fresh window, which is the wrong
      // direction to be wrong in.
      expect(usage.windows[0]!.utilization).toBe(55);
      expect(usage.readAt).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("brings back `limited` too — a restart does not un-exhaust an account", async () => {
    const h = harness();
    try {
      const alpha = loggedInAccount(h, "alpha");
      const { adapter } = stubAdapter(() => reading([
        { key: "seven_day", utilization: 99, resetsAt: "2026-08-06T20:00:00Z" },
      ]));
      const monitor = new LimitMonitor(h.db, h.accounts, { primary: adapter, now: () => h.clock.ms });
      await monitor.pollAll();

      const rebooted = new LimitMonitor(h.db, h.accounts, { now: () => h.clock.ms });
      expect(rebooted.usageOf(alpha.id)!.limited).toBe(true);
      expect(rebooted.usageOf(alpha.id)!.limitedUntil).toBe("2026-08-06T20:00:00Z");
    } finally {
      h.cleanup();
    }
  });

  it("survives a snapshot whose stored windows will not parse", async () => {
    const h = harness();
    try {
      const alpha = loggedInAccount(h, "alpha");
      h.db.prepare(
        "INSERT INTO usage_snapshots (account_id, read_at, source, approximate, windows, note, limited, limited_until)"
        + " VALUES (?, ?, 'endpoint', 0, '{ not json', NULL, 0, NULL)",
      ).run(alpha.id, 1);
      const monitor = new LimitMonitor(h.db, h.accounts, { now: () => h.clock.ms });
      expect(monitor.usageOf(alpha.id)!.windows).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

describe("worstWindow", () => {
  it("is the fullest one, and null for no windows at all", () => {
    const w = (key: string, utilization: number) => ({ key, label: key, utilization, resetsAt: null, detail: null });
    expect(worstWindow([w("a", 10), w("b", 91), w("c", 40)])!.key).toBe("b");
    expect(worstWindow([])).toBeNull();
  });
});
