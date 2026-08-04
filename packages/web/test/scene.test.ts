import { describe, expect, it } from "vitest";
import { ringPosition as sharedRingPosition } from "@superfabric/shared";
import {
  agentFacing,
  agentSlots,
  beaconHeight,
  buildingSize,
  CAMERA_FAR,
  CAMERA_NEAR,
  draggedPosition,
  FLOOR_SIZE,
  grabOffset,
  ISO_CAMERA_POSITION,
  ISO_ZOOM,
  ISO_ZOOM_MAX,
  ISO_ZOOM_MIN,
  isoCameraTarget,
  isoFloorDelta,
  isoFraming,
  isoPolarAngle,
  isoProject,
  labelHeight,
  loadingBays,
  MAX_POLAR_ANGLE,
  MIN_POLAR_ANGLE,
  PROJECT_ROOF_HEIGHT,
  ringPosition,
  roofTop,
  SLAB_APRON_RATIO,
  SLAB_MIN_HALF,
  slabHalf,
} from "../src/scene/layout";
import {
  ACCENT_HUE_MAX,
  ACCENT_HUE_MIN,
  ACCENT_HUE_STEP,
  BYPASS_COLOR,
  hsl,
  PACKAGE_COLORS,
  roomAccent,
  roomAccentHue,
  SELECT_COLOR,
  STATUS_COLOR,
  STATUS_EMISSIVE,
  STATUS_HUE_BANDS,
  WAITING_PACKAGE_COLOR,
} from "../src/scene/palette";
import {
  wallDistance,
  waitingSlot,
  waitingStackIndices,
  WAITING_STACK_MAX,
} from "../src/scene/conveyorPath";

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
    expect(ringPosition(0)).toEqual({ x: 12.934, z: 5.358 });
    expect(ringPosition(1)).toEqual({ x: 5.358, z: 12.934 });
    expect(ringPosition(2)).toEqual({ x: -5.358, z: 12.934 });
    expect(ringPosition(8)).toEqual({ x: 17.554, z: 7.271 });
  });

  it("never puts a room on the camera's own diagonal, where the project block would hide it", () => {
    // ISO_CAMERA_POSITION has equal x and z, so |x| === |z| on the floor is the one line of sight
    // a building must never stand on.
    expect(ISO_CAMERA_POSITION[0]).toBe(ISO_CAMERA_POSITION[2]);
    for (let i = 0; i < 24; i++) {
      const { x, z } = ringPosition(i);
      expect(Math.abs(Math.abs(x) - Math.abs(z))).toBeGreaterThan(1);
    }
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

describe("isoProject / isoFloorDelta", () => {
  it("puts the origin at the middle of the view", () => {
    expect(isoProject(0, 0, 0)).toEqual([0, 0]);
  });

  it("sends +x right and +z left, which is what makes the view read as isometric", () => {
    expect(isoProject(1, 0, 0)[0]).toBeGreaterThan(0);
    expect(isoProject(0, 0, 1)[0]).toBeLessThan(0);
    // and equally so: the camera has equal x and z
    expect(isoProject(1, 0, 0)[0]).toBeCloseTo(-isoProject(0, 0, 1)[0], 6);
  });

  it("sends height up the screen and distance down it", () => {
    expect(isoProject(0, 1, 0)[1]).toBeGreaterThan(0);
    expect(isoProject(1, 0, 1)[1]).toBeLessThan(0);
  });

  it("is a rigid projection: it never changes the scale of anything", () => {
    // the diagonal towards the camera is the most foreshortened direction there is, and even it
    // must not stretch
    for (const p of [[1, 0, 0], [0, 0, 1], [1, 0, 1], [3, 2, -4]] as const) {
      const [sx, sy] = isoProject(p[0], p[1], p[2]);
      expect(Math.hypot(sx, sy)).toBeLessThanOrEqual(Math.hypot(p[0], p[1], p[2]) + 1e-9);
    }
  });

  it("inverts itself on the floor plane, so a pan can be aimed in screen units", () => {
    for (const [dsx, dsy] of [[1, 0], [0, 1], [-3.5, 2.25]] as const) {
      const { x, z } = isoFloorDelta(dsx, dsy);
      const [sx, sy] = isoProject(x, 0, z);
      expect(sx).toBeCloseTo(dsx, 2);
      expect(sy).toBeCloseTo(dsy, 2);
    }
  });
});

describe("isoFraming", () => {
  const floor = (n: number) =>
    [
      { position: { x: 0, z: 0 }, kind: "project" as const },
      ...Array.from({ length: n }, (_, i) => ({ position: ringPosition(i), kind: "room" as const })),
    ];

  /** Every corner of every building, in screen pixels relative to the canvas centre. */
  const cornersPx = (rooms: ReturnType<typeof floor>, f: ReturnType<typeof isoFraming>) => {
    const [cx, cy] = isoProject(f.target[0], 0, f.target[2]);
    const out: [number, number][] = [];
    for (const r of rooms) {
      const half = buildingSize(r.kind).width / 2;
      for (const dx of [-half, half]) {
        for (const dz of [-half, half]) {
          for (const y of [0, labelHeight(r.kind)]) {
            const [sx, sy] = isoProject(r.position.x + dx, y, r.position.z + dz);
            out.push([(sx - cx) * f.zoom, (sy - cy) * f.zoom]);
          }
        }
      }
    }
    return out;
  };

  it("frames the origin at the designed zoom when the floor is empty", () => {
    expect(isoFraming([], 1440, 900)).toEqual({ zoom: ISO_ZOOM, target: [0, 0, 0] });
  });

  it("never zooms in past the designed reading distance", () => {
    // one small building could technically be fitted at the maximum zoom; a factory with room to
    // grow is the truthful picture
    expect(isoFraming(floor(0), 1440, 900).zoom).toBe(ISO_ZOOM);
    expect(isoFraming(floor(1), 1440, 900).zoom).toBeLessThanOrEqual(ISO_ZOOM);
  });

  it("keeps every building inside the viewport, which the default framing did not", () => {
    const rooms = floor(6);
    const f = isoFraming(rooms, 1440, 900);
    for (const [px, py] of cornersPx(rooms, f)) {
      expect(Math.abs(px)).toBeLessThanOrEqual(1440 / 2);
      expect(Math.abs(py)).toBeLessThanOrEqual(900 / 2);
    }
  });

  it("keeps every building clear of the panels, not merely on the canvas", () => {
    const rooms = floor(8);
    const left = 320;
    const right = 560;
    const f = isoFraming(rooms, 1440, 900, left, right);
    for (const [px, py] of cornersPx(rooms, f)) {
      // canvas x of this corner, from a canvas-centre-relative offset
      const x = 1440 / 2 + px;
      expect(x).toBeGreaterThanOrEqual(left);
      expect(x).toBeLessThanOrEqual(1440 - right);
      expect(Math.abs(py)).toBeLessThanOrEqual(900 / 2);
    }
  });

  it("pans towards the uncovered floor rather than centring on the canvas", () => {
    const rooms = floor(6);
    const centred = isoFraming(rooms, 1440, 900);
    const withPanels = isoFraming(rooms, 1440, 900, 320, 560);
    // the console drawer is the wider panel, so the visible strip — and the view — moves left
    expect(isoProject(withPanels.target[0], 0, withPanels.target[2])[0])
      .toBeGreaterThan(isoProject(centred.target[0], 0, centred.target[2])[0]);
  });

  it("zooms out as the factory grows and never past the clamp", () => {
    const zooms = [1, 4, 8, 16, 24].map((n) => isoFraming(floor(n), 1440, 900, 320, 560).zoom);
    for (let i = 1; i < zooms.length; i++) expect(zooms[i]).toBeLessThanOrEqual(zooms[i - 1]);
    for (const z of zooms) {
      expect(z).toBeGreaterThanOrEqual(ISO_ZOOM_MIN);
      expect(z).toBeLessThanOrEqual(ISO_ZOOM_MAX);
    }
  });

  it("survives panels that cover the whole viewport instead of dividing by zero", () => {
    const f = isoFraming(floor(6), 600, 400, 400, 400);
    expect(Number.isFinite(f.zoom)).toBe(true);
    expect(f.zoom).toBeGreaterThanOrEqual(ISO_ZOOM_MIN);
  });

  it("keeps the target on the floor plane", () => {
    expect(isoFraming(floor(5), 1440, 900, 320, 560).target[1]).toBe(0);
  });

  it("keeps every building clear of the task board along the bottom edge", () => {
    const rooms = floor(8);
    const bottom = 260;
    const f = isoFraming(rooms, 1440, 900, 320, 560, bottom);
    for (const [px, py] of cornersPx(rooms, f)) {
      // canvas y measured from the top, from a canvas-centre-relative offset (screen +y is up)
      const y = 900 / 2 - py;
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(900 - bottom);
      expect(Math.abs(px)).toBeLessThanOrEqual(1440 / 2);
    }
  });

  it("lifts the view when the board opens instead of leaving the factory behind it", () => {
    const rooms = floor(6);
    const closed = isoFraming(rooms, 1440, 900, 320, 560);
    const open = isoFraming(rooms, 1440, 900, 320, 560, 260);
    // The uncovered strip's centre is higher up the screen, so the factory has to move up with it.
    expect(isoProject(open.target[0], 0, open.target[2])[1])
      .toBeLessThan(isoProject(closed.target[0], 0, closed.target[2])[1]);
    // …and there is less room, so it also pulls back.
    expect(open.zoom).toBeLessThanOrEqual(closed.zoom);
  });

  it("survives a board taller than the viewport", () => {
    const f = isoFraming(floor(6), 600, 400, 0, 0, 900);
    expect(Number.isFinite(f.zoom)).toBe(true);
    expect(f.zoom).toBeGreaterThanOrEqual(ISO_ZOOM_MIN);
  });
});

describe("camera contract", () => {
  it("opens on the isometric orthographic view the plan specifies", () => {
    expect(ISO_CAMERA_POSITION).toEqual([24, 20, 24]);
    expect(ISO_ZOOM).toBe(38);
    // equal x and z is what makes the opening view read as isometric rather than as an arbitrary
    // angle — and it is what `fit` restores, so it is still a fixed point of the scene
    expect(ISO_CAMERA_POSITION[0]).toBe(ISO_CAMERA_POSITION[2]);
    expect(ISO_ZOOM).toBeGreaterThan(ISO_ZOOM_MIN);
    expect(ISO_ZOOM).toBeLessThan(ISO_ZOOM_MAX);
  });

  it("lets the operator get very close and very far", () => {
    expect([ISO_ZOOM_MIN, ISO_ZOOM_MAX]).toEqual([2, 400]);
    // At the near end an agent figure (~1.2 world units tall, see `Agents`) has to be inspectable,
    // not a speck: 400 px/unit makes it most of a laptop's screen height.
    expect(1.2 * ISO_ZOOM_MAX).toBeGreaterThan(300);
  });

  it("shows a whole 25-room factory at the widest zoom", () => {
    const rooms = [
      { position: { x: 0, z: 0 }, kind: "project" as const },
      ...Array.from({ length: 25 }, (_, i) => ({ position: ringPosition(i), kind: "room" as const })),
    ];
    let spanX = 0;
    let spanY = 0;
    for (const r of rooms) {
      const half = buildingSize(r.kind).width / 2;
      for (const dx of [-half, half]) {
        for (const dz of [-half, half]) {
          const [sx, sy] = isoProject(r.position.x + dx, labelHeight(r.kind), r.position.z + dz);
          spanX = Math.max(spanX, Math.abs(sx) * 2);
          spanY = Math.max(spanY, Math.abs(sy) * 2);
        }
      }
    }
    // …with room to spare in a small window, even before the fit's own margins.
    expect(spanX * ISO_ZOOM_MIN).toBeLessThan(1280);
    expect(spanY * ISO_ZOOM_MIN).toBeLessThan(720);
  });

  it("never lets the orbit go under the floor", () => {
    expect(MIN_POLAR_ANGLE).toBeGreaterThanOrEqual(0);
    // Strictly above the horizon: at exactly PI / 2 the camera is in the ground plane, past it the
    // operator is looking at the underside of the factory.
    expect(MAX_POLAR_ANGLE).toBeLessThan(Math.PI / 2);
    // …but only just: the point of the clamp is to keep the floor solid, not to forbid a low angle.
    expect(MAX_POLAR_ANGLE).toBeGreaterThan(Math.PI / 2 - 0.1);
  });

  it("keeps the default view inside the orbit limits it will be dragged from", () => {
    const polar = isoPolarAngle();
    expect(polar).toBeGreaterThan(MIN_POLAR_ANGLE);
    expect(polar).toBeLessThan(MAX_POLAR_ANGLE);
  });

  it("draws a ground plane far bigger than the widest view of it", () => {
    // 1440 px at the widest zoom is 720 world units across; the ground has to outrun that from
    // wherever the operator has panned to, or the edge of the world becomes scenery.
    expect(FLOOR_SIZE).toBeGreaterThan((1440 / ISO_ZOOM_MIN) * 4);
  });

  it("has a frustum deep enough for that ground plane seen edge-on", () => {
    // Half the ground's diagonal is the furthest a visible point can be along the view axis.
    const reach = (FLOOR_SIZE * Math.SQRT2) / 2;
    expect(CAMERA_FAR).toBeGreaterThan(reach);
    expect(-CAMERA_NEAR).toBeGreaterThan(reach);
  });
});

describe("the factory shell", () => {
  const rooms = (n: number) => [
    { position: { x: 0, z: 0 }, kind: "project" as const },
    ...Array.from({ length: n }, (_, i) => ({ position: ringPosition(i), kind: "room" as const })),
  ];

  /** How far the outermost building reaches from the origin, corners included. */
  const reachOf = (list: ReturnType<typeof rooms>) =>
    Math.max(...list.map((r) =>
      Math.max(Math.abs(r.position.x), Math.abs(r.position.z)) + buildingSize(r.kind).width / 2));

  it("keeps the kerb outside the default view of a small factory", () => {
    // At ISO_ZOOM a 1440 px viewport spans ~38 world units, so ±19 from the target. A slab half of
    // SLAB_MIN_HALF puts the edge well outside that: the floor reads as unbounded until you go
    // looking for its edge.
    expect(slabHalf(rooms(1))).toBeGreaterThanOrEqual(SLAB_MIN_HALF);
    expect(SLAB_MIN_HALF).toBeGreaterThan(1440 / ISO_ZOOM);
  });

  it("grows with the factory instead of hugging it", () => {
    for (const n of [1, 8, 25, 64]) {
      const list = rooms(n);
      const reach = reachOf(list);
      // Not "a few metres past the last building": the apron scales, so the shell always has the
      // plant sitting inside it with clear floor around.
      expect(slabHalf(list)).toBeGreaterThan(reach * (1 + SLAB_APRON_RATIO * 0.9));
    }
  });

  it("still contains every building on every ring", () => {
    for (const n of [0, 1, 8, 25, 64]) {
      const list = rooms(n);
      expect(slabHalf(list)).toBeGreaterThan(reachOf(list));
    }
  });

  it("stays inside the ground it is poured on", () => {
    expect(slabHalf(rooms(64)) * 2).toBeLessThan(FLOOR_SIZE);
  });
});

describe("buildingSize", () => {
  it("makes the project block read as headquarters, not as one more shed", () => {
    expect(buildingSize("project")).toEqual({ width: 7, height: 6.5 });
    expect(buildingSize("room")).toEqual({ width: 4, height: 3 });
    const project = buildingSize("project");
    const workshop = buildingSize("room");
    expect(project.width).toBeGreaterThan(workshop.width);
    // over twice a workshop's volume: "bigger" was not enough to read as a different kind of thing
    const volume = (s: { width: number; height: number }) => s.width * s.width * s.height;
    expect(volume(project) / volume(workshop)).toBeGreaterThan(2);
  });

  it("keeps a workshop small enough that two adjacent ring slots cannot overlap", () => {
    // slot 0 and slot 1 on the inner ring are the closest two buildings ever get
    const a = ringPosition(0);
    const b = ringPosition(1);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(buildingSize("room").width);
  });
});

describe("what stacks above a building", () => {
  it("keeps the project block's pitch steep enough to read from a fixed isometric camera", () => {
    // rise over the horizontal run from eaves to apex; a shallow cone reads as a flat dark cap.
    // The old 2-on-a-6-wide-block was 34 degrees; this must be a proper pitch.
    const pitch = Math.atan2(PROJECT_ROOF_HEIGHT, buildingSize("project").width / 2);
    expect(pitch * (180 / Math.PI)).toBeGreaterThan(42);
  });

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

describe("loadingBays", () => {
  const half = buildingSize("room").width / 2;

  it("gives a wall-less building no doors", () => {
    expect(loadingBays("room", [])).toEqual([]);
  });

  it("puts the bay on the wall the belt actually crosses, at the point it crosses it", () => {
    // straight out along +x
    expect(loadingBays("room", [10, 0])).toEqual([{ x: half, z: 0, yaw: Math.PI / 2 }]);
    // straight out along -z
    expect(loadingBays("room", [0, -10])).toEqual([{ x: 0, z: -half, yaw: Math.PI }]);
    // off-axis: the +x wall, but not in the middle of it
    const [bay] = loadingBays("room", [10, 4]);
    expect(bay.x).toBe(half);
    expect(bay.z).toBeCloseTo((half * 4) / 10, 3);
    expect(bay.yaw).toBeCloseTo(Math.PI / 2, 6);
  });

  it("faces the bay out of the wall, never into the building", () => {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [3, 1], [-2, 5]] as const) {
      const [bay] = loadingBays("room", [dx, dz]);
      // the bay's outward normal is local +z rotated by yaw
      const nx = Math.sin(bay.yaw);
      const nz = Math.cos(bay.yaw);
      expect(nx * dx + nz * dz).toBeGreaterThan(0);
    }
  });

  it("is where the belt is: a bay and its belt's end agree on which wall they are on", () => {
    // beltEnds anchors the belt at `wallDistance` along the same direction, which is the same
    // point this picks — a bay somewhere else would be a door with no conveyor at it.
    for (const [dx, dz] of [[14, 5.4], [5.4, 14], [-14, -5.4]] as const) {
      const [bay] = loadingBays("room", [dx, dz]);
      const d = wallDistance("room", dx, dz);
      const span = Math.hypot(dx, dz);
      expect(bay.x).toBeCloseTo((dx / span) * d, 2);
      expect(bay.z).toBeCloseTo((dz / span) * d, 2);
    }
  });

  it("collapses doors that would overlap, so the project block is not a wall of doors", () => {
    // Eight belts all leaving the +x wall within one bay width of each other.
    const dirs: number[] = [];
    for (let i = 0; i < 8; i++) dirs.push(20, i * 0.2);
    expect(loadingBays("project", dirs)).toHaveLength(1);
  });

  it("still gives one bay per wall when the belts genuinely go different ways", () => {
    const bays = loadingBays("project", [20, 0, 0, 20, -20, 0, 0, -20]);
    expect(bays).toHaveLength(4);
    expect(new Set(bays.map((b) => b.yaw)).size).toBe(4);
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

  it("faces every figure out of the building it stands at", () => {
    for (const count of [1, 3, 6]) {
      for (const [x, z] of agentSlots(count, "room")) {
        const yaw = agentFacing(x, z);
        // a figure's front is its local +z; rotated by yaw that is (sin yaw, cos yaw)
        const fx = Math.sin(yaw);
        const fz = Math.cos(yaw);
        // pointing away from the building's centre, not into its wall
        expect(fx * x + fz * z).toBeGreaterThan(0);
        // and exactly along its own radius
        expect(Math.hypot(fx - x / Math.hypot(x, z), fz - z / Math.hypot(x, z))).toBeCloseTo(0, 6);
      }
    }
  });

  it("faces a figure standing dead centre at the camera rather than dividing by zero", () => {
    expect(agentFacing(0, 0)).toBeCloseTo(Math.PI / 4, 6);
  });

  it("pushes the arc further out for the bigger project block", () => {
    const [[rx, rz]] = agentSlots(1, "room");
    const [[px, pz]] = agentSlots(1, "project");
    expect(Math.hypot(px, pz)).toBeGreaterThan(Math.hypot(rx, rz));
  });
});

describe("the status palette", () => {
  it("gives the five statuses five distinguishable colours", () => {
    const colors = Object.values(STATUS_COLOR);
    expect(colors).toHaveLength(5);
    expect(new Set(colors).size).toBe(5);
    // `paused` is a quiet state and shares the slate family with `idle`, so the two are separated by
    // value and temperature rather than by hue — but they must still be different enough to read.
    expect(STATUS_COLOR.paused).not.toBe(STATUS_COLOR.idle);
    // the two an operator must never confuse: "answer me" and "I failed"
    expect(STATUS_COLOR.blocked).not.toBe(STATUS_COLOR.error);
    // and the bypass marker must not collide with any of them
    expect(colors).not.toContain(BYPASS_COLOR);
  });

  it("keeps idle quiet and everything that wants attention bright", () => {
    expect(STATUS_EMISSIVE.idle).toBeLessThan(STATUS_EMISSIVE.working);
    // A held agent is worth a second look, never an alarm: lit more than idle, far less than the
    // three that want something from you.
    expect(STATUS_EMISSIVE.paused).toBeGreaterThan(STATUS_EMISSIVE.idle);
    expect(STATUS_EMISSIVE.paused).toBeLessThan(STATUS_EMISSIVE.working);
    expect(STATUS_EMISSIVE.blocked).toBeGreaterThanOrEqual(STATUS_EMISSIVE.working);
    expect(STATUS_EMISSIVE.error).toBeGreaterThanOrEqual(STATUS_EMISSIVE.working);
  });
});

/** `#rrggbb` -> hue in degrees and saturation/lightness in 0..1. */
function hslOf(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s, l };
}

const inBand = (h: number, [lo, hi]: readonly [number, number]): boolean =>
  lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi;

describe("hsl", () => {
  it("agrees with the CSS colour it is named after", () => {
    expect(hsl(0, 0, 0)).toBe("#000000");
    expect(hsl(0, 0, 1)).toBe("#ffffff");
    expect(hsl(0, 1, 0.5)).toBe("#ff0000");
    expect(hsl(120, 1, 0.5)).toBe("#00ff00");
    expect(hsl(240, 1, 0.5)).toBe("#0000ff");
  });

  it("wraps the hue rather than clipping it", () => {
    expect(hsl(360, 1, 0.5)).toBe(hsl(0, 1, 0.5));
    expect(hsl(-120, 1, 0.5)).toBe(hsl(240, 1, 0.5));
  });
});

describe("room accents", () => {
  const names = ["intake", "design", "backend", "frontend", "qa", "shipping", "docs", "infra"];

  it("is stable for a name: the same department is the same colour everywhere, forever", () => {
    expect(roomAccent("backend")).toEqual(roomAccent("backend"));
    expect(roomAccentHue("backend")).toBe(roomAccentHue("backend"));
  });

  it("spreads a handful of departments over the band", () => {
    const trims = names.map((n) => JSON.stringify(roomAccent(n)));
    // Not "all distinct": the hue is quantised, so eight names over nine steps may tie. What must
    // hold is that most of them differ, and that a tie is a *tie* rather than a near-miss.
    expect(new Set(trims).size).toBeGreaterThanOrEqual(names.length - 2);
  });

  it("never puts two departments confusingly close: they tie exactly or differ by a whole step", () => {
    // Two trims 1 degree apart are worse than two identical ones — identical says "these could not
    // be told apart", nearly-identical says "these are different" and then does not show you how.
    for (const a of names) {
      for (const b of names) {
        const gap = Math.abs(roomAccentHue(a) - roomAccentHue(b));
        if (gap === 0) continue;
        expect(gap).toBeGreaterThanOrEqual(ACCENT_HUE_STEP - 0.2);
      }
    }
  });

  it("**never collides with a status hue** — status is semantics, an accent is decoration", () => {
    for (const name of names) {
      const hue = roomAccentHue(name);
      expect(hue).toBeGreaterThanOrEqual(ACCENT_HUE_MIN);
      expect(hue).toBeLessThanOrEqual(ACCENT_HUE_MAX);
      for (const band of STATUS_HUE_BANDS) expect(inBand(hue, band)).toBe(false);
    }
  });

  it("puts every status colour and the bypass marker inside a band an accent may not use", () => {
    // The bands are only worth having if they actually cover the colours they claim to.
    for (const color of [...Object.values(STATUS_COLOR), BYPASS_COLOR]) {
      const { h, s } = hslOf(color);
      if (s < 0.2) continue; // `idle` is desaturated slate; its hue carries no meaning
      expect(STATUS_HUE_BANDS.some((band) => inBand(h, band))).toBe(true);
    }
  });

  it("stays quieter than any status colour, so status always wins the read", () => {
    const loudestStatus = Math.min(
      ...Object.values(STATUS_COLOR).map((c) => hslOf(c).s).filter((s) => s > 0.2),
    );
    for (const name of names) {
      for (const shade of Object.values(roomAccent(name))) {
        expect(hslOf(shade).s).toBeLessThan(loudestStatus);
      }
    }
  });

  it("shades an accent light to dark, so trim can be layered on one building", () => {
    for (const name of names) {
      const { band, deep, light } = roomAccent(name);
      expect(hslOf(deep).l).toBeLessThan(hslOf(band).l);
      expect(hslOf(band).l).toBeLessThan(hslOf(light).l);
    }
  });
});

describe("selection and packages", () => {
  it("keeps the selection colour out of every status band and off the accent scale", () => {
    const { h, s } = hslOf(SELECT_COLOR);
    for (const band of STATUS_HUE_BANDS) expect(inBand(h, band)).toBe(false);
    // Saturated, unlike every accent: the rim has to shout where a painted band murmurs.
    expect(s).toBeGreaterThan(0.6);
    expect(SELECT_COLOR).not.toBe(BYPASS_COLOR);
    expect(Object.values(STATUS_COLOR)).not.toContain(SELECT_COLOR);
  });

  it("varies the packages by tone only, and keeps them all cardboard", () => {
    expect(new Set(PACKAGE_COLORS).size).toBe(PACKAGE_COLORS.length);
    const hues = PACKAGE_COLORS.map((c) => hslOf(c).h);
    // one hue family (they are all cardboard), spread in lightness
    expect(Math.max(...hues) - Math.min(...hues)).toBeLessThan(15);
    const lightness = PACKAGE_COLORS.map((c) => hslOf(c).l);
    expect(Math.max(...lightness) - Math.min(...lightness)).toBeGreaterThan(0.05);
  });

  it("keeps the waiting-crate colour out of the status vocabulary and off the cardboard", () => {
    // A queue is not an approval waiting on the operator; borrowing amber would make the one colour
    // that means "answer me" mean two things.
    const { h, s } = hslOf(WAITING_PACKAGE_COLOR);
    for (const band of STATUS_HUE_BANDS) expect(inBand(h, band)).toBe(false);
    // Near-neutral, so it cannot be mistaken for a room's accent either (those sit at 0.3).
    expect(s).toBeLessThan(0.2);
    // Cool, where everything that moves on the belts is warm: a crate going nowhere is not goods.
    expect(h).toBeGreaterThan(180);
    expect(s).toBeLessThan(Math.min(...PACKAGE_COLORS.map((c) => hslOf(c).s)));
  });
});

describe("messages waiting at a door", () => {
  it("puts the first crate at the sender's end of the belt, not out on the road", () => {
    const { t, lift } = waitingSlot(0);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(0.12);
    expect(lift).toBe(0);
  });

  it("stacks each further crate a little along and a little higher", () => {
    const a = waitingSlot(0);
    const b = waitingSlot(1);
    const c = waitingSlot(2);
    expect(b.t).toBeGreaterThan(a.t);
    expect(c.t).toBeGreaterThan(b.t);
    expect(b.lift).toBeGreaterThan(a.lift);
    expect(c.lift - b.lift).toBeCloseTo(b.lift - a.lift, 6);
  });

  it("stops spreading past the stack limit, so forty messages are not a staircase", () => {
    const capped = waitingSlot(WAITING_STACK_MAX - 1);
    expect(waitingSlot(WAITING_STACK_MAX)).toEqual(capped);
    expect(waitingSlot(400)).toEqual(capped);
    // A negative index is a caller bug, not a crate under the floor.
    expect(waitingSlot(-3)).toEqual(waitingSlot(0));
  });

  it("counts each queue at its own sender, for its own recipient", () => {
    expect(waitingStackIndices([
      { from: "a", to: "b" },
      { from: "a", to: "b" },
      { from: "c", to: "b" },
      // The other direction is a different pile: the marker stands at the sender's end.
      { from: "b", to: "a" },
      { from: "a", to: "b" },
    ])).toEqual([0, 1, 0, 0, 2]);
  });
});
