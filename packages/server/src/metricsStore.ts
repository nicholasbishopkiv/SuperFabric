import {
  type AccountBurn,
  type AccountMetrics,
  type CostRollup,
  type CostRollups,
  type FactoryMetrics,
  LIMIT_PAUSE_PERCENT,
  type RoomCost,
  type UsageWindow,
} from "@superfabric/shared";
import type { AccountManager } from "./accountManager.js";
import type { Db } from "./db.js";
import type { ProjectManager } from "./projectManager.js";

/**
 * Burn rate and cost: how long an account has at the rate it is going, and what the work has cost.
 *
 * **Two numbers of very different quality, and the difference is the whole design of this file.**
 *
 * 1. **The burn rate is a measurement.** It is the slope of `usage_snapshots` — real utilisation
 *    percentages read from Anthropic's own endpoint, minutes apart — projected forward to the
 *    threshold the scheduler actually acts on. No pricing table, no token model, nothing derived from
 *    an assumption. "At this rate you have about two hours" is the number an operator acts on, and it
 *    is sourced from the only history that can support it.
 * 2. **The cost is a reconstruction, and is marked as one everywhere it appears.** It comes from
 *    `turn_complete.costUsd`, which the CLI reports **cumulatively per `query()`** rather than per
 *    turn — so a turn's cost is the *difference* between consecutive readings, and a restart of the
 *    executor (which begins a new `query()`) shows up as the counter going backwards. See
 *    `notes/agent-sdk-api.md`, "What `total_cost_usd` counts". **No pricing table exists anywhere in
 *    SuperFabric**: the figure is Anthropic's own, never tokens multiplied by a rate we wrote down.
 *
 * **A projection nobody can make says "unknown".** Fewer than two readings, a series spanning less
 * than `MIN_BURN_SPAN_SECONDS`, or utilisation that is flat or falling all produce a null
 * `secondsToLimit` with the reason in words. That is the difference between a useful instrument and a
 * decorative one: an operator told "3 h" by a projection built on one reading would plan their
 * afternoon around a number with no information in it.
 */

/**
 * How far back readings are taken from, in seconds.
 *
 * Six hours: longer than a 5-hour window, so the trimming below always has the whole of the current
 * one to work with, and short enough that a burst of work three days ago cannot flatten today's rate.
 */
export const BURN_HISTORY_SECONDS = 6 * 60 * 60;

/**
 * The shortest span a projection is made from, in seconds.
 *
 * Fifteen minutes, which at the 180 s polling floor is five readings. Below it the slope is dominated
 * by the endpoint's own rounding — a window that ticks from 61 % to 62 % between two polls three
 * minutes apart implies 20 points an hour, which would tell the operator they have 100 minutes when
 * they may have all day.
 */
export const MIN_BURN_SPAN_SECONDS = 15 * 60;

/** Two points make a line. Fewer make nothing, and saying so is the point. */
export const MIN_BURN_SAMPLES = 2;

/** The windows the cost rollups cover, in seconds. */
const DAY_SECONDS = 24 * 60 * 60;
const WEEK_SECONDS = 7 * DAY_SECONDS;

/**
 * One reading of one window: the pair a rate is computed from, plus what it is worth.
 *
 * Exported because `project` is: the tests drive the projection with a synthetic series rather than
 * through a database, which is the only way to assert what happens over six hours of readings without
 * a six-hour test.
 */
export interface BurnSample {
  /** Unix seconds. */
  at: number;
  utilization: number;
  /** What the meter is called on screen — carried so the projection can name its own window. */
  label: string;
  /** This reading came from the local estimate rather than the endpoint. */
  approximate: boolean;
  resetsAt: string | null;
}

/** Row shape of the snapshot query. */
interface SnapshotRow {
  read_at: number;
  approximate: number;
  windows: string;
}

/** Row shape of the cost queries: one bucket keyed by whatever was grouped on. */
interface CostRow {
  key: string | null;
  usd: number;
  turns: number;
}

/**
 * Per-turn spend, reconstructed from a cumulative counter.
 *
 * `turn_complete.costUsd` is the CLI's `total_cost_usd`, which accumulates across the lifetime of one
 * `query()` — so the cost of a single turn is that value minus the previous `turn_complete`'s in the
 * same session. A value *lower* than its predecessor means the executor was restarted (`set_model`, a
 * pause, a resume: a new `query()` with its counter back near zero), and then the whole value is this
 * turn's. `LAG` over the session's own `seq` order says both in one pass.
 *
 * One expression, interpolated into both grouped queries below, so the reconstruction cannot end up
 * being two subtly different things.
 */
