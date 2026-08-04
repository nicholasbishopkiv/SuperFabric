import { describe, expect, it } from "vitest";
import {
  BAY_PILE_COLUMNS,
  BAY_PILE_ROWS,
  bayCrateSlot,
  bayPickupPoint,
  canFetch,
  chooseFetcher,
  EARLY_MS,
  errandAt,
  errandEndsAt,
  fetchPath,
  fetchWalkMs,
  MIN_LEG_MS,
  pathLength,
  PICKUP_STANDOFF,
  pilesByBay,
  planErrand,
  walkAt,
  WALK_SPEED,
} from "../src/scene/errands";
import { agentSlots, bayForDirection, buildingSize, loadingBays } from "../src/scene/layout";

/**
 * The maths behind an agent fetching a crate. jsdom cannot mount a `<Canvas>`, so this — rather than
 * a rendered figure — is what actually holds the behaviour to account.
 */

/** The bay a belt from `(dx, dz)` arrives at, for a room joined to exactly that one other building. */
const soleBay = (kind: "room" | "project", dx: number, dz: number) => {
  const bay = bayForDirection(kind, [dx, dz], dx, dz);
  if (bay === undefined) throw new Error("expected a bay");
  return bay;
};

describe("where the crate is met", () => {
  it("stands just outside the bay, on the wall's outward normal", () => {
    // A belt arriving from -x crosses the -x wall, so the pickup point is further out along -x.
    const bay = soleBay("room", -8, 0);
    expect([bay.x, bay.z]).toEqual([-2, 0]);
    expect(bayPickupPoint(bay)).toEqual([-2 - PICKUP_STANDOFF, 0]);
  });

  it("is outside the wall on every side, never inside the building", () => {
    const half = buildingSize("room").width / 2;
    for (const [dx, dz] of [[8, 0], [-8, 0], [0, 8], [0, -8]] as const) {
      const [x, z] = bayPickupPoint(soleBay("room", dx, dz));
      expect(Math.max(Math.abs(x), Math.abs(z))).toBeGreaterThan(half);
    }
  });
});

describe("the route from a post to a bay", () => {
  const post = agentSlots(1, "room")[0];

  it("starts at the agent's post and ends at the crate", () => {
    const bay = soleBay("room", -8, 0);
    const path = fetchPath("room", post, bay);
    expect(path[0]).toEqual([post[0], post[1]]);
    expect(path[path.length - 1]).toEqual(bayPickupPoint(bay));
  });

  it("walks around the building rather than through it", () => {
    // The bay on the far wall is the case a straight line gets wrong: the post stands on the
    // camera-facing +x/+z diagonal, so the direct route to the -x wall crosses the footprint.
    const half = buildingSize("room").width / 2;
    for (const [dx, dz] of [[8, 0], [-8, 0], [0, 8], [0, -8], [-8, -8]] as const) {
      const path = fetchPath("room", post, soleBay("room", dx, dz));
      for (const [x, z] of path) {
        // Outside the square footprint: a point is inside only if *both* axes are within the half.
        expect(Math.max(Math.abs(x), Math.abs(z))).toBeGreaterThanOrEqual(half);
      }
    }
  });

  it("clears the project block's corners too, whose posts stand inside its own diagonal", () => {
    const half = buildingSize("project").width / 2;
    const hqPost = agentSlots(3, "project")[0];
    const path = fetchPath("project", hqPost, soleBay("project", -20, -20));
    for (const [x, z] of path) {
      expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(half);
    }
  });

  it("takes the short way round, not the long way about the same two points", () => {
    // A bay one eighth of a turn clockwise of the post must be a short walk, not seven eighths.
    const short = pathLength(fetchPath("room", post, soleBay("room", 8, 0)));
    const long = pathLength(fetchPath("room", post, soleBay("room", -8, -8)));
    expect(short).toBeLessThan(long);
    // Half the circumference of the walking ring is the worst case; nothing may exceed it by much.
    expect(long).toBeLessThan(Math.PI * 3.3 + PICKUP_STANDOFF + 1);
  });

  it("has no zero-length segments, which would leave a step with no direction to face", () => {
    const path = fetchPath("room", post, soleBay("room", 8, 8));
    for (let i = 1; i < path.length; i++) {
      expect(Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])).toBeGreaterThan(0);
    }
  });
});

