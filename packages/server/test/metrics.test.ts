import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMIT_PAUSE_PERCENT, type UsageWindow } from "@superfabric/shared";
import { AccountManager } from "../src/accountManager.js";
import { openDb, type Db } from "../src/db.js";
import { MetricsStore, MIN_BURN_SPAN_SECONDS, project } from "../src/metricsStore.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";

/**
 * Burn rate and cost.
 *
 * **Nothing here reads a network or spends a subscription.** Snapshot rows are written straight into a
 * throwaway in-memory database and the clock is a number the test moves — which is the only way to
 * assert what six hours of readings imply without a six-hour test, and the only honest way to check
 * that a projection built on too little history says so rather than guessing.
 *
 * Two properties get the most attention, because they are the two that decide whether the number is an
 * instrument or a decoration:
 *
 * - a projection with too little behind it is **`unknown` with a reason**, never a figure;
 * - the cost figure is reconstructed from a **cumulative** `costUsd`, so a session that reported
 *   0.10 → 0.30 → 0.60 spent $0.60 and not $1.00.
 */

const HOUR = 3600;
const NOW = Math.floor(Date.parse("2026-08-04T12:00:00Z") / 1000);

interface Harness {
  db: Db;
  accounts: AccountManager;
  projects: ProjectManager;
  rooms: RoomManager;
  metrics: MetricsStore;
  root: string;
  projectId: string;
  /** Write one `usage_snapshots` row, as the limit monitor would. */
  snapshot(opts: {
    accountId: string;
    at: number;
    windows: { key: string; label?: string; utilization: number; resetsAt?: string | null }[];
    approximate?: boolean;
  }): void;
  /** A session row, as `SessionManager.createSession` would leave one. */
  session(opts: { id: string; accountId?: string | null; roomId?: string | null }): void;
  /** A `turn_complete` carrying the CLI's cumulative `total_cost_usd`. */
  turn(opts: { sessionId: string; seq: number; at: number; costUsd?: number }): void;
  cleanup(): void;
}

/** Every temp root this file made, removed after each test whatever happened in it. */

const temps: string[] = [];