const SPEND_CTE = `
  WITH turns AS (
    SELECT e.session_id AS session_id,
           e.ts AS ts,
           CAST(json_extract(e.payload, '$.costUsd') AS REAL) AS total,
           LAG(CAST(json_extract(e.payload, '$.costUsd') AS REAL))
             OVER (PARTITION BY e.session_id ORDER BY e.seq) AS previous
    FROM events e
    WHERE e.type = 'turn_complete' AND json_extract(e.payload, '$.costUsd') IS NOT NULL
  ),
  spend AS (
    SELECT session_id, ts,
           CASE WHEN previous IS NULL OR total < previous THEN total ELSE total - previous END AS usd
    FROM turns
  )
`;

const ZERO: CostRollup = { usd: 0, turns: 0 };
const ZERO_ROLLUPS: CostRollups = { day: ZERO, week: ZERO };

export interface MetricsStoreOptions {
  /** Injected so a synthetic snapshot series can be measured against a fixed clock. */
  now?: () => number;
}

export class MetricsStore {
  private readonly now: () => number;
  private readonly stmts;

  constructor(
    db: Db,
    private accounts: AccountManager,
    private projects: ProjectManager,
    opts: MetricsStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.stmts = {
      // Oldest first: the slope is computed in reading order, and the reset detection depends on it.
      snapshots: db.prepare(`
        SELECT read_at, approximate, windows FROM usage_snapshots
        WHERE account_id = ? AND read_at >= ?
        ORDER BY read_at, id
      `),
      /*
       * By account, across every factory. A LEFT JOIN, so a turn whose session row has since been
       * deleted still counts towards the ambient bucket rather than disappearing from the accounting —
       * the event log has no foreign key to `sessions` precisely because history outlives it.
       */
      costByAccount: db.prepare(`
        ${SPEND_CTE}
        SELECT s.account_id AS key, COALESCE(SUM(spend.usd), 0) AS usd, COUNT(*) AS turns
        FROM spend LEFT JOIN sessions s ON s.id = spend.session_id
        WHERE spend.ts >= ?
        GROUP BY s.account_id
      `),
      /*
       * By room, for one factory. An inner join and `room_id IS NOT NULL`: a roomless session has no
       * room to attribute its spend to, and inventing one would put work in a department that never
       * did it.
       */
      costByRoom: db.prepare(`
        ${SPEND_CTE}
        SELECT s.room_id AS key, COALESCE(SUM(spend.usd), 0) AS usd, COUNT(*) AS turns
        FROM spend JOIN sessions s ON s.id = spend.session_id
        WHERE spend.ts >= ? AND s.project_id = ? AND s.room_id IS NOT NULL
        GROUP BY s.room_id
      `),
    };
  }

  /**
   * Everything the metrics surface shows for one factory: every account's projection and spend, the
   * ambient account's spend, and this floor's rooms.
   */
  snapshot(projectId: string = this.projects.defaultProject().id): FactoryMetrics {
    const now = this.now();
    const byAccount = this.costByAccount(now);
    return {
      accounts: this.accounts.list().map((account) => ({
        accountId: account.id,
        burn: this.burnRate(account.id, now),
        cost: byAccount.get(account.id) ?? ZERO_ROLLUPS,
      })),
      // The `null` bucket: agents with no account bound, i.e. the ambient `~/.claude`.
      ambient: byAccount.get(null) ?? ZERO_ROLLUPS,
      rooms: this.costByRoom(projectId, now),
    };
  }

  /**
   * How fast one account is spending, and how long that leaves it.
   *
   * Every window in the newest reading is projected independently and the **soonest** one wins — not
   * the fullest. A 5-hour window at 60 % climbing 20 points an hour runs out before a weekly window at
   * 90 % that has not moved all day, and the operator's afternoon depends on the first, not the second.
   */
  burnRate(accountId: string, now: number = this.now()): AccountBurn {
    const series = this.seriesOf(accountId, now);
    if (series.size === 0) {
      return unknownBurn(
        accountId,
        "no usage readings for this account yet — the projection appears once the monitor has read "
        + "it twice",
      );
    }

    let best: AccountBurn | null = null;
    // The most informative refusal across every window, for the case where nothing can be projected.
    let fallback: AccountBurn | null = null;

    for (const [key, samples] of series) {
      const projected = project(accountId, key, samples);
      if (projected.secondsToLimit === null) {
        if (fallback === null || rank(projected) > rank(fallback)) fallback = projected;
        continue;
      }
      if (best === null || projected.secondsToLimit < best.secondsToLimit!) best = projected;
    }
    return best ?? fallback ?? unknownBurn(accountId, "no window could be projected");
  }

