import type { RoomInfo } from "@superfabric/shared";
import type { FactoryStatus } from "../store";
import { BAY_WIDTH, bayForDirection, buildingSize, type LoadingBay } from "./layout";

/**
 * An agent fetching a crate from a loading bay: where it walks, how long it takes, which agent goes,
 * and where the crates nobody collected pile up.
 *
 * Pure arithmetic — no React, no three, no store — for the same reason `layout.ts` and
 * `conveyorPath.ts` are: jsdom cannot render WebGL, so the only way to actually *test* what the
 * figures do is for the maths to live somewhere a test can call it. `Agents` places what this
 * returns and `store.ts` schedules from it; neither decides any of it.
 */

/** How fast an agent walks, in world units per second. A purposeful walk, not a jog. */
export const WALK_SPEED = 1.6;

/**
 * How far outside the wall the crate is met. The belt already stops `BELT_EDGE_MARGIN` clear of the
 * wall, so this is roughly where the last package on it sits — near enough that the figure and the
 * box are plainly the same event, far enough that a 0.44-wide body does not stand inside the crate.
 */
export const PICKUP_STANDOFF = 0.8;

/**
 * The shortest leg we will animate. A post two metres from its own bay would otherwise produce a
 * 300 ms twitch, which reads as a glitch rather than as someone walking.
 */
export const MIN_LEG_MS = 420;

/**
 * How far outside the footprint's corners the walk passes. Agents walk *around* their building, never
 * through it, so the arc has to clear the diagonal rather than the wall.
 */
const ARC_CLEARANCE = 0.35;

/** Roughly one waypoint per this many radians, so the arc reads as a curve and not as a chord. */
const ARC_STEP = 0.28;

/** A walk, as a polyline in the building's own local frame. `Agents` is rendered in that frame. */
export type WalkPath = readonly (readonly [x: number, z: number])[];

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Where the crate is met: just outside the bay, on the wall's outward normal.
 *
 * A bay's `yaw` is the rotation that points its face out of the wall, and a yaw of θ about y sends
 * local `+z` to `(sin θ, cos θ)` — which is therefore the outward normal.
 */
export function bayPickupPoint(bay: LoadingBay): [x: number, z: number] {
  return [
    round3(bay.x + Math.sin(bay.yaw) * PICKUP_STANDOFF),
    round3(bay.z + Math.cos(bay.yaw) * PICKUP_STANDOFF),
  ];
}

/**
 * The route from an agent's post to the bay a belt arrives at: **around** the building on an arc, then
 * a short step in (or out) to the crate.
 *
 * A straight line would be shorter and wrong — posts stand on the camera-facing diagonal and a belt
 * can arrive at any of the four walls, so the direct route from a post to the far bay goes through the
 * building. The arc is taken at whichever radius clears the footprint's *corners*, which is the
 * diagonal rather than the wall, and always the short way round.
 */
export function fetchPath(
  kind: RoomInfo["kind"],
  post: readonly [x: number, z: number],
  bay: LoadingBay,
): WalkPath {
  const pickup = bayPickupPoint(bay);
  const half = buildingSize(kind).width / 2;
  const ring = Math.max(Math.hypot(post[0], post[1]), half * Math.SQRT2 + ARC_CLEARANCE);

  const from = Math.atan2(post[1], post[0]);
  const to = Math.atan2(pickup[1], pickup[0]);
  // The short way round: any delta outside ±180° is the long way about the same two points.
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;

  const steps = Math.max(1, Math.ceil(Math.abs(delta) / ARC_STEP));
  const points: [number, number][] = [[round3(post[0]), round3(post[1])]];
  for (let i = 1; i <= steps; i++) {
    const angle = from + delta * (i / steps);
    points.push([round3(ring * Math.cos(angle)), round3(ring * Math.sin(angle))]);
  }
  points.push(pickup);

  // Zero-length segments have no direction, and a figure walking one would have no facing.
  return points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-6);
}

/** How far the walk is, in world units. */
export function pathLength(path: WalkPath): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  }
  return total;
}

