import type { RoomInfo } from "@superfabric/shared";
import { BAY_WIDTH, buildingSize, loadingBays } from "./layout";
import { roleWork, type WorkKind } from "./roleLook";

/**
 * What a department's forecourt is furnished with, and where the furniture stands.
 *
 * Pure arithmetic — no React, no three — like `layout.ts` and `errands.ts`, and for the same reason:
 * "a bench never stands in a doorway" is only a claim you can check if it is a function.
 *
 * ## What decides the props: the **roles present**, not what an agent is doing this second
 *
 * The two candidates were the roles in the room (stable) and the agent's current activity (live). The
 * roles win, and the reason is that a prop is a *building*-scale object: at the zoom a floor is read
 * at, furniture appearing and vanishing as tool calls come and go is a flicker under every workshop,
 * and the eye is drawn to change. Belts, packages and beacons are the three things that are allowed
 * to move here. Furniture is architecture, and architecture says what a place is *for*.
 *
 * Activity gets exactly one say, and the quietest one available: a prop with a lamp or a screen shows
 * it **lit while the room is working**, using the glazing's own colour and intensity (`DETAIL.window`
 * / `windowGlow`) rather than a second vocabulary for the same fact. It is a steady state rather than
 * a pulse, so it adds nothing to `hasMotion` — a factory whose furniture pulsed would be paying rAF
 * frames for decoration. The room's status rather than the individual agent's, which is a
 * simplification: a bench is shared, and a per-agent lamp would need the whole floor's event logs.
 *
 * ## Which prop
 *
 * By **work family** (`roleWork`), which is the operator's own grouping — "a workbench if they build,
 * a lab bench if they run tests/checks, a desk with a computer if they write or read" — extended in
 * the same register with a drafting table for the people who decide the shape and a rack for the
 * people who run the plant. It is the *same* five families the figures' carried tools come from, so
 * the tool in the hand and the furniture behind it are one vocabulary learnt once: the figure with
 * the spanner works at the bench, the one with the lens at the test rig.
 *
 * Deduplicated, so three backend agents make one bench rather than three. The generalist declares no
 * specialism and therefore furnishes nothing — a room of generalists is an empty forecourt, which is
 * the honest drawing of "nobody here has said what this department is".
 */

/** The five pieces of furniture. One per work family; `none` has none. */
export type PropKind = "bench" | "rig" | "desk" | "drafting" | "rack";

/** What each family works at. `null` for the generalist: no specialism, no furniture. */
export const PROP_FOR_WORK: Record<WorkKind, PropKind | null> = {
  build: "bench",
  check: "rig",
  write: "desk",
  plan: "drafting",
  operate: "rack",
  none: null,
};

/**
 * The order furniture is placed in, and therefore which piece is dropped when a room has more
 * disciplines than it has room for. Fixed rather than derived from the agent list, so a room's yard
 * does not rearrange itself when an agent comes or goes.
 */
export const PROP_ORDER: readonly PropKind[] = ["bench", "rig", "desk", "drafting", "rack"];

/** A place something can stand in a building's yard, in the building's own local frame. */
export interface PropSlot {
  x: number;
  z: number;
  /** The rotation that points the prop's front (local `+z`) out of the wall behind it. */
  yaw: number;
}

/** A piece of furniture, placed. */
export interface PlacedProp extends PropSlot {
  kind: PropKind;
}

/**
 * How far a prop's centre stands out from the wall it backs onto, and how far along that wall the two
 * slots sit from the corner.
 *
 * Both are inside the ring the figures stand on (`agentSlots` is at `width/2 + 1.3`) and well inside
 * the arc they walk to a bay on (`fetchPath`'s ring clears the footprint's *corners*), so furniture is
 * never walked through and never stands where a figure is drawn. `ACROSS` is capped because the
 * project block is 7 wide: scaled with the building, its slots would land exactly on the posts its own
 * agents stand at.
 */
const STANDOFF = 0.5;
const ACROSS_MAX = 1.6;

/** How close a slot may come to a loading bay before it is given up. */
const BAY_CLEARANCE = BAY_WIDTH * 0.9;

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * The four places a building can put furniture: two along each of the walls the default camera can
 * see (`+x` and `+z`), one either side of the wall's middle — which is where a loading bay sits when
 * there is one, and why the middle is left free.
 *
 * Only the two visible walls, deliberately. Furniture behind a building is furniture nobody will ever
 * see from the view this floor is read in, and paying draw calls for it would be paying for nothing.
 */
export function propSlots(kind: RoomInfo["kind"]): PropSlot[] {
  const half = buildingSize(kind).width / 2;
  const out = round3(half + STANDOFF);
  const across = round3(Math.min(half - 0.85, ACROSS_MAX));
  // Ordered **far corner first, and alternating walls**, which is what stops the common cases
  // stacking: the two slots nearest the building's own corner are adjacent, so filling them first put
  // one room's whole yard in a heap where the two visible walls meet. This way a room with one prop
  // gets an end of a wall, and a room with two gets one end of each.
  return [
    { x: -across, z: out, yaw: 0 },
    { x: out, z: -across, yaw: Math.PI / 2 },
    { x: across, z: out, yaw: 0 },
    { x: out, z: across, yaw: Math.PI / 2 },
  ];
}

/**
 * What stands in this room's yard: one piece of furniture per work family present, in `PROP_ORDER`,
 * placed into the free slots of `propSlots`.
 *
 * A slot within `BAY_CLEARANCE` of a loading bay is **not used**: a belt arrives there, a crate is
 * carried out of there, and a workbench across the door would be the floor contradicting itself. That
 * is why a room's furniture depends on the belts it has as well as on the agents in it, and why more
 * disciplines than free slots means the last of them simply is not drawn — the alternative is
 * stacking two benches in one place.
 */
export function roomProps(
  kind: RoomInfo["kind"],
  roleIds: readonly string[],
  beltDirections: readonly number[],
): PlacedProp[] {
  const wanted = new Set<PropKind>();
  for (const roleId of roleIds) {
    const prop = PROP_FOR_WORK[roleWork(roleId)];
    if (prop !== null) wanted.add(prop);
  }
  if (wanted.size === 0) return [];

  const bays = loadingBays(kind, beltDirections);
  const free = propSlots(kind).filter(
    (slot) => !bays.some((bay) => Math.hypot(bay.x - slot.x, bay.z - slot.z) < BAY_CLEARANCE),
  );

  const placed: PlacedProp[] = [];
  for (const kindOfProp of PROP_ORDER) {
    if (!wanted.has(kindOfProp)) continue;
    const slot = free[placed.length];
    if (slot === undefined) break;
    placed.push({ kind: kindOfProp, ...slot });
  }
  return placed;
}
