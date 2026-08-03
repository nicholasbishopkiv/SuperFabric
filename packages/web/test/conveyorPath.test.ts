import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { BELT_HEIGHT, conveyorCurve, pointAt } from "../src/scene/conveyorPath";

/**
 * The belt geometry is pure three-plus-arithmetic with no React and no WebGL in it, which is the
 * whole reason it lives in its own module: jsdom can check every claim the scene relies on.
 */

const at = (x: number, z: number) => ({ x, z });

describe("conveyorCurve", () => {
  it("starts on one building and ends on the other, at belt height", () => {
    const curve = conveyorCurve(at(0, 0), at(8, 0));

    const start = pointAt(curve, 0);
    const end = pointAt(curve, 1);
    expect(start.x).toBeCloseTo(0, 6);
    expect(start.z).toBeCloseTo(0, 6);
    expect(start.y).toBeCloseTo(BELT_HEIGHT, 6);
    expect(end.x).toBeCloseTo(8, 6);
    expect(end.z).toBeCloseTo(0, 6);
    expect(end.y).toBeCloseTo(BELT_HEIGHT, 6);
  });

  it("lands on buildings that are nowhere near the axes either", () => {
    const curve = conveyorCurve(at(-5.657, 5.657), at(13, -2.5));
    expect(pointAt(curve, 0).toArray()).toEqual([
      expect.closeTo(-5.657, 5), expect.closeTo(BELT_HEIGHT, 5), expect.closeTo(5.657, 5),
    ]);
    expect(pointAt(curve, 1).toArray()).toEqual([
      expect.closeTo(13, 5), expect.closeTo(BELT_HEIGHT, 5), expect.closeTo(-2.5, 5),
    ]);
  });

  it("bows away from the straight line, so parallel belts do not overlap", () => {
    const curve = conveyorCurve(at(0, 0), at(8, 0), 0.18);
    const mid = pointAt(curve, 0.5);

    // the straight-line midpoint would be (4, y, 0)
    expect(mid.x).toBeCloseTo(4, 3);
    expect(Math.abs(mid.z)).toBeGreaterThan(0.5);
  });

  it("bows harder the longer the belt is, so a long belt is not a barely-bent line", () => {
    const short = Math.abs(pointAt(conveyorCurve(at(0, 0), at(8, 0)), 0.5).z);
    const long = Math.abs(pointAt(conveyorCurve(at(0, 0), at(24, 0)), 0.5).z);
    expect(long).toBeGreaterThan(short);
  });

  it("bows the same amount either way round, so one pair means one belt", () => {
    const there = pointAt(conveyorCurve(at(0, 0), at(8, 0)), 0.5);
    const back = pointAt(conveyorCurve(at(8, 0), at(0, 0)), 0.5);
    expect(Math.abs(there.z)).toBeCloseTo(Math.abs(back.z), 6);
  });

  it("is a straight line when the bow is zero", () => {
    const curve = conveyorCurve(at(2, -3), at(10, 5), 0);
    const start = pointAt(curve, 0);
    const end = pointAt(curve, 1);

    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const p = pointAt(curve, t);
      // cross product of (p - start) and (end - start) in the floor plane: zero means collinear
      const cross = (p.x - start.x) * (end.z - start.z) - (p.z - start.z) * (end.x - start.x);
      expect(cross).toBeCloseTo(0, 5);
    }
    expect(pointAt(curve, 0.5).x).toBeCloseTo(6, 5);
    expect(pointAt(curve, 0.5).z).toBeCloseTo(1, 5);
  });

  it("does not blow up on two buildings standing in the same place", () => {
    const curve = conveyorCurve(at(3, 3), at(3, 3));
    const p = pointAt(curve, 0.5);
    expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
  });
});

describe("pointAt", () => {
  const curve = conveyorCurve(at(0, 0), at(8, 8));

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

  it("clamps t, so a package that overran its duration sits on the far building", () => {
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
