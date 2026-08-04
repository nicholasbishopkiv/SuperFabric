import {
  type AccountUsage,
  LIMIT_PAUSE_PERCENT,
  USAGE_POLL_INTERVAL_MS,
  type UsageWindow,
} from "@superfabric/shared";
import type { AccountManager } from "./accountManager.js";
import type { Db } from "./db.js";
import {
  OAuthUsageAdapter,
  TranscriptEstimateAdapter,
  type UsageAdapter,
  type UsageReading,
} from "./usageAdapters.js";

/**
 * What each account's limits are, and keeping that answer current.
 *
 * Three properties are the whole class:
 *
 * 1. **It polls no faster than the research says is safe.** `USAGE_POLL_INTERVAL_MS` is a floor
 *    enforced per account, not a timer interval that a second caller could shorten — a monitor that
 *    earns a 429 is a monitor that causes the thing it watches for.
 * 2. **A degraded reading is visible, never silent.** The primary source is undocumented and will
 *    change. When it does, the fallback answers and the reading is marked `approximate` with the
 *    reason attached, all the way to the meter on screen.
 * 3. **A 429 from a live session is believed immediately.** It is the earliest and most certain
 *    signal that an account is spent, and waiting up to three minutes for a poll to agree would be
 *    silly. `markLimited` is that door.
 *
 * Snapshots are persisted, so a restart comes back with the meters it had rather than with blanks —
 * an empty meter reads as "you have used nothing", which is the wrong direction to be wrong in.
 */

/** A reading that has never happened: what an account looks like before its first poll. */
function emptyUsage(accountId: string): AccountUsage {
  return {
    accountId,
    source: "endpoint",
    approximate: false,
    windows: [],
    readAt: null,
    note: null,
    limited: false,
    limitedUntil: null,
  };
}

/** Row shape of `usage_snapshots`, as the newest-per-account query returns it. */
interface SnapshotRow {
  account_id: string;
  read_at: number;
  source: string;
  approximate: number;
  windows: string;
  note: string | null;
  limited: number;
  limited_until: string | null;
}

export interface LimitMonitorOptions {
  /** The authoritative source. Defaults to the OAuth usage endpoint. */
  primary?: UsageAdapter;
  /** Used when the primary throws. Defaults to counting local transcripts. */
  fallback?: UsageAdapter;
  /** Milliseconds. Injected so a fake clock can drive the poll-interval rule. */
  now?: () => number;
  /**
   * The floor under how often one account is read. Overridable **downwards only in tests** — the
   * default is what `docs/RESEARCH.md` §2 calls safe against an endpoint nobody promised us.
   */
  minIntervalMs?: number;
  /** Something changed and every attached socket should see fresh meters. */
  onChange?: () => void;
}

export class LimitMonitor {
  private readonly stmts;
  private readonly primary: UsageAdapter;
  private readonly fallback: UsageAdapter;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  /** accountId -> the newest reading. Hydrated from the database at construction. */
  private readings = new Map<string, AccountUsage>();
  /** accountId -> when it was last *attempted*, in ms. A failed read still spends the interval. */
  private lastAttemptMs = new Map<string, number>();
  private listeners: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** One poll at a time: an overlapping sweep would double the request rate this class exists to cap. */
  private polling = false;

