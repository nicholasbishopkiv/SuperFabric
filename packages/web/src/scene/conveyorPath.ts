import type { RoomInfo, ScenePosition } from "@superfabric/shared";
import { CatmullRomCurve3, Vector3 } from "three";
import { buildingSize } from "./layout";

/**
 * Where the belts run and how a package moves along one. Pure geometry: no React, no WebGL, so every
 * claim the scene depends on is unit-testable in jsdom.
 */

/** How high above the floor a belt sits — low enough to read as a conveyor, not a monorail. */
export const BELT_HEIGHT = 0.45;

/**
 * One end of a belt: a building's position *and* its kind, because a belt has to know how big the
 * building it leaves is. `RoomInfo` satisfies this structurally, so a caller holding a room can pass
 * it straight through.
 */
export type BeltEnd = Pick<RoomInfo, "position" | "kind">;

/**
 * How far clear of a wall a belt stops. Small and deliberate: a workshop's roof slab overhangs its
 * walls by 0.2, so an endpoint exactly on the wall would put the first package under the eaves.
 */
export const BELT_EDGE_MARGIN = 0.3;

/**
 * Distance from a building's centre to its wall, along a floor direction. The footprint is a square,
 * so this is `half / max(|cos|, |sin|)` — half the width when the belt leaves face-on, and half the
 * diagonal when it leaves towards a corner.
 */
export function wallDistance(kind: RoomInfo["kind"], dx: number, dz: number): number {
  const half = buildingSize(kind).width / 2;
  const longest = Math.max(Math.abs(dx), Math.abs(dz));
  if (longest === 0) return half;
  return (half * Math.hypot(dx, dz)) / longest;
}

/**
 * Where a belt between two buildings actually starts and stops: **at the walls**, not at the
 * centres. A belt drawn centre-to-centre spends its first and last few units buried inside a solid
 * block, so a package appears to slide out of the middle of a blank slab and then vanish into
 * another one. Anchored to the walls, it emerges at a door and arrives at the far one.
 *
 * If the two buildings are so close that their insets would meet, both are scaled back
 * proportionally so the belt keeps a direction and a length rather than folding inside out.
 */
export function beltEnds(from: BeltEnd, to: BeltEnd): { start: ScenePosition; end: ScenePosition } {
  const dx = to.position.x - from.position.x;
  const dz = to.position.z - from.position.z;
  const span = Math.hypot(dx, dz);
  if (span === 0) return { start: from.position, end: to.position };

  let head = wallDistance(from.kind, dx, dz) + BELT_EDGE_MARGIN;
  let tail = wallDistance(to.kind, dx, dz) + BELT_EDGE_MARGIN;
  // Two overlapping buildings still get a belt; it is simply short.
  const usable = span * 0.8;
  if (head + tail > usable) {
    const scale = usable / (head + tail);
    head *= scale;
    tail *= scale;
  }
  return {
    start: { x: from.position.x + (dx / span) * head, z: from.position.z + (dz / span) * head },
    end: { x: to.position.x - (dx / span) * tail, z: to.position.z - (dz / span) * tail },
  };
}

/**
 * How far the middle of a belt is pushed sideways, as a fraction of its length. Belts are bowed for a
 * practical reason, not a decorative one: two rooms on the same ring are joined to the project block
 * by two nearly-collinear belts, and straight ones would lie on top of each other.
 */
export const DEFAULT_BOW = 0.18;

/**
 * Extra sideways offset per unit of `fan`, in world units.
 *
 * Bowing by a *fraction of length* alone is not enough to separate belts leaving the same wall: two
 * spine belts are within a few percent of the same length, so they bow by the same amount and track
 * each other all the way in, arriving as one thick line at the mouth. `fan` is the belt's signed
 * index among the belts leaving that room (the store assigns it), and this is how far apart one step
 * of index pushes them. It is a fixed distance rather than a fraction, because the point is to
 * separate two belts from each other and not to be proportional to anything.
 */
