import type { ScenePosition } from "@superfabric/shared";
import { CatmullRomCurve3, Vector3 } from "three";

/**
 * Where the belts run and how a package moves along one. Pure geometry: no React, no WebGL, so every
 * claim the scene depends on is unit-testable in jsdom.
 */

/** How high above the floor a belt sits — low enough to read as a conveyor, not a monorail. */
export const BELT_HEIGHT = 0.45;

/**
 * How far the middle of a belt is pushed sideways, as a fraction of its length. Belts are bowed for a
 * practical reason, not a decorative one: two rooms on the same ring are joined to the project block
 * by two nearly-collinear belts, and straight ones would lie on top of each other.
 */
export const DEFAULT_BOW = 0.18;

/**
 * A belt from one building to another, bowed slightly outward. Deliberately symmetric: swapping the
 * arguments bows the belt to the same side of the line, so a pair of rooms is one belt however it is
 * addressed.
 */
export function conveyorCurve(from: ScenePosition, to: ScenePosition, bow = DEFAULT_BOW): CatmullRomCurve3 {
  const start = new Vector3(from.x, BELT_HEIGHT, from.z);
  const end = new Vector3(to.x, BELT_HEIGHT, to.z);

  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  // The floor-plane normal of the line, oriented by the pair rather than by the argument order —
  // otherwise a -> b and b -> a would bow to opposite sides and draw two belts for one connection.
  const flip = dx < 0 || (dx === 0 && dz < 0) ? -1 : 1;
  const nx = length === 0 ? 0 : (-dz / length) * flip;
  const nz = length === 0 ? 0 : (dx / length) * flip;
  const offset = bow * length;

  const mid = new Vector3(
    (from.x + to.x) / 2 + nx * offset,
    BELT_HEIGHT,
    (from.z + to.z) / 2 + nz * offset,
  );
  return new CatmullRomCurve3([start, mid, end], false, "catmullrom", 0.5);
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
