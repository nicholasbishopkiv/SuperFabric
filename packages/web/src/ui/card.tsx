import type * as React from "react";
import { cn } from "./utils";

/**
 * An entity, as a surface: a room, a task, a session, an account.
 *
 * This is the middle of the HUD's three levels — `panel` is the chassis, a card is a thing standing
 * on it, and `panel-sunken` is content recessed into one (a transcript, a path). Before it existed
 * every surface was `bg-panel/80` plus a hairline, so the *create a room* form weighed exactly as
 * much as the rooms it created. Scanning a panel should mean counting cards.
 *
 * Selection is a `data-selected` attribute rather than a prop, so a caller that already spreads DOM
 * attributes onto a row does not grow a second mechanism for it.
 */
export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "rounded-[4px] border border-line/70 bg-panel-raised/55 transition-colors",
        "hover:border-line-strong/70",
        "data-[selected=true]:border-accent/60 data-[selected=true]:bg-accent/8",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex items-center gap-1.5 px-2 py-1.5", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="card-title"
      className={cn("min-w-0 truncate text-md font-semibold text-fg", className)}
      {...props}
    />
  );
}

/** The recessed level: paths, transcripts, anything that is content rather than chrome. */
export function CardBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-body"
      className={cn("border-t border-line/50 bg-panel-sunken/40 px-2 py-1.5", className)}
      {...props}
    />
  );
}
