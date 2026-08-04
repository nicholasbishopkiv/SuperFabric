import * as SelectPrimitive from "@radix-ui/react-select";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "./utils";

/**
 * Radix Select, vendored and shrunk to HUD size.
 *
 * Why a Radix select rather than the native `<select>` the panels used to carry: a native dropdown
 * is drawn by the OS in the OS's colours, so over a dark panel on a bright factory floor it was the
 * one control that could not be made to look like part of the HUD. Radix draws it in the document,
 * which also means it obeys our type scale — the old model picker's option labels were a full
 * sentence each and the widget was as wide as the panel.
 *
 * **The portal is load-bearing.** The whole app is a full-viewport WebGL canvas with fixed overlays
 * on top; a dropdown rendered inside a panel would be clipped by that panel's own `overflow-y: auto`
 * and would inherit its stacking. `SelectPrimitive.Portal` puts the list at the end of `<body>`,
 * past the canvas, and `z-70` puts it above every overlay including the drop target.
 *
 * One consequence to remember at every call site: **Radix reserves the empty string** as an item
 * value (it means "no value"), so a select whose "nothing chosen" option was `value=""` — the model
 * picker's default, the task form's unassigned room — needs a real sentinel instead.
 */

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

export function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "inline-flex h-6.5 min-w-0 items-center justify-between gap-1 rounded-[3px]",
        "border border-line bg-panel-raised/80 px-2 text-xs text-fg",
        "transition-colors hover:border-line-strong",
        "outline-none focus-visible:border-accent/60 focus-visible:ring-1 focus-visible:ring-accent/60",
        "disabled:pointer-events-none disabled:opacity-40",
        "data-[placeholder]:text-fg-faint [&>span]:truncate",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-3 shrink-0 text-fg-faint" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={4}
        className={cn(
          "z-70 max-h-72 min-w-[8rem] overflow-hidden rounded-[4px] border border-line-strong",
          "bg-panel/95 text-fg shadow-[0_10px_30px_rgba(0,0,0,0.55)] backdrop-blur-md",
          "animate-pop",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport
          className={cn(
            "p-1",
            position === "popper" &&
              "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default select-none items-center gap-2 rounded-[3px]",
        "py-1 pl-2 pr-6 text-xs outline-none",
        "focus:bg-accent/15 focus:text-accent",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-1.5 flex size-3 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-3" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

/** A dim caption inside the list — "shortlist", "on this agent". */
export function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn("px-2 py-1 text-2xs uppercase tracking-wide text-fg-faint", className)}
      {...props}
    />
  );
}
