import { describe, expect, it } from "vitest";
import { ringPosition as sharedRingPosition } from "@superfabric/shared";
import {
  agentSlots,
  beaconHeight,
  buildingSize,
  draggedPosition,
  grabOffset,
  ISO_CAMERA_POSITION,
  ISO_ZOOM,
  ISO_ZOOM_MAX,
  ISO_ZOOM_MIN,
  isoCameraTarget,
  labelHeight,
  ringPosition,
  roofTop,
} from "../src/scene/layout";
import { BYPASS_COLOR, STATUS_COLOR, STATUS_EMISSIVE } from "../src/scene/palette";

/**
 * jsdom has no WebGL, so a `<Canvas>` can never be mounted here. What is testable is every piece of
 * geometry the scene is built from, which is exactly why it all lives in `scene/layout.ts`.
 */

const at = (x: number, z: number) => ({ position: { x, z } });

describe("ringPosition", () => {
  it("is the server's formula, not a second copy of it", () => {
    for (let i = 0; i < 12; i++) expect(ringPosition(i)).toEqual(sharedRingPosition(i));
  });

  it("matches the known ring values a preview has to agree with", () => {
    expect(ringPosition(0)).toEqual({ x: 8, z: 0 });
    expect(ringPosition(1)).toEqual({ x: 5.657, z: 5.657 });
    expect(ringPosition(2)).toEqual({ x: 0, z: 8 });
    expect(ringPosition(8)).toEqual({ x: 13, z: 0 });
  });
});

describe("dragging a building onto a floor point", () => {
  it("holds the building where it was grabbed instead of snapping its centre to the pointer", () => {
    const roomAt = { x: 14, z: 0 };
    // the operator grabbed the roof's near corner, a metre off the building's centre
    const grabbed = { x: 15, z: 1.5 };
    const offset = grabOffset(roomAt, grabbed);

    // the first move of the drag has not moved the pointer yet, so the building must not have moved
    expect(draggedPosition(grabbed, offset)).toEqual(roomAt);
    // and a pointer that moved by (-4, +2) moves the building by exactly that
    expect(draggedPosition({ x: 11, z: 3.5 }, offset)).toEqual({ x: 10, z: 2 });
  });

  it("is the identity when the building is grabbed dead centre", () => {
    const offset = grabOffset({ x: 3, z: -7 }, { x: 3, z: -7 });
    expect(offset).toEqual({ x: 0, z: 0 });
    expect(draggedPosition({ x: -2, z: 9 }, offset)).toEqual({ x: -2, z: 9 });
  });

  it("rounds to three decimals, so a raycast hit is not stored to fifteen", () => {
    const offset = grabOffset({ x: 0, z: 0 }, { x: 0, z: 0 });
    expect(draggedPosition({ x: 1.23456789, z: -4.987654321 }, offset)).toEqual({ x: 1.235, z: -4.988 });
  });

  it("ignores the height of the point it was handed — the floor plane is y = 0", () => {
    // the raycaster reports a Vector3; only x and z are ever read, and a drag can never lift a
    // building off the floor
    const offset = grabOffset({ x: 2, z: 2 }, { x: 1, z: 1 });
    expect(Object.keys(draggedPosition({ x: 5, z: 5 }, offset)).sort()).toEqual(["x", "z"]);
  });
});

describe("isoCameraTarget", () => {
  it("frames the origin when there is nothing on the floor yet", () => {
    expect(isoCameraTarget([])).toEqual([0, 0, 0]);
  });

  it("frames a single building exactly", () => {
    expect(isoCameraTarget([at(8, -3)])).toEqual([8, 0, -3]);
  });

  it("averages the positions of every building", () => {
    expect(isoCameraTarget([at(0, 0), at(8, 0), at(-8, 0), at(0, 8)])).toEqual([0, 0, 2]);
    expect(isoCameraTarget([at(2, 4), at(4, 8)])).toEqual([3, 0, 6]);
  });

  it("keeps the target on the floor plane", () => {
    expect(isoCameraTarget([at(3, 9), at(-5, 1)])[1]).toBe(0);
  });

  it("rounds to three decimals so a pan target never carries float noise", () => {
    expect(isoCameraTarget([at(1, 0), at(0, 0), at(0, 0)])).toEqual([0.333, 0, 0]);
  });
});

