import {
  type AccountUsage,
  LIMIT_PAUSE_PERCENT,
  LIMIT_WARN_PERCENT,
  type UsageWindow,
} from "@superfabric/shared";
import type { AccountManager } from "./accountManager.js";
import { type LimitMonitor, worstWindow } from "./limitMonitor.js";
import type { SessionManager } from "./sessionManager.js";

/**
 * Turning utilisation into action: warn, pause, resume.
 *
 * Three rules, and each of them is a decision about what to do to someone else's work:
 *
 * - **80 % — warn.** A short turn into every agent on that account saying the limit is close, so it
 *   can commit, write up and reach a stopping point of its own choosing. It is a turn rather than a
 *   toast because the agent is the one who has to act on it, and the operator may not be there.
 * - **95 % — pause.** The agent is stopped **at its next turn boundary**, its state is persisted, and
 *   the floor shows a countdown. Never mid-turn: interrupting a turn throws away the tokens it has
 *   already spent, which is the opposite of the point.
 * - **`resets_at` — resume**, from the stored `claude_session_id`, and the agent is told what
 *   happened to it.
 *
 * ## Two things this deliberately does not do
 *
 * **It never moves an agent to another account.** If a subscription is exhausted, its agents wait
 * for its window to roll. Rotating them onto a second subscription is the ToS line SuperFabric does
 * not cross (`CLAUDE.md`; `docs/RESEARCH.md` §5) — there is no "least-loaded account" anywhere in
 * this file, and there must never be one.
 *
 * **It never pauses on a guess.** A reading from the local-transcript estimate cannot see other
 * devices and does not know when the real window began, so it may be wildly wrong in either
 * direction — and being wrong in one of those directions means stopping an agent that had plenty of
 * quota left. An approximate reading is allowed to *warn* (a warning costs a sentence) and never to
 * pause. The provider itself refusing a turn with a 429 is a different thing entirely: that is not
 * an estimate, and it pauses whatever the meters say.
 */

/** How often the scheduler re-examines the world when nothing has changed. */
const DEFAULT_TICK_MS = 30_000;

/** A warn ledger entry older than this is dropped; the longest window is seven days. */
const LEDGER_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface LimitSchedulerDeps {
  monitor: LimitMonitor;
  sessions: SessionManager;
  accounts: AccountManager;
  /** Milliseconds. Injected so every threshold can be driven by a fake clock. */
  now?: () => number;
  warnAt?: number;
  pauseAt?: number;
  tickMs?: number;
  /** Something was warned, paused or resumed and the session list should be pushed. */
  onChange?: () => void;
}

export class LimitScheduler {
  private readonly now: () => number;
  private readonly warnAt: number;
  private readonly pauseAt: number;
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /**
   * `accountId|windowKey|resetsAt` -> when we warned, so **a threshold fires once and not per poll**.
   *
   * The reset time is part of the key rather than a separate "have we warned this window" flag: when
   * the window rolls, `resets_at` changes and the next crossing is a genuinely new event that must be
   * announced again. A flag would have had to be cleared by something, and whatever cleared it would
   * be the bug.
   */
  private warned = new Map<string, number>();
  /**
   * accountId -> when its agents were last resumed, in ms.
   *
   * Guards the one loop this design could otherwise fall into: a resume, followed immediately by a
   * pause driven by the *stale* reading that caused the first pause. An account is not paused again
   * until a reading taken after the resume says so.
   */
  private resumedAtMs = new Map<string, number>();

  constructor(private deps: LimitSchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.warnAt = deps.warnAt ?? LIMIT_WARN_PERCENT;
    this.pauseAt = deps.pauseAt ?? LIMIT_PAUSE_PERCENT;
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  }

