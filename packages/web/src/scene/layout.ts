import { ringPosition, type RoomInfo, type ScenePosition } from "@superfabric/shared";

/**
 * Pure scene geometry. Nothing here imports three or React, so it is unit-testable in jsdom — which
 * cannot render WebGL and therefore cannot mount a `<Canvas>` at all.
 */

/**
 * Where a new workshop will stand. Re-exported from `@superfabric/shared` rather than reimplemented:
 * the server assigns the same positions with the same function, so a client-side preview of "your
 * new room lands here" can never disagree with where the room actually appears.
 */
export { ringPosition };

/** Isometric-looking orthographic camera: equal x and z, lifted, looking at the origin. */
export const ISO_CAMERA_POSITION: readonly [number, number, number] = [24, 20, 24];
export const ISO_ZOOM = 38;
export const ISO_ZOOM_MIN = 12;
export const ISO_ZOOM_MAX = 90;

/** Half-extent of the ground plane and the grid drawn on it. */
export const FLOOR_SIZE = 200;

/**
 * The point the camera should frame: the centroid of every building on the floor, so adding rooms
 * on one side of the origin does not push them out of view. An empty floor frames the origin, where
 * the project building will appear the moment the server answers.
 */
export function isoCameraTarget(rooms: readonly Pick<RoomInfo, "position">[]): [number, number, number] {
  if (rooms.length === 0) return [0, 0, 0];
  let x = 0;
  let z = 0;
  for (const room of rooms) {
    x += room.position.x;
    z += room.position.z;
  }
  const round = (v: number) => Math.round((v / rooms.length) * 1000) / 1000;
  return [round(x), 0, round(z)];
}

// ---- framing the floor -------------------------------------------------------------------------
//
// The camera never rotates, so "where on screen does this world point land" is a fixed 3x2 matrix
// that can be written down once and reasoned about without a renderer. Everything the framing needs
// — how big the factory is in screen units, and which way to pan to centre it between the two HUD
// panels — falls out of that matrix, which is why none of this needs three or a mounted canvas.

/** Unit vectors of the camera's screen plane, in world space, derived from where the camera stands. */
function isoBasis(): { right: [number, number, number]; up: [number, number, number] } {
  const [px, py, pz] = ISO_CAMERA_POSITION;
  const len = Math.hypot(px, py, pz);
  // The camera looks at the origin, so forward is the negated (normalised) position.
  const f: [number, number, number] = [-px / len, -py / len, -pz / len];
  // right = normalise(forward x worldUp); worldUp is (0, 1, 0), which collapses the cross product.
  const rLen = Math.hypot(-f[2], f[0]);
  const right: [number, number, number] = [-f[2] / rLen, 0, f[0] / rLen];
  // up = right x forward
  const up: [number, number, number] = [
    right[1] * f[2] - right[2] * f[1],
    right[2] * f[0] - right[0] * f[2],
    right[0] * f[1] - right[1] * f[0],
  ];
  return { right, up };
}

const ISO_BASIS = isoBasis();

/**
 * Where a world point lands on screen, in **world units** (multiply by `camera.zoom` for pixels),
 * relative to whatever the camera is looking at. `+x` is right, `+y` is up.
 */
export function isoProject(x: number, y: number, z: number): [number, number] {
  const { right, up } = ISO_BASIS;
  return [
    x * right[0] + y * right[1] + z * right[2],
    x * up[0] + y * up[1] + z * up[2],
  ];
}

/**
 * The floor movement that shifts the view by `(dsx, dsy)` screen units — the inverse of
 * `isoProject` restricted to the floor plane, so panning to recentre the factory never lifts the
 * camera's target off the ground.
 */
export function isoFloorDelta(dsx: number, dsy: number): ScenePosition {
  const { right, up } = ISO_BASIS;
  const [a, b] = [right[0], right[2]];
  const [c, d] = [up[0], up[2]];
  const det = a * d - b * c;
  return { x: round3((dsx * d - dsy * b) / det), z: round3((dsy * a - dsx * c) / det) };
}

/** Clear floor left around the factory when the view is fitted to it, in CSS pixels. */
export const FIT_MARGIN_PX = 56;

