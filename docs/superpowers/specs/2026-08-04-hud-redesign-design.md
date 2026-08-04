# HUD redesign: completing the component kit and making the limits visible

Status: approved 2026-08-04. Supersedes nothing; extends the HUD described in
`docs/ARCHITECTURE.md` and the M1b decision `docs/decisions/0003-ui-library.md`.

## Why

The operator's verdict was that the HUD "looks bad" and the request was to migrate to a
ready-made UI kit. Reading the code first changed the diagnosis, and the change is worth
recording because it is the reason this spec is not a migration.

**The kit is already here.** `packages/web` runs Tailwind v4 + Radix primitives + `cva` +
`lucide-react`, with five components vendored under `src/ui/` — that *is* shadcn/ui, which is
the mainstream React kit. What is missing is the other forty-odd components, and the cost of
their absence is visible: 68 native `title=` attributes standing in for tooltips, a hand-rolled
session tab strip, hand-rolled scroll containers, hand-rolled progress bars.

**But the kit is not what looks bad.** Swapping to Mantine or MUI would rewrite twenty files and
fix none of the following, because no kit has an opinion about an instrument panel floating over
a 3D isometric factory:

1. Every surface is `bg-panel/80` plus a hairline border, so the *create a room* form weighs
   exactly as much as the rooms it creates. There is no elevation, therefore no hierarchy.
2. The console is forty consecutive 11px lines reading `· starting`, ungrouped and untimed.
3. The warm concrete floor (`#c6bfb2`) meets the cool near-black chrome (`#10151b`) at a hard
   edge, so the two halves of the screen read as different applications.
4. The task board is a five-column grid of em-dashes.
5. The session tabs overflow into a cramped strip with a visible scrollbar.
6. Three type sizes (11/12/13px) at near-identical weight give the eye no entry point.

So: complete the kit, and redesign the visual layer. Both were approved.

## What is not in scope

Repainting the floor. `scene/palette.ts` carries a long, sound argument for the warm slab — the
warm/cool split is what stops a grey building on a grey floor reading as one continuous surface
at a shallow isometric angle. The floor is right; the *junction* is wrong, and that is a HUD
problem (§3).

Changing control density. `ui/button.tsx` deliberately tops out at 28px, two steps under
shadcn's default, and its comment explains that this density is why a panel can show three
sections at once. That decision stands.

## 1. Components to vendor

All Radix, all MIT, all consistent with the dependency licence policy in `CLAUDE.md`. Vendored
as our own source under `src/ui/`, in the same style as the existing five.

| Component | Replaces |
|---|---|
| `tooltip` | 68 native `title=` attributes — slow, unstyleable, invisible on touch |
| `tabs` | the hand-rolled session strip |
| `scroll-area` | the `.hud-scroll` CSS hack and the visible scrollbars |
| `separator` | ad-hoc `border-t` divs |
| `card` | the missing middle of the surface hierarchy (§2) |
| `progress` | hand-built bars, except the one in `UsageMeters` — see below |
| `dialog` | the import-problems list, destructive confirmations |
| `alert` | `NoticeBar` |

New dependencies: `@radix-ui/react-tooltip`, `-tabs`, `-scroll-area`, `-separator`,
`-progress`, `-dialog`.

`UsageMeters` keeps its own bar rather than adopting `progress` wholesale in one place: its bar
carries the hatched-estimate texture and the two threshold ticks, which are semantics rather
than decoration. It adopts the component's roles and accessibility shape, not its fill.

## 2. A surface hierarchy

Three levels, using tokens that already exist in `index.css` and are currently almost unused:

- **`panel`** — the chassis. The edge panels themselves.
- **`panel-raised` / card** — an entity: a room, a task, a session, an account.
- **`panel-sunken` / well** — recessed content: the transcript, file paths, code.

The rule is that an entity is a card and a container is not, so scanning a panel means counting
cards rather than parsing indentation.

## 3. The junction between floor and HUD

The floor stays as it is. The HUD stops butting into it:

- Panels get an inner light line along the edge that faces the scene, plus a real drop shadow,
  so a panel reads as glass laid *over* the floor rather than as a hole cut into it.
- The floor gets a vignette toward the frame, so the pale slab does not run flush into a black
  rectangle.

Neither touches `scene/palette.ts`.

## 4. The console

Today it is an undifferentiated wall. It becomes a transcript:

