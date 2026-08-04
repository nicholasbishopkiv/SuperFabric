import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type * as React from "react";
import { cn } from "./utils";

/**
 * The HUD's tooltip, and the reason 68 native `title=` attributes could leave.
 *
 * A native tooltip cannot be styled, waits about a second, never appears on touch, and is invisible
 * to a screenshot — which matters here because half of what this HUD explains in a tooltip is *why a
 * number is approximate*, and a caveat nobody can see is a caveat that was not made.
 */
export function TooltipProvider({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
  );
}

export function Tooltip(props: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

export function TooltipTrigger(props: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-50 max-w-72 rounded-[3px] border border-line bg-panel-raised/95 px-2 py-1.5",
          "text-2xs leading-snug text-fg shadow-[0_4px_20px_rgba(0,0,0,0.45)] backdrop-blur-xl",
          "animate-pop",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

/**
 * The whole tooltip in one element, because the migration it exists for touches 68 call sites and a
 * four-line replacement at each would have been a reason not to do it.
 *
 * `title="…"` becomes `<Hint text="…">…</Hint>`. `asChild` is on by default: the trigger is almost
 * always an existing `Button` or `span`, and wrapping one in a second button would break both the
 * layout and the tab order.
 *
 * Empty text returns the child untouched, so a conditional `title={x ?? undefined}` becomes
 * `text={x}` with no branch at the call site.
 */
export function Hint({
  text,
  children,
  side,
  asChild = true,
}: {
  text: React.ReactNode;
  children: React.ReactNode;
  side?: React.ComponentProps<typeof TooltipPrimitive.Content>["side"];
  asChild?: boolean;
}) {
  if (text === null || text === undefined || text === "" || text === false) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild={asChild}>{children}</TooltipTrigger>
      <TooltipContent side={side}>{text}</TooltipContent>
    </Tooltip>
  );
}