  /**
   * Run on every fresh reading, and on a timer besides.
   *
   * The timer is not redundant: a resume is due at a wall-clock instant, and the monitor only speaks
   * when it has read something. Without it an account whose window rolled while the endpoint was
   * unavailable would stay paused with nobody to notice.
   */
  start(): void {
    if (this.timer !== null) return;
    this.deps.monitor.onChange(() => { void this.tick(); });
    this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
    // A pending tick must never be the reason the process refuses to exit.
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Examine every account once: resume what is due, then warn and pause on what is not.
   *
   * Resume comes first on purpose. An account whose window has just rolled should have its agents
   * back *before* this tick considers whether anyone needs warning, so the freshly-resumed agents are
   * warned by the same reading that resumed them rather than a tick later.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let changed = false;
      this.prune();
      for (const account of this.deps.accounts.list()) {
        const usage = this.deps.monitor.usageOf(account.id);
        if (await this.resumeDue(account.id, account.label, usage)) changed = true;
        if (usage === undefined) continue;
        if (this.warn(account.id, account.label, usage)) changed = true;
        if (await this.pause(account.id, account.label, usage)) changed = true;
      }
      if (changed) this.deps.onChange?.();
    } finally {
      this.ticking = false;
    }
  }

  // ---- warn ---------------------------------------------------------------------------------------

  /**
   * Tell this account's agents a limit is close, once per window per window-instance.
   *
   * An **approximate** reading may warn. A warning costs one sentence and cannot hurt anyone; it is
   * only the *pause* that has to be certain. The text says which it is, so an agent reading "this is
   * an estimate" can weigh it accordingly.
   */
  private warn(accountId: string, label: string, usage: AccountUsage): boolean {
    let warned = false;
    for (const window of usage.windows) {
      if (window.utilization < this.warnAt) continue;
      const key = `${accountId}|${window.key}|${window.resetsAt ?? "?"}`;
      if (this.warned.has(key)) continue;

      const sessions = this.deps.sessions.liveSessionsOnAccount(accountId);
      // Recorded even when nobody is running, so an agent started a minute later is not greeted by a
      // warning about a threshold that was crossed before it existed.
      this.warned.set(key, this.now());
      if (sessions.length === 0) continue;

      const text = warningText(label, window, usage.approximate);
      for (const sessionId of sessions) {
        // `prompt` is the same push the factory bus delivers through: the SDK's streaming input
        // takes the turn now and the agent reads it when its current one ends.
        try { this.deps.sessions.prompt(sessionId, text); } catch { /* it stopped between the two calls */ }
      }
      warned = true;
    }
    return warned;
  }

  // ---- pause --------------------------------------------------------------------------------------

  /** Should this account's agents be held? See the class comment for why a guess never gets to say yes. */
  private shouldPause(usage: AccountUsage): { yes: boolean; window: UsageWindow | null } {
    // The provider refused a turn. Not an estimate, not a threshold — the limit, observed.
    if (usage.limitedBy === "rate_limit_error") return { yes: true, window: worstWindow(usage.windows) };
    if (usage.approximate) return { yes: false, window: null };
    const window = worstWindow(usage.windows);
    return { yes: window !== null && window.utilization >= this.pauseAt, window };
  }

  private async pause(accountId: string, label: string, usage: AccountUsage): Promise<boolean> {
    const { yes, window } = this.shouldPause(usage);
    if (!yes) return false;

    // A reading older than the last resume is the reading that caused it. Acting on it again would
    // pause the agents we have just brought back, forever, one tick at a time.
    const resumedAt = this.resumedAtMs.get(accountId);
    if (resumedAt !== undefined && (usage.readAt === null || usage.readAt * 1000 <= resumedAt)) {
      if (usage.limitedBy !== "rate_limit_error") return false;
    }

    const until = resetSeconds(usage.limitedUntil ?? window?.resetsAt ?? null);
    const reason = pauseReason(label, usage, window);
    let paused = false;
    for (const sessionId of this.deps.sessions.liveSessionsOnAccount(accountId)) {
      const outcome = await this.deps.sessions.pauseSession(sessionId, until, reason);
      if (outcome !== "already-paused") paused = true;
    }
    return paused;
  }

  // ---- resume -------------------------------------------------------------------------------------

  /**
   * Bring back exactly the agents that were paused on this account, and only once the window has
   * actually rolled.
   *
   * Two ways to know it has, and both are required to be *about this pause*:
   *
   * 1. The reset time recorded when the agent was paused has passed. This is the ordinary path and it
   *    works with no endpoint at all — a wall clock is enough.
   * 2. A reading **taken after the pause** says the account is no longer at its limit. This is what
   *    covers a pause with no known reset (a 429 nobody could put a time on) and a window that rolled
   *    earlier than its stated time. A reading from *before* the pause is the reading that caused it
   *    and can never authorise undoing it.
   */
  private async resumeDue(
    accountId: string,
    label: string,
    usage: AccountUsage | undefined,
  ): Promise<boolean> {
    const paused = this.deps.sessions.pausedSessions().filter((s) => s.accountId === accountId);
    if (paused.length === 0) return false;

    const nowMs = this.now();
    let resumed = false;
    for (const session of paused) {
      const timeIsUp = session.pausedUntil !== null && nowMs >= session.pausedUntil * 1000;
      const readingClears = usage !== undefined
        && usage.readAt !== null
        && (session.pausedAt === null || usage.readAt > session.pausedAt)
        && !this.shouldPause(usage).yes;
      if (!timeIsUp && !readingClears) continue;

      if (this.deps.sessions.resumeSession(session.id, `${label}'s limit window has rolled — resuming`)) {
        // Told, not silently restarted: an agent that comes back after an unexplained gap repeats
        // work it already did, or worse, assumes its last tool call failed.
        try { this.deps.sessions.prompt(session.id, resumeText(label)); } catch { /* it did not come up */ }
        resumed = true;
      }
    }
    if (resumed) this.resumedAtMs.set(accountId, nowMs);
    return resumed;
  }

  /** Keep the fire-once ledger from growing without bound on a long-lived server. */
  private prune(): void {
    const cutoff = this.now() - LEDGER_TTL_MS;
    for (const [key, at] of this.warned) {
      if (at < cutoff) this.warned.delete(key);
    }
  }
}

