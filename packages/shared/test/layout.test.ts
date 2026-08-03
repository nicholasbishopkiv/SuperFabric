import { describe, expect, it } from "vitest";
import { RING_ANGLE_OFFSET, RING_RADIUS, RING_SLOTS, RING_STEP, ringPosition } from "../src/layout.js";

/**
 * The formula is shared because the server assigns positions with it and the browser previews with
 * it. These are the values both sides must agree on; changing them changes where every existing
 * factory's buildings would be previewed, so they are pinned deliberately.
 */
describe("ringPosition", () => {
  it("puts the first room half a slot off the +x axis, at the first ring's radius", () => {
    // 14 * cos(22.5°) = 12.9344…, 14 * sin(22.5°) = 5.3583…
    expect(ringPosition(0)).toEqual({ x: 12.934, z: 5.358 });
    expect(RING_RADIUS).toBe(14);
  });

  it("steps a quarter-turn every two slots", () => {
    expect(ringPosition(2)).toEqual({ x: -5.358, z: 12.934 });
    expect(ringPosition(4)).toEqual({ x: -12.934, z: -5.358 });
    expect(ringPosition(6)).toEqual({ x: 5.358, z: -12.934 });
  });

  it("rounds to three decimals", () => {
    expect(ringPosition(1)).toEqual({ x: 5.358, z: 12.934 });
  });

  it("steps outwards once a ring is full", () => {
    expect(ringPosition(RING_SLOTS)).toEqual({ x: 17.554, z: 7.271 });
    expect(ringPosition(RING_SLOTS * 2)).toEqual({ x: 22.173, z: 9.184 });
  });

  it("keeps every slot off the isometric camera's 45° view axis", () => {
    // The camera sits on x = z, so a room at 45° (or 225°) hides behind the project block and its
    // belt is occluded for its whole length. Half a slot of offset is what guarantees that.
    expect(RING_ANGLE_OFFSET).toBeCloseTo(Math.PI / 8, 10);
    for (let i = 0; i < 24; i++) {
      const { x, z } = ringPosition(i);
      // On the diagonal |x| === |z|; every slot must be comfortably clear of it.
      expect(Math.abs(Math.abs(x) - Math.abs(z))).toBeGreaterThan(1);
    }
  });

  it("keeps every position on its ring's radius", () => {
    for (let i = 0; i < 20; i++) {
      const { x, z } = ringPosition(i);
      const expected = RING_RADIUS + Math.floor(i / RING_SLOTS) * RING_STEP;
      expect(Math.hypot(x, z)).toBeCloseTo(expected, 2);
    }
  });

  it("leaves a run of open floor between the project block and every workshop", () => {
    // The belt lives in this gap. A 7-wide project block and a 4-wide workshop consume 5.5 units of
    // the distance between their centres before any belt is drawn, so the radius has to be
    // comfortably more than that or the conveyor is a detail inside two buildings.
    // (The footprints themselves live in the web package's `buildingSize`; these are the numbers
    // this radius was chosen against.)
    const projectHalf = 3.5;
    const workshopHalf = 2;
    expect(RING_RADIUS - projectHalf - workshopHalf).toBeGreaterThan(6);
  });

  it("never stacks two of the first sixteen rooms on the same spot", () => {
    const seen = new Set(Array.from({ length: 16 }, (_, i) => JSON.stringify(ringPosition(i))));
    expect(seen.size).toBe(16);
  });
});
