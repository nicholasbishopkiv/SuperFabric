import { describe, expect, it } from "vitest";
import { agentSlots, BAY_WIDTH, bayForDirection, loadingBays } from "../src/scene/layout";
import { PROP_FOR_WORK, PROP_ORDER, propSlots, roomProps } from "../src/scene/props";
import { KNOWN_ROLE_IDS, roleWork, type WorkKind } from "../src/scene/roleLook";

/**
 * What furnishes a room, and where it stands. The three claims worth pinning: furniture follows the
 * **roles** (deduplicated, in a fixed order), it never stands in a **doorway**, and it never stands
 * where a **figure** does — the last two being the ones that would make the floor contradict itself.
 */

/** The radius the room's figures stand at, taken from the function that places them. */
function postRadius(kind: "project" | "room"): number {
  const [x, z] = agentSlots(1, kind)[0];
  return Math.hypot(x, z);
}

describe("PROP_FOR_WORK", () => {
  it("furnishes every work family except the generalist's", () => {
    const works = new Set<WorkKind>(KNOWN_ROLE_IDS.map(roleWork));
    for (const work of works) {
      if (work === "none") expect(PROP_FOR_WORK[work]).toBeNull();
      else expect(PROP_ORDER).toContain(PROP_FOR_WORK[work]);
    }
    // Every piece of furniture is reachable from some shipped role, and no two families share one.
    const props = [...works].map((w) => PROP_FOR_WORK[w]).filter((p) => p !== null);
    expect(new Set(props).size).toBe(props.length);
    expect(new Set(props)).toEqual(new Set(PROP_ORDER));
  });
});

describe("propSlots", () => {
  it("only ever uses the two walls the default camera can see", () => {
    for (const kind of ["room", "project"] as const) {
      for (const slot of propSlots(kind)) {
        // A slot is out along +x or out along +z, never behind the building.
        expect(Math.max(slot.x, slot.z)).toBeGreaterThan(0);
        expect(slot.yaw === 0 || slot.yaw === Math.PI / 2).toBe(true);
      }
    }
  });

  it("**never stands where a figure does**, at either building size", () => {
    // A prop is turned along the wall it backs onto, so what points at the figures is its *depth*
    // (half a unit, so 0.25 from its centre) rather than its width. A third of a unit is that plus
    // room to be wrong.
    const PROP_REACH = 0.3;
    for (const kind of ["room", "project"] as const) {
      const posts = postRadius(kind);
      for (const slot of propSlots(kind)) {
        expect(Math.hypot(slot.x, slot.z) + PROP_REACH).toBeLessThan(posts);
      }
    }
  });

  it("keeps the middle of each wall free, which is where a loading bay goes", () => {
    for (const kind of ["room", "project"] as const) {
      for (const slot of propSlots(kind)) {
        const across = slot.yaw === 0 ? slot.x : slot.z;
        expect(Math.abs(across)).toBeGreaterThan(BAY_WIDTH / 2);
      }
    }
  });

  it("puts a room's first two pieces of furniture on different walls", () => {
    // Otherwise the two slots nearest the building's own corner fill first and the yard is a heap.
    const [first, second] = propSlots("room");
    expect(first.yaw).not.toBe(second.yaw);
  });
});

describe("roomProps", () => {
  const noBelts: number[] = [];

  it("furnishes nothing for a room with nobody in it", () => {
    expect(roomProps("room", [], noBelts)).toEqual([]);
  });

  it("furnishes nothing for a room of generalists — they declare no specialism", () => {
    expect(roomProps("room", ["generalist", "generalist"], noBelts)).toEqual([]);
    // …and the same for a role this build has never heard of, which reads as no specialism.
    expect(roomProps("room", ["a-role-of-my-own"], noBelts)).toEqual([]);
  });

  it("gives one piece of furniture per discipline, not per agent", () => {
    const props = roomProps("room", ["backend", "backend", "frontend"], noBelts);
    expect(props.map((p) => p.kind)).toEqual(["bench"]);
  });

  it("names the operator's own vocabulary: a bench to build at, a rig to check at, a desk to write at", () => {
    expect(roomProps("room", ["backend"], noBelts)[0].kind).toBe("bench");
    expect(roomProps("room", ["qa"], noBelts)[0].kind).toBe("rig");
    expect(roomProps("room", ["tech-writer"], noBelts)[0].kind).toBe("desk");
    expect(roomProps("room", ["architect"], noBelts)[0].kind).toBe("drafting");
    expect(roomProps("room", ["devops"], noBelts)[0].kind).toBe("rack");
  });

  it("is stable in `PROP_ORDER` however the agents are listed", () => {
    const a = roomProps("room", ["devops", "qa", "backend"], noBelts).map((p) => p.kind);
    const b = roomProps("room", ["backend", "devops", "qa"], noBelts).map((p) => p.kind);
    expect(a).toEqual(b);
    expect(a).toEqual(["bench", "rig", "rack"]);
  });

  it("stops at the number of slots rather than stacking two benches in one place", () => {
    // One role from each of the five families: more disciplines than a building has room for.
    const props = roomProps("room", ["backend", "qa", "tech-writer", "architect", "devops"], noBelts);
    expect(props).toHaveLength(propSlots("room").length);
    expect(props.map((p) => p.kind)).toEqual(PROP_ORDER.slice(0, 4));
    // Every piece is in its own place.
    const places = new Set(props.map((p) => `${p.x},${p.z}`));
    expect(places.size).toBe(props.length);
  });

  it("**never blocks a door**: a slot at a loading bay is given up, not built on", () => {
    // A belt arriving from straight ahead (+z) puts a bay in the middle of that wall.
    const belts = [0, 12];
    const bay = bayForDirection("room", belts, 0, 12);
    expect(bay).toBeDefined();
    const props = roomProps("room", ["backend", "qa", "tech-writer", "architect"], belts);
    for (const prop of props) {
      expect(Math.hypot(prop.x - bay!.x, prop.z - bay!.z)).toBeGreaterThan(BAY_WIDTH * 0.8);
    }
    // …and the room really is worse off for it, so this is not a vacuous assertion.
    expect(props.length).toBeLessThan(roomProps("room", ["backend", "qa", "tech-writer", "architect"], noBelts).length);
  });

  it("keeps the spine belt's own door clear for a workshop on the far side of the floor", () => {
    // A room at (-12.934, 5.358) is joined to the project block at the origin, so its bay is on a
    // wall the camera *can* see — the case where a prop and a door really do compete.
    const belts = [12.934, -5.358];
    const bays = loadingBays("room", belts);
    expect(bays).toHaveLength(1);
    for (const prop of roomProps("room", ["backend", "qa", "tech-writer", "architect"], belts)) {
      expect(Math.hypot(prop.x - bays[0].x, prop.z - bays[0].z)).toBeGreaterThan(BAY_WIDTH * 0.8);
    }
  });

  it("furnishes the project block too, on its own larger footprint", () => {
    const props = roomProps("project", ["architect"], []);
    expect(props.map((p) => p.kind)).toEqual(["drafting"]);
    // Placed on the project block's wall, not on a workshop's.
    expect(Math.hypot(props[0].x, props[0].z)).toBeGreaterThan(3.5);
  });
});
