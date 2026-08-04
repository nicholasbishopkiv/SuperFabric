import type { AccountBurn, CostRollups } from "@superfabric/shared";
import { LIMIT_PAUSE_PERCENT } from "@superfabric/shared";
import { CircleHelpIcon, FlameIcon, RotateCcwIcon } from "lucide-react";
import { STATUS_COLOR } from "../scene/palette";

/**
 * How long this account has, and what its work has cost.
 *
 * **The number an operator acts on is a duration.** "At this rate you have about two hours" is a
 * sentence someone can plan an afternoon around; "1.4 M tokens" is not. So the headline here is the
 * time to the threshold at which the scheduler actually stops the agents (95 %, not 100 %), and the
 * rate that produced it is the small print.
 *
 * **A projection nobody can make says "unknown", and says why.** The server refuses to guess from one
 * reading or from four minutes of history, and this surface shows the refusal in the same place the
 * figure would have been — with the reason in the operator's own words. A decorative "—" would have
 * been worse than nothing, because it reads as "zero".
 *
 * **Both approximations are marked, and they are different approximations.** A projection built on
 * estimated readings gets the same `≈` the meters above it use. The cost figure gets one always: it is
 * a *cost-equivalent* reconstructed from the provider's own per-query counter, and on a subscription no
 * money changes hands per turn. Neither number is presented as harder than it is.
 */

/** "about 2 h", "about 25 min", "under a minute" — a duration, because that is the unit of decision. */
export function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "already there";
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `about ${minutes} min`;
  const hours = seconds / 3600;
  if (hours < 24) {
    // A quarter-hour resolution: a projection accurate to the minute would be a claim the slope of a
    // handful of coarse percentages cannot support.
    const rounded = Math.round(hours * 4) / 4;
    return `about ${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(2).replace(/0$/, "")} h`;
  }
  const days = Math.round(hours / 24);
  return `about ${days} d`;
}

/** A dollar figure that stays readable at both ends: `$0.04`, `$1.75`, `$132`. */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}

/** Points per hour, at a resolution the underlying percentages can actually support. */
export function formatRate(percentPerHour: number): string {
  if (percentPerHour >= 10) return `${Math.round(percentPerHour)} pts/h`;
  if (percentPerHour >= 1) return `${percentPerHour.toFixed(1)} pts/h`;
  return `${percentPerHour.toFixed(2)} pts/h`;
}

/**
 * How alarming the projection is, in the floor's own status colours.
 *
 * Under an hour is `error` red, under four is `blocked` amber, beyond that `working` green — the same
 * three colours meaning the same three things as a beacon on a roof, read from `scene/palette.ts` so a
 * panel and the floor cannot disagree.
 */
function urgencyColor(seconds: number): string {
  if (seconds < 3600) return STATUS_COLOR.error;
  if (seconds < 4 * 3600) return STATUS_COLOR.blocked;
  return STATUS_COLOR.working;
}

function CostLine({ cost }: { cost: CostRollups }) {
  const title =
    "What these turns would have cost through the API, from the CLI's own figure — SuperFabric has no "
    + "pricing table. On a subscription no money changes hands per turn, so this is a cost-equivalent, "
    + "and a turn whose result reported no cost is not counted.";
  return (
    <div className="mt-0.5 flex items-baseline gap-1.5 text-2xs text-fg-faint" title={title}>
      <span>cost-equivalent</span>
      <span className="ml-auto shrink-0 font-mono tabular-nums text-fg-muted">
        ≈{formatUsd(cost.day.usd)} <span className="text-fg-faint">/ 24 h</span>
      </span>
      <span className="shrink-0 font-mono tabular-nums text-fg-muted">
        ≈{formatUsd(cost.week.usd)} <span className="text-fg-faint">/ 7 d</span>
      </span>
    </div>
  );
}

/**
 * One account's projection, and the spend beside it.
 *
 * `burn` may be absent entirely (the server has not sent a metrics frame yet), which is a third state
 * distinct from "unknown": nothing has been *asked*, as opposed to asked and unanswerable.
 */
export function BurnRate({ burn, cost }: { burn: AccountBurn | undefined; cost: CostRollups | undefined }) {
  if (burn === undefined || cost === undefined) return null;

  return (
    <div className="mt-1 border-t border-line/40 pt-1">
      {burn.secondsToLimit === null ? (
        <div className="flex items-start gap-1 text-2xs text-fg-faint">
          <CircleHelpIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span className="min-w-0">
            <span className="font-semibold text-fg-muted">Time left: unknown</span>
            {burn.unknown !== null && <span> — {burn.unknown}</span>}
          </span>
        </div>
      ) : (
        <div className="flex items-baseline gap-1.5">
          <FlameIcon
            className="size-3 shrink-0 self-center"
            aria-hidden
            style={{ color: urgencyColor(burn.secondsToLimit) }}
          />
          <span className="text-2xs text-fg-muted">at this rate</span>
          <span
            className="font-mono text-xs font-semibold tabular-nums"
            style={{ color: urgencyColor(burn.secondsToLimit) }}
            title={
              `${burn.windowLabel ?? "this window"} reaches ${LIMIT_PAUSE_PERCENT} % — the point at `
              + "which agents on this account are paused — from "
              + `${burn.samples} readings over ${Math.round(burn.spanSeconds / 60)} min`
            }
          >
            {/* The mark travels with the figure: a projection off estimated readings is a guess about
                a guess, and must never be shown as hard as one off the endpoint's own numbers. */}
            {burn.approximate ? "≈" : ""}{formatRemaining(burn.secondsToLimit)}
          </span>
          <span className="ml-auto shrink-0 font-mono text-2xs tabular-nums text-fg-faint">
            {burn.windowLabel} · {burn.percentPerHour !== null ? formatRate(burn.percentPerHour) : ""}
          </span>
        </div>
      )}

      {/* Good news that inverts the advice, so it is said rather than left to be inferred from two
          numbers the operator would have to compare themselves. */}
      {burn.resetsFirst && (
        <div className="mt-0.5 flex items-start gap-1 text-2xs text-status-idle">
          <RotateCcwIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>this window rolls before that, so the quota comes back first</span>
        </div>
      )}

      <CostLine cost={cost} />
    </div>
  );
}