  constructor(
    private db: Db,
    private accounts: AccountManager,
    opts: LimitMonitorOptions = {},
  ) {
    this.primary = opts.primary ?? new OAuthUsageAdapter();
    this.fallback = opts.fallback ?? new TranscriptEstimateAdapter();
    this.now = opts.now ?? (() => Date.now());
    this.minIntervalMs = opts.minIntervalMs ?? USAGE_POLL_INTERVAL_MS;
    if (opts.onChange !== undefined) this.listeners.push(opts.onChange);

    this.stmts = {
      insert: db.prepare(
        "INSERT INTO usage_snapshots (account_id, read_at, source, approximate, windows, note, limited, limited_until)"
        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      // The newest row per account, in one statement: a per-account query inside a loop is
      // O(accounts) round trips on every boot for a list that is three rows long, and the shape
      // generalises to a machine with twenty.
      newest: db.prepare(`
        SELECT s.account_id, s.read_at, s.source, s.approximate, s.windows, s.note, s.limited, s.limited_until
        FROM usage_snapshots s
        JOIN (SELECT account_id, MAX(read_at) AS read_at FROM usage_snapshots GROUP BY account_id) n
          ON n.account_id = s.account_id AND n.read_at = s.read_at
        GROUP BY s.account_id
      `),
    };
    this.hydrate();
  }

  /** Be told when a reading changed. Same idiom as `AccountManager.onChange`. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private announce(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* a listener's failure is not the monitor's */ }
    }
  }

  /**
   * Bring the last known reading of every account back into memory.
   *
   * Persistence exists for exactly this moment: without it a reboot shows every meter empty, and an
   * empty meter is indistinguishable from a fresh window. `limited` comes back too — an account that
   * was at its limit when the server went down is still at its limit when it comes up.
   */
  private hydrate(): void {
    for (const row of this.stmts.newest.all() as SnapshotRow[]) {
      this.readings.set(row.account_id, rowToUsage(row));
    }
  }

  /** Every account's meters, in the account list's own order. Accounts never polled report empty. */
  list(): AccountUsage[] {
    return this.accounts.list().map((a) => this.readings.get(a.id) ?? emptyUsage(a.id));
  }

  /** One account's meters, or `undefined` for an account this monitor holds nothing for. */
  usageOf(accountId: string): AccountUsage | undefined {
    return this.readings.get(accountId);
  }

  /**
   * Start polling. Idempotent, and the timer never keeps the process alive — an unread meter is not
   * a reason for a server to refuse to exit.
   *
   * The first sweep runs immediately so a fresh boot has numbers before the first three minutes are
   * up; the per-account floor still applies, so a restart loop cannot turn that into a request storm.
   */
  start(): void {
    if (this.timer !== null) return;
    void this.pollAll();
    this.timer = setInterval(() => { void this.pollAll(); }, this.minIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Read every account that is due. Accounts read recently are skipped rather than queued: the floor
   * is per account, so adding a tenth account does not make the first one nine times quieter.
   *
   * An account with no credentials is skipped entirely. There is nothing to authenticate with, and
   * the estimate would only report the transcripts of an account that has never run anything.
   */
  async pollAll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      let changed = false;
      for (const account of this.accounts.list()) {
        if (!this.isDue(account.id)) continue;
        if (!this.accounts.credentialsPresent(account.id)) continue;
        if (await this.poll(account.id, account.configDir)) changed = true;
      }
      if (changed) this.announce();
    } finally {
      this.polling = false;
    }
  }

  /** Has this account's interval elapsed? The one rule that keeps us welcome at an undocumented API. */
  private isDue(accountId: string): boolean {
    const last = this.lastAttemptMs.get(accountId);
    return last === undefined || this.now() - last >= this.minIntervalMs;
  }

  /**
   * Read one account: the primary, and the fallback when it throws.
   *
   * The interval is spent **before** the read, so a primary that fails slowly cannot be retried in a
   * tight loop, and a throw from the fallback too leaves the previous reading standing with a note
   * rather than blanking the meters.
   */
  private async poll(accountId: string, configDir: string): Promise<boolean> {
    this.lastAttemptMs.set(accountId, this.now());
    const account = { id: accountId, configDir };

    let reading: UsageReading;
    try {
      reading = await this.primary.read(account);
    } catch (primaryError) {
      try {
        const estimate = await this.fallback.read(account);
        reading = {
          ...estimate,
          approximate: true,
          // Both halves matter: what failed, and what is standing in for it. An operator looking at
          // a dashed meter has to be able to tell "the endpoint moved" from "I am not logged in".
          note: `${String(primaryError)} — falling back to a local estimate. ${estimate.note ?? ""}`.trim(),
        };
      } catch (fallbackError) {
        const previous = this.readings.get(accountId) ?? emptyUsage(accountId);
        const next: AccountUsage = {
          ...previous,
          note: `no usage could be read: ${String(primaryError)}; the local estimate also failed: `
            + String(fallbackError),
        };
        if (next.note === previous.note) return false;
        this.readings.set(accountId, next);
        return true;
      }
    }

    this.record(accountId, reading);
    return true;
  }

  /**
   * Store a reading and make it the current one.
   *
   * `limited` is derived here rather than by whoever reads the meters, so the scheduler, the UI and a
   * future consumer cannot each decide "at its limit" means a slightly different thing. A window at
   * the pause threshold or above *is* the limit for our purposes: the point of the number is to act
   * before the 429, not after it.
   */
  private record(accountId: string, reading: UsageReading): void {
    const readAt = Math.floor(this.now() / 1000);
    const worst = worstWindow(reading.windows);
    const limited = worst !== null && worst.utilization >= LIMIT_PAUSE_PERCENT;
    const usage: AccountUsage = {
      accountId,
      source: reading.source,
      approximate: reading.approximate,
      windows: reading.windows,
      readAt,
      note: reading.note,
      limited,
      limitedUntil: limited ? worst!.resetsAt : null,
    };
    this.readings.set(accountId, usage);
    this.stmts.insert.run(
      accountId, readAt, usage.source, usage.approximate ? 1 : 0,
      JSON.stringify(usage.windows), usage.note, usage.limited ? 1 : 0, usage.limitedUntil,
    );
  }

  /**
   * A session on this account was refused with a rate-limit error. Believe it now.
   *
   * The poller may be up to three minutes behind and the endpoint may be unavailable altogether, but
   * a 429 from the provider is not an estimate — it is the limit, observed. So the account is marked
   * limited immediately, and `limitedUntil` is the best time anything currently knows: the reset of
   * whichever window the last reading said was fullest. When nothing knows, it stays null, which the
   * scheduler reads as "hold until a reading says otherwise" rather than as "resume now".
   *
   * Not persisted as a snapshot: this is an observation *about* an account, not a reading *of* it,
   * and writing it as one would put a row in the history claiming a poll happened that did not.
   */
  markLimited(accountId: string, reason?: string): void {
    const previous = this.readings.get(accountId) ?? emptyUsage(accountId);
    const worst = worstWindow(previous.windows);
    const next: AccountUsage = {
      ...previous,
      limited: true,
      limitedUntil: previous.limitedUntil ?? worst?.resetsAt ?? null,
      note: reason ?? previous.note,
    };
    if (previous.limited && next.note === previous.note && next.limitedUntil === previous.limitedUntil) {
      return;
    }
    this.readings.set(accountId, next);
    this.announce();
  }

  /**
   * How many readings this account has on record. History is the point of persisting them, and this
   * is what a later "usage over time" surface would count; today it is what the tests assert on.
   */
  snapshotCount(accountId: string): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM usage_snapshots WHERE account_id = ?")
      .get(accountId) as { c: number }).c;
  }
}

/** The fullest window, which is the one that decides whether an account may keep working. */
export function worstWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  let worst: UsageWindow | null = null;
  for (const w of windows) {
    if (worst === null || w.utilization > worst.utilization) worst = w;
  }
  return worst;
}

/**
 * A stored row, back as a reading. A `windows` column that will not parse (a hand-edited file, a
 * downgrade) yields no meters rather than crashing the boot it is read during.
 */
function rowToUsage(row: SnapshotRow): AccountUsage {
  let windows: UsageWindow[] = [];
  try {
    const parsed: unknown = JSON.parse(row.windows);
    if (Array.isArray(parsed)) windows = parsed as UsageWindow[];
  } catch { /* an unreadable snapshot is no meters, not a failed boot */ }
  return {
    accountId: row.account_id,
    source: row.source === "estimate" ? "estimate" : "endpoint",
    approximate: row.approximate === 1,
    windows,
    readAt: row.read_at,
    note: row.note,
    limited: row.limited === 1,
    limitedUntil: row.limited_until,
  };
}
