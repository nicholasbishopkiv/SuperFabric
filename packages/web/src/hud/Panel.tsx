import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
} from "lucide-react";
import type * as React from "react";
import type { HudSide } from "../store";
import { Button } from "../ui/button";
import { cn } from "../ui/utils";
import { useHudInset } from "./useHudInset";

/**
 * The shell every edge panel is built from, and the reason they now look like one instrument rather
 * than three widgets that happen to share a screen.
 *
 * ## One collapse affordance, three edges
 *
 * Each panel used to invent its own: `‹ rooms`, `› console`, `⌄ tasks`, in three different places,
 * with three different collapsed shapes. Here there is exactly one rule:
 *
 * > **The panel's header sits on its inner edge, and the last thing on that header is a chevron
 * > pointing the way the panel will travel.** Collapsed, the panel *is* that header, reduced to an
 * > icon, a live count and the chevron pointing back.
 *
 * So the room panel's control is at its right, the console's at its left, the board's at its top;
 * all three are the same button, all three keep saying what they are hiding, and a collapsed panel
 * is a small pill on its own edge rather than a stray button floating over the floor.
 *
 * ## What stays true whatever it looks like
 *
 * - **The content is never unmounted.** Radix's `Collapsible.Content` gets `forceMount` and is
 *   hidden by us with `data-[state=closed]:hidden`, so a half-typed room name, the console's
 *   transcript and the "which session am I following" state all survive a collapse. That was true
 *   before and would be very easy to lose. (`forceMount` alone is not enough: with it, Radix keeps
 *   its own `hidden` attribute *off* and leaves the hiding to CSS — so a `Content` that merely said
 *   `forceMount` would never collapse at all.)
 * - **Every state reports its size.** `useHudInset` observes the `<aside>` itself, so the camera
 *   frames the factory into the strip the panels actually leave — including the collapsed pill.
 * - **A collapsed panel stops eating the floor.** The aside still spans its whole edge (that is
 *   what keeps the pill in the corner), so while collapsed it is `pointer-events-none` and only the
 *   pill takes the pointer back. Dragging the floor works everywhere a panel is not.
 */

/** Which way the chevron points, given the edge and whether the panel is open. */
function Chevron({ side, open }: { side: HudSide; open: boolean }) {
  if (side === "bottom") return open ? <ChevronDownIcon /> : <ChevronUpIcon />;
  const goesLeft = side === "left" ? open : !open;
  return goesLeft ? <ChevronLeftIcon /> : <ChevronRightIcon />;
}

const SHELL: Record<HudSide, string> = {
  left: "fixed inset-y-0 left-0 flex flex-col",
  right: "fixed inset-y-0 right-0 flex flex-col",
  bottom: "fixed bottom-0 flex flex-col",
};

const OPEN_SKIN: Record<HudSide, string> = {
  left: "border-r border-line",
  right: "border-l border-line",
  bottom: "border-t border-line",
};

export interface EdgePanelProps {
  side: HudSide;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The panel's name, on the header while open and in the toggle's tooltip while collapsed. */
  label: string;
  icon: React.ReactNode;
  /** What the collapsed pill says it is hiding — a count, kept to a character or three. */
  summary: React.ReactNode;
  /** Spelled-out version of the same, as the pill's tooltip. */
  summaryTitle: string;
  /** Header content shown only while open, between the title and the chevron. */
  headerExtra?: React.ReactNode;
  /** Geometry that differs per panel: the side panels' widths, the board's left/right/max-height. */
  className?: string;
  /**
   * Overrides on the scrolling region. The console drawer passes `overflow-hidden`: it manages its
   * own scrolling, because only its transcript may scroll and its composer has to stay pinned.
   */
  contentClassName?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export function EdgePanel({
  side,
  open,
  onOpenChange,
  label,
  icon,
  summary,
  summaryTitle,
  headerExtra,
  className,
  contentClassName,
  style,
  children,
}: EdgePanelProps) {
  const inset = useHudInset<HTMLElement>(side);

  return (
    <CollapsiblePrimitive.Root open={open} onOpenChange={onOpenChange} asChild>
      <aside
        ref={inset}
        data-hud-panel={side}
        style={style}
        className={cn(
          SHELL[side],
          "z-30 text-sm text-fg",
          open
            ? cn(
                "bg-panel/80 shadow-[0_0_40px_rgba(0,0,0,0.35)] backdrop-blur-xl",
                OPEN_SKIN[side],
                className,
              )
            : "pointer-events-none bg-transparent",
        )}
      >
        <header
          className={cn(
            "flex shrink-0 items-center gap-2",
            open ? "px-3 py-2" : "pointer-events-auto p-2",
            // Collapsed, the board's pill is centred in the strip rather than stranded at one end.
            side === "bottom" && !open && "justify-center",
          )}
        >
          <CollapsiblePrimitive.Trigger asChild>
            <Button
              variant={open ? "ghost" : "outline"}
              size={open ? "icon-xs" : "sm"}
              className={cn(
                // The chevron sits on the panel's *inner* edge: the right of the left panel, the
                // left of the console, the top-right of the board. `order` rather than a reversed
                // row, so the header's reading order stays icon → name → detail either way.
                side === "right" ? "order-first" : "order-last",
                !open && "gap-1.5 bg-panel/80 backdrop-blur-xl",
              )}
              title={open ? `Collapse the ${label.toLowerCase()}` : summaryTitle}
              aria-label={open ? `Collapse the ${label.toLowerCase()}` : `Open the ${label.toLowerCase()}`}
            >
              {!open && icon}
              {!open && <span className="text-2xs tabular-nums">{summary}</span>}
              <Chevron side={side} open={open} />
            </Button>
          </CollapsiblePrimitive.Trigger>

          {open && (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 text-fg-muted [&_svg]:size-3.5">{icon}</span>
              <h2 className="shrink-0 text-xs font-semibold uppercase tracking-[0.08em] text-fg-muted">
                {label}
              </h2>
              {headerExtra}
            </div>
          )}
        </header>

        <CollapsiblePrimitive.Content
          forceMount
          className={cn(
            "hud-scroll min-h-0 flex-1 data-[state=closed]:hidden",
            side === "bottom" ? "flex flex-col" : "overflow-y-auto",
            contentClassName,
          )}
        >
          {children}
        </CollapsiblePrimitive.Content>
      </aside>
    </CollapsiblePrimitive.Root>
  );
}

/** A titled block inside a panel: a hairline above it and a small caps heading. */
export function PanelSection({
  title,
  right,
  className,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("border-t border-line px-3 py-2.5", className)}>
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-2xs font-semibold uppercase tracking-[0.08em] text-fg-faint">{title}</h3>
        {right !== undefined && <div className="ml-auto flex items-center gap-1">{right}</div>}
      </div>
      {children}
    </section>
  );
}

/** Dim secondary text, the HUD's most common element after the panels themselves. */
export function Muted({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("text-2xs text-fg-muted", className)} {...props} />;
}
