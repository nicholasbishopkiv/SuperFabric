import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../src/accountManager.js";
import { openDb } from "../src/db.js";
import { LimitMonitor } from "../src/limitMonitor.js";
import { CodexUsageAdapter } from "../src/usageAdapters.js";

/**
 * Codex's limits, read out of the records its own CLI writes.
 *
 * The shape below is captured verbatim from `codex-cli 0.146.0` (`notes/codex-cli.md`). Two of these
 * cases are about numbers that would be *wrong to act on*: a window that has already reset, and a
 * plan window at 100 % on an account that still has credits — which is not hypothetical, it is what
 * a free plan reports while working perfectly well.
 */

const HOUR = 3600;

interface Limits {
  primary?: unknown;
  secondary?: unknown;
  credits?: unknown;
  plan_type?: string;
  spend_control_reached?: boolean;
  rate_limit_reached_type?: string | null;
}

/** A `CODEX_HOME` holding one session record with the given rate limits. */
function codexHome(limits: Limits, at = new Date()): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-codex-usage-"));
  const day = join(dir, "sessions", "2026", "08", "05");
  mkdirSync(day, { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: at.toISOString(), type: "session_meta", payload: {} }),
    JSON.stringify({
      timestamp: at.toISOString(),
      type: "event_msg",
      payload: { type: "token_count", info: {}, rate_limits: limits },
    }),
  ];
  writeFileSync(join(day, "rollout-2026-08-05T00-16-41-abc.jsonl"), `${lines.join("\n")}\n`);
  return dir;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

