import type * as React from "react";
import { cn } from "./utils";

/**
 * A text field, sunken rather than raised: over a translucent panel the only reliable way to say
 * "you can type here" is to make the box *darker* than the surface it sits in, because a lighter
 * box is indistinguishable from the floor showing through.
 */
export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn(
        "h-6.5 w-full min-w-0 rounded-[3px] border border-line bg-panel-sunken/70 px-2 text-sm text-fg",
        "placeholder:text-fg-faint",
        "outline-none focus-visible:border-accent/60 focus-visible:ring-1 focus-visible:ring-accent/60",
        "disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

/** The small print under a field: what the field means, what the rule is, where the file lands. */
export function FieldNote({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("mt-1 text-2xs leading-snug text-fg-faint", className)} {...props} />;
}