/** What the camera should look at and how far it should be zoomed out to show the whole factory. */
export interface Framing {
  zoom: number;
  target: [number, number, number];
}

/**
 * Frame the whole factory, allowing for the HUD.
 *
 * Two things make this more than "look at the centroid". First, the buildings have *extent*: a
 * ring-14 workshop is 4 wide and carries a beacon and a label above its roof, so fitting the
 * centres would still clip the thing the operator is trying to read. Second, the two overlay panels
 * cover the left and right edges of the canvas — the canvas is full-bleed behind them — so the
 * usable rectangle is neither the viewport nor centred on it, and a view centred on the canvas puts
 * the factory half under the console drawer. Both are handled here: the screen-space bounding box of
 * every building is fitted into the *unobstructed* rectangle, and the target is panned so the box's
 * centre lands at that rectangle's centre rather than the canvas's.
 *
 * The zoom only ever pulls **back**: `ISO_ZOOM` is the designed reading distance, and a floor with
 * one building on it should look like a factory with room to grow, not a close-up of a shed.
 */
export function isoFraming(
  rooms: readonly Pick<RoomInfo, "position" | "kind">[],
  viewWidth: number,
  viewHeight: number,
  leftInset = 0,
  rightInset = 0,
): Framing {
  const target = isoCameraTarget(rooms);
  if (rooms.length === 0) return { zoom: ISO_ZOOM, target };

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const room of rooms) {
    const half = buildingSize(room.kind).width / 2;
    // The footprint's four corners, at the floor and at the top of everything stacked on the roof.
    for (const dx of [-half, half]) {
      for (const dz of [-half, half]) {
        for (const y of [0, labelHeight(room.kind)]) {
          const [sx, sy] = isoProject(room.position.x + dx, y, room.position.z + dz);
          if (sx < minX) minX = sx;
          if (sx > maxX) maxX = sx;
          if (sy < minY) minY = sy;
          if (sy > maxY) maxY = sy;
        }
      }
    }
  }

  const usableWidth = Math.max(1, viewWidth - leftInset - rightInset - 2 * FIT_MARGIN_PX);
  const usableHeight = Math.max(1, viewHeight - 2 * FIT_MARGIN_PX);
  const spanX = Math.max(maxX - minX, 0.001);
  const spanY = Math.max(maxY - minY, 0.001);
  const fitted = Math.min(usableWidth / spanX, usableHeight / spanY, ISO_ZOOM);
  const zoom = Math.round(Math.max(ISO_ZOOM_MIN, Math.min(ISO_ZOOM_MAX, fitted)) * 1000) / 1000;

  // Where the usable rectangle's centre sits relative to the canvas's, in screen units.
  const offsetX = (leftInset - rightInset) / 2 / zoom;
  const [cx, cy] = isoProject(target[0], 0, target[2]);
  // Pan so the bounding box's centre lands on the usable rectangle's centre.
  const pan = isoFloorDelta((minX + maxX) / 2 - cx - offsetX, (minY + maxY) / 2 - cy);
  return { zoom, target: [round3(target[0] + pan.x), 0, round3(target[2] + pan.z)] };
}

/** Positions on the floor are kept to this many decimals, in the store and on the wire alike. */
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Dragging a building, in the only two lines of arithmetic it actually needs. The screen-to-world
 * part is not here on purpose: the `<Canvas>`'s own raycaster already reports the point where the
 * pointer's ray meets the floor plane, and hand-rolling that projection would be a second,
 * disagreeing camera model.
 *
 * What is left is the grab offset. Without it a building's centre snaps to the pointer the instant
 * the drag starts, so grabbing a roof corner teleports the building by half its width before it has
 * moved at all.
 */
export function grabOffset(roomPosition: ScenePosition, floorPoint: ScenePosition): ScenePosition {
  return { x: roomPosition.x - floorPoint.x, z: roomPosition.z - floorPoint.z };
}

/** Where a dragged building stands when the pointer's ray meets the floor at `floorPoint`. */
export function draggedPosition(floorPoint: ScenePosition, offset: ScenePosition): ScenePosition {
  return { x: round3(floorPoint.x + offset.x), z: round3(floorPoint.z + offset.z) };
}

