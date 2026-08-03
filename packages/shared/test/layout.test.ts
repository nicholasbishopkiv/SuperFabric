import { describe, expect, it } from "vitest";
import { RING_RADIUS, RING_SLOTS, RING_STEP, ringPosition } from "../src/layout.js";

/**
 * The formula is shared because the server assigns positions with it and the browser previews with
 * it. These are the values both sides must agree on; changing them changes where every existing
 * factory's buildings would be previewed, so they are pinned deliberately.
 */
describe("ringPosition", () => {
  it("puts the first room on the +x axis at the first ring's radius", () => {
    expect(ringPosition(0)).toEqual({ x: 14, z: 0 });
    expect(RING_RADIUS).toBe(14);
  });

  it("steps a quarter-turn every two slots", () => {
    expect(ringPosition(2)).toEqual({ x: 0, z: 14 });
    expect(ringPosition(4)).toEqual({ x: -14, z: 0 });
    expect(ringPosition(6)).toEqual({ x: -0, z: -14 });
  });

  it("rounds to three decimals", () => {
    // 14 * cos(pi/4) = 9.89949…
    expect(ringPosition(1)).toEqual({ x: 9.899, z: 9.899 });
  });

  it("steps outwards once a ring is full", () => {
    expect(ringPosition(RING_SLOTS)).toEqual({ x: 19, z: 0 });
    expect(ringPosition(RING_SLOTS * 2)).toEqual({ x: 24, z: 0 });
  });

  it("keeps every position on its ring's radius", () => {
    for (let i = 0; i < 20; i++) {
      const { x, z } = ringPosition(i);
      const expected = RING_RADIUS + Math.floor(i / RING_SLOTS) * RING_STEP;
      expect(Math.hypot(x, z)).toBeCloseTo(expected, 2);
    }
  });

  it("leaves a run of open floor between the project block and every workshop", () => {
    // The belt lives in this gap. A 6-wide project block and a 4-wide workshop consume 5 units of
    // the distance between their centres before any belt is drawn, so the radius has to be
    // comfortably more than that or the conveyor is a detail inside two buildings.
    const projectHalf = 3;
    const workshopHalf = 2;
    expect(RING_RADIUS - projectHalf - workshopHalf).toBeGreaterThan(6);
  });

  it("never stacks two of the first sixteen rooms on the same spot", () => {
    const seen = new Set(Array.from({ length: 16 }, (_, i) => JSON.stringify(ringPosition(i))));
    expect(seen.size).toBe(16);
  });
});
