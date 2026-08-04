import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@superfabric/shared";
import { AccountManager } from "../src/accountManager.js";
import { openDb, type Db } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import type { Executor, ExecutorEvents, ExecutorHandle, ExecutorStartOptions } from "../src/executor.js";
import { LimitMonitor } from "../src/limitMonitor.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { LimitScheduler } from "../src/scheduler.js";
import { SessionManager } from "../src/sessionManager.js";
import type { UsageAdapter, UsageReading } from "../src/usageAdapters.js";

/**
 * The scheduler: warn at 80, hold at 95, come back when the window rolls.
 *
 * Everything here runs on a fake clock against a **stubbed adapter**. No real limit is approached,
 * let alone reached — forcing the thresholds with a stub is the only honest way to exercise them, and
 * deliberately exhausting a real subscription to test a feature would be an absurd way to spend an
 * operator's quota.
 */

/**
 * An executor that records what it was told and lets a test decide when a turn ends.
 *
 * `turn_complete` is manual because the turn boundary *is* the thing under test: a pause must wait
 * for one, and nothing else in the runner can be trusted to prove that if the boundary arrives on its
 * own schedule.
 */
class SteppableExecutor implements Executor {
  readonly name = "steppable";
  readonly starts: ExecutorStartOptions[] = [];
  /** sessionId is not known here, so sessions are addressed by start order. */
  private live: { ev: ExecutorEvents; prompts: string[]; stopped: boolean }[] = [];

  start(opts: ExecutorStartOptions, ev: ExecutorEvents): ExecutorHandle {
    this.starts.push(opts);
    const entry = { ev, prompts: [] as string[], stopped: false };
    this.live.push(entry);
    ev.onEvent({ type: "session_status", status: "idle" });
    return {
      providerSessionId: Promise.resolve(`provider-${this.starts.length}`),
      send: (text: string) => { entry.prompts.push(text); },
      interrupt: async () => {},
      stop: async () => { entry.stopped = true; },
    };
  }

  /** Everything the Nth started executor was sent, in order. */
  promptsOf(index: number): string[] {
    return this.live[index]?.prompts ?? [];
  }

  /** Every prompt any executor has been sent. */
  allPrompts(): string[] {
    return this.live.flatMap((l) => l.prompts);
  }

  emit(index: number, event: SessionEvent): void {
    this.live[index]!.ev.onEvent(event);
  }

  /** Put the Nth executor into a turn, so a pause has a boundary to wait for. */
  beginTurn(index: number): void {
    this.emit(index, { type: "session_status", status: "working" });
  }

  endTurn(index: number): void {
    this.emit(index, { type: "turn_complete" });
    this.emit(index, { type: "session_status", status: "idle" });
  }

  stopped(index: number): boolean {
    return this.live[index]?.stopped ?? false;
  }
}

/**
 * An adapter the test moves by hand — a default answer for every account, plus per-account overrides
 * so a case can put one subscription at its limit and leave the other one alone.
 */
function movableAdapter() {
  let fallback: UsageReading = reading(0);
  const perDir = new Map<string, UsageReading>();
  const adapter: UsageAdapter = {
    name: "stub",
    read: async (account) => perDir.get(account.configDir) ?? fallback,
  };
  return {
    adapter,
    set: (r: UsageReading) => { fallback = r; },
    setFor: (configDir: string, r: UsageReading) => { perDir.set(configDir, r); },
  };
}

const RESETS_AT = "2026-08-04T18:00:00Z";

function reading(utilization: number, opts: { resetsAt?: string; approximate?: boolean } = {}): UsageReading {
  return {
    source: opts.approximate === true ? "estimate" : "endpoint",
    approximate: opts.approximate === true,
    note: null,
    windows: [{
      key: "five_hour",
      label: opts.approximate === true ? "5-hour (estimated)" : "5-hour",
      utilization,
      resetsAt: opts.resetsAt ?? RESETS_AT,
      detail: null,
    }],
  };
}

