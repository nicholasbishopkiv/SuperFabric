import type { ScenePosition } from "./protocol.js";

/** Rooms of the same "ring" sit this far apart in angle; each full ring steps outwards. */
export const RING_SLOTS = 8;

/**
 * How far the first ring of workshops stands from the project block.
 *
 * This is not a free parameter: the gap between two buildings is what the conveyor between them has
 * to be drawn in. A 6-wide project block and 4-wide workshops eat 5 units of any belt's length
 * before it starts, so at the original radius of 8 almost the whole belt was inside the buildings and
 * the sliver that showed was under a roof. At 14 there is a clear run of floor between every pair of
 * buildings, which is the point of having belts at all.
 */
export const RING_RADIUS = 14;
/** Each full ring steps out by this much, so ring 2 clears ring 1's roofs. */
export const RING_STEP = 5;

/**
 * The whole ring is rotated by half a slot — 22.5° — and that is a *viewing* decision, not a
 * decorative one.
 *
 * The floor is read down a fixed isometric diagonal (the camera sits on x = z, so its view axis
 * crosses the floor at 45°). Without this offset slot 1 lands at exactly 45°, which puts that
 * workshop directly behind the project block from the camera's point of view: the block hides the
 * building, and the belt between them is occluded for its whole length. Half a slot of rotation
 * moves every slot off the diagonal — the angles become 22.5°, 67.5°, … 337.5° — so no room can ever
 * line up with the view axis, whichever ring it is on.
 */
export const RING_ANGLE_OFFSET = Math.PI / 8;

/**
 * Where the n-th workshop stands, so the first buildings never stack on each other:
 * radius `RING_RADIUS + floor(n / RING_SLOTS) * RING_STEP`, angle
 * `RING_ANGLE_OFFSET + (n % RING_SLOTS) * (PI / 4)`, rounded to 3 decimals.
 *
 * This lives in `shared` because both sides need it and they must agree: the server assigns a new
 * room's position with it, and the browser uses the same formula to preview where a building will
 * land before the server answers. Two copies of a layout formula drift the moment one is tuned.
 */
export function ringPosition(index: number): ScenePosition {
  const radius = RING_RADIUS + Math.floor(index / RING_SLOTS) * RING_STEP;
  const angle = RING_ANGLE_OFFSET + (index % RING_SLOTS) * (Math.PI / 4);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return { x: round(radius * Math.cos(angle)), z: round(radius * Math.sin(angle)) };
}