  /**
   * Cost by room for one factory, most expensive week first.
   *
   * Rooms with nothing recorded are omitted rather than listed at zero: a list of every room in the
   * factory with $0.00 against most of them buries the two that are actually spending. The client
   * holds the room list and can say "nothing yet" for the rest.
   */
  costByRoom(projectId: string, now: number = this.now()): RoomCost[] {
    const day = bucket(this.stmts.costByRoom.all(now - DAY_SECONDS, projectId) as CostRow[]);
    const week = bucket(this.stmts.costByRoom.all(now - WEEK_SECONDS, projectId) as CostRow[]);
    const rooms: RoomCost[] = [];
    for (const [roomId, weekCost] of week) {
      if (roomId === null) continue;
      rooms.push({ roomId, cost: { day: day.get(roomId) ?? ZERO, week: weekCost } });
    }
    rooms.sort((a, b) => b.cost.week.usd - a.cost.week.usd);
    return rooms;
  }

  /**
   * Cost by account across every factory, keyed by `account_id` — `null` for the ambient `~/.claude`.
   *
   * Deliberately **not** scoped to a project: an account is machine-wide (`AccountInfo`), so "what has
   * this subscription spent" is a question about the subscription, not about the floor the operator
   * happens to be looking at. Scoping it would make one account report different totals in two tabs.
   */
  costByAccount(now: number = this.now()): Map<string | null, CostRollups> {
    const day = bucket(this.stmts.costByAccount.all(now - DAY_SECONDS) as CostRow[]);
    const week = bucket(this.stmts.costByAccount.all(now - WEEK_SECONDS) as CostRow[]);
    const out = new Map<string | null, CostRollups>();
    for (const [key, weekCost] of week) {
      out.set(key, { day: day.get(key) ?? ZERO, week: weekCost });
    }
    return out;
  }

  /**
   * One account's readings, as a series per window key, with everything before the last reset dropped.
   *
   * **A window that rolled has to break the series, not flatten it.** Utilisation going from 96 % to
   * 3 % is not a burn rate of minus ninety-three points an hour; it is a new window, and the only
   * honest thing to measure is what has happened since. So the series is rebuilt from scratch whenever
   * a reading is lower than the one before it.
   */
  private seriesOf(accountId: string, now: number): Map<string, BurnSample[]> {
    const rows = this.stmts.snapshots.all(accountId, now - BURN_HISTORY_SECONDS) as SnapshotRow[];
    const series = new Map<string, BurnSample[]>();
    for (const row of rows) {
      for (const window of parseWindows(row.windows)) {
        const sample: BurnSample = {
          at: row.read_at,
          utilization: window.utilization,
          label: window.label,
          approximate: row.approximate === 1,
          resetsAt: window.resetsAt,
        };
        const existing = series.get(window.key);
        if (existing === undefined) { series.set(window.key, [sample]); continue; }
        const previous = existing[existing.length - 1]!;
        if (sample.utilization < previous.utilization) series.set(window.key, [sample]);
        else existing.push(sample);
      }
    }
    // A window present in older readings but not in the newest one is gone (the endpoint stopped
    // reporting it, or renamed it); projecting it would be projecting history.
    const newest = rows[rows.length - 1];
    if (newest !== undefined) {
      const live = new Set(parseWindows(newest.windows).map((w) => w.key));
      for (const key of [...series.keys()]) if (!live.has(key)) series.delete(key);
    }
    return series;
  }
}

function bucket(rows: CostRow[]): Map<string | null, CostRollup> {
  const out = new Map<string | null, CostRollup>();
  for (const row of rows) {
    // A float sum of dollars is fine at this magnitude, but rounding here keeps the wire clean and
    // stops `0.30000000000000004` reaching a screen.
    out.set(row.key, { usd: Math.max(0, round(row.usd)), turns: row.turns });
  }
  return out;
}