describe("camera contract", () => {
  it("is the isometric orthographic setup the plan specifies", () => {
    expect(ISO_CAMERA_POSITION).toEqual([24, 20, 24]);
    expect(ISO_ZOOM).toBe(38);
    expect([ISO_ZOOM_MIN, ISO_ZOOM_MAX]).toEqual([12, 90]);
    // equal x and z is what makes the view read as isometric rather than as an arbitrary angle
    expect(ISO_CAMERA_POSITION[0]).toBe(ISO_CAMERA_POSITION[2]);
    expect(ISO_ZOOM).toBeGreaterThan(ISO_ZOOM_MIN);
    expect(ISO_ZOOM).toBeLessThan(ISO_ZOOM_MAX);
  });
});

describe("buildingSize", () => {
  it("gives the project block a bigger footprint than a workshop", () => {
    expect(buildingSize("project")).toEqual({ width: 6, height: 5 });
    expect(buildingSize("room")).toEqual({ width: 4, height: 3 });
    expect(buildingSize("project").width).toBeGreaterThan(buildingSize("room").width);
  });

  it("keeps a workshop small enough that two adjacent ring slots cannot overlap", () => {
    // slot 0 and slot 1 on the inner ring are the closest two buildings ever get
    const a = ringPosition(0);
    const b = ringPosition(1);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(buildingSize("room").width);
  });
});

describe("what stacks above a building", () => {
  it("puts the beacon clear of the roof and the label clear of the beacon", () => {
    for (const kind of ["project", "room"] as const) {
      expect(roofTop(kind)).toBeGreaterThan(buildingSize(kind).height);
      expect(beaconHeight(kind)).toBeGreaterThan(roofTop(kind));
      expect(labelHeight(kind)).toBeGreaterThan(beaconHeight(kind));
    }
  });

  it("stacks the project block's furniture higher than a workshop's", () => {
    expect(beaconHeight("project")).toBeGreaterThan(beaconHeight("room"));
    expect(labelHeight("project")).toBeGreaterThan(labelHeight("room"));
  });
});

describe("agentSlots", () => {
  it("places nobody for an empty room", () => {
    expect(agentSlots(0, "room")).toEqual([]);
  });

  it("stands a lone agent on the camera-facing diagonal", () => {
    const [[x, z]] = agentSlots(1, "room");
    expect(x).toBeCloseTo(z, 3);
    expect(x).toBeGreaterThan(0);
  });

  it("gives every agent its own spot, all in front of the building", () => {
    for (const count of [2, 3, 5, 8]) {
      const slots = agentSlots(count, "room");
      expect(slots).toHaveLength(count);
      expect(new Set(slots.map((s) => s.join(","))).size).toBe(count);
      // "in front" means the +x/+z half of the floor: nobody hides behind the block
      for (const [x, z] of slots) expect(x + z).toBeGreaterThan(0);
    }
  });

  it("stands them outside the building's own footprint", () => {
    for (const kind of ["project", "room"] as const) {
      const half = buildingSize(kind).width / 2;
      for (const [x, z] of agentSlots(4, kind)) {
        expect(Math.max(Math.abs(x), Math.abs(z))).toBeGreaterThan(half);
      }
    }
  });

  it("pushes the arc further out for the bigger project block", () => {
    const [[rx, rz]] = agentSlots(1, "room");
    const [[px, pz]] = agentSlots(1, "project");
    expect(Math.hypot(px, pz)).toBeGreaterThan(Math.hypot(rx, rz));
  });
});

describe("the status palette", () => {
  it("gives the four statuses four distinguishable colours", () => {
    const colors = Object.values(STATUS_COLOR);
    expect(colors).toHaveLength(4);
    expect(new Set(colors).size).toBe(4);
    // the two an operator must never confuse: "answer me" and "I failed"
    expect(STATUS_COLOR.blocked).not.toBe(STATUS_COLOR.error);
    // and the bypass marker must not collide with any of them
    expect(colors).not.toContain(BYPASS_COLOR);
  });

  it("keeps idle quiet and everything that wants attention bright", () => {
    expect(STATUS_EMISSIVE.idle).toBeLessThan(STATUS_EMISSIVE.working);
    expect(STATUS_EMISSIVE.blocked).toBeGreaterThanOrEqual(STATUS_EMISSIVE.working);
    expect(STATUS_EMISSIVE.error).toBeGreaterThanOrEqual(STATUS_EMISSIVE.working);
  });
});
