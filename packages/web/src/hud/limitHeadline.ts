import type { AccountInfo, AccountMetrics, AccountUsage } from "@superfabric/shared";
import { LIMIT_PAUSE_PERCENT, LIMIT_WARN_PERCENT } from "@superfabric/shared";

/**
 * What the permanent limit strip says, decided here rather than in the component.
 *
 * **The silence states are the point.** Limits used to be reachable only by opening the accounts
 * popover *and* having credentials in the account, while `scheduler.ts` pauses every agent on the
 * floor at `LIMIT_PAUSE_PERCENT`. With no accounts configured the surface rendered nothing at all —
 * and nothing reads as "fine". So every state in which there is no number produces a sentence, and
 * the three sentences are three different facts: nobody is measuring, nobody is logged in, or
 * nothing has been read yet.
 *
 * Pure, and separate from the component, because this is the part worth testing: this package mounts
 * no components (jsdom has no WebGL and the HUD floats over a canvas), so a pure function is the only
 * thing a test can actually check — the same reason `conveyorPath.ts` and `errands.ts` are pure.
 */

/** A state in which there is no figure to show. Each is a different fact. */
export type LimitSilence = "no-accounts" | "not-logged-in" | "no-reading";

/** The words, kept here so the component holds no copy and a test can assert on the state. */
export const SILENCE_TEXT: Record<LimitSilence, string> = {
  "no-accounts": "no limit reading",
  "not-logged-in": "not logged in",
  "no-reading": "no reading yet",
};

export type LimitSeverity = "none" | "ok" | "warn" | "critical";

export interface LimitHeadline {
  /** Non-null when there is no figure; the component renders `SILENCE_TEXT[silence]`. */
  silence: LimitSilence | null;
  severity: LimitSeverity;
  accountId: string | null;
  accountLabel: string | null;
  /** Whether to print the label beside the figure — only meaningful with more than one account. */
  showLabel: boolean;
  /** 0–100, from the fullest window of the worst account. */
  utilization: number | null;
  windowLabel: string | null;
  /** The reading was counted from local transcripts rather than read from the provider. */
  approximate: boolean;
  /** Seconds until the scheduler would pause this account, or null when unprojectable. */
  secondsToLimit: number | null;
  /**
   * Why there is no projection, in the server's own words. Null both when there *is* one and when
   * nothing has been measured at all — `secondsToLimit === null && burnUnknown === null` is the third
   * state, "never asked", which `BurnRate` already distinguishes and this must not flatten.
   */
  burnUnknown: string | null;
  limited: boolean;
}

const SILENT = (silence: LimitSilence): LimitHeadline => ({
  silence,
  severity: "none",
  accountId: null,
  accountLabel: null,
  showLabel: false,
  utilization: null,
  windowLabel: null,
  approximate: false,
  secondsToLimit: null,
  burnUnknown: null,
  limited: false,
});

/** Where a reading sits relative to what the scheduler will actually do about it. */
function severityOf(utilization: number, limited: boolean): LimitSeverity {
  if (limited || utilization >= LIMIT_PAUSE_PERCENT) return "critical";
  if (utilization >= LIMIT_WARN_PERCENT) return "warn";
  return "ok";
}

/** The fullest window of one reading, or null when it has none. */
function fullestWindow(usage: AccountUsage): { utilization: number; label: string } | null {
  let best: { utilization: number; label: string } | null = null;
  for (const w of usage.windows) {
    if (best === null || w.utilization > best.utilization) {
      best = { utilization: w.utilization, label: w.label };
    }
  }
  return best;
}

/**
 * The worst account, and what to say about it.
 *
 * "Worst" is `limited` first, then the fullest window — deliberately **not** the shortest
 * `secondsToLimit`, which is the more precise question. A projection is null far more often than it
 * is present (one reading, too short a span, a window that is not filling), so ranking by it would
 * reorder the strip as measurements trickle in and leave it unranked exactly when the operator is
 * new to the machine. Utilization is always there; the projection rides along beside it.
 *
 * Providers are not a dimension here, and that is deliberate: an agent stopped because its Codex
 * account is spent is exactly as stopped as one held on a Claude limit, so the strip ranks them by
 * the same rule and names the account rather than the CLI.
 */
export function limitHeadline(
  accounts: readonly AccountInfo[],
  usage: readonly AccountUsage[],
  metrics: readonly AccountMetrics[],
): LimitHeadline {
  if (accounts.length === 0) return SILENT("no-accounts");

  const loggedIn = accounts.filter((a) => a.credentialsPresent);
  if (loggedIn.length === 0) return SILENT("not-logged-in");

  interface Candidate {
    account: AccountInfo;
    reading: AccountUsage;
    window: { utilization: number; label: string };
  }

  const candidates: Candidate[] = [];
  for (const account of loggedIn) {
    const reading = usage.find((u) => u.accountId === account.id);
    if (reading === undefined || reading.readAt === null) continue;
    const window = fullestWindow(reading);
    if (window === null) continue;
    candidates.push({ account, reading, window });
  }
  if (candidates.length === 0) return SILENT("no-reading");

  let worst = candidates[0];
  for (const c of candidates.slice(1)) {
    const beatsOnLimit = c.reading.limited && !worst.reading.limited;
    const tiedOnLimit = c.reading.limited === worst.reading.limited;
    if (beatsOnLimit || (tiedOnLimit && c.window.utilization > worst.window.utilization)) worst = c;
  }

  const burn = metrics.find((m) => m.accountId === worst.account.id)?.burn;
  return {
    silence: null,
    severity: severityOf(worst.window.utilization, worst.reading.limited),
    accountId: worst.account.id,
    accountLabel: worst.account.label,
    // One account needs no attribution; with two or more an unlabelled number is ambiguous.
    showLabel: accounts.length > 1,
    utilization: worst.window.utilization,
    windowLabel: worst.window.label,
    approximate: worst.reading.approximate,
    secondsToLimit: burn?.secondsToLimit ?? null,
    burnUnknown: burn === undefined ? null : burn.secondsToLimit === null ? burn.unknown : null,
    limited: worst.reading.limited,
  };
}