- consecutive identical events collapse (`starting ×17`) — this alone removes most of the wall;
- a gutter carries relative time;
- a tool call is a distinct row: icon plus the monospace gist that `gist.ts` already produces
  (the same summariser the thought bubble uses, so the two cannot read differently);
- the transcript sits in a sunken well;
- session tabs become `Tabs` in a horizontal `ScrollArea`, and past a threshold collapse to the
  active tab plus a picker, rather than ten eight-character stubs.

## 5. The limit readout — the one functional addition

### The gap

Limits are reachable only through two gates: open the **Accounts** popover, *and* have
`account.credentialsPresent`. Nothing on the permanently visible surface mentions limits at all.
Meanwhile `scheduler.ts` pauses every agent on the floor at 95%. The product invests heavily in
the *honesty* of this reading — approximate marking, "unknown" rather than a guess, no pricing
table — and then puts it where nobody looks.

Worse, the zero-account case renders nothing, and nothing reads as "fine".

### The surface

A permanent readout in the top strip, immediately after the **Accounts** button. Not a fourth
edge panel: `TopLeftBar`'s own comment already argues that a permanent hole in the floor does not
pay for a list that is usually three rows long, and that argument holds.

It shows the **worst** account — the one that will pause agents first — as a short bar with its
percentage, plus **time remaining** whenever the burn rate is known. Time ranks above percentage
because it is the figure an operator plans around. With more than one account configured, the
account's label rides alongside, or the number is unattributed.

### Loudness follows the thresholds, not the presence of a number

Below `LIMIT_WARN_PERCENT` (80) it is quiet chrome, in the same register as its neighbouring
buttons. At 80 it takes the `blocked` amber; at `LIMIT_PAUSE_PERCENT` (95), or whenever `limited`
is set, the `error` red with a paused badge. No sixth loud colour is introduced, so the rule that
status wins every read survives.

### Silence is stated in words

The whole point of the surface, given this product's stance that an honest gap beats a guess:

| State | What it says |
|---|---|
| no accounts | on `~/.claude` — no limit reading |
| account without credentials | not logged in |
| polled never | no reading yet |
| approximate | hatching plus `≈`, the same texture `UsageMeters` uses |
| burn rate unavailable | *unknown* in the time slot, never a blank |

### No second source of truth

Clicking opens the existing popover. `UsageMeters` and `BurnRate` do not move and are not
duplicated — the readout is a headline over them, not a re-render of the same figures under its
own rules. It reads the same store fields and the same shared constants.

### Room panel — already right

An earlier draft of this spec proposed making a paused agent state its reason in words. It already
does: `AgentLine` renders "resumes in 2 h 14 m", falls back to "waiting for the limit to lift" when
no reset time is known, and carries the exact instant alongside. Nothing to change beyond the
tooltip migration every other surface gets.

### Documentation consequence

`CLAUDE.md` currently records that the top edge "carries only the two switchers … and is
otherwise left clear". That decision changes here, so the sentence changes in the same commit,
per the spec-first convention.

## 6. Typography

One size step up for entity headings and a genuine weight split, keeping instrument density. The
existing `--text-2xs/xs/sm` scale stays; what is added is a heading step and the discipline of
using weight to mean something.

## 7. Invariants preserved

- Semantic colours stay generated from `scene/palette.ts` through `hud/tokens.ts`. No palette hex
  is retyped into CSS.
- `SceneOverlay` remains the only way DOM enters the scene.
- `EdgePanel` keeps `forceMount`, so a half-typed room name survives a collapse.
- `useHudInset` keeps measuring every state, including the collapsed pill, so the camera still
  frames the factory into the strip the panels leave.
- Accounts stay machine-wide; the readout is therefore not scoped to a project.

## 8. Testing

The 424 web tests render no components — they are pure logic plus source greps in the idiom of
`test/sceneOverlay.test.ts`. So this redesign breaks no test and no test catches its regressions.
Verification is therefore visual, in a live browser, plus two new source-grep guards in the
existing idiom:

- no `title=` survives in `src/hud/` once tooltips land;
- no literal hex colour appears in `src/hud/`, which is the palette invariant made mechanical.

Pure logic added along the way — choosing the worst account, formatting a remaining duration at a
resolution the readings support — is unit-tested as a pure function, the way `burnRate.test.ts`
and `errands.test.ts` already do it.
