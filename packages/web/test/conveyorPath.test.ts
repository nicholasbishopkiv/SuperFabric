import { ringPosition as sharedRingPosition } from "@superfabric/shared";
import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import {
  BELT_EDGE_MARGIN,
  BELT_FAN_STEP,
  BELT_HEIGHT,
  beltEnds,
  conveyorCurve,
  DEFAULT_BOW,
  pointAt,
  wallDistance,
} from "../src/scene/conveyorPath";
import { buildingSize } from "../src/scene/layout";

/**
 * The belt geometry is pure three-plus-arithmetic with no React and no WebGL in it, which is the
 * whole reason it lives in its own module: jsdom can check every claim the scene relies on.
 */

/** A belt end: where a building stands and what kind it is (which is how wide it is). */
const room = (x: number, z: number) => ({ position: { x, z }, kind: "room" as const });
const project = (x: number, z: number) => ({ position: { x, z }, kind: "project" as const });

/** How far from a building's centre its belt endpoint should sit, for a belt heading (dx, dz). */
const inset = (kind: "room" | "project", dx: number, dz: number) =>
  wallDistance(kind, dx, dz) + BELT_EDGE_MARGIN;

describe("wallDistance", () => {
  it("is half the width when the belt leaves a wall face-on", () => {
    expect(wallDistance("room", 1, 0)).toBeCloseTo(2, 6);
    expect(wallDistance("room", 0, -1)).toBeCloseTo(2, 6);
    expect(wallDistance("project", 1, 0)).toBeCloseTo(3.5, 6);
  });

  it("is half the diagonal when the belt leaves towards a corner", () => {
    // the footprint is a square, so the boundary is further away on the diagonal
    expect(wallDistance("room", 1, 1)).toBeCloseTo(2 * Math.SQRT2, 6);
    expect(wallDistance("project", -1, 1)).toBeCloseTo(3.5 * Math.SQRT2, 6);
  });

  it("never reports less than half the width, whichever way the belt leaves", () => {
    for (let a = 0; a < Math.PI * 2; a += 0.19) {
      expect(wallDistance("room", Math.cos(a), Math.sin(a))).toBeGreaterThanOrEqual(2 - 1e-9);
    }
  });

  it("does not divide by zero for two buildings in the same place", () => {
    expect(wallDistance("room", 0, 0)).toBe(2);
  });
});

describe("beltEnds", () => {
  it("stops at each building's wall rather than at its centre", () => {
    const { start, end } = beltEnds(project(0, 0), room(14, 0));
    expect(start).toEqual({ x: inset("project", 1, 0), z: 0 });
    expect(end).toEqual({ x: 14 - inset("room", 1, 0), z: 0 });
    // 3.5 + 0.3 and 14 - (2 + 0.3): a package has 7.9 units of open floor to travel
    expect(start.x).toBeCloseTo(3.8, 6);
    expect(end.x).toBeCloseTo(11.7, 6);
  });

  it("insets the wider project block further than the workshop", () => {
    const { start, end } = beltEnds(project(0, 0), room(0, 14));
    expect(start.z).toBeGreaterThan(14 - end.z);
  });

  it("still produces a belt when two buildings overlap", () => {
    // 1.5 apart is well inside both footprints; the belt has to stay finite and keep its direction
    const { start, end } = beltEnds(room(0, 0), room(1.5, 0));
    expect(Number.isFinite(start.x) && Number.isFinite(end.x)).toBe(true);
    expect(end.x).toBeGreaterThan(start.x);
    expect(end.x - start.x).toBeCloseTo(1.5 * 0.2, 6);
  });

  it("degenerates to the two centres for two buildings in the same place", () => {
    const { start, end } = beltEnds(room(3, 3), room(3, 3));
    expect(start).toEqual({ x: 3, z: 3 });
    expect(end).toEqual({ x: 3, z: 3 });
  });
});

