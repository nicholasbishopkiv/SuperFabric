import * as TabsPrimitive from "@radix-ui/react-tabs";
import type * as React from "react";
import { cn } from "./utils";

/**
 * The session strip, sized to the HUD: a tab here is a 22px chip, not a web-page tab. The active
 * state reuses the `chip` button variant's vocabulary so a selected session and a selected room
 * read the same way.
 */
export function Tabs(props: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" {...props} />;
}

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("flex items-center gap-1", className)}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex h-5.5 shrink-0 select-none items-center gap-1 whitespace-nowrap rounded-[3px]",
        "border border-line bg-transparent px-1.5 text-2xs font-medium text-fg-muted transition-colors",
        "outline-none hover:border-line-strong hover:text-fg focus-visible:ring-1 focus-visible:ring-accent",
        "data-[state=active]:border-accent/70 data-[state=active]:bg-accent/12 data-[state=active]:text-accent",
        className,
      )}
      {...props}
    />
  );
}
