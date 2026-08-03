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
