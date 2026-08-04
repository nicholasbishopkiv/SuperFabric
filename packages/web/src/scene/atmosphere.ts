import { SMOKE_FADE_MS } from "../store";

/**
 * The arithmetic behind the things that make the floor look inhabited: a chimney plume, and the slats
 * of a belt crawling under a package.
 *
 * Pure, and separate from the components that draw it, for the reason the rest of `scene/*` is: jsdom
 * cannot render WebGL, so a claim like "an idle chimney emits nothing at all" is only checkable if the
 * claim is a function.
 *
 * **All of it is deliberately quiet.** The belts, the packages and the status beacons are the readable
 * things on this floor and this is atmosphere; every constant here was chosen to sit under them.
 */

// ---- chimney smoke ------------------------------------------------------------------------------

/** How many puffs are in the air above one vent at a time. */
export const SMOKE_PUFFS_PER_VENT = 7;
/** How long one puff takes to rise, thin out and vanish. */
export const SMOKE_LIFE_MS = 2_600;
/** How far it climbs in that time. */
export const SMOKE_RISE = 2.9;
/** How far it wanders sideways on the way up — a plume, not a laser. */
export const SMOKE_DRIFT = 0.62;
/** Radius fresh out of the pipe, and at its widest before it starts to disperse. */
export const SMOKE_MIN_SCALE = 0.24;
export const SMOKE_MAX_SCALE = 0.72;
/** The fraction of a puff's life after which it starts shrinking away to nothing. */
const SMOKE_TAPER_FROM = 0.68;

/**
 * How hard a room's chimney is smoking, from 1 (working) down to 0 (nothing at all).
 *
 * The middle of that range is the *fade*, and it is the only reason the store keeps a deadline per
 * room: a plume that stopped the instant a turn completed would pop out of existence, and a fade needs
 * frames after the work has stopped. `hasMotion` counts a live deadline for exactly that window, and
 * `reapSmoke` dropping it is what lets the canvas go back to `frameloop="demand"`.
 *
 * **Zero is load-bearing**: an idle chimney draws no instances at all, so an idle factory has no
 * hidden per-frame work waiting for someone to ask for a frame.
 */
export function smokeStrength(working: boolean, smokeUntil: number, now: number): number {
  if (working) return 1;
  if (smokeUntil <= now) return 0;
  return Math.min(1, (smokeUntil - now) / SMOKE_FADE_MS);
}

/** One puff of smoke: where it is above its vent, how big, and how far it has thinned out. */
export interface Puff {
  /** How far through its life it is, in [0, 1). */
  life: number;
  /** Offset from the vent mouth. */
  x: number;
  y: number;
  z: number;
  /** Radius. Zero at the very end of a life, so a puff disappears rather than blinking out. */
  scale: number;
  /** How far towards the thinned-out colour it has gone, in [0, 1]. */
  mix: number;
}

/**
 * Where the `index`-th puff above a vent is at `elapsedMs`.
 *
 * The puffs share one loop and are spread evenly through it by their index, so a vent emits at a
 * steady rate with no state at all — which is what lets the whole plume be recomputed from the clock
 * on any frame, including the first one after the tab was backgrounded.
 */
export function puffAt(index: number, elapsedMs: number): Puff {
  const offset = (index % SMOKE_PUFFS_PER_VENT) / SMOKE_PUFFS_PER_VENT;
  const raw = elapsedMs / SMOKE_LIFE_MS + offset;
  const life = raw - Math.floor(raw);
  // Grows as it rises, then tapers to nothing over the last third: smoke disperses, it does not stop.
  const taper = life < SMOKE_TAPER_FROM ? 1 : Math.max(0, (1 - life) / (1 - SMOKE_TAPER_FROM));
  const wander = Math.sin(life * 3.4 + index * 1.7) * SMOKE_DRIFT * life;
  return {
    life,
    x: wander,
    y: life * SMOKE_RISE,
    // A second, slower wobble on the other axis, so the column is not flat from one side.
    z: Math.cos(life * 2.2 + index) * SMOKE_DRIFT * 0.6 * life,
    scale: (SMOKE_MIN_SCALE + (SMOKE_MAX_SCALE - SMOKE_MIN_SCALE) * life) * taper,
    mix: life,
  };
}

// ---- belt slats ---------------------------------------------------------------------------------

/**
 * How fast the slats crawl, in slat-spacings per second. Slower than the packages that ride them on
 * purpose: the belt is the road and the box is the traffic, and a road that moved as fast as its
 * traffic would compete with it for the eye.
 */
export const SLAT_CRAWL_SPEED = 0.5;

/**
 * How far the slats of a belt have crawled, as a fraction of one spacing, in [0, 1).
 *
 * `flow` is which way the traffic is going (`+1` along the belt as drawn, `-1` against it, `0` for an
 * empty belt, which does not move at all). Wrapped rather than accumulated, so a belt that has been
 * running for an hour needs no state and cannot drift.
 */
export function slatOffset(elapsedSeconds: number, flow: number): number {
  if (flow === 0) return 0;
  const raw = elapsedSeconds * SLAT_CRAWL_SPEED * flow;
  return raw - Math.floor(raw);
}

/**
 * Where the `index`-th of `count` slats sits along its belt, in [0, 1), having crawled by `offset`.
 *
 * The modulo is what makes it a loop: the slat that runs off the end of the belt is the one that
 * appears at the start of it, so the strip is endless with a fixed number of slats.
 */
export function slatPosition(index: number, count: number, offset: number): number {
  if (count <= 0) return 0;
  return ((index + 0.5 + offset) % count) / count;
}
