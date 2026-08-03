import type { RoomInfo } from "@superfabric/shared";
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { BoxGeometry, InstancedMesh, Matrix4, Quaternion, TubeGeometry, Vector3 } from "three";
import { useFabric, useRoomKind, useRoomPosition } from "../store";
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
) {
  const curve = conveyorCurve(
    { position: { x: ax, z: az }, kind: akind },
    { position: { x: bx, z: bz }, kind: bkind },
  );

  const tube = new TubeGeometry(curve, 64, BELT_RADIUS, 4, false);
  // Scaling y happens about the world origin, which also drops the belt towards the floor; the
  // translate puts its centre line back at belt height.
  tube.scale(1, BELT_FLATTEN, 1);
  tube.translate(0, BELT_HEIGHT * (1 - BELT_FLATTEN), 0);

  const length = curve.getLength();
  const count = Math.max(2, Math.round(length / SLAT_SPACING));
  const point = new Vector3();
  const tangent = new Vector3();
  const rotation = new Quaternion();
  const unit = new Vector3(1, 1, 1);
  const matrices: Matrix4[] = [];
  for (let i = 0; i < count; i++) {
    const u = (i + 0.5) / count;
    curve.getPointAt(u, point);
    curve.getTangentAt(u, tangent);
    // The slat's long axis is its local x, and it has to lie *across* the direction of travel: a
    // rotation of θ about y sends x to (cos θ, 0, −sin θ), and we want it at the tangent's normal.
    rotation.setFromAxisAngle(UP, Math.atan2(-tangent.x, -tangent.z));
    matrices.push(new Matrix4().compose(point.clone().setY(SLAT_Y), rotation, unit));
  }
  return { tube, matrices };
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
}: {
  ax: number;
  az: number;
  akind: RoomInfo["kind"];
  bx: number;
  bz: number;
  bkind: RoomInfo["kind"];
}) {
  const slatsRef = useRef<InstancedMesh>(null);
  const { tube, matrices } = useMemo(
    () => beltGeometry(ax, az, akind, bx, bz, bkind),
    [ax, az, akind, bx, bz, bkind],
  );

  // A TubeGeometry holds GPU buffers; dropping the reference is not enough to free them.
  useEffect(() => () => tube.dispose(), [tube]);

  useLayoutEffect(() => {
    const mesh = slatsRef.current;
    if (mesh === null) return;
    for (const [i, matrix] of matrices.entries()) mesh.setMatrixAt(i, matrix);
    mesh.count = matrices.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [matrices]);

  return (
    <>
      <mesh geometry={tube} receiveShadow>
        <meshStandardMaterial color={BELT_COLOR} roughness={0.85} />
      </mesh>
      {/* Every slat of one belt in a single draw call. */}
      <instancedMesh ref={slatsRef} args={[SLAT_GEOMETRY, undefined, matrices.length]} frustumCulled={false}>
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
export const Conveyor = memo(function Conveyor({ from, to }: { from: string; to: string }) {
  const a = useRoomPosition(from);
  const b = useRoomPosition(to);
  // The kinds are what let the belt stop at the walls: the project block is half again as wide as a
  // workshop, so its end has to be inset further.
  const akind = useRoomKind(from);
  const bkind = useRoomKind(to);
  if (a === undefined || b === undefined || akind === undefined || bkind === undefined) return null;
  return <Belt ax={a.x} az={a.z} akind={akind} bx={b.x} bz={b.z} bkind={bkind} />;
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
        <Conveyor key={`${c.from}|${c.to}`} from={c.from} to={c.to} />
      ))}
    </>
  );
}
