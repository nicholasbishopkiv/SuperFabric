# HUD Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the shadcn/ui kit already in `packages/web`, rebuild the HUD's visual layer, and give the subscription limits a permanently visible readout.

**Architecture:** Vendor the missing Radix-based components into `src/ui/` in the style of the existing five, then adopt them panel by panel. Every piece of logic that can be a pure function (which account is worst, how a run of identical events collapses) becomes one in its own module and is unit-tested; components are verified visually in a live browser plus two source-grep guards in the idiom of `test/sceneOverlay.test.ts`.

**Tech Stack:** React 19 · Tailwind v4 (`@theme` in `src/index.css`, no config file) · Radix primitives · `cva` · `lucide-react` · zustand · **vitest** (this package is vitest, never `bun test`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-04-hud-redesign-design.md`. Read it before Task 1.
- Package manager is **pnpm**. Never `bun install`.
- `packages/web` tests run under **vitest**. `bun test` is the *server* package only.
- **No literal hex colour may be written into `src/hud/`.** Semantic colours come from `scene/palette.ts` via `hud/tokens.ts` and are referenced as Tailwind tokens (`text-status-blocked`) or as `STATUS_COLOR.x` imports. Task 9 makes this mechanical.
- **Do not repaint the floor.** `scene/palette.ts` is out of scope for every task here.
- **Do not change control heights.** `ui/button.tsx` tops out at 28px on purpose.
- `EdgePanel` keeps `forceMount` on `Collapsible.Content`; removing it loses a half-typed room name on collapse.
- Every DOM overlay inside the 3D scene goes through `scene/SceneOverlay.tsx`. No raw drei `<Html>`.
- Thresholds are `LIMIT_WARN_PERCENT` (80) and `LIMIT_PAUSE_PERCENT` (95) imported from `@superfabric/shared`. Never retype the numbers.
- Type-check with `pnpm -F @superfabric/web build` (it runs `tsc --noEmit && vite build`).
- Commit after every task.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/ui/tooltip.tsx` | Radix tooltip + a `Hint` wrapper that makes the 68-site migration mechanical |
| `src/ui/tabs.tsx` | Radix tabs, sized for the session strip |
| `src/ui/scroll-area.tsx` | Radix scroll area with the HUD's thin thumb |
| `src/ui/separator.tsx` | Radix separator |
| `src/ui/card.tsx` | The missing middle of the surface hierarchy |
| `src/ui/progress.tsx` | Radix progress |
| `src/ui/dialog.tsx` | Radix dialog |
| `src/ui/alert.tsx` | The shape `NoticeBar` needs |
| `src/hud/limitHeadline.ts` | Pure: which account is worst, and what the strip says when there is no number |
| `src/hud/LimitReadout.tsx` | The permanent limit strip |
| `src/hud/collapseRuns.ts` | Pure: consecutive identical rows → runs |
| `test/uiKit.test.ts` | Every vendored module still exports what its consumers import |
| `test/limitHeadline.test.ts` | Unit tests for the pure headline logic |
| `test/collapseRuns.test.ts` | Unit tests for run collapsing |
| `test/hudHygiene.test.ts` | Source guards: no `title=`, no literal hex in `src/hud/` |

**Modified:** `package.json` (6 deps) · `src/main.tsx` (TooltipProvider) · `src/index.css` (elevation + vignette) · `src/hud/TopLeftBar.tsx` · `src/hud/Panel.tsx` · `src/hud/RoomPanel.tsx` · `src/hud/ConsoleDrawer.tsx` · `src/hud/TaskPanel.tsx` · `src/hud/UsageMeters.tsx` · `src/hud/NoticeBar.tsx` · `src/hud/AccountSwitcher.tsx` · `src/hud/FactoryTransfer.tsx` · `src/scene/Floor.tsx` · `CLAUDE.md` · `docs/ARCHITECTURE.md`

---

### Task 1: Vendor the kit

**Files:**
- Modify: `packages/web/package.json`
- Create: `packages/web/src/ui/tooltip.tsx`, `tabs.tsx`, `scroll-area.tsx`, `separator.tsx`, `card.tsx`, `progress.tsx`, `dialog.tsx`, `alert.tsx`
- Modify: `packages/web/src/main.tsx`
- Test: `packages/web/test/uiKit.test.ts`

**Interfaces:**
- Consumes: `cn` from `src/ui/utils.ts`.
- Produces: `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider`, `Hint` · `Tabs`, `TabsList`, `TabsTrigger` · `ScrollArea` · `Separator` · `Card`, `CardHeader`, `CardTitle`, `CardBody` · `Progress` · `Dialog`, `DialogTrigger`, `DialogContent`, `DialogTitle`, `DialogDescription` · `Alert`, `AlertTitle`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/test/uiKit.test.ts
import { describe, expect, it } from "vitest";

/**
 * The vendored kit's export surface, asserted rather than assumed. These modules are our own source
 * (shadcn's model), so nothing upstream stops a rename — and a renamed export fails at a call site
 * far from the file that changed. jsdom cannot usefully mount a Radix portal, so what is tested is
 * the contract every consumer imports against, in the idiom of `sceneOverlay.test.ts`.
 */
const EXPECTED: Record<string, readonly string[]> = {
  tooltip: ["Tooltip", "TooltipTrigger", "TooltipContent", "TooltipProvider", "Hint"],
  tabs: ["Tabs", "TabsList", "TabsTrigger"],
  "scroll-area": ["ScrollArea"],
  separator: ["Separator"],
  card: ["Card", "CardHeader", "CardTitle", "CardBody"],
  progress: ["Progress"],
  dialog: ["Dialog", "DialogTrigger", "DialogContent", "DialogTitle", "DialogDescription"],
  alert: ["Alert", "AlertTitle"],
};

describe("the vendored ui kit", () => {
  for (const [name, exports] of Object.entries(EXPECTED)) {
    it(`${name} exports what its consumers import`, async () => {
      const mod = await import(`../src/ui/${name}`);
      for (const exported of exports) expect(mod[exported], `${name}.${exported}`).toBeTypeOf("function");
    });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @superfabric/web test uiKit`
Expected: FAIL — every module is missing (`Failed to resolve import`).

- [ ] **Step 3: Add the dependencies**

```bash
pnpm -F @superfabric/web add @radix-ui/react-tooltip @radix-ui/react-tabs @radix-ui/react-scroll-area @radix-ui/react-separator @radix-ui/react-progress @radix-ui/react-dialog
```

All six are MIT, which the dependency licence policy in `CLAUDE.md` requires of anything shipping in the bundle.

- [ ] **Step 4: Write `src/ui/tooltip.tsx`**

```tsx
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type * as React from "react";
import { cn } from "./utils";

/**
 * The HUD's tooltip, and the reason 68 native `title=` attributes could leave.
 *
 * A native tooltip cannot be styled, waits about a second, never appears on touch, and is invisible
 * to a screenshot — which matters here because half of what the HUD explains in a tooltip is *why a
 * number is approximate*, and that is exactly the kind of caveat that has to survive being looked at.
 */
export function TooltipProvider({
  delayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />;
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
  if (text === null || text === undefined || text === "") return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild={asChild}>{children}</TooltipTrigger>
      <TooltipContent side={side}>{text}</TooltipContent>
    </Tooltip>
  );
}
```

- [ ] **Step 5: Write `src/ui/card.tsx`**

```tsx
import type * as React from "react";
import { cn } from "./utils";

/**
 * An entity, as a surface: a room, a task, a session, an account.
 *
 * This is the middle of the HUD's three levels — `panel` is the chassis, a card is a thing in it,
 * and `panel-sunken` is content recessed into one (a transcript, a path). Before it existed every
 * surface was `bg-panel/80` plus a hairline, so the *create a room* form weighed exactly as much as
 * the rooms it created. Scanning a panel should mean counting cards.
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
  return <div data-slot="card-header" className={cn("flex items-center gap-1.5 px-2 py-1.5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span data-slot="card-title" className={cn("min-w-0 truncate text-sm font-semibold text-fg", className)} {...props} />
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
```

- [ ] **Step 6: Write `src/ui/scroll-area.tsx`**

```tsx
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type * as React from "react";
import { cn } from "./utils";

/**
 * Scrolling with a thumb the HUD can style, replacing the `.hud-scroll` rules in `index.css`.
 *
 * `type="scroll"` rather than `"always"`: a permanent gutter on a 300px panel costs a readable
 * column of text, and this surface floats over a live scene where a static bar reads as chrome.
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
    <ScrollAreaPrimitive.Root data-slot="scroll-area" type="scroll" className={cn("relative", className)} {...props}>
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
```

- [ ] **Step 7: Write the remaining five modules**

`src/ui/separator.tsx`:

```tsx
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import type * as React from "react";
import { cn } from "./utils";

export function Separator({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative
      orientation={orientation}
      className={cn("shrink-0 bg-line", orientation === "horizontal" ? "h-px w-full" : "h-full w-px", className)}
      {...props}
    />
  );
}
```

`src/ui/tabs.tsx`:

```tsx
import * as TabsPrimitive from "@radix-ui/react-tabs";
import type * as React from "react";
import { cn } from "./utils";

/** The session strip. Sized to the HUD, so a tab is a 22px chip rather than a web-page tab. */
export function Tabs(props: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" {...props} />;
}

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn("flex items-center gap-1", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex h-5.5 shrink-0 select-none items-center gap-1 whitespace-nowrap rounded-[3px] border",
        "border-line bg-transparent px-1.5 text-2xs font-medium text-fg-muted transition-colors",
        "hover:border-line-strong hover:text-fg outline-none focus-visible:ring-1 focus-visible:ring-accent",
        "data-[state=active]:border-accent/70 data-[state=active]:bg-accent/12 data-[state=active]:text-accent",
        className,
      )}
      {...props}
    />
  );
}
```

`src/ui/progress.tsx`:

```tsx
import * as ProgressPrimitive from "@radix-ui/react-progress";
import type * as React from "react";
import { cn } from "./utils";

/**
 * A bar with the right ARIA shape. The *fill* is passed in rather than themed here, because the one
 * caller that matters (`UsageMeters`) fills with a hatch when the reading is a guess — which is
 * semantics, not decoration, and must not be reachable by a `variant`.
 */
export function Progress({
  className,
  value,
  fill,
  children,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & { fill?: React.CSSProperties }) {
  const clamped = Math.min(100, Math.max(0, value ?? 0));
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={clamped}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-panel-sunken", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${clamped}%`, ...fill }}
      />
      {children}
    </ProgressPrimitive.Root>
  );
}
```

`src/ui/dialog.tsx`:

```tsx
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "./utils";

export function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

export function DialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-sm font-semibold text-fg", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("mt-1 text-2xs leading-snug text-fg-muted", className)}
      {...props}
    />
  );
}

