# 0003 — shadcn/ui (Radix + Tailwind) for the HUD

Date: 2026-08-04 · Status: accepted

## Context

The HUD grew organically: three panels (rooms, console, task board) built from hand-rolled
inline styles and a small `hud/theme.ts` of greys. It works and it is legible, but it looks
assembled rather than designed, and every new control re-invents its own spacing, focus
ring and disabled state. The operator asked for a real component library.

The HUD is unusual in one way that rules some options out: it floats **over a live WebGL
canvas**. It needs precise control of translucency, blur and density, it must never steal
pointer events from the floor except where a panel actually is, and it must stay readable
against a scene whose colours change. It is also dark-only by nature — a bright panel over
a factory floor is a flashlight in the eye.

## Decision

**Adopt shadcn/ui — Radix UI primitives styled with Tailwind, with the component source
copied into `packages/web/src/ui/`.**

Concretely: Tailwind v4 in the web package, Radix primitives as dependencies, and shadcn
components vendored as our own files rather than imported from a package.

## Why this one

- **We own the components.** shadcn is not a runtime dependency — it is source we copy and
  then edit. For a bespoke HUD that will keep diverging from any library's defaults, that
  is the difference between styling and fighting.
- **Radix gives the hard parts for free**: select, dialog, tooltip, collapsible,
  scroll-area, popover — accessible, keyboard-navigable, focus-managed. Those are exactly
  the controls the panels need, and they are the parts that are tedious and easy to get
  subtly wrong by hand.
- **Tailwind gives density control.** A HUD lives or dies on spacing and on translucency
  (`bg-background/80 backdrop-blur`); utility classes make that adjustable per element
  without a stylesheet round trip.
- **MIT throughout**, matching the dependency policy, with no copyleft anywhere in the
  tree.
- **Bundle cost is small in context.** The web bundle is already ~1.2 MB because of
  three.js; Radix primitives are tree-shaken per component and Tailwind ships only the
  utilities actually used.

## Rejected

- **Mantine / Chakra** — batteries-included and pleasant, but each brings its own runtime
  styling engine and theme object. Over a canvas we would spend the savings on overriding
  their defaults, and we would carry a dependency we cannot edit in place.
- **Radix Themes** (Radix's own styled layer) — faster to adopt than shadcn, but it owns
  the visual language. We want Radix's behaviour with our own look.
- **Ark UI / Park UI** — credible and framework-agnostic, smaller ecosystem and fewer
  worked examples for exactly the controls we need.
- **Keep hand-rolling** — the honest baseline. Rejected because the HUD is about to grow a
  project switcher, folder pickers, an attachment tray and (in M2) per-account limit
  meters; that is the point where consistent primitives stop being a luxury.

## Consequences

- Tailwind joins the web build. It does not touch the server or the scene — the 3D side has
  no DOM to style.
- A `packages/web/src/ui/` directory of vendored components appears. It is ours: reviewed
  like any other source, edited freely, and not upgraded wholesale from upstream.
- The existing panels get rebuilt on the new primitives in one pass, so the HUD is
  consistent rather than half-migrated. `hud/theme.ts` is replaced by Tailwind tokens.
- Verify at adoption time that the versions actually agree: React 19 + Vite 6 + Tailwind 4
  + the Radix versions shadcn pulls. If any of that fights, say so before proceeding rather
  than pinning something old.

## Adopted — 2026-08-04

Done in one pass. Nothing fought, and nothing was pinned back.

- **Versions.** React 19.2 · Vite 6.4 · Tailwind 4.3.3 (`@tailwindcss/vite`, whose peer range
  is `^5.2 || ^6 || ^7 || ^8`) · Radix select 2.3, popover 1.1, collapsible 1.1, slot 1.3 —
  all of which declare `react: … || ^19.0`.
- **No CLI.** shadcn's generator assumes a Next.js layout and a `components.json`; the five
  components we wanted were faster to vendor by hand, and they are ours to edit anyway.
- **Licences.** Radix / Tailwind / clsx / tailwind-merge MIT · `class-variance-authority`
  Apache-2.0 · `lucide-react` ISC. One exception worth recording: `@tailwindcss/vite` pulls
  `lightningcss`, which is **MPL-2.0**. It is a build-time CSS transformer, used unmodified,
  and ships nothing into the bundle — but MPL is file-level copyleft and is not on the
  policy's list, so it is called out here rather than waved through.
- **Not adopted from the "hard parts" list.** `@radix-ui/react-tooltip` and
  `react-scroll-area`. Every tooltip in the HUD is a full path or a full id, which the native
  `title` shows without a portal per hover and lets the operator read at their own pace; and
  Radix's scroll area wraps the scrolling element in a viewport of its own, which the
  console's `scrollTop = scrollHeight` autoscroll would have to reach through. Native
  overflow with a thin dark scrollbar (`.hud-scroll`) does the same job for no dependency.
- **Cost.** JS 1,260 → 1,402 kB (gzip 355 → 402), plus 33 kB of CSS (gzip 6). ~140 kB of JS
  is Radix and floating-ui; `lucide-react` tree-shakes to the dozen icons actually imported.
  Against three.js's 1.2 MB that is the "small in context" this ADR predicted, but it is not
  nothing, and it is the number to watch if more primitives are vendored.
- **`hud/theme.ts` is gone.** Replaced by two things: neutral chrome tokens declared in
  `index.css`, and semantic colours *generated* from `scene/palette.ts` at boot by
  `hud/tokens.ts`. The overlay now contains no colour the floor does not also use.