/** `2026-08-04T04:10:00Z` -> unix seconds, or null for anything that will not parse. */
function resetSeconds(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** A reset time as something a person (or an agent) reads, or a plain admission that we do not know. */
function when(iso: string | null): string {
  if (iso === null) return "an unknown time";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(".000", "") : iso;
}

/**
 * The turn an agent gets at 80 %.
 *
 * Written to be *actionable in one read*: what is nearly full, when it rolls, what will happen, and
 * what to do about it now. It says "estimated" out loud when it is, because an agent told to wrap up
 * on the strength of a guess should be able to weigh that.
 */
export function warningText(accountLabel: string, window: UsageWindow, approximate: boolean): string {
  return [
    `[SuperFabric] The account "${accountLabel}" is at ${Math.round(window.utilization)}% of its `
    + `${window.label} limit, which resets at ${when(window.resetsAt)}.`
    + (approximate ? " (This is an estimate from local transcripts, not a reading from Anthropic.)" : ""),
    "Please bring what you are doing to a safe stopping point now: commit or write up anything "
    + "unfinished, record any decision worth keeping, and hand off what you cannot complete.",
    `At ${LIMIT_PAUSE_PERCENT}% SuperFabric will pause you at the end of a turn and resume you `
    + "automatically when the window rolls — you will not lose the conversation, but you will lose "
    + "whatever is only in your head.",
  ].join("\n");
}

/** The one line the log, the floor and the countdown all show for a paused agent. */
export function pauseReason(
  accountLabel: string,
  usage: AccountUsage,
  window: UsageWindow | null,
): string {
  const cause = usage.limitedBy === "rate_limit_error"
    ? "the provider refused a turn with a rate-limit error"
    : `its ${window?.label ?? "limit"} window is at ${Math.round(window?.utilization ?? 100)}%`;
  const until = usage.limitedUntil ?? window?.resetsAt ?? null;
  return `paused — the account "${accountLabel}" is at its limit (${cause}); `
    + (until === null ? "resuming when the limit lifts" : `resuming at ${when(until)}`);
}

/** The turn an agent gets when it comes back. */
export function resumeText(accountLabel: string): string {
  return `[SuperFabric] You were paused because the account "${accountLabel}" reached its limit. `
    + "That window has now rolled and you are running again — this is the same conversation, so "
    + "check what you had already finished before redoing anything, then carry on.";
}