export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2",
          "rounded-[4px] border border-line bg-panel/95 p-3 shadow-[0_16px_60px_rgba(0,0,0,0.6)] backdrop-blur-xl",
          "animate-pop",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          aria-label="Close"
          className="absolute right-2 top-2 rounded-[3px] p-0.5 text-fg-muted outline-none hover:bg-fg/8 hover:text-fg focus-visible:ring-1 focus-visible:ring-accent"
        >
          <XIcon className="size-3.5" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
```

`src/ui/alert.tsx`:

```tsx
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "./utils";

/**
 * The shape `NoticeBar` needs. Variants are the floor's own meanings — the HUD does not invent an
 * attention colour the beacons do not use.
 */
const alertVariants = cva(
  "flex items-start gap-2 rounded-[4px] border px-2.5 py-1.5 text-xs backdrop-blur-xl [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0",
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

export function Alert({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="status" className={cn(alertVariants({ variant }), className)} {...props} />;
}

export function AlertTitle({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="alert-title" className={cn("font-semibold", className)} {...props} />;
}
```

- [ ] **Step 8: Mount `TooltipProvider` once, at the root**

In `src/main.tsx`, wrap the rendered `<App />` so every `Hint` shares one provider (Radix requires it, and one provider is what makes the grouped-hover delay work):

```tsx
import { TooltipProvider } from "./ui/tooltip";
// …
<TooltipProvider>
  <App />
</TooltipProvider>
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm -F @superfabric/web test uiKit`
Expected: PASS — 8 tests.

- [ ] **Step 10: Type-check**

Run: `pnpm -F @superfabric/web build`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add packages/web/package.json packages/web/src/ui packages/web/src/main.tsx packages/web/test/uiKit.test.ts pnpm-lock.yaml
git commit -m "feat(web): vendor the rest of the shadcn kit"
```

---

### Task 2: The limit headline, as a pure function

The riskiest logic in the plan and the one with no DOM in it, so it lands first and alone.

**Files:**
- Create: `packages/web/src/hud/limitHeadline.ts`
- Test: `packages/web/test/limitHeadline.test.ts`

**Interfaces:**
- Consumes: `AccountInfo`, `AccountUsage`, `AccountMetrics`, `LIMIT_WARN_PERCENT`, `LIMIT_PAUSE_PERCENT` from `@superfabric/shared`.
- Produces: `limitHeadline(accounts, usage, metrics): LimitHeadline` · `type LimitHeadline` · `type LimitSilence` · `SILENCE_TEXT: Record<LimitSilence, string>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/test/limitHeadline.test.ts
import type { AccountInfo, AccountMetrics, AccountUsage } from "@superfabric/shared";
import { describe, expect, it } from "vitest";
import { limitHeadline } from "../src/hud/limitHeadline";

/**
 * The rules behind the one number the operator sees without opening anything.
 *
 * Most of these tests are about *silence*. The product's stance is that an estimate presented as a
 * fact is worse than an honest gap — and the corollary, which is what this surface exists for, is
 * that a blank reads as "fine". Every state in which there is no figure must therefore produce a
 * sentence, and each of those sentences is a different fact.
 */

const account = (over: Partial<AccountInfo> = {}): AccountInfo => ({
  id: "a1",
  label: "work",
  configDir: "/home/x/.claude-work",
  credentialsPresent: true,
  createdAt: 0,
  lastUsedAt: null,
  login: { status: "idle", url: null, message: null },
  ...over,
});

const usageFor = (accountId: string, utilization: number, over: Partial<AccountUsage> = {}): AccountUsage => ({
  accountId,
  source: "endpoint",
  approximate: false,
  windows: [{ key: "five_hour", label: "5-hour", utilization, resetsAt: null, detail: null }],
  readAt: 1_000,
  note: null,
  limited: false,
  limitedUntil: null,
  limitedBy: null,
  ...over,
});

const metricsFor = (accountId: string, secondsToLimit: number | null, unknown: string | null): AccountMetrics => ({
  accountId,
  burn: {
    accountId,
    windowKey: "five_hour",
    windowLabel: "5-hour",
    percentPerHour: secondsToLimit === null ? null : 4,
    secondsToLimit,
    resetsFirst: false,
    approximate: false,
    unknown,
    samples: 6,
    spanSeconds: 3600,
  },
  cost: { day: { usd: 1, turns: 2 }, week: { usd: 3, turns: 5 } },
});

describe("limitHeadline — silence states", () => {
  it("says agents run on the ambient config when there are no accounts", () => {
    const h = limitHeadline([], [], []);
    expect(h.silence).toBe("no-accounts");
    expect(h.utilization).toBeNull();
    expect(h.severity).toBe("none");
  });

  it("says not logged in when every account lacks credentials", () => {
    const h = limitHeadline([account({ credentialsPresent: false })], [], []);
    expect(h.silence).toBe("not-logged-in");
  });

  it("says there is no reading yet when a logged-in account has never been polled", () => {
    const h = limitHeadline([account()], [], []);
    expect(h.silence).toBe("no-reading");
  });

  it("treats a reading with no windows as no reading", () => {
    const h = limitHeadline([account()], [usageFor("a1", 0, { windows: [], readAt: null })], []);
    expect(h.silence).toBe("no-reading");
  });

  it("ignores an account with no credentials when another has a reading", () => {
    const accounts = [account({ id: "a1", credentialsPresent: false }), account({ id: "a2", label: "personal" })];
    const h = limitHeadline(accounts, [usageFor("a2", 40)], []);
    expect(h.silence).toBeNull();
    expect(h.accountId).toBe("a2");
  });
});

describe("limitHeadline — choosing the worst account", () => {
  it("picks the highest utilization", () => {
    const accounts = [account({ id: "a1", label: "work" }), account({ id: "a2", label: "personal" })];
    const h = limitHeadline(accounts, [usageFor("a1", 30), usageFor("a2", 71)], []);
    expect(h.accountId).toBe("a2");
    expect(h.utilization).toBe(71);
  });

  it("takes the fullest window within an account, not the first", () => {
    const usage = usageFor("a1", 12);
    usage.windows.push({ key: "seven_day", label: "7-day", utilization: 88, resetsAt: null, detail: null });
    const h = limitHeadline([account()], [usage], []);
    expect(h.utilization).toBe(88);
    expect(h.windowLabel).toBe("7-day");
  });

  it("an account already at its limit outranks a fuller one that is not", () => {
    const accounts = [account({ id: "a1" }), account({ id: "a2" })];
    const usage = [usageFor("a1", 20, { limited: true }), usageFor("a2", 92)];
    const h = limitHeadline(accounts, usage, []);
    expect(h.accountId).toBe("a1");
    expect(h.limited).toBe(true);
    expect(h.severity).toBe("critical");
  });

  it("shows the account label only when more than one account is configured", () => {
    expect(limitHeadline([account()], [usageFor("a1", 10)], []).showLabel).toBe(false);
    const two = [account({ id: "a1" }), account({ id: "a2" })];
    expect(limitHeadline(two, [usageFor("a1", 10), usageFor("a2", 5)], []).showLabel).toBe(true);
  });
});

describe("limitHeadline — severity follows the scheduler's own thresholds", () => {
  it("is ok below the warn threshold", () => {
    expect(limitHeadline([account()], [usageFor("a1", 79.9)], []).severity).toBe("ok");
  });

  it("warns at exactly the warn threshold", () => {
    expect(limitHeadline([account()], [usageFor("a1", 80)], []).severity).toBe("warn");
  });

  it("is critical at exactly the pause threshold", () => {
    expect(limitHeadline([account()], [usageFor("a1", 95)], []).severity).toBe("critical");
  });
});

describe("limitHeadline — provenance travels with the figure", () => {
  it("marks an estimated reading", () => {
    const h = limitHeadline([account()], [usageFor("a1", 50, { approximate: true, source: "transcripts" })], []);
    expect(h.approximate).toBe(true);
  });

  it("carries the projection when there is one", () => {
    const h = limitHeadline([account()], [usageFor("a1", 50)], [metricsFor("a1", 7200, null)]);
    expect(h.secondsToLimit).toBe(7200);
    expect(h.burnUnknown).toBeNull();
  });

  it("carries the server's reason verbatim when there is no projection", () => {
    const h = limitHeadline([account()], [usageFor("a1", 50)], [metricsFor("a1", null, "only one reading so far")]);
    expect(h.secondsToLimit).toBeNull();
    expect(h.burnUnknown).toBe("only one reading so far");
  });

  it("distinguishes never-measured from measured-and-unanswerable", () => {
    const h = limitHeadline([account()], [usageFor("a1", 50)], []);
    expect(h.secondsToLimit).toBeNull();
    expect(h.burnUnknown).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @superfabric/web test limitHeadline`
Expected: FAIL — `Failed to resolve import "../src/hud/limitHeadline"`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/web/src/hud/limitHeadline.ts
import type { AccountInfo, AccountMetrics, AccountUsage } from "@superfabric/shared";
import { LIMIT_PAUSE_PERCENT, LIMIT_WARN_PERCENT } from "@superfabric/shared";

/**
 * What the permanent limit strip says, decided here rather than in the component.
 *
 * **The silence states are the point.** Limits used to be reachable only by opening the accounts
 * popover *and* having credentials in the account, while the scheduler pauses every agent on the
 * floor at `LIMIT_PAUSE_PERCENT`. With no accounts configured the surface rendered nothing at all —
 * and nothing reads as "fine". So every state in which there is no number produces a sentence, and
 * the three sentences are three different facts: nobody is measuring, nobody is logged in, or
 * nothing has been read yet.
 *
 * Pure, and separate from the component, because this is the part worth testing: jsdom cannot mount
 * the strip, but it can check every one of these branches.
 */

/** A state in which there is no figure to show. Each is a different fact. */
export type LimitSilence = "no-accounts" | "not-logged-in" | "no-reading";

/** The words, kept here so the component holds no copy and a test can assert on the state. */
export const SILENCE_TEXT: Record<LimitSilence, string> = {
  "no-accounts": "on ~/.claude — no limit reading",
  "not-logged-in": "not logged in",
  "no-reading": "no reading yet",
};

export type LimitSeverity = "none" | "ok" | "warn" | "critical";

export interface LimitHeadline {
  /** Non-null when there is no figure; the component renders `SILENCE_TEXT[silence]`. */
  silence: LimitSilence | null;
  severity: LimitSeverity;
  accountId: string | null;
  accountLabel: string | null;
  /** Whether to print the label beside the figure — only meaningful with more than one account. */
  showLabel: boolean;
  /** 0–100, from the fullest window of the worst account. */
  utilization: number | null;
  windowLabel: string | null;
  /** The reading is counted from local transcripts rather than read from Anthropic. */
  approximate: boolean;
  /** Seconds until the scheduler would pause this account, or null when unprojectable. */
  secondsToLimit: number | null;
  /** Why there is no projection, in the server's own words. Null both when there is one and when
   *  nothing has been measured at all — `secondsToLimit === null && burnUnknown === null` is the
   *  third state, "never asked". */
  burnUnknown: string | null;
  limited: boolean;
}

const SILENT = (silence: LimitSilence): LimitHeadline => ({
  silence,
  severity: "none",
  accountId: null,
  accountLabel: null,
  showLabel: false,
  utilization: null,
  windowLabel: null,
  approximate: false,
  secondsToLimit: null,
  burnUnknown: null,
  limited: false,
});

function severityOf(utilization: number, limited: boolean): LimitSeverity {
  if (limited || utilization >= LIMIT_PAUSE_PERCENT) return "critical";
  if (utilization >= LIMIT_WARN_PERCENT) return "warn";
  return "ok";
}

/** The fullest window of one reading, or null when it has none. */
function fullestWindow(usage: AccountUsage): { utilization: number; label: string } | null {
  let best: { utilization: number; label: string } | null = null;
  for (const w of usage.windows) {
    if (best === null || w.utilization > best.utilization) best = { utilization: w.utilization, label: w.label };
  }
  return best;
}

/**
 * The worst account, and what to say about it.
 *
 * "Worst" is `limited` first, then the fullest window — deliberately **not** the shortest
 * `secondsToLimit`, which would be the more precise question. A projection is null far more often
 * than it is present (one reading, too short a span, a window that is not filling), so ranking by it
 * would reorder the strip as measurements arrive and leave it unranked exactly when the operator is
 * new to the machine. Utilization is always there, and the projection rides along as the second
 * line.
 */
export function limitHeadline(
  accounts: readonly AccountInfo[],
  usage: readonly AccountUsage[],
  metrics: readonly AccountMetrics[],
): LimitHeadline {
  if (accounts.length === 0) return SILENT("no-accounts");

  const loggedIn = accounts.filter((a) => a.credentialsPresent);
  if (loggedIn.length === 0) return SILENT("not-logged-in");

  type Candidate = {
    account: AccountInfo;
    reading: AccountUsage;
    window: { utilization: number; label: string };
  };

  const candidates: Candidate[] = [];
  for (const account of loggedIn) {
    const reading = usage.find((u) => u.accountId === account.id);
    if (reading === undefined || reading.readAt === null) continue;
    const window = fullestWindow(reading);
    if (window === null) continue;
    candidates.push({ account, reading, window });
  }
  if (candidates.length === 0) return SILENT("no-reading");

  let worst = candidates[0];
  for (const c of candidates.slice(1)) {
    const beatsOnLimit = c.reading.limited && !worst.reading.limited;
    const tiedOnLimit = c.reading.limited === worst.reading.limited;
    if (beatsOnLimit || (tiedOnLimit && c.window.utilization > worst.window.utilization)) worst = c;
  }

  const burn = metrics.find((m) => m.accountId === worst.account.id)?.burn;
  return {
    silence: null,
    severity: severityOf(worst.window.utilization, worst.reading.limited),
    accountId: worst.account.id,
    accountLabel: worst.account.label,
    // One account needs no attribution; two or more and an unlabelled number is ambiguous.
    showLabel: accounts.length > 1,
    utilization: worst.window.utilization,
    windowLabel: worst.window.label,
    approximate: worst.reading.approximate,
    secondsToLimit: burn?.secondsToLimit ?? null,
    burnUnknown: burn === undefined ? null : burn.secondsToLimit === null ? burn.unknown : null,
    limited: worst.reading.limited,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -F @superfabric/web test limitHeadline`
Expected: PASS — 16 tests.

If the `AccountInfo.login` or `AccountBurn` literals in the test do not type-check, read the current shapes in `packages/shared/src/protocol.ts` and correct the *test fixtures* — never widen the production types to accommodate a fixture.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/hud/limitHeadline.ts packages/web/test/limitHeadline.test.ts
git commit -m "feat(web): decide the limit headline as a pure function"
```

---

### Task 3: The permanent limit readout

**Files:**
- Create: `packages/web/src/hud/LimitReadout.tsx`
- Modify: `packages/web/src/hud/TopLeftBar.tsx`

**Interfaces:**
- Consumes: `limitHeadline`, `SILENCE_TEXT`, `LimitHeadline` (Task 2) · `Hint` (Task 1) · `Progress` (Task 1) · `formatRemaining` from `./BurnRate` · `STATUS_COLOR` from `../scene/palette` · `useAccounts`, `useUsage`, `useFabric` from `../store`.
- Produces: `LimitReadout` — a self-contained element for the top strip.

- [ ] **Step 1: Write `src/hud/LimitReadout.tsx`**

```tsx
import { LIMIT_PAUSE_PERCENT } from "@superfabric/shared";
import { CircleHelpIcon, GaugeIcon, PauseIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { STATUS_COLOR } from "../scene/palette";
import { useAccounts, useFabric, useUsage } from "../store";
import { Progress } from "../ui/progress";
import { Hint } from "../ui/tooltip";
import { cn } from "../ui/utils";
import { formatRemaining } from "./BurnRate";
import { limitHeadline, type LimitSeverity, SILENCE_TEXT } from "./limitHeadline";

/**
 * How much subscription is left, where the operator cannot miss it.
 *
 * Before this, limits were behind two gates — open the accounts popover, *and* have credentials in
 * the account — while `scheduler.ts` pauses every agent on the floor at `LIMIT_PAUSE_PERCENT`. The
 * numbers were already scrupulously honest and simply had nowhere to be read.
 *
 * **It is quiet until it is not.** Below the warn threshold this is chrome in the same register as
 * the two switchers beside it; the amber and the red are the floor's own `blocked` and `error`, so
 * no sixth loud colour enters the vocabulary and "status wins every read" survives.
 *
 * **It is a headline, not a second source of truth.** Clicking opens the accounts popover, where
 * `UsageMeters` and `BurnRate` render the same figures under the rules they already had. Nothing
 * here re-derives a number that surface owns.
 */

const SEVERITY_COLOR: Record<Exclude<LimitSeverity, "none">, string> = {
  ok: STATUS_COLOR.working,
  warn: STATUS_COLOR.blocked,
  critical: STATUS_COLOR.error,
};

export function LimitReadout() {
  const accounts = useAccounts();
  const usage = useUsage();
  const accountMetrics = useFabric(useShallow((s) => s.metrics?.accounts ?? []));
  const head = limitHeadline(accounts, usage, accountMetrics);

  const openAccounts = () => useFabric.getState().setAccountsOpen(true);

  if (head.silence !== null) {
    return (
      <Hint
        text={
          head.silence === "no-accounts"
            ? "Agents run on your own ~/.claude, whose limits SuperFabric cannot read. Add an account to see them."
            : head.silence === "not-logged-in"
              ? "This account has no credentials yet, so nothing can be read from it."
              : "The monitor polls every three minutes. The meters appear after the first reading."
        }
      >
        <button
          type="button"
          onClick={openAccounts}
          className="flex h-7 items-center gap-1.5 rounded-[3px] border border-line bg-panel/80 px-2 text-2xs text-fg-faint backdrop-blur-xl transition-colors hover:border-line-strong hover:text-fg-muted"
        >
          <CircleHelpIcon className="size-3 shrink-0" />
          <span>{SILENCE_TEXT[head.silence]}</span>
        </button>
      </Hint>
    );
  }

  const color = SEVERITY_COLOR[head.severity === "none" ? "ok" : head.severity];
  const percent = Math.round(head.utilization ?? 0);

  return (
    <Hint
      text={
        <span>
          {head.windowLabel} on <b>{head.accountLabel}</b> is {head.approximate ? "about " : ""}
          {percent}% full. Agents on this account are paused at {LIMIT_PAUSE_PERCENT}%.
          {head.approximate && " This reading is counted from this machine's transcripts, not read from Anthropic — it cannot see your other devices."}
          {head.burnUnknown !== null && ` No projection: ${head.burnUnknown}.`}
        </span>
      }
    >
      <button
        type="button"
        onClick={openAccounts}
        aria-label={`Limits: ${percent}% of ${head.windowLabel}`}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-[3px] border bg-panel/80 px-2 backdrop-blur-xl transition-colors",
          head.severity === "ok" && "border-line hover:border-line-strong",
          head.severity === "warn" && "border-status-blocked/60 bg-status-blocked/10",
          head.severity === "critical" && "border-status-error/60 bg-status-error/10",
        )}
      >
        {head.limited ? (
          <PauseIcon className="size-3 shrink-0" style={{ color }} />
        ) : (
          <GaugeIcon className="size-3 shrink-0" style={{ color }} />
        )}

        {head.showLabel && <span className="max-w-20 truncate text-2xs text-fg-muted">{head.accountLabel}</span>}

        <Progress
          value={percent}
          aria-hidden
          className="h-1 w-14"
          // Solid for a reading, hatched for a guess — the same texture `UsageMeters` uses, because
          // it is the one mark that survives a screenshot and a colour-blind reader.
          fill={{
            background: head.approximate
              ? `repeating-linear-gradient(115deg, ${color} 0 3px, transparent 3px 6px)`
              : color,
          }}
        />

        <span className="shrink-0 font-mono text-2xs font-semibold tabular-nums" style={{ color }}>
          {head.approximate ? "≈" : ""}
          {percent}%
        </span>

        {/* The figure an operator actually plans around, and an honest blank where there isn't one. */}
        <span className="shrink-0 border-l border-line/60 pl-1.5 font-mono text-2xs tabular-nums text-fg-muted">
          {head.secondsToLimit !== null
            ? formatRemaining(head.secondsToLimit).replace(/^about /, "≈")
            : head.burnUnknown !== null
              ? "unknown"
              : "—"}
        </span>
      </button>
    </Hint>
  );
}
```

- [ ] **Step 2: Add the `accountsOpen` control to the store**

`AccountSwitcher` owns its popover state locally today. Clicking the readout must open it, so lift that one boolean. In `src/store.ts`, add to the state interface and the initial state:

```ts
  /** Whether the accounts popover is open. In the store rather than in `AccountSwitcher` because the
   *  limit readout in the top strip opens it, and two surfaces cannot share a `useState`. */
  accountsOpen: boolean;
```

initial `accountsOpen: false`, plus the setter alongside the other UI setters:

```ts
  setAccountsOpen: (open: boolean) => set({ accountsOpen: open }),
```

Then in `src/hud/AccountSwitcher.tsx` replace its local `useState` for the popover with
`useFabric((s) => s.accountsOpen)` and `useFabric.getState().setAccountsOpen`.

- [ ] **Step 3: Put it in the top strip**

In `src/hud/TopLeftBar.tsx`, add `<LimitReadout />` after `<AccountSwitcher />` and extend the doc comment, since that comment currently describes a two-control strip:

```tsx
      <ProjectSwitcher />
      <AccountSwitcher />
      {/* Third, and deliberately last: it is a *reading* about the account beside it rather than a
          control, and clicking it opens that account's popover. */}
      <LimitReadout />
```

- [ ] **Step 4: Type-check and run the whole suite**

Run: `pnpm -F @superfabric/web build && pnpm -F @superfabric/web test`
Expected: type-check clean, all tests pass.

- [ ] **Step 5: Verify visually**

Start both dev servers, open `http://localhost:5173`, and dispatch one `window.dispatchEvent(new Event("resize"))` before measuring anything — a hidden tab never sizes the r3f canvas (see `CLAUDE.md`).

```bash
pnpm -F @superfabric/server dev
```

Confirm with **no accounts configured** the strip reads `on ~/.claude — no limit reading` rather than being absent, and that clicking it opens the accounts popover.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/hud/LimitReadout.tsx packages/web/src/hud/TopLeftBar.tsx packages/web/src/hud/AccountSwitcher.tsx packages/web/src/store.ts
git commit -m "feat(web): show the limits without opening anything"
```

---

### Task 4: Collapse runs in the console

**Files:**
- Create: `packages/web/src/hud/collapseRuns.ts`
- Test: `packages/web/test/collapseRuns.test.ts`

**Interfaces:**
- Produces: `collapseRuns<T>(rows, keyOf): Run<T>[]` · `interface Run<T> { first: T; count: number; index: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/test/collapseRuns.test.ts
import { describe, expect, it } from "vitest";
import { collapseRuns } from "../src/hud/collapseRuns";

/**
 * The console's wall of forty identical `· starting` lines, reduced to arithmetic so it can be
 * tested without a canvas — the same reason `conveyorPath.ts` and `errands.ts` are pure.
 */
const key = (s: string) => s;

describe("collapseRuns", () => {
  it("returns nothing for nothing", () => {
    expect(collapseRuns([], key)).toEqual([]);
  });

  it("leaves a single row alone", () => {
    expect(collapseRuns(["a"], key)).toEqual([{ first: "a", count: 1, index: 0 }]);
  });

  it("collapses a run", () => {
    expect(collapseRuns(["a", "a", "a"], key)).toEqual([{ first: "a", count: 3, index: 0 }]);
  });

  it("keeps non-adjacent repeats apart", () => {
    expect(collapseRuns(["a", "b", "a"], key)).toEqual([
      { first: "a", count: 1, index: 0 },
      { first: "b", count: 1, index: 1 },
      { first: "a", count: 1, index: 2 },
    ]);
  });

  it("collapses a run that ends the list", () => {
    expect(collapseRuns(["a", "b", "b"], key)).toEqual([
      { first: "a", count: 1, index: 0 },
      { first: "b", count: 2, index: 1 },
    ]);
  });

  it("keeps the first row of a run, not the last, so its timestamp is when the run began", () => {
    const rows = [{ id: 1, t: "x" }, { id: 2, t: "x" }];
    expect(collapseRuns(rows, (r) => r.t)[0].first.id).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @superfabric/web test collapseRuns`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/web/src/hud/collapseRuns.ts

/**
 * Consecutive identical rows, folded into one row with a count.
 *
 * The console's worst reading was forty consecutive `· starting` lines at 11px, which is not a
 * transcript but a texture. Collapsing runs removes most of it without hiding anything: the count
 * says exactly how many there were, and `first` is kept rather than `last` so the row's timestamp is
 * when the run *began*, which is the question someone scrolling back is asking.
 *
 * Adjacent-only, deliberately. Folding non-adjacent repeats would reorder a transcript, and a
 * transcript whose order is a lie is worse than a long one.
 */
export interface Run<T> {
  first: T;
  count: number;
  /** Index of `first` in the input, so a caller can key on it without a second pass. */
  index: number;
}

export function collapseRuns<T>(rows: readonly T[], keyOf: (row: T) => string): Run<T>[] {
  const runs: Run<T>[] = [];
  let currentKey: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const k = keyOf(rows[i]);
    if (runs.length > 0 && k === currentKey) {
      runs[runs.length - 1].count++;
      continue;
    }
    runs.push({ first: rows[i], count: 1, index: i });
    currentKey = k;
  }
  return runs;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -F @superfabric/web test collapseRuns`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/hud/collapseRuns.ts packages/web/test/collapseRuns.test.ts
git commit -m "feat(web): fold a run of identical console rows into one"
```

---

### Task 5: Rebuild the console

**Files:**
- Modify: `packages/web/src/hud/ConsoleDrawer.tsx`

**Interfaces:**
- Consumes: `collapseRuns` (Task 4) · `Tabs`, `TabsList`, `TabsTrigger`, `ScrollArea`, `Hint` (Task 1) · `toolGist`, `truncate` from `../gist`.

- [ ] **Step 1: Read the file end to end**

`ConsoleDrawer.tsx` is 525 lines and the transcript renderer is only part of it. Read all of it before editing; the composer's pinning and the `EdgePanel` `contentClassName="overflow-hidden"` contract both matter.

- [ ] **Step 2: Replace the session strip with `Tabs`**

The strip becomes a `TabsList` inside a horizontal `ScrollArea`. Past six sessions, render the active tab plus a `Select` of the rest rather than a row of eight-character stubs — the current strip overflows into a cramped scrolling band at ten.

- [ ] **Step 3: Collapse runs in the transcript**

Key an event row by what makes two rows *look* identical — its type plus its rendered text, not its sequence number:

```tsx
const runs = collapseRuns(rows, (r) => `${r.event.type}:${rowText(r)}`);
```

Render `×{count}` as a `Badge` when `count > 1`. Keep `first`'s timestamp.

- [ ] **Step 4: Give the transcript a gutter and a well**

Relative time in a fixed-width left gutter (`tabular-nums`, `text-fg-faint`); the transcript region gets `bg-panel-sunken/40`. A tool-call row keeps its icon and the monospace gist `toolGist` already produces — do not write a second summariser, the bubble over an agent's head shares this one.

- [ ] **Step 5: Verify visually**

Reload the app with a session that has many events. Confirm the forty `starting` lines are one row reading `starting ×40`, that the composer stays pinned, and that switching tabs preserves a half-typed message.

- [ ] **Step 6: Type-check, test, commit**

```bash
pnpm -F @superfabric/web build && pnpm -F @superfabric/web test
git add packages/web/src/hud/ConsoleDrawer.tsx
git commit -m "feat(web): make the console a transcript rather than a wall"
```

---

### Task 6: Cards in the room panel and the task board

**Files:**
- Modify: `packages/web/src/hud/RoomPanel.tsx`, `packages/web/src/hud/TaskPanel.tsx`

- [ ] **Step 1: Rooms and agents become cards**

Each room row and each agent row becomes a `Card`; the config path and similar detail move into `CardBody`. The create-room form loses its visual weight — it is a container, not an entity, so it is *not* a card.

- [ ] **Step 2: Leave the paused agent's wording alone**

`AgentLine` (`RoomPanel.tsx:204-217`) already says "resumes in 2 h 14 m", falls back to "waiting for
the limit to lift" when `pausedUntil` is null, and carries the exact instant as a tooltip. It is
correct as written — the only change it takes is Task 7's `title=` → `Hint` migration. Do not
rewrite it, and note that `pausedUntil` is unix **seconds**, so any new reader of it needs `* 1000`.

- [ ] **Step 3: Task cards and honest empty states**

Each task becomes a `Card`; each column heading takes a `Badge` count. Replace the em-dash placeholders with a real empty state per column ("nothing open", "nothing blocked").

- [ ] **Step 4: Verify visually, then commit**

```bash
pnpm -F @superfabric/web build && pnpm -F @superfabric/web test
git add packages/web/src/hud/RoomPanel.tsx packages/web/src/hud/TaskPanel.tsx
git commit -m "feat(web): give rooms, agents and tasks a surface of their own"
```

---

### Task 7: Tooltips everywhere, and the guard that keeps them

**Files:**
- Modify: every file under `packages/web/src/hud/` carrying a `title=`
- Create: `packages/web/test/hudHygiene.test.ts` (the `title=` half; the hex half lands in Task 9)

- [ ] **Step 1: Write the failing guard**

```ts
// packages/web/test/hudHygiene.test.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Two properties of the HUD that are easy to state and easy to lose, checked against the source in
 * the idiom of `sceneOverlay.test.ts` — this package mounts no components, so the source is what
 * there is to test.
 */
const HUD_DIR = join(import.meta.dirname, "../src/hud");
const hudFiles = (): string[] => readdirSync(HUD_DIR).filter((f) => f.endsWith(".tsx"));
const read = (file: string): string => readFileSync(join(HUD_DIR, file), "utf8");

describe("no native tooltips survive in the HUD", () => {
  it.each(hudFiles())("%s uses Hint rather than title=", (file) => {
    const offenders = read(file)
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /\stitle=/.test(line));
    expect(offenders, `${file}: a native title= cannot be styled, is invisible on touch and never
appears in a screenshot. Use <Hint text="…"> from ui/tooltip.`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @superfabric/web test hudHygiene`
Expected: FAIL, listing the files still carrying `title=` (68 attributes at the start).

- [ ] **Step 3: Migrate, file by file**

`<Button title="Collapse the rooms">…</Button>` becomes:

```tsx
<Hint text="Collapse the rooms">
  <Button …>…</Button>
</Hint>
```

Three rules while migrating:

1. **`aria-label` stays.** A tooltip is not an accessible name; removing the label would strip a screen reader of the only text on an icon button.
2. `Hint` returns its child untouched for empty text, so a conditional `title={x ?? undefined}` becomes `text={x}` with no branch.
3. `<Hint>` wrapping a `Select` trigger or a `PopoverTrigger` needs `asChild` on exactly one of the two — check the rendered DOM, because two nested `asChild` triggers silently drop a handler.

- [ ] **Step 4: Run the guard until it passes**

Run: `pnpm -F @superfabric/web test hudHygiene`
Expected: PASS.

- [ ] **Step 5: Verify visually**

Hover a meter, a badge and an icon button. Confirm one styled tooltip appears, that it is readable over the floor, and that no native tooltip appears behind it.

- [ ] **Step 6: Type-check, test, commit**

```bash
pnpm -F @superfabric/web build && pnpm -F @superfabric/web test
git add packages/web/src/hud packages/web/test/hudHygiene.test.ts
git commit -m "feat(web): real tooltips, and a guard against the native ones coming back"
```

---

### Task 8: The junction between floor and HUD

**Files:**
- Modify: `packages/web/src/index.css`, `packages/web/src/hud/Panel.tsx`, `packages/web/src/scene/Floor.tsx`

**The floor's colours are not touched.** `scene/palette.ts` stays exactly as it is.

- [ ] **Step 1: Give a panel a lit inner edge**

In `Panel.tsx`, the open panel's skin gains an inset highlight on the edge facing the scene, so it reads as glass over the floor rather than as a hole cut in it:

```ts
const OPEN_SKIN: Record<HudSide, string> = {
  left: "border-r border-line shadow-[inset_-1px_0_0_rgba(255,255,255,0.06)]",
  right: "border-l border-line shadow-[inset_1px_0_0_rgba(255,255,255,0.06)]",
  bottom: "border-t border-line shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
};
```

The existing outer `shadow-[0_0_40px_rgba(0,0,0,0.35)]` is applied on the same element; combine both in one `shadow-[…]` value rather than letting the second overwrite the first.

- [ ] **Step 2: Vignette the floor**

Add a non-interactive overlay in `index.css` and render one `<div className="floor-vignette" />` as the first child in `App.tsx`, before the panels:

```css
@layer base {
  /* The slab is a pale warm concrete and the panels are a cool near-black; before this they met at a
     hard edge and the two halves of the screen read as different applications. Darkening the frame
     is the cheapest honest fix — the scene keeps its own colours (`scene/palette.ts` argues for them
     at length) and only the corners of the *viewport* are shaded. */
  .floor-vignette {
    position: fixed;
    inset: 0;
    z-index: 10;
    pointer-events: none;
    background: radial-gradient(ellipse at 50% 45%, transparent 45%, rgba(9, 13, 18, 0.45) 100%);
  }
}
```

`z-index: 10` puts it under every panel (`z-30`) and over the canvas. `pointer-events: none` is load-bearing: a full-viewport element that hit-tests would make the entire floor undraggable, which is the same class of bug `SceneOverlay` exists to prevent.

- [ ] **Step 3: Verify visually**

Confirm the beige no longer runs flush into a black rectangle, and — importantly — **that a building can still be dragged**. If dragging broke, the vignette is taking the pointer.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/index.css packages/web/src/hud/Panel.tsx packages/web/src/App.tsx
git commit -m "feat(web): stop the HUD butting into the floor"
```

---

### Task 9: Typography, the hex guard, and the docs

**Files:**
- Modify: `packages/web/src/index.css`, `packages/web/test/hudHygiene.test.ts`, `CLAUDE.md`, `docs/ARCHITECTURE.md`

- [ ] **Step 1: Add the heading step**

The scale is 11/12/13px with everything at a similar weight, which gives the eye no entry point. Add one step up in `@theme`, for entity headings only:

```css
  --text-md: 0.9375rem; /* 15px — an entity's name: a room, an account, a session */
  --text-md--line-height: 1.3rem;
```

Apply it to `CardTitle` and to the room/account name rows. Do not apply it to buttons or to any control.

- [ ] **Step 2: Add the hex guard to `hudHygiene.test.ts`**

```ts
describe("the HUD never retypes a palette colour", () => {
  it.each(hudFiles())("%s carries no literal hex", (file) => {
    const offenders = read(file)
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /#[0-9a-fA-F]{3,8}\b/.test(line))
      // A colour named inside a comment is documentation, not a value the browser will read.
      .filter(([, line]) => !/^\s*(\*|\/\/)/.test(line));
    expect(offenders, `${file}: semantic colours come from scene/palette.ts through hud/tokens.ts.
Reference a token (text-status-blocked) or import STATUS_COLOR — a retyped hex is how a room's dot
in a panel ends up disagreeing with its beacon on the roof.`).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and fix what it finds**

Run: `pnpm -F @superfabric/web test hudHygiene`

Every hit is either a token reference that should be used instead, or a genuine non-semantic
neutral (the `rgba(255,255,255,0.06)` inner highlight from Task 8 is `rgba`, not hex, and is chrome
rather than semantics — it does not trip this and should not).

- [ ] **Step 4: Reconcile the docs**

In `CLAUDE.md`, the `App.tsx`/HUD description says the top edge "carries only the two switchers … and is otherwise left clear". Replace with the three-control strip and name the readout. Also add `LimitReadout.tsx`, `limitHeadline.ts` and `collapseRuns.ts` to the `packages/web` layout list, in the style of the entries already there.

In `docs/ARCHITECTURE.md`, update the HUD section for the same two facts.

Both are required by the spec-first convention: a design change ships with its docs in the same PR.

- [ ] **Step 5: Full workspace check**

Run: `pnpm build && pnpm test`
Expected: every package builds; the whole suite is green. Note the new web test count in the commit body if `CLAUDE.md`'s "1355 tests green" line needs updating — it does, and that line is in `CLAUDE.md`'s Status section.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/index.css packages/web/test/hudHygiene.test.ts CLAUDE.md docs/ARCHITECTURE.md
git commit -m "feat(web): a heading step, a palette guard, and the docs to match"
```

---

## Self-review notes

Checked against `docs/superpowers/specs/2026-08-04-hud-redesign-design.md`:

| Spec section | Task |
|---|---|
| §1 components to vendor | 1 |
| §2 surface hierarchy | 1 (`card.tsx`), 6 (adoption) |
| §3 floor/HUD junction | 8 |
| §4 console | 4, 5 |
| §5 limit readout | 2, 3; room-panel half in 6 |
| §6 typography | 9 |
| §7 invariants | constraints above; enforced by 7 and 9 |
| §8 testing | 1, 2, 4, 7, 9 |

**Where this plan is instructions rather than code, and why.** Tasks 1–4 and 7–9 carry the exact
source to write. Tasks 5 and 6 do not: `ConsoleDrawer.tsx` (525 lines), `RoomPanel.tsx` (763) and
`TaskPanel.tsx` (344) were surveyed but not read line by line while planning, and exact replacement
code for a file that was skimmed would be a guess wearing the costume of a specification. Each of
those tasks therefore opens by reading its file end to end, and states the constraints that must
survive the edit. If you are implementing them and the instructions under-determine something,
prefer the existing file's own pattern over inventing one.

Two spec items are deliberately *not* separate tasks: `alert.tsx` is vendored in Task 1 and adopted
by `NoticeBar` during Task 7's sweep (it is a one-element file), and `dialog.tsx` likewise reaches
`FactoryTransfer`'s import-problems list there. If either turns out to need real layout work, split
it out rather than growing Task 7.