interface Harness {
  db: Db;
  root: string;
  clock: { ms: number };
  accounts: AccountManager;
  monitor: LimitMonitor;
  scheduler: LimitScheduler;
  mgr: SessionManager;
  store: EventStore;
  executor: SteppableExecutor;
  set: (r: UsageReading) => void;
  setFor: (configDir: string, r: UsageReading) => void;
  /** Advance the clock past the poll floor and read again. */
  repoll: () => Promise<void>;
  cleanup: () => void;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "sf-scheduler-"));
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const projects = new ProjectManager(db, root);
  const rooms = new RoomManager(db, projects);
  const accounts = new AccountManager(db);
  const executor = new SteppableExecutor();
  const clock = { ms: Date.parse("2026-08-04T12:00:00Z") };
  const { adapter, set, setFor } = movableAdapter();
  const monitor = new LimitMonitor(db, accounts, {
    primary: adapter, now: () => clock.ms, minIntervalMs: 1000,
  });
  const mgr = new SessionManager(db, store, executor, rooms, projects, {
    accounts,
    onRateLimited: (_s, accountId) => { if (accountId !== null) monitor.markLimited(accountId, "429"); },
  });
  const scheduler = new LimitScheduler({
    monitor, sessions: mgr, accounts, now: () => clock.ms,
  });
  return {
    db, root, clock, accounts, monitor, scheduler, mgr, store, executor, set, setFor,
    repoll: async () => { clock.ms += 1000; await monitor.pollAll(); },
    cleanup: () => { rmSync(root, { recursive: true, force: true }); },
  };
}

/** An account with credentials in place, so the monitor is willing to read it. */
function loggedIn(h: Harness, label: string) {
  const account = h.accounts.create({ label, configDir: join(h.root, `cfg-${label}`) });
  writeFileSync(join(account.configDir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "t" },
  }));
  return account;
}

/** Every `session_status` detail this session's log holds, in order. */
function statusDetails(store: EventStore, sessionId: string): string[] {
  return store.listAfter(sessionId, 0)
    .map((r) => r.event)
    .filter((e): e is Extract<SessionEvent, { type: "session_status" }> => e.type === "session_status")
    .map((e) => `${e.status}${e.detail === undefined ? "" : `: ${e.detail}`}`);
}