describe("conveyorCurve", () => {
  it("starts on one building's wall and ends on the other's, at belt height", () => {
    const curve = conveyorCurve(project(0, 0), room(14, 0));

    const start = pointAt(curve, 0);
    const end = pointAt(curve, 1);
    // A belt drawn centre-to-centre spends its first units buried inside a solid block, so a
    // package appeared to slide out of the middle of a blank slab. It now leaves at a wall.
    expect(start.x).toBeCloseTo(inset("project", 1, 0), 5);
    expect(start.z).toBeCloseTo(0, 5);
    expect(start.y).toBeCloseTo(BELT_HEIGHT, 6);
    expect(end.x).toBeCloseTo(14 - inset("room", 1, 0), 5);
    expect(end.z).toBeCloseTo(0, 5);
    expect(end.y).toBeCloseTo(BELT_HEIGHT, 6);
  });

  it("puts both endpoints just outside their building's footprint, not inside it", () => {
    for (const [a, b] of [
      [project(0, 0), room(14, 0)],
      [project(0, 0), room(9.899, 9.899)],
      [room(-9.899, 9.899), room(13, -2.5)],
    ] as const) {
      const start = pointAt(conveyorCurve(a, b), 0);
      const end = pointAt(conveyorCurve(a, b), 1);
      const halfA = buildingSize(a.kind).width / 2;
      const halfB = buildingSize(b.kind).width / 2;
      // outside the square footprint means clear of the wall in the Chebyshev sense
      expect(Math.max(Math.abs(start.x - a.position.x), Math.abs(start.z - a.position.z)))
        .toBeGreaterThan(halfA);
      expect(Math.max(Math.abs(end.x - b.position.x), Math.abs(end.z - b.position.z)))
        .toBeGreaterThan(halfB);
    }
  });

  it("lands on buildings that are nowhere near the axes either", () => {
    const from = room(-9.899, 9.899);
    const to = room(13, -2.5);
    const { start, end } = beltEnds(from, to);
    expect(pointAt(conveyorCurve(from, to), 0).toArray()).toEqual([
      expect.closeTo(start.x, 5), expect.closeTo(BELT_HEIGHT, 5), expect.closeTo(start.z, 5),
    ]);
    expect(pointAt(conveyorCurve(from, to), 1).toArray()).toEqual([
      expect.closeTo(end.x, 5), expect.closeTo(BELT_HEIGHT, 5), expect.closeTo(end.z, 5),
    ]);
  });

  it("bows away from the straight line, so parallel belts do not overlap", () => {
    const curve = conveyorCurve(project(0, 0), room(14, 0), 0.18);
    const mid = pointAt(curve, 0.5);

    // the straight line between the two wall anchors runs from x = 3.8 to x = 11.7
    expect(mid.x).toBeCloseTo(7.75, 3);
    expect(Math.abs(mid.z)).toBeGreaterThan(0.5);
  });

  it("fans belts leaving the same building apart, so their mouths separate", () => {
    // Two spine belts of the same length to two adjacent ring slots. Without a fan they bow by the
    // same amount and track each other all the way in; with one they diverge.
    const a = room(sharedRingPosition(0).x, sharedRingPosition(0).z);
    const b = room(sharedRingPosition(1).x, sharedRingPosition(1).z);
    const hub = project(0, 0);

    const gap = (fanA: number, fanB: number) => {
      // a quarter of the way along each belt: near the mouth, where they used to converge
      const pa = pointAt(conveyorCurve(hub, a, DEFAULT_BOW, fanA), 0.25);
      const pb = pointAt(conveyorCurve(hub, b, DEFAULT_BOW, fanB), 0.25);
      return pa.distanceTo(pb);
    };

    expect(gap(-1, 1)).toBeGreaterThan(gap(0, 0));
  });

  it("offsets by a fixed distance per step of fan, not by a fraction of the length", () => {
    // The bow is proportional to length, which is exactly why it cannot separate two belts of the
    // same length. The fan has to be absolute.
    const shortMid = pointAt(conveyorCurve(room(0, 0), room(12, 0), 0, 1), 0.5);
    const longMid = pointAt(conveyorCurve(room(0, 0), room(30, 0), 0, 1), 0.5);
    expect(Math.abs(shortMid.z)).toBeCloseTo(BELT_FAN_STEP, 2);
    expect(Math.abs(longMid.z)).toBeCloseTo(BELT_FAN_STEP, 2);
  });

  it("is symmetric in the fan too: one pair of rooms is one belt however it is addressed", () => {
    // `Packages` builds its curve from the package's own from/to, which may be the other way round
    // from how the belt was drawn. If the fan were mirrored the box would fly beside the conveyor.
    const forward = pointAt(conveyorCurve(room(0, 0), room(14, 6), DEFAULT_BOW, 2), 0.4);
    const backward = pointAt(conveyorCurve(room(14, 6), room(0, 0), DEFAULT_BOW, 2), 0.6);
    expect(forward.x).toBeCloseTo(backward.x, 4);
    expect(forward.z).toBeCloseTo(backward.z, 4);
  });

  it("bows harder the longer the belt is, so a long belt is not a barely-bent line", () => {
    const short = Math.abs(pointAt(conveyorCurve(room(0, 0), room(14, 0)), 0.5).z);
    const long = Math.abs(pointAt(conveyorCurve(room(0, 0), room(30, 0)), 0.5).z);
    expect(long).toBeGreaterThan(short);
  });

  it("bows the same amount either way round, so one pair means one belt", () => {
    const there = pointAt(conveyorCurve(project(0, 0), room(14, 0)), 0.5);
    const back = pointAt(conveyorCurve(room(14, 0), project(0, 0)), 0.5);
    expect(Math.abs(there.z)).toBeCloseTo(Math.abs(back.z), 6);
    expect(there.x).toBeCloseTo(back.x, 6);
  });

  it("is a straight line when the bow is zero", () => {
    const curve = conveyorCurve(room(2, -3), room(14, 9), 0);
    const start = pointAt(curve, 0);
    const end = pointAt(curve, 1);

    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const p = pointAt(curve, t);
      // cross product of (p - start) and (end - start) in the floor plane: zero means collinear
      const cross = (p.x - start.x) * (end.z - start.z) - (p.z - start.z) * (end.x - start.x);
      expect(cross).toBeCloseTo(0, 5);
    }
    // both ends are inset by the same amount, so the midpoint is still the midpoint of the centres
    expect(pointAt(curve, 0.5).x).toBeCloseTo(8, 5);
    expect(pointAt(curve, 0.5).z).toBeCloseTo(3, 5);
  });

  it("does not blow up on two buildings standing in the same place", () => {
    const curve = conveyorCurve(room(3, 3), room(3, 3));
    const p = pointAt(curve, 0.5);
    expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
  });
});

describe("pointAt", () => {
  const curve = conveyorCurve(project(0, 0), room(14, 14));

  it("stays at belt height the whole way along", () => {
    for (const t of [0, 0.1, 0.5, 0.9, 1]) expect(pointAt(curve, t).y).toBeCloseTo(BELT_HEIGHT, 6);
  });

  it("advances monotonically towards the far building", () => {
    let previous = -Infinity;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const travelled = pointAt(curve, t).distanceTo(pointAt(curve, 0));
      expect(travelled).toBeGreaterThan(previous);
      previous = travelled;
    }
  });

  it("clamps t, so a package that overran its duration sits on the far building's wall", () => {
    expect(pointAt(curve, 1.4).toArray()).toEqual(pointAt(curve, 1).toArray());
    expect(pointAt(curve, -0.3).toArray()).toEqual(pointAt(curve, 0).toArray());
  });

  it("writes into a target vector so the render loop allocates nothing", () => {
    const target = new Vector3();
    const returned = pointAt(curve, 0.5, target);
    expect(returned).toBe(target);
    expect(target.y).toBeCloseTo(BELT_HEIGHT, 6);
  });
});
