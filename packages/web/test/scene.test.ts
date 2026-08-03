import { describe, expect, it } from "vitest";
import { ringPosition as sharedRingPosition } from "@superfabric/shared";
import {
  buildingSize,
  ISO_CAMERA_POSITION,
  ISO_ZOOM,
  ISO_ZOOM_MAX,
  ISO_ZOOM_MIN,
  isoCameraTarget,
  ringPosition,
} from "../src/scene/layout";

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
