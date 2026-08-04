import type { AccountInfo, AccountMetrics, AccountUsage } from "@superfabric/shared";
import { describe, expect, it } from "vitest";
import { limitHeadline } from "../src/hud/limitHeadline";

/**
 * The rules behind the one number the operator sees without opening anything.
 *
 * Most of these tests are about *silence*. The product's stance is that an estimate presented as a
 * fact is worse than an honest gap — and the corollary, which is the whole reason this surface
 * exists, is that a **blank reads as "fine"**. Every state in which there is no figure must
 * therefore produce a sentence, and each of those sentences is a different fact.
 */

const account = (over: Partial<AccountInfo> = {}): AccountInfo => ({
  id: "a1",
  label: "work",
  provider: "claude",
  configDir: "/home/x/.claude-work",
  credentialsPresent: true,
  createdAt: 0,
  lastUsedAt: null,
  login: { status: "idle", url: null, message: null },
  ...over,
});

const usageFor = (accountId: string, utilization: number, over: Partial<AccountUsage> = {}): AccountUsage => ({
  accountId,
  source: "endpoint",
  approximate: false,
  windows: [{ key: "five_hour", label: "5-hour", utilization, resetsAt: null, detail: null }],
  readAt: 1_000,
  note: null,
  limited: false,
  limitedUntil: null,
  limitedBy: null,
  ...over,
});

const metricsFor = (
  accountId: string,
  secondsToLimit: number | null,
  unknown: string | null,
): AccountMetrics => ({
  accountId,
  burn: {
    accountId,
    windowKey: "five_hour",
    windowLabel: "5-hour",
    percentPerHour: secondsToLimit === null ? null : 4,
    secondsToLimit,
    resetsFirst: false,
    approximate: false,
    unknown,
    samples: 6,
    spanSeconds: 3600,
  },
  cost: { day: { usd: 1, turns: 2 }, week: { usd: 3, turns: 5 } },
});

describe("limitHeadline — silence states", () => {
  it("says agents run on the ambient config when there are no accounts", () => {
    const h = limitHeadline([], [], []);
    expect(h.silence).toBe("no-accounts");
    expect(h.utilization).toBeNull();
    expect(h.severity).toBe("none");
  });

  it("says not logged in when every account lacks credentials", () => {
    const h = limitHeadline([account({ credentialsPresent: false })], [], []);
    expect(h.silence).toBe("not-logged-in");
  });

  it("says there is no reading yet when a logged-in account has never been polled", () => {
    const h = limitHeadline([account()], [], []);
    expect(h.silence).toBe("no-reading");
  });

  it("treats a reading with no windows as no reading", () => {
    const h = limitHeadline([account()], [usageFor("a1", 0, { windows: [], readAt: null })], []);
    expect(h.silence).toBe("no-reading");
  });

  it("ignores an account with no credentials when another has a reading", () => {
    const accounts = [
      account({ id: "a1", credentialsPresent: false }),
      account({ id: "a2", label: "personal" }),
    ];
    const h = limitHeadline(accounts, [usageFor("a2", 40)], []);
    expect(h.silence).toBeNull();
    expect(h.accountId).toBe("a2");
  });
});

describe("limitHeadline — choosing the worst account", () => {
  it("picks the highest utilization", () => {
    const accounts = [account({ id: "a1", label: "work" }), account({ id: "a2", label: "personal" })];
    const h = limitHeadline(accounts, [usageFor("a1", 30), usageFor("a2", 71)], []);
    expect(h.accountId).toBe("a2");
    expect(h.utilization).toBe(71);
  });

  it("takes the fullest window within an account, not the first", () => {
    const usage = usageFor("a1", 12);
    usage.windows.push({ key: "seven_day", label: "7-day", utilization: 88, resetsAt: null, detail: null });
    const h = limitHeadline([account()], [usage], []);
    expect(h.utilization).toBe(88);
    expect(h.windowLabel).toBe("7-day");
  });

  it("an account already at its limit outranks a fuller one that is not", () => {
    const accounts = [account({ id: "a1" }), account({ id: "a2" })];
    const usage = [usageFor("a1", 20, { limited: true }), usageFor("a2", 92)];
    const h = limitHeadline(accounts, usage, []);
    expect(h.accountId).toBe("a1");
    expect(h.limited).toBe(true);
    expect(h.severity).toBe("critical");
  });

  it("ranks across providers by the same rule, because a stopped agent is a stopped agent", () => {
    const accounts = [
      account({ id: "a1", label: "claude", provider: "claude" }),
      account({ id: "a2", label: "codex", provider: "codex" }),
    ];
    const h = limitHeadline(accounts, [usageFor("a1", 30), usageFor("a2", 84)], []);
    expect(h.accountId).toBe("a2");
    expect(h.severity).toBe("warn");
  });

  it("shows the account label only when more than one account is configured", () => {
    expect(limitHeadline([account()], [usageFor("a1", 10)], []).showLabel).toBe(false);
    const two = [account({ id: "a1" }), account({ id: "a2" })];
    expect(limitHeadline(two, [usageFor("a1", 10), usageFor("a2", 5)], []).showLabel).toBe(true);
  });
});

describe("limitHeadline — severity follows the scheduler's own thresholds", () => {
  it("is ok below the warn threshold", () => {
    expect(limitHeadline([account()], [usageFor("a1", 79.9)], []).severity).toBe("ok");
  });

  it("warns at exactly the warn threshold", () => {
    expect(limitHeadline([account()], [usageFor("a1", 80)], []).severity).toBe("warn");
  });

  it("is critical at exactly the pause threshold", () => {
    expect(limitHeadline([account()], [usageFor("a1", 95)], []).severity).toBe("critical");
  });
});

describe("limitHeadline — provenance travels with the figure", () => {
  it("marks an estimated reading", () => {
    const h = limitHeadline(
      [account()],
      [usageFor("a1", 50, { approximate: true, source: "estimate" })],
      [],
    );
    expect(h.approximate).toBe(true);
  });

  it("carries the projection when there is one", () => {
    const h = limitHeadline([account()], [usageFor("a1", 50)], [metricsFor("a1", 7200, null)]);
    expect(h.secondsToLimit).toBe(7200);
    expect(h.burnUnknown).toBeNull();
  });

  it("carries the server's reason verbatim when there is no projection", () => {
    const h = limitHeadline(
      [account()],
      [usageFor("a1", 50)],
      [metricsFor("a1", null, "only one reading so far")],
    );
    expect(h.secondsToLimit).toBeNull();
    expect(h.burnUnknown).toBe("only one reading so far");
  });

  it("distinguishes never-measured from measured-and-unanswerable", () => {
    const h = limitHeadline([account()], [usageFor("a1", 50)], []);
    expect(h.secondsToLimit).toBeNull();
    expect(h.burnUnknown).toBeNull();
  });
});
