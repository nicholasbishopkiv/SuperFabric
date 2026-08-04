import * as ProgressPrimitive from "@radix-ui/react-progress";
import type * as React from "react";
import { cn } from "./utils";

/**
 * A bar with the right ARIA shape.
 *
 * The *fill* is passed in rather than themed here, because the callers that matter fill with a
 * hatch when the reading is a guess — which is semantics rather than decoration, and must not be
 * reachable by a `variant` that some future caller picks for the look of it.
 */
export function Progress({
  className,
  value,
  fill,
  children,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & { fill?: React.CSSProperties }) {
  const clamped = Math.min(100, Math.max(0, value ?? 0));
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={clamped}
      className={cn(
        "relative h-1.5 w-full overflow-hidden rounded-full bg-panel-sunken",
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${clamped}%`, ...fill }}
      />
      {children}
    </ProgressPrimitive.Root>
  );
}