/** Where on the walk the figure is at `t` in [0, 1] of its length, and which way it is facing. */
export function walkAt(path: WalkPath, t: number): { x: number; z: number; yaw: number } {
  if (path.length === 0) return { x: 0, z: 0, yaw: 0 };
  if (path.length === 1) return { x: path[0][0], z: path[0][1], yaw: 0 };
  const target = Math.max(0, Math.min(1, t)) * pathLength(path);
  let travelled = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = path[i][0] - path[i - 1][0];
    const dz = path[i][1] - path[i - 1][1];
    const segment = Math.hypot(dx, dz);
    // The final segment also catches t = 1 exactly, and floating-point shortfalls just under it.
    if (travelled + segment >= target || i === path.length - 1) {
      const along = segment === 0 ? 0 : Math.max(0, Math.min(1, (target - travelled) / segment));
      return {
        x: path[i - 1][0] + dx * along,
        z: path[i - 1][1] + dz * along,
        // A figure's front is its local +z, so this is the yaw that sends +z along the direction of
        // travel — the same convention `agentFacing` uses.
        yaw: Math.atan2(dx, dz),
      };
    }
    travelled += segment;
  }
  const last = path[path.length - 1];
  return { x: last[0], z: last[1], yaw: 0 };
}

/** How long one leg of a fetch takes. Derived from the distance, so every agent walks at one speed. */
export function fetchWalkMs(path: WalkPath): number {
  return Math.max(MIN_LEG_MS, Math.round((pathLength(path) / WALK_SPEED) * 1000));
}

// ---- when an agent leaves, and what it is doing when ---------------------------------------------

/** The clock of one fetch. Fixed when the errand is created, so no frame has to re-decide it. */
export interface ErrandTiming {
  /** When the agent leaves its post. */
  startAt: number;
  /** When the crate is in hand — never before it has actually arrived. */
  pickupAt: number;
  /** One-way walk duration; the return leg is the same walk carrying something. */
  legMs: number;
}

/**
 * What an agent on an errand is doing:
 *
 * - `post` — it has been given the job but the crate is still far up the belt; it waits on its mark.
 * - `out` — walking to the bay, empty-handed.
 * - `wait` — standing at the bay, because it got there before the crate did.
 * - `back` — walking home with the crate at its side.
 * - `done` — the errand is over and the store should forget it.
 */
export type ErrandPhase = "post" | "out" | "wait" | "back" | "done";

/** When an errand is finished, which is when the store drops it and the crate with it. */
export function errandEndsAt(timing: ErrandTiming): number {
  return timing.pickupAt + timing.legMs;
}

/**
 * How much sooner than strictly necessary an agent sets off.
 *
 * Small and deliberate. Timed to the millisecond, the figure and the box reach the dock on the same
 * frame, which reads as a coincidence; a beat of standing at the open door *waiting* for the crate is
 * what makes it read as somebody who went out to meet it. It is also the only thing that makes the
 * `wait` phase reachable at all.
 */
export const EARLY_MS = 400;

/**
 * When to set off so the agent is at the bay before the crate is, and when the crate is in hand.
 *
 * Leaving *early* is the point: an agent that waited for the box to land and then walked out would
 * meet it a walk later, and the two events would not read as one. If there is not enough time left it
 * leaves now and the crate waits at the bay for *it* instead — which is the honest version, and the
 * only one available once a box is already halfway down the belt.
 */
export function planErrand(now: number, arrivesAt: number, legMs: number): ErrandTiming {
  const startAt = Math.max(now, arrivesAt - legMs - EARLY_MS);
  return { startAt, pickupAt: Math.max(arrivesAt, startAt + legMs), legMs };
}

/** Where along its walk an agent on an errand is, and whether it is carrying anything yet. */
export function errandAt(
  timing: ErrandTiming,
  now: number,
): { phase: ErrandPhase; t: number; carrying: boolean } {
  const { startAt, pickupAt, legMs } = timing;
  if (now < startAt) return { phase: "post", t: 0, carrying: false };
  if (now < startAt + legMs) {
    return { phase: "out", t: (now - startAt) / legMs, carrying: false };
  }
  if (now < pickupAt) return { phase: "wait", t: 1, carrying: false };
  if (now < pickupAt + legMs) {
    return { phase: "back", t: 1 - (now - pickupAt) / legMs, carrying: true };
  }
  // Home, and the crate is inside the building — **not** still in its hands. The store reaps a
  // finished errand on the next frame, but a backgrounded tab renders none, and a figure standing at
  // its post holding a box it delivered minutes ago would be the wrong picture to come back to.
  return { phase: "done", t: 0, carrying: false };
}

