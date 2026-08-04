import type { RoomInfo } from "@superfabric/shared";
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { CatmullRomCurve3 } from "three";
import { BoxGeometry, InstancedMesh, Matrix4, Quaternion, TubeGeometry, Vector3 } from "three";
import { useBeltFlow, useFabric, useRoomKind, useRoomPosition } from "../store";
import { slatOffset, slatPosition } from "./atmosphere";
import { BELT_HEIGHT, conveyorCurve } from "./conveyorPath";
import { BELT_COLOR, SLAT_COLOR } from "./palette";

/** One slat geometry, shared by every belt on the floor — there is only ever one shape of slat. */
const SLAT_GEOMETRY = new BoxGeometry(0.86, 0.07, 0.24);
/** Distance between slats along the belt. */
const SLAT_SPACING = 1.2;
const BELT_RADIUS = 0.18;
/** Tubes are round; a belt is not. Squash it vertically into a strip. */
const BELT_FLATTEN = 0.45;
/** Slats ride just clear of the flattened tube's top surface. */
const SLAT_Y = BELT_HEIGHT + BELT_RADIUS * BELT_FLATTEN + 0.03;
const UP = new Vector3(0, 1, 0);

/**
 * The belt strip plus the transform of every slat on it. Built once per pair of positions — a belt is
 * static geometry, and rebuilding a tube while the operator pans would be the most expensive possible
 * way to draw a line that has not moved.
 */
function beltGeometry(
  ax: number,
  az: number,
  akind: RoomInfo["kind"],
  bx: number,
  bz: number,
  bkind: RoomInfo["kind"],
  fan: number,
) {
  const curve = conveyorCurve(
    { position: { x: ax, z: az }, kind: akind },
    { position: { x: bx, z: bz }, kind: bkind },
    undefined,
    fan,
  );

  const tube = new TubeGeometry(curve, 64, BELT_RADIUS, 4, false);
  // Scaling y happens about the world origin, which also drops the belt towards the floor; the
  // translate puts its centre line back at belt height.
  tube.scale(1, BELT_FLATTEN, 1);
  tube.translate(0, BELT_HEIGHT * (1 - BELT_FLATTEN), 0);

  const count = Math.max(2, Math.round(curve.getLength() / SLAT_SPACING));
  return { tube, curve, count };
}

const scratchPoint = new Vector3();
const scratchTangent = new Vector3();
const scratchRotation = new Quaternion();
const scratchMatrix = new Matrix4();
const UNIT_SCALE = new Vector3(1, 1, 1);

/**
 * Writes every slat of one belt, having crawled by `offset` of one spacing.
 *
 * Called once when a belt is built (`offset` 0) and once per frame while a package is on it, from the
 * same code — the still belt and the moving one must be the same strip, and two placement routines
 * would eventually disagree about where a slat sits.
 */
function placeSlats(
  mesh: InstancedMesh,
  curve: CatmullRomCurve3,
  count: number,
  offset: number,
): void {
  for (let i = 0; i < count; i++) {
    const u = slatPosition(i, count, offset);
    curve.getPointAt(u, scratchPoint);
    curve.getTangentAt(u, scratchTangent);
    // The slat's long axis is its local x, and it has to lie *across* the direction of travel: a
    // rotation of θ about y sends x to (cos θ, 0, −sin θ), and we want it at the tangent's normal.
    scratchRotation.setFromAxisAngle(UP, Math.atan2(-scratchTangent.x, -scratchTangent.z));
    scratchMatrix.compose(scratchPoint.setY(SLAT_Y), scratchRotation, UNIT_SCALE);
    mesh.setMatrixAt(i, scratchMatrix);
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
}

/**
 * One belt between two buildings. Split from `Conveyor` so the geometry memo keys on plain numbers
 * and kinds rather than on two room objects: a room row is replaced whenever its agent count changes,
 * and that must not rebuild a tube.
 */
const Belt = memo(function Belt({
  ax,
  az,
  akind,
  bx,
  bz,
  bkind,
  fan,
  flow,
}: {
  ax: number;
  az: number;
  akind: RoomInfo["kind"];
  bx: number;
  bz: number;
  bkind: RoomInfo["kind"];
  fan: number;
  /**
   * Which way traffic is moving on this belt: `+1` along it as drawn, `-1` against it, `0` for an
   * empty belt. The slats crawl with the box and are **still** otherwise — a belt that ran all the
   * time would be a factory whose conveyors say nothing about whether anything is on them, and it
   * would pin `frameloop="always"` for ever.
   */
  flow: number;
}) {
  const slatsRef = useRef<InstancedMesh>(null);
  const { tube, curve, count } = useMemo(
    () => beltGeometry(ax, az, akind, bx, bz, bkind, fan),
    [ax, az, akind, bx, bz, bkind, fan],
  );

  // A TubeGeometry holds GPU buffers; dropping the reference is not enough to free them.
  useEffect(() => () => tube.dispose(), [tube]);

  // At rest, and after the last package leaves: a belt that stopped mid-crawl would leave its slats
  // wherever the final frame happened to catch them, which over a session drifts into a jumble.
  useLayoutEffect(() => {
    const mesh = slatsRef.current;
    if (mesh === null) return;
    placeSlats(mesh, curve, count, 0);
  }, [curve, count, flow]);

  useFrame(({ clock }) => {
    const mesh = slatsRef.current;
    if (mesh === null || flow === 0) return;
    placeSlats(mesh, curve, count, slatOffset(clock.elapsedTime, flow));
  });

  return (
    <>
      <mesh geometry={tube} receiveShadow>
        <meshStandardMaterial color={BELT_COLOR} roughness={0.85} />
      </mesh>
      {/* Every slat of one belt in a single draw call. */}
      <instancedMesh ref={slatsRef} args={[SLAT_GEOMETRY, undefined, count]} frustumCulled={false}>
        <meshStandardMaterial color={SLAT_COLOR} roughness={0.7} />
      </instancedMesh>
    </>
  );
});

/**
 * A belt between two rooms, looked up by id so it follows either building when it moves — including
 * while one of them is being dragged, which is what `useRoomPosition` adds over the room's own row.
 * A belt left hanging in the air where a building used to be would make a drag look like a bug.
 */
export const Conveyor = memo(function Conveyor({
  from,
  to,
  fan,
}: {
  from: string;
  to: string;
  fan: number;
}) {
  const a = useRoomPosition(from);
  const b = useRoomPosition(to);
  // The kinds are what let the belt stop at the walls: the project block is half again as wide as a
  // workshop, so its end has to be inset further.
  const akind = useRoomKind(from);
  const bkind = useRoomKind(to);
  // A number, so this re-renders when the belt starts or stops carrying something and not when a
  // package one belt over moves.
  const flow = useBeltFlow(from, to);
  if (a === undefined || b === undefined || akind === undefined || bkind === undefined) return null;
  return (
    <Belt ax={a.x} az={a.z} akind={akind} bx={b.x} bz={b.z} bkind={bkind} fan={fan} flow={flow} />
  );
});

/**
 * Every belt on the floor. The list is derived in the store (`conveyors`), so this component maps and
 * nothing more — which belts exist is a question about the factory, not about the scene.
 */
export function Conveyors() {
  const conveyors = useFabric((s) => s.conveyors);
  return (
    <>
      {conveyors.map((c) => (
        <Conveyor key={`${c.from}|${c.to}`} from={c.from} to={c.to} fan={c.fan} />
      ))}
    </>
  );
}