function harness(now: number = NOW): Harness {
  const root = mkdtempSync(join(tmpdir(), "sf-metrics-"));
  temps.push(root);
  const db = openDb(":memory:");
  const accounts = new AccountManager(db);
  const projects = new ProjectManager(db, root);
  const rooms = new RoomManager(db, projects);
  const projectId = projects.defaultProject().id;
  rooms.ensureProjectRoom(projectId);
  const metrics = new MetricsStore(db, accounts, projects, { now: () => now });

  return {
    db, accounts, projects, rooms, metrics, root, projectId,
    snapshot: ({ accountId, at, windows, approximate }) => {
      const payload: UsageWindow[] = windows.map((w) => ({
        key: w.key,
        label: w.label ?? w.key,
        utilization: w.utilization,
        resetsAt: w.resetsAt === undefined ? null : w.resetsAt,
        detail: null,
      }));
      db.prepare(
        "INSERT INTO usage_snapshots (account_id, read_at, source, approximate, windows, note,"
        + " limited, limited_until, limited_by) VALUES (?, ?, 'endpoint', ?, ?, NULL, 0, NULL, NULL)",
      ).run(accountId, at, approximate === true ? 1 : 0, JSON.stringify(payload));
    },
    session: ({ id, accountId, roomId }) => {
      db.prepare(
        "INSERT INTO sessions (id, cwd, project_id, account_id, room_id) VALUES (?, ?, ?, ?, ?)",
      ).run(id, root, projectId, accountId ?? null, roomId ?? null);
    },
    turn: ({ sessionId, seq, at, costUsd }) => {
      const payload = costUsd === undefined
        ? JSON.stringify({ type: "turn_complete" })
        : JSON.stringify({ type: "turn_complete", costUsd });
      db.prepare("INSERT INTO events (session_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)")
        .run(sessionId, seq, at, "turn_complete", payload);
    },
    cleanup: () => { db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("burn rate from a snapshot series", () => {
  it("reads the rate off a constant climb and projects to the pause threshold", () => {
    const h = harness();
    const account = h.accounts.create({ label: "work", configDir: join(h.root, "work") });
    // 30 points/hour for an hour, ending at 55 %. 40 points left to 95 % => 80 minutes.
    for (let i = 0; i <= 20; i++) {
      h.snapshot({
        accountId: account.id,
        at: NOW - HOUR + i * 180,
        windows: [{ key: "five_hour", label: "5-hour", utilization: 25 + (30 * (i * 180)) / HOUR }],
      });
    }

    const burn = h.metrics.burnRate(account.id);
    expect(burn.unknown).toBeNull();
    expect(burn.windowKey).toBe("five_hour");
    expect(burn.windowLabel).toBe("5-hour");
    expect(burn.percentPerHour).toBeCloseTo(30, 3);
    expect(burn.samples).toBe(21);
    expect(burn.spanSeconds).toBe(HOUR);
    // (95 - 55) / 30 hours = 1 h 20 m.
    expect(burn.secondsToLimit).toBeCloseTo(80 * 60, -1);
    expect(burn.approximate).toBe(false);
    h.cleanup();
  });

  it("picks the window that runs out soonest, not the fullest one", () => {
    const h = harness();
    const account = h.accounts.create({ label: "work", configDir: join(h.root, "work") });
    for (let i = 0; i <= 20; i++) {
      h.snapshot({
        accountId: account.id,
        at: NOW - HOUR + i * 180,
        windows: [
          // Fullest, but barely moving: 90 % + 0.1 points/hour is days away.
          { key: "seven_day", label: "Weekly", utilization: 90 + (0.1 * (i * 180)) / HOUR },
          // Less full and climbing hard: this is the one the operator's afternoon depends on.
          { key: "five_hour", label: "5-hour", utilization: 40 + (25 * (i * 180)) / HOUR },
        ],
      });
    }

    const burn = h.metrics.burnRate(account.id);
    expect(burn.windowKey).toBe("five_hour");
    expect(burn.secondsToLimit).not.toBeNull();
    // (95 - 65) / 25 h = 1 h 12 m, comfortably sooner than the weekly window's five points.
    expect(burn.secondsToLimit!).toBeLessThan(2 * HOUR);
    h.cleanup();
  });

  it("marks a projection built on estimated readings as approximate", () => {
    const h = harness();
    const account = h.accounts.create({ label: "work", configDir: join(h.root, "work") });
    for (let i = 0; i <= 10; i++) {
      h.snapshot({
        accountId: account.id,
        at: NOW - HOUR + i * 360,
        windows: [{ key: "five_hour", label: "5-hour", utilization: 20 + i * 3 }],
        // One estimate anywhere in the series is enough: the slope is only as good as its worst point.
        approximate: i === 4,
      });
    }
    const burn = h.metrics.burnRate(account.id);
    expect(burn.unknown).toBeNull();
    expect(burn.approximate).toBe(true);
    h.cleanup();
  });

  it("starts the series again when a window rolls, instead of reading a reset as a negative rate", () => {
    const h = harness();
    const account = h.accounts.create({ label: "work", configDir: join(h.root, "work") });
    // Two hours climbing to 96 %, then the window rolls to 4 % and climbs again for an hour.
    for (let i = 0; i <= 20; i++) {
      h.snapshot({
        accountId: account.id,
        at: NOW - 3 * HOUR + i * 180,
        windows: [{ key: "five_hour", label: "5-hour", utilization: 60 + i * 1.8 }],
      });
    }
    for (let i = 0; i <= 20; i++) {
      h.snapshot({
        accountId: account.id,
        at: NOW - HOUR + i * 180,
        windows: [{ key: "five_hour", label: "5-hour", utilization: 4 + (12 * (i * 180)) / HOUR }],
      });
    }

    const burn = h.metrics.burnRate(account.id);
    // Only the post-reset hour is measured: 12 points/hour, not the -90 the reset would imply.
    expect(burn.percentPerHour).toBeCloseTo(12, 2);
    expect(burn.samples).toBe(21);
    h.cleanup();
  });

  it("says a window resets before this rate would exhaust it", () => {
    const h = harness();
    const account = h.accounts.create({ label: "work", configDir: join(h.root, "work") });
    // 10 points/hour from 30 % to 40 %: 5.5 h to the threshold. The window rolls in 20 minutes.
    const resetsAt = new Date((NOW + 20 * 60) * 1000).toISOString();
    for (let i = 0; i <= 20; i++) {
      h.snapshot({
        accountId: account.id,
        at: NOW - HOUR + i * 180,
        windows: [{ key: "five_hour", label: "5-hour", utilization: 30 + (10 * (i * 180)) / HOUR, resetsAt }],
      });
    }
    const burn = h.metrics.burnRate(account.id);
    expect(burn.secondsToLimit).not.toBeNull();
    expect(burn.resetsFirst).toBe(true);
    h.cleanup();
  });

  it("answers zero seconds, not a projection, for a window already at the threshold", () => {
    const h = harness();
    const account = h.accounts.create({ label: "work", configDir: join(h.root, "work") });
    for (let i = 0; i <= 20; i++) {
      h.snapshot({
        accountId: account.id,
        at: NOW - HOUR + i * 180,
        windows: [{ key: "five_hour", label: "5-hour", utilization: 90 + i * 0.3 }],
      });
    }
    const burn = h.metrics.burnRate(account.id);
    expect(burn.windowKey).toBe("five_hour");
    expect(burn.secondsToLimit).toBe(0);
    expect(h.metrics.burnRate(account.id).percentPerHour).toBeGreaterThan(0);
    // Sanity: the series really did cross the line the scheduler acts on.
    expect(90 + 20 * 0.3).toBeGreaterThan(LIMIT_PAUSE_PERCENT);
    h.cleanup();
  });

  it("ignores a window the newest reading no longer reports", () => {
    const h = harness();
    const account = h.accounts.create({ label: "work", configDir: join(h.root, "work") });
    for (let i = 0; i <= 20; i++) {
      h.snapshot({
        accountId: account.id,
        at: NOW - 2 * HOUR + i * 180,
        windows: [
          { key: "five_hour", label: "5-hour", utilization: 10 + i * 0.2 },
          { key: "weekly_scoped:Opus", label: "Weekly · Opus", utilization: 50 + i * 2 },
        ],
      });
    }
    // The endpoint has stopped reporting the scoped window — it has already done that once.
    for (let i = 0; i <= 20; i++) {
      h.snapshot({
        accountId: account.id,
        at: NOW - HOUR + i * 180,
        windows: [{ key: "five_hour", label: "5-hour", utilization: 14 + i * 0.2 }],
      });
    }
    const burn = h.metrics.burnRate(account.id);
    expect(burn.windowKey).toBe("five_hour");
    h.cleanup();
  });
});

describe("a projection nobody can make says so", () => {
  it("says unknown for an account that has never been read", () => {
    const h = harness();
    const account = h.accounts.create({ label: "work", configDir: join(h.root, "work") });
    const burn = h.metrics.burnRate(account.id);
    expect(burn.secondsToLimit).toBeNull();
    expect(burn.percentPerHour).toBeNull();
    expect(burn.windowKey).toBeNull();
    expect(burn.unknown).toContain("no usage readings");
    h.cleanup();
  });

  it("says unknown, naming the window, for a single reading", () => {
    const h = harness();
    const account = h.accounts.create({ label: "work", configDir: join(h.root, "work") });
    h.snapshot({
      accountId: account.id,
      at: NOW - 60,
      windows: [{ key: "five_hour", label: "5-hour", utilization: 42 }],
    });
    const burn = h.metrics.burnRate(account.id);
    expect(burn.secondsToLimit).toBeNull();
    expect(burn.samples).toBe(1);
    expect(burn.unknown).toBe("only 1 reading of 5-hour so far — a rate needs two");
    h.cleanup();
  });

  it("says unknown when the readings span less than the floor, however many there are", () => {
    const h = harness();
    const account = h.accounts.create({ label: "work", configDir: join(h.root, "work") });
    // Five readings a minute apart: plenty of points, five minutes of span. The endpoint's own
    // rounding would dominate any slope taken from that.
    for (let i = 0; i < 5; i++) {
      h.snapshot({
        accountId: account.id,
        at: NOW - 5 * 60 + i * 60,
        windows: [{ key: "five_hour", label: "5-hour", utilization: 40 + i }],
      });
    }
    const burn = h.metrics.burnRate(account.id);
    expect(burn.samples).toBe(5);
    expect(burn.secondsToLimit).toBeNull();
    expect(burn.percentPerHour).toBeNull();
    expect(burn.unknown).toContain("too little to project from");
    expect(burn.spanSeconds).toBeLessThan(MIN_BURN_SPAN_SECONDS);
    h.cleanup();
  });

  it("says unknown, rather than a negative or infinite projection, for a window that is not filling", () => {
    const h = harness();
    const account = h.accounts.create({ label: "work", configDir: join(h.root, "work") });
    for (let i = 0; i <= 20; i++) {
      h.snapshot({
        accountId: account.id,
        at: NOW - HOUR + i * 180,
        windows: [{ key: "five_hour", label: "5-hour", utilization: 33 }],
      });
    }
    const burn = h.metrics.burnRate(account.id);
    expect(burn.percentPerHour).toBe(0);
    expect(burn.secondsToLimit).toBeNull();
    expect(burn.unknown).toContain("not filling");
    h.cleanup();
  });

  it("ignores readings older than the history window, so yesterday cannot flatten today", () => {
    const h = harness();
    const account = h.accounts.create({ label: "work", configDir: join(h.root, "work") });
    // A day-old pair, far outside the six-hour history window.
    h.snapshot({
      accountId: account.id,
      at: NOW - 30 * HOUR,
      windows: [{ key: "five_hour", label: "5-hour", utilization: 5 }],
    });
    h.snapshot({
      accountId: account.id,
      at: NOW - 29 * HOUR,
      windows: [{ key: "five_hour", label: "5-hour", utilization: 80 }],
    });
    const burn = h.metrics.burnRate(account.id);
    expect(burn.samples).toBe(0);
    expect(burn.unknown).toContain("no usage readings");
    h.cleanup();
  });

  it("projects nothing from a series with no time between its readings", () => {
    // Two readings with the same timestamp: a rate would be a division by zero. `project` is exercised
    // directly here because a database cannot easily be made to produce it.
    const burn = project("acct", "five_hour", [
      { at: NOW, utilization: 10, label: "5-hour", approximate: false, resetsAt: null },
      { at: NOW, utilization: 90, label: "5-hour", approximate: false, resetsAt: null },
    ]);
    expect(burn.secondsToLimit).toBeNull();
    expect(burn.spanSeconds).toBe(0);
    expect(burn.unknown).toContain("too little to project from");
  });
});

describe("cost aggregation", () => {
  it("reconstructs per-turn spend from a cumulative counter, per account", () => {
    const h = harness();
    const work = h.accounts.create({ label: "work", configDir: join(h.root, "work") });
    const other = h.accounts.create({ label: "other", configDir: join(h.root, "other") });
    h.session({ id: "s1", accountId: work.id });
    h.session({ id: "s2", accountId: other.id });

    // One session, three turns, cumulative: it spent $0.60 in total, not $1.00.
    h.turn({ sessionId: "s1", seq: 1, at: NOW - 600, costUsd: 0.1 });
    h.turn({ sessionId: "s1", seq: 2, at: NOW - 500, costUsd: 0.3 });
    h.turn({ sessionId: "s1", seq: 3, at: NOW - 400, costUsd: 0.6 });
    h.turn({ sessionId: "s2", seq: 1, at: NOW - 300, costUsd: 0.05 });

    const byAccount = h.metrics.costByAccount();
    expect(byAccount.get(work.id)!.day).toEqual({ usd: 0.6, turns: 3 });
    expect(byAccount.get(other.id)!.day).toEqual({ usd: 0.05, turns: 1 });
    h.cleanup();
  });

  it("treats a counter that goes backwards as a restarted query, not a refund", () => {
    const h = harness();
    const work = h.accounts.create({ label: "work", configDir: join(h.root, "work") });
    h.session({ id: "s1", accountId: work.id });
    // Two turns, then `set_model` restarts the executor: a new `query()` with its counter back near
    // zero. The restart's turns are additional spend, and the total is 0.30 + 0.07 + 0.15.
    h.turn({ sessionId: "s1", seq: 1, at: NOW - 900, costUsd: 0.12 });
    h.turn({ sessionId: "s1", seq: 2, at: NOW - 800, costUsd: 0.3 });
    h.turn({ sessionId: "s1", seq: 3, at: NOW - 700, costUsd: 0.07 });
    h.turn({ sessionId: "s1", seq: 4, at: NOW - 600, costUsd: 0.22 });

    expect(h.metrics.costByAccount().get(work.id)!.day).toEqual({ usd: 0.52, turns: 4 });
    h.cleanup();
  });

  it("puts an agent with no account into the ambient bucket, not into a real one", () => {
    const h = harness();
    const work = h.accounts.create({ label: "work", configDir: join(h.root, "work") });
    h.session({ id: "bound", accountId: work.id });
    h.session({ id: "ambient", accountId: null });
    h.turn({ sessionId: "bound", seq: 1, at: NOW - 100, costUsd: 0.2 });
    h.turn({ sessionId: "ambient", seq: 1, at: NOW - 100, costUsd: 0.4 });

    const snapshot = h.metrics.snapshot(h.projectId);
    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.accounts[0]!.cost.day.usd).toBe(0.2);
    expect(snapshot.ambient.day).toEqual({ usd: 0.4, turns: 1 });
    h.cleanup();
  });

  it("counts a turn that reported no cost as neither spend nor a turn", () => {
    const h = harness();
    const work = h.accounts.create({ label: "work", configDir: join(h.root, "work") });
    h.session({ id: "s1", accountId: work.id });
    h.turn({ sessionId: "s1", seq: 1, at: NOW - 100, costUsd: 0.2 });
    // A `turn_complete` with no `costUsd` — an error result, or a provider that said nothing.
    h.turn({ sessionId: "s1", seq: 2, at: NOW - 50 });

    expect(h.metrics.costByAccount().get(work.id)!.day).toEqual({ usd: 0.2, turns: 1 });
    h.cleanup();
  });

  it("separates the day from the week", () => {
    const h = harness();
    const work = h.accounts.create({ label: "work", configDir: join(h.root, "work") });
    h.session({ id: "old", accountId: work.id });
    h.session({ id: "new", accountId: work.id });
    h.turn({ sessionId: "old", seq: 1, at: NOW - 3 * 24 * HOUR, costUsd: 1.5 });
    h.turn({ sessionId: "new", seq: 1, at: NOW - HOUR, costUsd: 0.25 });

    const cost = h.metrics.costByAccount().get(work.id)!;
    expect(cost.day).toEqual({ usd: 0.25, turns: 1 });
    expect(cost.week).toEqual({ usd: 1.75, turns: 2 });
    h.cleanup();
  });

  it("aggregates by room, most expensive first, and leaves rooms that cost nothing out", () => {
    const h = harness();
    const backend = h.rooms.createRoom("backend", { projectId: h.projectId });
    const docs = h.rooms.createRoom("docs", { projectId: h.projectId });
    h.rooms.createRoom("quiet", { projectId: h.projectId });
    h.session({ id: "b1", roomId: backend.id });
    h.session({ id: "b2", roomId: backend.id });
    h.session({ id: "d1", roomId: docs.id });
    h.session({ id: "roomless" });

    h.turn({ sessionId: "b1", seq: 1, at: NOW - 100, costUsd: 0.4 });
    h.turn({ sessionId: "b2", seq: 1, at: NOW - 100, costUsd: 0.1 });
    h.turn({ sessionId: "d1", seq: 1, at: NOW - 100, costUsd: 0.2 });
    // A roomless session's spend belongs to no department; attributing it to one would be a lie.
    h.turn({ sessionId: "roomless", seq: 1, at: NOW - 100, costUsd: 9.99 });

    const rooms = h.metrics.costByRoom(h.projectId);
    expect(rooms.map((r) => r.roomId)).toEqual([backend.id, docs.id]);
    expect(rooms[0]!.cost.day).toEqual({ usd: 0.5, turns: 2 });
    expect(rooms[1]!.cost.day).toEqual({ usd: 0.2, turns: 1 });
    h.cleanup();
  });

  it("keeps one factory's room spend out of another's", () => {
    const h = harness();
    const otherRoot = mkdtempSync(join(tmpdir(), "sf-metrics-other-"));
    temps.push(otherRoot);
    const second = h.projects.create({ root: otherRoot, name: "second" });
    h.rooms.ensureProjectRoom(second.id);
    const mine = h.rooms.createRoom("mine", { projectId: h.projectId });
    const theirs = h.rooms.createRoom("theirs", { projectId: second.id });

    h.session({ id: "m1", roomId: mine.id });
    h.db.prepare("INSERT INTO sessions (id, cwd, project_id, room_id) VALUES (?, ?, ?, ?)")
      .run("t1", otherRoot, second.id, theirs.id);
    h.turn({ sessionId: "m1", seq: 1, at: NOW - 100, costUsd: 0.3 });
    h.turn({ sessionId: "t1", seq: 1, at: NOW - 100, costUsd: 0.7 });

    expect(h.metrics.costByRoom(h.projectId).map((r) => r.roomId)).toEqual([mine.id]);
    expect(h.metrics.costByRoom(second.id).map((r) => r.roomId)).toEqual([theirs.id]);
    // The account totals are deliberately *not* scoped: a subscription's spend is the subscription's,
    // whichever floor the operator happens to be looking at.
    expect(h.metrics.costByAccount().get(null)!.day.usd).toBe(1);
    h.cleanup();
  });

  it("reports zeroes for a configured account that has never run anything", () => {
    const h = harness();
    h.accounts.create({ label: "fresh", configDir: join(h.root, "fresh") });
    const snapshot = h.metrics.snapshot(h.projectId);
    expect(snapshot.accounts[0]!.cost).toEqual({ day: { usd: 0, turns: 0 }, week: { usd: 0, turns: 0 } });
    expect(snapshot.accounts[0]!.burn.unknown).not.toBeNull();
    expect(snapshot.rooms).toEqual([]);
    h.cleanup();
  });
});
