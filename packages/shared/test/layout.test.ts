import { describe, expect, it } from "vitest";
import { RING_SLOTS, ringPosition } from "../src/layout.js";

/**
 * The formula is shared because the server assigns positions with it and the browser previews with
 * it. These are the values both sides must agree on; changing them changes where every existing
 * factory's buildings would be previewed, so they are pinned deliberately.
 */
describe("ringPosition", () => {
  it("puts the first room on the +x axis at radius 8", () => {
    expect(ringPosition(0)).toEqual({ x: 8, z: 0 });
  });

  it("steps a quarter-turn every two slots", () => {
    expect(ringPosition(2)).toEqual({ x: 0, z: 8 });
    expect(ringPosition(4)).toEqual({ x: -8, z: 0 });
    expect(ringPosition(6)).toEqual({ x: -0, z: -8 });
  });

  it("rounds to three decimals", () => {
    // 8 * cos(pi/4) = 5.65685…
    expect(ringPosition(1)).toEqual({ x: 5.657, z: 5.657 });
  });

  it("steps outwards by 5 once a ring is full", () => {
    expect(ringPosition(RING_SLOTS)).toEqual({ x: 13, z: 0 });
    expect(ringPosition(RING_SLOTS * 2)).toEqual({ x: 18, z: 0 });
  });

  it("keeps every position on its ring's radius", () => {
    for (let i = 0; i < 20; i++) {
      const { x, z } = ringPosition(i);
      const expected = 8 + Math.floor(i / RING_SLOTS) * 5;
      expect(Math.hypot(x, z)).toBeCloseTo(expected, 2);
    }
  });

  it("never stacks two of the first sixteen rooms on the same spot", () => {
    const seen = new Set(Array.from({ length: 16 }, (_, i) => JSON.stringify(ringPosition(i))));
    expect(seen.size).toBe(16);
  });
});
