import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "./utils";

/**
 * A line the server said out loud: a notice, an error, a warning.
 *
 * Variants are the floor's own meanings — the HUD does not get to invent an "attention" colour that
 * the beacons do not use, which is the same rule `ui/badge.tsx` follows.
 */
const alertVariants = cva(
  "flex items-start gap-2 rounded-[4px] border px-2.5 py-1.5 text-xs backdrop-blur-xl " +
    "[&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        notice: "border-line bg-panel-raised/90 text-fg",
        accent: "border-accent/50 bg-accent/12 text-accent",
        warn: "border-status-blocked/50 bg-status-blocked/12 text-status-blocked",
        danger: "border-status-error/50 bg-status-error/12 text-status-error",
      },
    },
    defaultVariants: { variant: "notice" },
  },
);

export function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div data-slot="alert" role="status" className={cn(alertVariants({ variant }), className)} {...props} />
  );
}

export function AlertTitle({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="alert-title" className={cn("font-semibold", className)} {...props} />;
}