describe("reading codex's own record", () => {
  it("reports the provider's numbers as a measurement, not an estimate", async () => {
    const dir = codexHome({
      primary: { used_percent: 21, window_minutes: 300, resets_at: nowSeconds() + 2 * HOUR },
      secondary: { used_percent: 11, window_minutes: 10080, resets_at: nowSeconds() + 40 * HOUR },
      plan_type: "plus",
    });
    try {
      const reading = await new CodexUsageAdapter().read({ id: "a", configDir: dir });

      // These came from the API through codex, so they carry the same standing as a reading from
      // Anthropic's endpoint — nothing here is measured against a budget we assumed.
      expect(reading.source).toBe("endpoint");
      expect(reading.approximate).toBe(false);
      expect(reading.windows.map((w) => `${w.label} ${w.utilization}`)).toEqual(["5-hour 21", "weekly 11"]);
      expect(reading.note).toMatch(/plan: plus/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dates the reading to when codex wrote it, not to when we looked", async () => {
    const wroteAt = new Date(Date.now() - 6 * HOUR * 1000);
    const dir = codexHome({
      primary: { used_percent: 40, window_minutes: 300, resets_at: nowSeconds() + HOUR },
    }, wroteAt);
    try {
      const reading = await new CodexUsageAdapter().read({ id: "a", configDir: dir });
      // A six-hour-old figure shown as freshly read would be the meter lying about its own age —
      // and this reading cannot refresh itself until the operator runs a turn.
      expect(reading.readAt).toBe(Math.floor(wroteAt.getTime() / 1000));
      expect(reading.note).toMatch(/as recorded by codex/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops a window that has already reset rather than showing a stale number", async () => {
    const dir = codexHome({
      primary: { used_percent: 96, window_minutes: 300, resets_at: nowSeconds() - 60 },
      secondary: { used_percent: 12, window_minutes: 10080, resets_at: nowSeconds() + 40 * HOUR },
    });
    try {
      const reading = await new CodexUsageAdapter().read({ id: "a", configDir: dir });
      // The 96 % was true before the window rolled overnight. Showing it would hold agents for a
      // limit that no longer exists — and unlike a Claude reading, this one cannot correct itself.
      expect(reading.windows.map((w) => w.label)).toEqual(["weekly"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not call an account stopped when the window is full but credits remain", async () => {
    const dir = codexHome({
      primary: { used_percent: 100, window_minutes: 43200, resets_at: nowSeconds() + 100 * HOUR },
      credits: { has_credits: true, unlimited: false, balance: "3918.36" },
      plan_type: "free",
    });
    try {
      const reading = await new CodexUsageAdapter().read({ id: "a", configDir: dir });
      // Exactly what a free plan reports while working perfectly well. The percentage is shown; the
      // decision comes from what the provider says about spending.
      expect(reading.windows[0]!.utilization).toBe(100);
      expect(reading.blocked).toBe(false);
      expect(reading.note).toMatch(/credits are available, so this account is not held/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does call it stopped when the provider says spending is over", async () => {
    const dir = codexHome({
      primary: { used_percent: 100, window_minutes: 300, resets_at: nowSeconds() + HOUR },
      credits: { has_credits: true, balance: "10" },
      spend_control_reached: true,
    });
    try {
      expect((await new CodexUsageAdapter().read({ id: "a", configDir: dir })).blocked).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says an account has told us nothing rather than reporting zero usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-codex-empty-"));
    try {
      // An empty meter reads as "you have used nothing", which is the wrong direction to be wrong in.
      await expect(new CodexUsageAdapter().read({ id: "a", configDir: dir }))
        .rejects.toThrow(/recorded no limits/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the monitor, with two providers on it", () => {
  it("reads each account through its own provider's adapter", async () => {
    const codexDir = codexHome({
      primary: { used_percent: 33, window_minutes: 300, resets_at: nowSeconds() + HOUR },
    });
    const claudeDir = mkdtempSync(join(tmpdir(), "sf-claude-"));
    try {
      writeFileSync(join(claudeDir, ".credentials.json"), "{}");
      writeFileSync(join(codexDir, "auth.json"), "{}");
      const db = openDb(":memory:");
      const accounts = new AccountManager(db);
      const claude = accounts.create({ label: "work", configDir: claudeDir });
      const codex = accounts.create({ label: "openai", configDir: codexDir, provider: "codex" });

      const monitor = new LimitMonitor(db, accounts, {
        primary: {
          name: "stub",
          read: async () => ({
            source: "endpoint", approximate: false, note: null,
            windows: [{ key: "five_hour", label: "5-hour", utilization: 7, resetsAt: null, detail: null }],
          }),
        },
        byProvider: { codex: new CodexUsageAdapter() },
      });
      await monitor.pollAll();

      // One list, two providers, each read in its own vocabulary — which is the whole point of the
      // account row carrying a provider.
      expect(monitor.usageOf(claude.id)!.windows[0]!.utilization).toBe(7);
      expect(monitor.usageOf(codex.id)!.windows[0]!.utilization).toBe(33);
    } finally {
      rmSync(codexDir, { recursive: true, force: true });
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });

  it("never falls back to the transcript estimate for a provider it is not about", async () => {
    const codexDir = mkdtempSync(join(tmpdir(), "sf-codex-none-"));
    try {
      writeFileSync(join(codexDir, "auth.json"), "{}");
      const db = openDb(":memory:");
      const accounts = new AccountManager(db);
      const codex = accounts.create({ label: "openai", configDir: codexDir, provider: "codex" });
      let estimates = 0;

      const monitor = new LimitMonitor(db, accounts, {
        fallback: {
          name: "estimate",
          read: async () => {
            estimates++;
            return { source: "estimate", approximate: true, windows: [], note: "a guess" };
          },
        },
        byProvider: { codex: new CodexUsageAdapter() },
      });
      await monitor.pollAll();

      // Counting `~/.claude` transcripts says nothing about a Codex account: a guess about the wrong
      // CLI is worse than an empty meter, so the reading is empty and the note says why.
      expect(estimates).toBe(0);
      expect(monitor.usageOf(codex.id)!.windows).toEqual([]);
      expect(monitor.usageOf(codex.id)!.note).toMatch(/recorded no limits/);
      expect(monitor.usageOf(codex.id)!.approximate).toBe(false);
    } finally {
      rmSync(codexDir, { recursive: true, force: true });
    }
  });

  it("does not poll an account whose provider it has no adapter for", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-codex-noadapter-"));
    try {
      writeFileSync(join(dir, "auth.json"), "{}");
      const db = openDb(":memory:");
      const accounts = new AccountManager(db);
      const codex = accounts.create({ label: "openai", configDir: dir, provider: "codex" });
      let claudeReads = 0;

      const monitor = new LimitMonitor(db, accounts, {
        primary: { name: "stub", read: async () => { claudeReads++; throw new Error("never"); } },
        // No `byProvider` at all: a server built before the second provider, or one that dropped it.
      });
      await monitor.pollAll();

      // A Claude reading taken from another CLI's directory would be a number about nothing.
      expect(claudeReads).toBe(0);
      expect(monitor.usageOf(codex.id)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
