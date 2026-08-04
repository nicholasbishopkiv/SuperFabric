import type { AccountUsage, UsageWindow } from "@superfabric/shared";
import { LIMIT_PAUSE_PERCENT, LIMIT_WARN_PERCENT } from "@superfabric/shared";
import { CircleAlertIcon, PauseIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { STATUS_COLOR } from "../scene/palette";
import { Badge } from "../ui/badge";
import { cn } from "../ui/utils";

/**
 * One account's rate limits, as meters.
 *
 * **The one thing this surface must never do is present a guess as a measurement.** The fallback
 * reading is counted from local transcripts: it cannot see the operator's other devices, it does not
 * know when the real window began, and there is no published limit to measure against. So an
 * approximate reading is marked three times over — a hatched bar rather than a solid one, an
 * "estimate" badge on the account, and the reason spelled out underneath — because a meter that
 * *looks* authoritative is worse than no meter at all: the operator would plan around it.
 *
 * The scheduler's own thresholds are drawn on the bar as ticks, from the same constants the server
 * acts on. A bar that turned amber at a different number from the one that actually warns the agents
 * would be a lie drawn to scale.
 */

/** Where a meter sits relative to what the scheduler will do about it. */
function severityOf(utilization: number): "ok" | "warn" | "critical" {
  if (utilization >= LIMIT_PAUSE_PERCENT) return "critical";
  if (utilization >= LIMIT_WARN_PERCENT) return "warn";
  return "ok";
}

/**
 * Bar colours, taken from the floor's own status table rather than written here.
 *
 * `working` green for "there is room", `blocked` amber for "the warning has fired", `error` red for
 * "you are at the pause threshold" — the same three colours, meaning the same three things, as the
 * beacon on a roof. See `scene/palette.ts`.
 */
const BAR_COLOR: Record<"ok" | "warn" | "critical", string> = {
  ok: STATUS_COLOR.working,
  warn: STATUS_COLOR.blocked,
  critical: STATUS_COLOR.error,
};

/**
 * A clock that re-renders its caller every half minute, so a countdown counts down.
 *
 * Needed because nothing else would move it: the meters arrive on the server's three-minute poll and
 * a paused agent's row only changes when the scheduler touches it, so between those a "resumes in
 * 12 m" would sit there saying 12 for a quarter of an hour. Half a minute is finer than the
 * countdown's own resolution, and the timer only runs while something is actually counting.
 */
export function useTickingNow(enabled: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/** "in 2 h 14 m", "in 3 d", "any moment now" — a duration, because nobody plans in UTC timestamps. */
export function formatCountdown(target: Date, now: Date): string {
  const seconds = Math.round((target.getTime() - now.getTime()) / 1000);
  if (seconds <= 0) return "any moment now";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `in ${days} d ${hours} h`;
  if (hours > 0) return `in ${hours} h ${minutes} m`;
  if (minutes > 0) return `in ${minutes} m`;
  return "in under a minute";
}

/** A reset time as a countdown plus the instant itself, or an honest shrug. */
export function resetLabel(resetsAt: string | null, now: Date = new Date()): {
  short: string;
  title: string;
} {
  if (resetsAt === null) return { short: "reset time unknown", title: "Nothing said when this window rolls" };
  const target = new Date(resetsAt);
  if (Number.isNaN(target.getTime())) return { short: "reset time unknown", title: resetsAt };
  return { short: `resets ${formatCountdown(target, now)}`, title: target.toLocaleString() };
}

function Meter({ window, approximate, now }: { window: UsageWindow; approximate: boolean; now: Date }) {
  const severity = severityOf(window.utilization);
  const color = BAR_COLOR[severity];
  const reset = resetLabel(window.resetsAt, now);
  const percent = Math.min(100, Math.max(0, window.utilization));

  return (
    <li className="mt-1">
      <div className="flex items-baseline gap-1.5">
        <span className="truncate text-2xs text-fg-muted">{window.label}</span>
        <span
          className="ml-auto shrink-0 font-mono text-2xs tabular-nums text-fg"
          style={{ color }}
        >
          {approximate ? "≈" : ""}{Math.round(window.utilization)}%
        </span>
      </div>
      <div
        className="relative mt-0.5 h-1.5 overflow-hidden rounded-full bg-panel-sunken"
        role="meter"
        aria-label={`${window.label}${approximate ? " (estimated)" : ""}`}
        aria-valuenow={Math.round(window.utilization)}
        aria-valuemin={0}
        aria-valuemax={100}
        title={window.detail ?? undefined}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{
            width: `${percent}%`,
            // Solid for a reading, hatched for a guess. The texture is the point: it survives a
            // screenshot, a colour-blind reader and a glance from across the desk, none of which a
            // tooltip does.
            background: approximate
              ? `repeating-linear-gradient(115deg, ${color} 0 3px, transparent 3px 6px)`
              : color,
            opacity: approximate ? 0.85 : 1,
          }}
        />
        {/* The two lines the scheduler actually acts on, drawn from the server's own constants. */}
        {[LIMIT_WARN_PERCENT, LIMIT_PAUSE_PERCENT].map((mark) => (
          <span
            key={mark}
            aria-hidden
            className="absolute top-0 h-full w-px bg-fg/25"
            style={{ left: `${mark}%` }}
            title={mark === LIMIT_WARN_PERCENT ? "agents are warned here" : "agents are paused here"}
          />
        ))}
      </div>
      <div className="mt-0.5 flex gap-1 text-2xs text-fg-faint">
        <span title={reset.title}>{reset.short}</span>
        {window.detail !== null && <span className="ml-auto truncate">{window.detail}</span>}
      </div>
    </li>
  );
}

export function UsageMeters({
  usage,
  /** Injected so the countdowns are testable; the live UI passes nothing and gets a ticking clock. */
  now: fixedNow,
}: {
  usage: AccountUsage | undefined;
  now?: Date;
}) {
  const ticking = useTickingNow(fixedNow === undefined && usage !== undefined && usage.windows.length > 0);
  const now = fixedNow ?? ticking;
  // Two different silences, and they must not look alike: a server that has never read this account
  // has nothing to say, which is not the same as an account with no usage.
  if (usage === undefined || usage.readAt === null || usage.windows.length === 0) {
    return (
      <div className="mt-1 text-2xs text-fg-faint">
        {usage?.note ?? "No limit reading yet — the meters appear after the first poll."}
      </div>
    );
  }

  const limitReset = resetLabel(usage.limitedUntil, now);
  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center gap-1">
        {usage.approximate && (
          <Badge
            variant="warn"
            title="Counted from this machine's transcripts, not read from Anthropic. It cannot see your other devices."
          >
            <CircleAlertIcon />
            estimate
          </Badge>
        )}
        {usage.limited && (
          <Badge variant="warn" title={limitReset.title}>
            <PauseIcon />
            at its limit ·{" "}
            {usage.limitedUntil === null ? "no known reset" : limitReset.short}
          </Badge>
        )}
        {usage.limitedBy === "rate_limit_error" && (
          <span className="text-2xs text-fg-faint">the provider refused a turn</span>
        )}
      </div>

      <ul className={cn("mt-0.5", usage.approximate && "opacity-95")}>
        {usage.windows.map((w) => (
          <Meter key={w.key} window={w} approximate={usage.approximate} now={now} />
        ))}
      </ul>

      {/* The reason, verbatim, whenever there is one. A degraded monitor that says nothing is a
          monitor the operator trusts more than they should. */}
      {usage.note !== null && (
        <p className="mt-1 text-2xs leading-snug text-fg-faint">{usage.note}</p>
      )}
    </div>
  );
}
