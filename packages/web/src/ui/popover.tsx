import * as PopoverPrimitive from "@radix-ui/react-popover";
import type * as React from "react";
import { cn } from "./utils";

/**
 * Radix Popover, for the two places the HUD needs a panel-within-a-panel: the project switcher's
 * list of factories and the task board's new-task form. Both are things an operator opens
 * occasionally and closes again, and both would cost a permanent strip of the floor if they were
 * always drawn.
 *
 * Portalled and `z-70` for the same reason the select is — see `select.tsx`.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-70 rounded-[4px] border border-line-strong bg-panel/92 p-2.5 text-sm text-fg",
          "shadow-[0_12px_36px_rgba(0,0,0,0.6)] backdrop-blur-md",
          "animate-pop outline-none",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