describe("walking along a path", () => {
  const straight = [[0, 0], [0, 4]] as const;

  it("is at the start at t=0 and at the end at t=1", () => {
    expect(walkAt(straight, 0)).toMatchObject({ x: 0, z: 0 });
    expect(walkAt(straight, 1)).toMatchObject({ x: 0, z: 4 });
  });

  it("measures by distance, so the middle of the path is the middle of the walk", () => {
    expect(walkAt([[0, 0], [0, 1], [0, 9]], 0.5)).toMatchObject({ z: 4.5 });
  });

  it("faces the direction of travel", () => {
    // A figure's front is its local +z, so walking towards +z is a yaw of 0 and +x is a quarter turn.
    expect(walkAt(straight, 0.5).yaw).toBeCloseTo(0);
    expect(walkAt([[0, 0], [4, 0]], 0.5).yaw).toBeCloseTo(Math.PI / 2);
    expect(walkAt([[0, 0], [0, -4]], 0.5).yaw).toBeCloseTo(Math.PI);
  });

  it("clamps outside [0, 1] rather than extrapolating off the end of the belt", () => {
    expect(walkAt(straight, -3)).toMatchObject({ x: 0, z: 0 });
    expect(walkAt(straight, 9)).toMatchObject({ x: 0, z: 4 });
  });
});

describe("how long a leg takes", () => {
  it("is the distance at one walking speed, so two agents never move at different rates", () => {
    expect(fetchWalkMs([[0, 0], [0, 8]])).toBe(Math.round((8 / WALK_SPEED) * 1000));
  });

  it("never drops below a floor: a two-metre walk must not be a twitch", () => {
    expect(fetchWalkMs([[0, 0], [0, 0.1]])).toBe(MIN_LEG_MS);
  });
});

describe("which agent goes", () => {
  const at = (id: string, status: "idle" | "working" | "blocked" | "paused" | "error") =>
    ({ id, status });

  it("prefers an idle agent over a busy one, whatever order they stand in", () => {
    expect(chooseFetcher([at("a", "working"), at("b", "idle")])).toBe("b");
    expect(chooseFetcher([at("a", "idle"), at("b", "idle")])).toBe("a");
  });

  it("sends a working agent when nobody is idle: the room is staffed, it is just busy", () => {
    expect(chooseFetcher([at("a", "working"), at("b", "working")])).toBe("a");
  });

  it("sends nobody when every agent is blocked, paused or failed", () => {
    expect(chooseFetcher([at("a", "blocked"), at("b", "paused"), at("c", "error")])).toBeNull();
  });

  it("sends nobody from a room with no agents at all", () => {
    expect(chooseFetcher([])).toBeNull();
  });

  it("will not send an agent that is already on an errand", () => {
    expect(chooseFetcher([at("a", "idle")], new Set(["a"]))).toBeNull();
    expect(chooseFetcher([at("a", "idle"), at("b", "working")], new Set(["a"]))).toBe("b");
  });

  it("agrees with canFetch about who can walk", () => {
    expect(canFetch("idle")).toBe(true);
    expect(canFetch("working")).toBe(true);
    for (const status of ["blocked", "paused", "error"] as const) {
      expect(canFetch(status)).toBe(false);
    }
  });
});

describe("the clock of one fetch", () => {
  it("leaves early enough to be standing at the bay before the crate lands", () => {
    const timing = planErrand(1_000, 5_000, 1_500);
    expect(timing.startAt).toBe(5_000 - 1_500 - EARLY_MS);
    // It reaches the door with a beat to spare, and picks the crate up when the crate arrives.
    expect(timing.startAt + timing.legMs).toBeLessThan(5_000);
    expect(timing.pickupAt).toBe(5_000);
  });

  it("leaves at once when there is not enough time, and the crate waits for it instead", () => {
    const timing = planErrand(1_000, 1_200, 1_500);
    expect(timing.startAt).toBe(1_000);
    // It cannot arrive before it gets there, so the pickup is when the *agent* reaches the bay.
    expect(timing.pickupAt).toBe(2_500);
    expect(errandEndsAt(timing)).toBe(4_000);
  });

  it("walks out, waits, and walks back carrying it", () => {
    // Sent at 1000 for a crate landing at 5000, with a 1500 ms walk: it leaves at 3100 and is at the
    // door at 4600, four tenths of a second before the box gets there.
    const timing = planErrand(1_000, 5_000, 1_500);
    expect(errandAt(timing, 1_000)).toMatchObject({ phase: "post", t: 0, carrying: false });
    expect(errandAt(timing, 3_100)).toMatchObject({ phase: "out", t: 0, carrying: false });
    expect(errandAt(timing, 3_850)).toMatchObject({ phase: "out", t: 0.5, carrying: false });
    expect(errandAt(timing, 4_700)).toMatchObject({ phase: "wait", t: 1, carrying: false });
    expect(errandAt(timing, 5_000)).toMatchObject({ phase: "back", t: 1, carrying: true });
    expect(errandAt(timing, 5_750)).toMatchObject({ phase: "back", t: 0.5, carrying: true });
    // Home, and empty-handed: the crate is inside the building, not still at its side.
    expect(errandAt(timing, 6_500)).toMatchObject({ phase: "done", carrying: false });
  });

  it("stands at the bay when it got there first", () => {
    // A 400 ms walk for a crate that is 3 s away: it arrives long before the box does.
    const timing = planErrand(0, 3_000, 400);
    expect(errandAt(timing, 2_700)).toMatchObject({ phase: "wait", t: 1, carrying: false });
    // Still at the bay: `t` of 1 is the end of the outbound path, which is the pickup point.
    expect(walkAt([[0, 0], [0, 3]], errandAt(timing, 2_700).t)).toMatchObject({ z: 3 });
  });
});