/** Two decimal places is what a dollar figure is read to; more is noise on a wire. */
function round(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/** A stored `windows` column, or nothing. An unreadable one is no meters, not a failed query. */
function parseWindows(json: string): UsageWindow[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as UsageWindow[]) : [];
  } catch {
    return [];
  }
}

/** The shape of "there is no projection, and here is why". */
function unknownBurn(accountId: string, reason: string): AccountBurn {
  return {
    accountId,
    windowKey: null,
    windowLabel: null,
    percentPerHour: null,
    secondsToLimit: null,
    resetsFirst: false,
    approximate: false,
    samples: 0,
    spanSeconds: 0,
    unknown: reason,
  };
}

/**
 * How useful one refusal is, for picking which to report when no window can be projected.
 *
 * "It is not rising" is the most informative thing that can be said — it means there *is* history and
 * the answer is "you are not burning anything" — so it outranks "the readings are too close together",
 * which in turn outranks "there is barely any history".
 */
function rank(burn: AccountBurn): number {
  if (burn.percentPerHour !== null) return 3;
  if (burn.samples >= MIN_BURN_SAMPLES) return 2;
  return 1;
}

/**
 * Project one window forward: the least-squares slope of its readings, and where that meets the pause
 * threshold.
 *
 * Least squares rather than first-to-last, because the endpoint's percentages are coarse and one
 * unlucky pair of endpoints would swing the answer by hours.
 */
export function project(accountId: string, key: string, samples: readonly BurnSample[]): AccountBurn {
  const newest = samples[samples.length - 1]!;
  const oldest = samples[0]!;
  const spanSeconds = Math.max(0, newest.at - oldest.at);

  const base: AccountBurn = {
    accountId,
    windowKey: key,
    windowLabel: newest.label,
    percentPerHour: null,
    secondsToLimit: null,
    resetsFirst: false,
    approximate: samples.some((s) => s.approximate),
    samples: samples.length,
    spanSeconds,
    unknown: null,
  };

  if (samples.length < MIN_BURN_SAMPLES) {
    return {
      ...base,
      unknown: `only ${samples.length} reading of ${newest.label} so far — a rate needs two`,
    };
  }
  if (spanSeconds < MIN_BURN_SPAN_SECONDS) {
    return {
      ...base,
      unknown: `the readings of ${newest.label} span ${Math.round(spanSeconds / 60)} min, which is `
        + `too little to project from (${Math.round(MIN_BURN_SPAN_SECONDS / 60)} min is the floor)`,
    };
  }

  const perHour = round4(slopePerSecond(samples) * 3600);
  if (perHour <= 0) {
    return {
      ...base,
      percentPerHour: perHour,
      unknown: `${newest.label} is not filling, so there is nothing to project towards`,
    };
  }

  // Already at or past the line the scheduler acts on: the answer is "now", not a projection.
  const remaining = LIMIT_PAUSE_PERCENT - newest.utilization;
  if (remaining <= 0) return { ...base, percentPerHour: perHour, secondsToLimit: 0 };

  const secondsToLimit = Math.round((remaining / perHour) * 3600);
  const resetSeconds = resetInSeconds(newest);
  return {
    ...base,
    percentPerHour: perHour,
    secondsToLimit,
    // The window refills before this rate would exhaust it. Said out loud because it inverts the
    // advice: an operator told "two hours" would stop handing out work, when in fact the quota comes
    // back first.
    resetsFirst: resetSeconds !== null && resetSeconds < secondsToLimit,
  };
}

/** Seconds from the newest reading until its window rolls, or null when nothing said when. */
function resetInSeconds(newest: BurnSample): number | null {
  if (newest.resetsAt === null) return null;
  const at = Date.parse(newest.resetsAt);
  if (!Number.isFinite(at)) return null;
  return Math.round(at / 1000) - newest.at;
}

/** Ordinary least squares on (seconds, percent). The denominator cannot be zero: the span is checked. */
function slopePerSecond(samples: readonly BurnSample[]): number {
  const n = samples.length;
  const meanT = samples.reduce((a, s) => a + s.at, 0) / n;
  const meanU = samples.reduce((a, s) => a + s.utilization, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const s of samples) {
    const dt = s.at - meanT;
    numerator += dt * (s.utilization - meanU);
    denominator += dt * dt;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Four decimals on a points-per-hour figure: enough for a slow weekly window, not a float artefact. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
