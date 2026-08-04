import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type * as React from "react";
import { cn } from "./utils";

/**
 * Scrolling with a thumb the HUD can style, rather than the platform's own.
 *
 * `type="scroll"` rather than `"always"`: a permanent gutter on a 300px panel costs a readable
 * column of text, and this surface floats over a live scene where a static bar reads as chrome.
 *
 * The `[&>div]:!block` on the viewport is Radix's own quirk — it renders an inner wrapper as
 * `display: table`, which makes a flex child inside it size to its content and breaks any panel
 * that wanted its rows to fill the width.
 */
export function ScrollArea({
  className,
  viewportClassName,
  orientation = "vertical",
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportClassName?: string;
  orientation?: "vertical" | "horizontal";
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      type="scroll"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn("size-full [&>div]:!block", viewportClassName)}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation={orientation}
        className={cn(
          "flex touch-none select-none p-0.5 transition-opacity",
          orientation === "vertical" ? "w-2" : "h-2 flex-col",
        )}
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-line-strong" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}