describe("crates nobody collected", () => {
  it("fills across the door before it stacks upwards", () => {
    const row = [0, 1, 2].map((i) => bayCrateSlot(i));
    // Three across, centred on the opening, all at one height.
    expect(row.map((s) => s.y)).toEqual([row[0].y, row[0].y, row[0].y]);
    expect(row[0].x).toBeLessThan(row[1].x);
    expect(row[1].x).toBeLessThan(row[2].x);
    expect(row[1].x).toBeCloseTo(0);
    // The fourth starts the next row.
    expect(bayCrateSlot(BAY_PILE_COLUMNS).y).toBeGreaterThan(row[0].y);
    expect(bayCrateSlot(BAY_PILE_COLUMNS).x).toBeCloseTo(row[0].x);
  });

  it("stops growing rather than building a tower through the roof", () => {
    const last = bayCrateSlot(BAY_PILE_COLUMNS * BAY_PILE_ROWS - 1);
    expect(bayCrateSlot(999)).toEqual(last);
  });

  it("stands clear of the wall but inside the point an agent walks to", () => {
    for (const i of [0, 5, 11]) {
      expect(bayCrateSlot(i).z).toBeGreaterThan(0);
      expect(bayCrateSlot(i).z).toBeLessThan(PICKUP_STANDOFF);
    }
  });
});

describe("grouping a pile by the door it is at", () => {
  it("puts every crate off one belt in one pile", () => {
    const piles = pilesByBay("room", [-8, 0], [
      { id: "a", dx: -8, dz: 0 },
      { id: "b", dx: -8, dz: 0 },
    ]);
    expect(piles).toHaveLength(1);
    expect(piles[0].ids).toEqual(["a", "b"]);
    expect(piles[0].bay.x).toBe(-2);
  });

  it("puts crates off belts at different walls in different piles", () => {
    const directions = [-8, 0, 0, 8];
    expect(loadingBays("room", directions)).toHaveLength(2);
    const piles = pilesByBay("room", directions, [
      { id: "a", dx: -8, dz: 0 },
      { id: "b", dx: 0, dz: 8 },
    ]);
    expect(piles).toHaveLength(2);
    expect(piles.map((p) => p.ids)).toEqual([["a"], ["b"]]);
  });

  it("merges two belts that share a door, because `loadingBays` drew only one", () => {
    // Two nearly-collinear belts leaving the same wall collapse into one opening; two piles at one
    // opening would draw two stacks of crates through each other.
    const directions = [0, 20, 1, 20];
    expect(loadingBays("room", directions)).toHaveLength(1);
    const piles = pilesByBay("room", directions, [
      { id: "a", dx: 0, dz: 20 },
      { id: "b", dx: 1, dz: 20 },
    ]);
    expect(piles).toHaveLength(1);
    expect(piles[0].ids).toEqual(["a", "b"]);
  });

  it("drops a crate whose belt this building has no door for", () => {
    // (0, 0) is what an unknown origin room resolves to: no wall faces it, so there is nowhere to
    // stand it and inventing a door would be a lie about the geometry.
    expect(pilesByBay("room", [-8, 0], [{ id: "a", dx: 0, dz: 0 }])).toEqual([]);
  });
});
