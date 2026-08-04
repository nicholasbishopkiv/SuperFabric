import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "./utils";

/**
 * A count or a one-word state, at 11px. Used for the task count on a room row, the number in a
 * board column heading, an agent's `ungated` marker and the staged-attachment chips.
 *
 * `warn`, `danger` and `bypass` are the floor's own colours — the HUD does not get to invent an
 * "attention" colour that the beacons do not use.
 */
const badgeVariants = cva(
  "inline-flex select-none items-center gap-1 whitespace-nowrap rounded-full border px-1.5 " +
    "text-2xs leading-4 font-medium [&_svg]:size-2.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        neutral: "border-line bg-fg/5 text-fg-muted",
        accent: "border-accent/50 bg-accent/12 text-accent",
        warn: "border-status-blocked/50 bg-status-blocked/12 text-status-blocked",
        danger: "border-status-error/50 bg-status-error/12 text-status-error",
        bypass: "border-bypass/50 bg-bypass/12 text-bypass",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}