// ---- who goes -----------------------------------------------------------------------------------

/**
 * Whether an agent in this state could walk to a bay at all.
 *
 * `blocked`, `paused` and `error` cannot: the first is waiting on the operator, the second has been
 * stopped by the limit scheduler and the third has failed. Sending one of them on an errand would
 * paint over exactly the state the operator needs to see — a figure that is walking does not read as
 * a figure that is stuck.
 */
export function canFetch(status: FactoryStatus): boolean {
  return status === "idle" || status === "working";
}

/**
 * Which of a room's agents goes, or `null` when **nobody is free** — in which case the crate stays at
 * the bay and piles up, which is the information the operator wants out of a room with nobody home.
 *
 * An `idle` agent is always preferred over a `working` one, whatever the order they stand in: it has
 * nothing else to do. Among equals the order of the room's agent list decides, so the same factory
 * always sends the same figure and a re-render cannot swap two agents mid-walk.
 */
export function chooseFetcher(
  agents: readonly { id: string; status: FactoryStatus }[],
  busy: ReadonlySet<string> = new Set(),
): string | null {
  let working: string | null = null;
  for (const agent of agents) {
    if (busy.has(agent.id) || !canFetch(agent.status)) continue;
    if (agent.status === "idle") return agent.id;
    if (working === null) working = agent.id;
  }
  return working;
}

// ---- crates nobody collected --------------------------------------------------------------------

/** How many crates stand across the mouth of one bay before the pile starts a second row. */
export const BAY_PILE_COLUMNS = 3;
/** …and how many rows it climbs before it stops growing and piles in place. */
export const BAY_PILE_ROWS = 4;
/** Centre-to-centre spacing of the pile, across and up. */
const BAY_PILE_ACROSS = BAY_WIDTH / BAY_PILE_COLUMNS;
const BAY_PILE_RISE = 0.44;

/**
 * Where the `index`-th uncollected crate stands, in the **bay's** local frame (`+z` out of the wall,
 * `x` across the opening).
 *
 * It fills across the door first and then upwards, so one crate is one crate and five are plainly
 * five — a single tall column would read as one tall object. Past `BAY_PILE_ROWS` it stops growing:
 * a room with forty crates must not build a tower through its own roof, and the count is the room
 * panel's to give in figures.
 */
export function bayCrateSlot(index: number): { x: number; z: number; y: number } {
  const capped = Math.max(0, Math.min(index, BAY_PILE_COLUMNS * BAY_PILE_ROWS - 1));
  const column = capped % BAY_PILE_COLUMNS;
  const row = Math.floor(capped / BAY_PILE_COLUMNS);
  return {
    x: round3((column - (BAY_PILE_COLUMNS - 1) / 2) * BAY_PILE_ACROSS),
    // Clear of the dock lip, and inside the pickup point so a figure never stands in the pile.
    z: round3(0.42 + (row % 2) * 0.06),
    y: round3(0.24 + row * BAY_PILE_RISE),
  };
}

/**
 * The uncollected crates at each of a building's bays, in landing order — the shape `Building` draws.
 *
 * Grouped by the **bay** rather than by the room the crate came from, because `loadingBays` collapses
 * openings that are too close together: two belts arriving at one door make one pile, and a pile per
 * belt would draw two stacks of crates through each other. A crate whose belt this building has no
 * door for is dropped rather than guessed at — it has nowhere to stand.
 *
 * `dx`/`dz` point from this building towards the one the crate came from, which is what picks the bay.
 */
export function pilesByBay(
  kind: RoomInfo["kind"],
  directions: readonly number[],
  crates: readonly { id: string; dx: number; dz: number }[],
): { bay: LoadingBay; ids: string[] }[] {
  const piles: { bay: LoadingBay; ids: string[] }[] = [];
  for (const crate of crates) {
    const bay = bayForDirection(kind, directions, crate.dx, crate.dz);
    if (bay === undefined) continue;
    const existing = piles.find((p) => p.bay.x === bay.x && p.bay.z === bay.z);
    if (existing === undefined) piles.push({ bay, ids: [crate.id] });
    else existing.ids.push(crate.id);
  }
  return piles;
}