export const BELT_FAN_STEP = 1.15;

/**
 * A belt from one building's wall to another's, bowed slightly outward. Deliberately symmetric in
 * `from`/`to`: swapping the arguments bows the belt to the same side of the line, so a pair of rooms
 * is one belt however it is addressed.
 *
 * `fan` must be the same for the belt and for any package travelling it, which is why it is carried
 * on the store's `Conveyor` rather than derived twice — a box on a belt drawn with a different fan
 * would fly through the air beside it.
 */
export function conveyorCurve(
  from: BeltEnd,
  to: BeltEnd,
  bow = DEFAULT_BOW,
  fan = 0,
): CatmullRomCurve3 {
  const ends = beltEnds(from, to);
  const start = new Vector3(ends.start.x, BELT_HEIGHT, ends.start.z);
  const end = new Vector3(ends.end.x, BELT_HEIGHT, ends.end.z);

  const dx = ends.end.x - ends.start.x;
  const dz = ends.end.z - ends.start.z;
  const length = Math.hypot(dx, dz);
  // The floor-plane normal of the line, oriented by the pair rather than by the argument order —
  // otherwise a -> b and b -> a would bow to opposite sides and draw two belts for one connection.
  const flip = dx < 0 || (dx === 0 && dz < 0) ? -1 : 1;
  const nx = length === 0 ? 0 : (-dz / length) * flip;
  const nz = length === 0 ? 0 : (dx / length) * flip;
  const offset = bow * length + fan * BELT_FAN_STEP;

  const mid = new Vector3(
    (ends.start.x + ends.end.x) / 2 + nx * offset,
    BELT_HEIGHT,
    (ends.start.z + ends.end.z) / 2 + nz * offset,
  );
  return new CatmullRomCurve3([start, mid, end], false, "catmullrom", 0.5);
}

// ---- messages nobody has picked up yet -----------------------------------------------------------

/** How far along its belt the first undelivered message sits: at the sender's door, not on the road. */
export const WAITING_T = 0.055;
/** How much further along each one behind it stands, so a queue reads as a queue and not as a blob. */
export const WAITING_T_STEP = 0.022;
/** And how much higher, which is what makes the pile look stacked rather than strung out. */
export const WAITING_LIFT = 0.19;
/**
 * How many markers one pair of rooms stacks before they stop spreading. A room with forty messages
 * queued must not build a staircase across the floor — past this they pile in place, and the number
 * is the operator's to read off the room panel rather than to count off the floor.
 */
export const WAITING_STACK_MAX = 6;

/** Where the `index`-th waiting message for one pair of rooms stands on their belt. */
export function waitingSlot(index: number): { t: number; lift: number } {
  const i = Math.min(Math.max(index, 0), WAITING_STACK_MAX - 1);
  return { t: WAITING_T + i * WAITING_T_STEP, lift: i * WAITING_LIFT };
}

/**
 * Each waiting message's place in the queue **at its own sender, for its own recipient** — so two
 * rooms both waiting on the payments room build two piles rather than one, and a reply queued the
 * other way round stacks separately from the request it answers.
 *
 * Directed on purpose (`from -> to`, not the undirected pair a belt is drawn for): the marker stands
 * at the sender's end, so which end it is matters.
 */
export function waitingStackIndices(queue: readonly { from: string; to: string }[]): number[] {
  const seen = new Map<string, number>();
  return queue.map(({ from, to }) => {
    const key = `${from}>${to}`;
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    return index;
  });
}

/**
 * Point on the belt at `t` in [0, 1], measured by *arc length* so a package travels at a constant
 * speed instead of hurrying through the bend. Pass `target` to reuse a vector: this is called once
 * per package per frame.
 */
export function pointAt(curve: CatmullRomCurve3, t: number, target = new Vector3()): Vector3 {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return curve.getPointAt(u, target);
}
