import { describe, expect, it } from "vitest";
import {
  puffAt,
  SLAT_CRAWL_SPEED,
  slatOffset,
  slatPosition,
  SMOKE_LIFE_MS,
  SMOKE_MAX_SCALE,
  SMOKE_MIN_SCALE,
  SMOKE_PUFFS_PER_VENT,
  SMOKE_RISE,
  smokeStrength,
} from "../src/scene/atmosphere";
import { ROOF_VENT_X, ROOF_VENT_Z, ventMouths, buildingSize, ROOM_ROOF_THICKNESS } from "../src/scene/layout";
import { SMOKE_FADE_MS } from "../src/store";

/** Atmosphere is the easiest thing to make illegible, so its arithmetic is pinned down here. */

describe("how hard a chimney smokes", () => {
  it("is at full while the room is working", () => {
    expect(smokeStrength(true, 0, 1_000)).toBe(1);
    // A stale fade deadline cannot dim a room that has started working again.
    expect(smokeStrength(true, 500, 1_000)).toBe(1);
  });

  it("is nothing at all when the room has been quiet for a while", () => {
    // Zero is load-bearing: an idle chimney must draw no instances, so an idle factory has no hidden
    // per-frame work waiting for a frame to happen.
    expect(smokeStrength(false, 0, 1_000)).toBe(0);
    expect(smokeStrength(false, 900, 1_000)).toBe(0);
  });

  it("fades from full to nothing across the fade window after the work stops", () => {
    const stopped = 10_000;
    const until = stopped + SMOKE_FADE_MS;
    expect(smokeStrength(false, until, stopped)).toBe(1);
    expect(smokeStrength(false, until, stopped + SMOKE_FADE_MS / 2)).toBeCloseTo(0.5);
    expect(smokeStrength(false, until, until)).toBe(0);
    // Monotonically down: a plume that brightened again on the way out would read as a second turn.
    let previous = 1.01;
    for (let t = stopped; t <= until; t += 100) {
      const now = smokeStrength(false, until, t);
      expect(now).toBeLessThan(previous);
      previous = now;
    }
  });
});

describe("one puff", () => {
  it("rises from the vent and thins out as it goes", () => {
    const fresh = puffAt(0, 0);
    expect(fresh.life).toBeCloseTo(0);
    expect(fresh.y).toBeCloseTo(0);
    expect(fresh.scale).toBeCloseTo(SMOKE_MIN_SCALE);
    expect(fresh.mix).toBeCloseTo(0);

    const older = puffAt(0, SMOKE_LIFE_MS * 0.6);
    expect(older.y).toBeCloseTo(SMOKE_RISE * 0.6);
    expect(older.scale).toBeGreaterThan(fresh.scale);
    expect(older.scale).toBeLessThanOrEqual(SMOKE_MAX_SCALE);
    expect(older.mix).toBeCloseTo(0.6);
  });

  it("disappears rather than blinking out: the last of it has no size", () => {
    expect(puffAt(0, SMOKE_LIFE_MS * 0.999).scale).toBeCloseTo(0, 2);
  });

  it("loops, so a chimney that has smoked for an hour needs no state", () => {
    const a = puffAt(0, 1_234);
    const b = puffAt(0, 1_234 + SMOKE_LIFE_MS * 500);
    expect(b.y).toBeCloseTo(a.y);
    expect(b.scale).toBeCloseTo(a.scale);
  });

  it("spreads its puffs evenly through the loop, so a vent emits at a steady rate", () => {
    const lives = Array.from({ length: SMOKE_PUFFS_PER_VENT }, (_, i) => puffAt(i, 0).life);
    const sorted = [...lives].sort((a, b) => a - b);
    expect(sorted).toEqual(lives);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeCloseTo(1 / SMOKE_PUFFS_PER_VENT);
    }
  });

  it("wanders sideways but stays over its own vent, never over the one beside it", () => {
    // The two vents are 1.5 apart; a plume that drifted that far would look like the wrong chimney.
    const gap = Math.abs(ROOF_VENT_X[1] - ROOF_VENT_X[0]);
    for (let i = 0; i < SMOKE_PUFFS_PER_VENT; i++) {
      for (let t = 0; t < SMOKE_LIFE_MS; t += 130) {
        const puff = puffAt(i, t);
        expect(Math.abs(puff.x)).toBeLessThan(gap / 2);
      }
    }
  });
});

describe("where the smoke comes out", () => {
  it("is the mouth of each pipe the roof actually draws", () => {
    const mouths = ventMouths("room");
    expect(mouths).toHaveLength(ROOF_VENT_X.length);
    expect(mouths.map((m) => m[0])).toEqual([...ROOF_VENT_X]);
    expect(mouths.every((m) => m[2] === ROOF_VENT_Z)).toBe(true);
    // Above the roof slab, not inside it.
    const roof = buildingSize("room").height + ROOM_ROOF_THICKNESS;
    expect(mouths.every((m) => m[1] > roof)).toBe(true);
  });

  it("is nothing at all for the project block, which has a finial and no roof plant", () => {
    expect(ventMouths("project")).toEqual([]);
  });
});

describe("belt slats", () => {
  it("stand still on an empty belt", () => {
    expect(slatOffset(0, 0)).toBe(0);
    expect(slatOffset(93.7, 0)).toBe(0);
  });

  it("crawl along the belt with the traffic, and back the other way against it", () => {
    expect(slatOffset(1 / SLAT_CRAWL_SPEED / 4, 1)).toBeCloseTo(0.25);
    expect(slatOffset(1 / SLAT_CRAWL_SPEED / 4, -1)).toBeCloseTo(0.75);
  });

  it("stay inside one spacing however long the belt has been running", () => {
    for (const t of [0, 3.3, 61, 4_000.5]) {
      for (const flow of [1, -1]) {
        const offset = slatOffset(t, flow);
        expect(offset).toBeGreaterThanOrEqual(0);
        expect(offset).toBeLessThan(1);
      }
    }
  });

  it("loop: the slat that runs off the end is the one that appears at the start", () => {
    // Four slats, crawled by a whole spacing: slat 0 has taken slat 1's place, and the last has
    // wrapped round to where slat 0 was.
    const before = [0, 1, 2, 3].map((i) => slatPosition(i, 4, 0));
    const after = [0, 1, 2, 3].map((i) => slatPosition(i, 4, 0.999));
    expect(after[0]).toBeCloseTo(before[1], 2);
    expect(after[3]).toBeCloseTo(before[0], 2);
    for (const u of [...before, ...after]) {
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  it("spreads the slats evenly along the belt", () => {
    const positions = [0, 1, 2, 3, 4].map((i) => slatPosition(i, 5, 0));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i] - positions[i - 1]).toBeCloseTo(0.2);
    }
  });
});