// ---- the factory shell -------------------------------------------------------------------------

/** Thickness of the poured slab, seen as a lip wherever the floor is edge-on. */
export const SLAB_THICKNESS = 0.5;
/** Clear concrete kept between the outermost building and the kerb. */
export const SLAB_APRON = 4;
/** The smallest slab we ever pour, so a one-room factory still stands in a building. */
export const SLAB_MIN_HALF = 18;

/**
 * Half-extent of the concrete slab: big enough to contain every building with an apron of clear
 * floor around it, snapped up to a whole number of grid sections so the painted joints always meet
 * the kerb squarely.
 *
 * Derived rather than constant because the floor grows: rooms are laid out on rings that step
 * outwards for ever, and a fixed slab would eventually have workshops standing on bare ground —
 * which would read as a bug, not as a big factory.
 */
export function slabHalf(rooms: readonly Pick<RoomInfo, "position" | "kind">[]): number {
  let reach = SLAB_MIN_HALF - SLAB_APRON;
  for (const room of rooms) {
    const half = buildingSize(room.kind).width / 2;
    reach = Math.max(reach, Math.abs(room.position.x) + half, Math.abs(room.position.z) + half);
  }
  return Math.ceil((reach + SLAB_APRON) / 2) * 2;
}

/**
 * The painted zone circles on the slab: one under each ring that has a building on it, so the floor
 * markings describe the layout the rooms actually use instead of decorating it arbitrarily.
 */
export function paintedZones(rooms: readonly Pick<RoomInfo, "position" | "kind">[]): number[] {
  const radii = new Set<number>();
  for (const room of rooms) {
    const r = Math.hypot(room.position.x, room.position.z);
    // The project block sits at the middle; it has no ring.
    if (r < 1) continue;
    radii.add(Math.round(r * 2) / 2);
  }
  return [...radii].sort((a, b) => a - b);
}

/** Footprint and height of a building, by room kind. The project block is the bigger one. */
export function buildingSize(kind: RoomInfo["kind"]): { width: number; height: number } {
  return kind === "project" ? { width: 6, height: 5 } : { width: 4, height: 3 };
}

/** The project block's pitched roof: a 4-sided cone this tall, sitting on top of the box. */
export const PROJECT_ROOF_HEIGHT = 2;
/** A workshop's flat roof: a thin slab with a slight overhang. */
export const ROOM_ROOF_THICKNESS = 0.3;

/** The highest point of a building's roof — everything stacked above it starts from here. */
export function roofTop(kind: RoomInfo["kind"]): number {
  const { height } = buildingSize(kind);
  return height + (kind === "project" ? PROJECT_ROOF_HEIGHT : ROOM_ROOF_THICKNESS);
}

/** Where a room's status beacon floats: clear of the roof, below the label. */
export function beaconHeight(kind: RoomInfo["kind"]): number {
  return roofTop(kind) + 0.9;
}

/** Where a building's name label sits: above the beacon, so the two never overlap. */
export function labelHeight(kind: RoomInfo["kind"]): number {
  return beaconHeight(kind) + 1.4;
}

/**
 * Where each of a room's agents stands: on a short arc in *front* of the building, meaning the
 * +x/+z corner, which is the one the fixed isometric camera looks at. One agent stands in the
 * middle; more fan out around it, and the arc widens with the crowd so eight agents still read as
 * eight figures rather than one blob.
 *
 * Pure and exported so it is testable — `Agents` only places what this returns.
 */
export function agentSlots(count: number, kind: RoomInfo["kind"]): [x: number, z: number][] {
  if (count <= 0) return [];
  const { width } = buildingSize(kind);
  const radius = width * 0.5 + 1.3;
  // The arc is centred on the camera-facing diagonal and spans up to ~120°.
  const centre = Math.PI / 4;
  const spread = Math.min(0.42 * (count - 1), (2 * Math.PI) / 3);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return Array.from({ length: count }, (_, i) => {
    const angle = centre + (count === 1 ? 0 : spread * (i / (count - 1) - 0.5));
    return [round(radius * Math.cos(angle)), round(radius * Math.sin(angle))];
  });
}
