import { ringPosition, type RoomInfo } from "@superfabric/shared";

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

/** Footprint and height of a building, by room kind. The project block is the bigger one. */
export function buildingSize(kind: RoomInfo["kind"]): { width: number; height: number } {
  return kind === "project" ? { width: 6, height: 5 } : { width: 4, height: 3 };
}