describe("LimitScheduler: warning at 80%", () => {
  it("injects one short turn into every agent on the account", async () => {
    const h = harness();
    try {
      const account = loggedIn(h, "work");
      h.mgr.createSession({ cwd: h.root, accountId: account.id });
      h.mgr.createSession({ cwd: h.root, accountId: account.id });

      h.set(reading(84));
      await h.repoll();
      await h.scheduler.tick();

      for (const index of [0, 1]) {
        const prompts = h.executor.promptsOf(index);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("84% of its 5-hour limit");
        expect(prompts[0]).toContain("safe stopping point");
        // Not a UI toast: the agent is the one who has to act, and the operator may not be there.
        expect(prompts[0]).toContain("[SuperFabric]");
      }
    } finally {
      h.cleanup();
    }
  });

  it("fires once, not per poll — the window instance is the key", async () => {
    const h = harness();
    try {
      const account = loggedIn(h, "work");
      h.mgr.createSession({ cwd: h.root, accountId: account.id });

      h.set(reading(84));
      for (let i = 0; i < 5; i++) {
        await h.repoll();
        await h.scheduler.tick();
      }
      expect(h.executor.promptsOf(0)).toHaveLength(1);

      // Still one when it climbs, as long as it is the same window instance.
      h.set(reading(88));
      await h.repoll();
      await h.scheduler.tick();
      expect(h.executor.promptsOf(0)).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it("warns again once the window has actually rolled", async () => {
    const h = harness();
    try {
      const account = loggedIn(h, "work");
      h.mgr.createSession({ cwd: h.root, accountId: account.id });

      h.set(reading(84));
      await h.repoll();
      await h.scheduler.tick();
      expect(h.executor.promptsOf(0)).toHaveLength(1);

      // A new `resets_at` is a new window, and crossing 80 in it is a genuinely new event.
      h.set(reading(81, { resetsAt: "2026-08-04T23:00:00Z" }));
      await h.repoll();
      await h.scheduler.tick();
      expect(h.executor.promptsOf(0)).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });

  it("says nothing at all below the threshold", async () => {
    const h = harness();
    try {
      const account = loggedIn(h, "work");
      h.mgr.createSession({ cwd: h.root, accountId: account.id });
      h.set(reading(79.9));
      await h.repoll();
      await h.scheduler.tick();
      expect(h.executor.promptsOf(0)).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it("warns on an approximate reading, and labels it as one", async () => {
    const h = harness();
    try {
      const account = loggedIn(h, "work");
      h.mgr.createSession({ cwd: h.root, accountId: account.id });
      h.set(reading(90, { approximate: true }));
      await h.repoll();
      await h.scheduler.tick();
      // A warning costs a sentence and cannot hurt anyone, so a guess is allowed to raise one — as
      // long as it admits to being a guess.
      expect(h.executor.promptsOf(0)[0]).toContain("This is an estimate");
    } finally {
      h.cleanup();
    }
  });
});

describe("LimitScheduler: pausing at 95%", () => {
  it("pauses an idle agent immediately, persists it, and records when it comes back", async () => {
    const h = harness();
    try {
      const account = loggedIn(h, "work");
      const id = h.mgr.createSession({ cwd: h.root, accountId: account.id });

      h.set(reading(96));
      await h.repoll();
      await h.scheduler.tick();

      const session = h.mgr.listSessions()[0]!;
      expect(session.state).toBe("paused");
      expect(session.status).toBe("paused");
      expect(session.pausedUntil).toBe(Math.floor(Date.parse(RESETS_AT) / 1000));
      expect(h.executor.stopped(0)).toBe(true);
      expect(statusDetails(h.store, id).join(" | ")).toContain('the account "work" is at its limit');
    } finally {
      h.cleanup();
    }
  });

  it("**waits for the turn boundary** rather than cutting an agent off mid-thought", async () => {
    const h = harness();
    try {
      const account = loggedIn(h, "work");
      const id = h.mgr.createSession({ cwd: h.root, accountId: account.id });
      h.executor.beginTurn(0);

      h.set(reading(99));
      await h.repoll();
      await h.scheduler.tick();

      // Still running: the turn's tokens are already spent and throwing them away is the opposite of
      // the point. The log says what is about to happen, so the operator is not surprised.
      expect(h.mgr.listSessions()[0]!.state).toBe("active");
      expect(h.executor.stopped(0)).toBe(false);
      expect(statusDetails(h.store, id).join(" | ")).toContain("pausing at the end of this turn");

      h.executor.endTurn(0);
      await Promise.resolve();
      expect(h.mgr.listSessions()[0]!.state).toBe("paused");
      expect(h.executor.stopped(0)).toBe(true);
      // …and the *log* ends on `paused` too. The executor emits an `idle` status one line after the
      // `turn_complete` the pause landed on; if that were appended, the row would say paused and the
      // transcript the operator reads would say idle. See `SessionManager.generation`.
      expect(h.mgr.listSessions()[0]!.status).toBe("paused");
      expect(statusDetails(h.store, id).at(-1)).toContain('paused: the account "work" is at its limit');
    } finally {
      h.cleanup();
    }
  });

  it("is idempotent — a second tick does not pause a paused agent again", async () => {
    const h = harness();
    try {
      const account = loggedIn(h, "work");
      const id = h.mgr.createSession({ cwd: h.root, accountId: account.id });
      h.set(reading(97));
      await h.repoll();
      await h.scheduler.tick();
      const after = statusDetails(h.store, id).length;

      for (let i = 0; i < 3; i++) {
        await h.repoll();
        await h.scheduler.tick();
      }
      expect(statusDetails(h.store, id).length).toBe(after);
      expect(h.executor.starts).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it("**never pauses on a guess** — an approximate reading at 99% warns and nothing more", async () => {
    const h = harness();
    try {
      const account = loggedIn(h, "work");
      h.mgr.createSession({ cwd: h.root, accountId: account.id });
      h.set(reading(99, { approximate: true }));
      await h.repoll();
      await h.scheduler.tick();

      // The estimate cannot see other devices and does not know when the window began, so it may be
      // wrong in the direction that stops an agent with plenty of quota left.
      expect(h.mgr.listSessions()[0]!.state).toBe("active");
      expect(h.executor.promptsOf(0)).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it("pauses on a 429 even when the meters are only an estimate", async () => {
    const h = harness();
    try {
      const account = loggedIn(h, "work");
      h.mgr.createSession({ cwd: h.root, accountId: account.id });
      h.set(reading(10, { approximate: true }));
      await h.repoll();
      await h.scheduler.tick();
      expect(h.mgr.listSessions()[0]!.state).toBe("active");

      // The provider itself refusing a turn is not an estimate.
      h.monitor.markLimited(account.id, "a session was refused with a rate-limit error");
      await h.scheduler.tick();

      expect(h.mgr.listSessions()[0]!.state).toBe("paused");
      expect(statusDetails(h.store, h.mgr.listSessions()[0]!.id).join(" | "))
        .toContain("the provider refused a turn with a rate-limit error");
    } finally {
      h.cleanup();
    }
  });

  it("leaves the other account's agents alone", async () => {
    const h = harness();
    try {
      const work = loggedIn(h, "work");
      const personal = loggedIn(h, "personal");
      const a = h.mgr.createSession({ cwd: h.root, accountId: work.id });
      const b = h.mgr.createSession({ cwd: h.root, accountId: personal.id });

      // Both accounts read the same stub, so mark only one by the door that is per account.
      h.monitor.markLimited(work.id, "429");
      await h.scheduler.tick();

      const byId = new Map(h.mgr.listSessions().map((s) => [s.id, s]));
      expect(byId.get(a)!.state).toBe("paused");
      // No rotation, and no collateral: the other subscription is a different quota entirely.
      expect(byId.get(b)!.state).toBe("active");
    } finally {
      h.cleanup();
    }
  });

  it("does not touch a session on the ambient ~/.claude", async () => {
    const h = harness();
    try {
      const account = loggedIn(h, "work");
      const ambient = h.mgr.createSession({ cwd: h.root });
      h.mgr.createSession({ cwd: h.root, accountId: account.id });
      h.set(reading(99));
      await h.repoll();
      await h.scheduler.tick();

      const byId = new Map(h.mgr.listSessions().map((s) => [s.id, s]));
      expect(byId.get(ambient)!.state).toBe("active");
    } finally {
      h.cleanup();
    }
  });
});

describe("LimitScheduler: resuming", () => {
  it("resumes exactly the sessions that were paused, and only once the window has rolled", async () => {
    const h = harness();
    try {
      const work = loggedIn(h, "work");
      const personal = loggedIn(h, "personal");
      const a = h.mgr.createSession({ cwd: h.root, accountId: work.id });
      const b = h.mgr.createSession({ cwd: h.root, accountId: work.id });
      const other = h.mgr.createSession({ cwd: h.root, accountId: personal.id });

      h.monitor.markLimited(work.id, "429");
      // A reset time to count down to, which markLimited alone has no way to know. The other
      // subscription is its own quota and reads its own, comfortable, number.
      h.setFor(work.configDir, reading(99));
      h.setFor(personal.configDir, reading(11));
      await h.repoll();
      await h.scheduler.tick();

      const paused = h.mgr.pausedSessions().map((s) => s.id).sort();
      expect(paused).toEqual([a, b].sort());

      // One minute before the window rolls: nothing comes back.
      h.clock.ms = Date.parse(RESETS_AT) - 60_000;
      await h.scheduler.tick();
      expect(h.mgr.pausedSessions()).toHaveLength(2);

      // And on the far side of it, both do — and nobody else.
      h.clock.ms = Date.parse(RESETS_AT) + 1000;
      await h.scheduler.tick();
      expect(h.mgr.pausedSessions()).toHaveLength(0);
      const byId = new Map(h.mgr.listSessions().map((s) => [s.id, s]));
      expect(byId.get(a)!.state).toBe("active");
      expect(byId.get(b)!.state).toBe("active");
      expect(byId.get(other)!.state).toBe("active");
      expect(byId.get(a)!.pausedUntil).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("resumes through `options.resume`, so it is the same conversation", async () => {
    const h = harness();
    try {
      const account = loggedIn(h, "work");
      const id = h.mgr.createSession({ cwd: h.root, accountId: account.id });
      // The provider session id the executor reported; a resume has to carry it.
      await Promise.resolve();
      h.db.prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?").run("prev-session", id);

      h.set(reading(99));
      await h.repoll();
      await h.scheduler.tick();

      h.clock.ms = Date.parse(RESETS_AT) + 1000;
      await h.scheduler.tick();

      expect(h.executor.starts).toHaveLength(2);
      expect(h.executor.starts[1]!.resumeSessionId).toBe("prev-session");
      // …on the same account, with the same autonomy: the whole row comes back, not just the id.
      expect(h.executor.starts[1]!.configDir).toBe(account.configDir);
    } finally {
      h.cleanup();
    }
  });

  it("tells the agent it was paused, rather than silently restarting it", async () => {
    const h = harness();
    try {
      const account = loggedIn(h, "work");
      h.mgr.createSession({ cwd: h.root, accountId: account.id });
      h.set(reading(99));
      await h.repoll();
      await h.scheduler.tick();

      h.clock.ms = Date.parse(RESETS_AT) + 1000;
      await h.scheduler.tick();

      // Sent to the *replacement* executor, which is index 1.
      const prompts = h.executor.promptsOf(1);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("You were paused");
      expect(prompts[0]).toContain("check what you had already finished before redoing anything");
    } finally {
      h.cleanup();
    }
  });

  it("holds a 429 with no known reset until a fresh reading clears it", async () => {
    const h = harness();
    try {
      const account = loggedIn(h, "work");
      h.mgr.createSession({ cwd: h.root, accountId: account.id });
      // Never polled, so nothing knows when this lifts.
      h.monitor.markLimited(account.id, "a session was refused with a rate-limit error");
      await h.scheduler.tick();
      expect(h.mgr.pausedSessions()[0]!.pausedUntil).toBeNull();

      // Time alone can never release it — there is no time to reach.
      h.clock.ms += 10 * 60 * 60 * 1000;
      await h.scheduler.tick();
      expect(h.mgr.pausedSessions()).toHaveLength(1);

      // A reading taken after the pause, saying the account is fine, is what releases it.
      h.set(reading(12));
      await h.repoll();
      await h.scheduler.tick();
      expect(h.mgr.pausedSessions()).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it("a stale reading — the one that caused the pause — can never undo it", async () => {
    const h = harness();
    try {
      const account = loggedIn(h, "work");
      h.mgr.createSession({ cwd: h.root, accountId: account.id });
      h.set(reading(99));
      await h.repoll();
      // Marked *after* the reading, so the reading is older than the pause it is about to cause.
      h.monitor.markLimited(account.id, "429");
      await h.scheduler.tick();
      expect(h.mgr.pausedSessions()).toHaveLength(1);

      // The same reading, still on file, still says 99 — but even a reading that said 5 would be
      // older than the pause and must not release it.
      h.set(reading(5));
      await h.scheduler.tick();
      expect(h.mgr.pausedSessions()).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it("does not pause again on the reading that caused the last pause", async () => {
    const h = harness();
    try {
      const account = loggedIn(h, "work");
      h.mgr.createSession({ cwd: h.root, accountId: account.id });
      h.set(reading(99));
      await h.repoll();
      await h.scheduler.tick();
      expect(h.mgr.pausedSessions()).toHaveLength(1);

      // The window rolls on the clock while the endpoint stays silent — the stored reading still
      // says 99. Resuming and immediately re-pausing on it would be an infinite loop the operator
      // would watch scroll past.
      h.clock.ms = Date.parse(RESETS_AT) + 1000;
      await h.scheduler.tick();
      expect(h.mgr.pausedSessions()).toHaveLength(0);
      await h.scheduler.tick();
      await h.scheduler.tick();
      expect(h.mgr.pausedSessions()).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it("a paused agent is not resurrected by a reboot's resumeAll — the scheduler owns that", async () => {
    const h = harness();
    try {
      const account = loggedIn(h, "work");
      h.mgr.createSession({ cwd: h.root, accountId: account.id });
      h.set(reading(99));
      await h.repoll();
      await h.scheduler.tick();
      await h.mgr.stopAll();

      // A reboot on the same database.
      const executor = new SteppableExecutor();
      const projects = new ProjectManager(h.db, h.root);
      const rebooted = new SessionManager(
        h.db, new EventStore(h.db), executor, new RoomManager(h.db, projects), projects,
        { accounts: h.accounts },
      );
      expect(rebooted.resumeAll()).toEqual([]);
      expect(executor.starts).toHaveLength(0);
      // Still held, with its countdown intact: the pause survived the restart.
      expect(rebooted.pausedSessions()).toHaveLength(1);
      expect(rebooted.pausedSessions()[0]!.pausedUntil).toBe(Math.floor(Date.parse(RESETS_AT) / 1000));
    } finally {
      h.cleanup();
    }
  });
});

describe("LimitScheduler: what it deliberately does not do", () => {
  it("never moves an agent to another account, however much room the other one has", async () => {
    const h = harness();
    try {
      const work = loggedIn(h, "work");
      const spare = loggedIn(h, "spare");
      const id = h.mgr.createSession({ cwd: h.root, accountId: work.id });

      h.monitor.markLimited(work.id, "429");
      await h.scheduler.tick();

      // Rotating onto a second subscription to evade a limit is the ToS line this project does not
      // cross (CLAUDE.md; docs/RESEARCH.md §5). The agent waits.
      const session = h.mgr.listSessions().find((s) => s.id === id)!;
      expect(session.state).toBe("paused");
      expect(session.accountId).toBe(work.id);
      expect(session.accountId).not.toBe(spare.id);
    } finally {
      h.cleanup();
    }
  });
});
