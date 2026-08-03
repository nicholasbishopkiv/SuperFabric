import type { ScenePosition } from "./protocol.js";

/** Rooms of the same "ring" sit this far apart in angle; each full ring steps outwards. */
export const RING_SLOTS = 8;

/**
 * Where the n-th workshop stands, so the first buildings never stack on each other:
 * radius `8 + floor(n / 8) * 5`, angle `(n % 8) * (PI / 4)`, rounded to 3 decimals.
 *
 * This lives in `shared` because both sides need it and they must agree: the server assigns a new
 * room's position with it, and the browser uses the same formula to preview where a building will
 * land before the server answers. Two copies of a layout formula drift the moment one is tuned.
 */
export function ringPosition(index: number): ScenePosition {
  const radius = 8 + Math.floor(index / RING_SLOTS) * 5;
  const angle = (index % RING_SLOTS) * (Math.PI / 4);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return { x: round(radius * Math.cos(angle)), z: round(radius * Math.sin(angle)) };
}
