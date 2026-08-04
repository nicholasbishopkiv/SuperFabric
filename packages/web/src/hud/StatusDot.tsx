import { STATUS_COLOR } from "../scene/palette";
import type { FactoryStatus } from "../store";
import { cn } from "../ui/utils";

/**
 * The status vocabulary of the floor, as a dot.
 *
 * The colour is read straight out of `scene/palette.ts` rather than through a Tailwind class, and
 * that is deliberate: it is the one place a *value* is needed rather than a utility (the glow is a
 * `box-shadow` of the same colour), and taking both from the same constant is what guarantees a
 * room's dot in the panel and its beacon on the roof can never disagree.
 */
export function StatusDot({
  status,
  title,
  className,
}: {
  status: FactoryStatus;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title ?? status}
      aria-label={status}
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{
        background: STATUS_COLOR[status],
        // An idle dot must not read as a light that is on; no halo says "known, quiet".
        boxShadow: status === "idle" ? "none" : `0 0 7px ${STATUS_COLOR[status]}`,
      }}
    />
  );
}
