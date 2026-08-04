import type { RoomInfo } from "@superfabric/shared";
import { useFrame } from "@react-three/fiber";
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import type { InstancedMesh } from "three";
import { Color, Matrix4, MeshBasicMaterial, Quaternion, SphereGeometry, Vector3 } from "three";
import { puffAt, SMOKE_PUFFS_PER_VENT, smokeStrength } from "./atmosphere";
import { ventMouths } from "./layout";
import { SMOKE } from "./palette";

/**
 * The plume over a working room's roof vents.
 *
 * **Quiet by construction.** It is unlit (so it never goes dark on a shaded roof and never picks up a
 * highlight that would compete with a beacon), it is a near-neutral grey a shade off the backdrop, it
 * is half transparent, and it writes no depth — so it can never hide a package, a belt or a lamp
 * behind it. What it adds is movement over a building that is doing something, which is the one thing
 * the floor had no way of saying at a glance from the roofline.
 *
 * One `instancedMesh` per building, one unit sphere and one material for the whole floor: a smoking
 * factory costs one draw call per chimney, not one per puff. `instanceColor` carries the fade from
 * fresh smoke to thinned-out smoke, so the dispersal costs no extra material either.
 *
 * The project block has no vents (`ventMouths`) and therefore no plume: it has a pitched roof with a
 * finial rather than roof plant, and inventing a chimney for it would be inventing architecture. Its
 * beacon still says it is working.
 */
const PUFF_GEOMETRY = new SphereGeometry(1, 7, 5);
const PUFF_MATERIAL = new MeshBasicMaterial({
  color: "#ffffff",
  transparent: true,
  // Enough to read as a plume against the mid-grey backdrop a chimney is normally seen against, and
  // not enough to hide anything: `depthWrite: false` means it never occludes a package or a lamp, and
  // at half opacity it does not even hide the roof it rises from.
  opacity: 0.46,
  depthWrite: false,
});

const FRESH = new Color(SMOKE.fresh);
const THIN = new Color(SMOKE.thin);

const scratchColor = new Color();
const scratchPosition = new Vector3();
const scratchScale = new Vector3();
const scratchMatrix = new Matrix4();
const IDENTITY_ROTATION = new Quaternion();

export const Chimney = memo(function Chimney({
  kind,
  working,
  smokeUntil,
}: {
  kind: RoomInfo["kind"];
  /** Somebody in this room is working: the plume is at full strength. */
  working: boolean;
  /** When the plume finishes fading, for a room that has stopped. `0` when there is nothing to fade. */
  smokeUntil: number;
}) {
  const meshRef = useRef<InstancedMesh>(null);
  const vents = useMemo(() => ventMouths(kind), [kind]);
  const capacity = vents.length * SMOKE_PUFFS_PER_VENT;

  /** Writes one matrix and one colour per puff, and returns how many are actually in the air. */
  function place(now: number): void {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const strength = smokeStrength(working, smokeUntil, now);
    if (strength <= 0) {
      // Nothing in the air: draw no instances at all rather than a stack of zero-scaled spheres.
      mesh.count = 0;
      mesh.instanceMatrix.needsUpdate = true;
      return;
    }
    let drawn = 0;
    for (const [ventIndex, vent] of vents.entries()) {
      for (let i = 0; i < SMOKE_PUFFS_PER_VENT; i++) {
        // Offsetting the phase by the vent keeps the two pipes from puffing in lockstep, which reads
        // as a machine rather than as a chimney.
        const puff = puffAt(i, now + ventIndex * 900);
        scratchPosition.set(vent[0] + puff.x, vent[1] + puff.y, vent[2] + puff.z);
        // The fade multiplies the size, so a room going quiet thins out instead of switching off.
        scratchScale.setScalar(puff.scale * strength);
        scratchMatrix.compose(scratchPosition, IDENTITY_ROTATION, scratchScale);
        mesh.setMatrixAt(drawn, scratchMatrix);
        mesh.setColorAt(drawn, scratchColor.copy(FRESH).lerp(THIN, puff.mix));
        drawn++;
      }
    }
    mesh.count = drawn;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }

  // Place immediately on a change, so the frame `RedrawOnStoreChange` asks for is already right —
  // including the last one, which is the frame that erases a plume that has finished fading.
  useLayoutEffect(() => {
    place(Date.now());
  });

  useFrame(() => {
    place(Date.now());
  });

  if (capacity === 0) return null;
  return (
    <instancedMesh
      ref={meshRef}
      args={[PUFF_GEOMETRY, PUFF_MATERIAL, capacity]}
      // Instance transforms are written by hand, so the mesh's own bounding sphere (one unit sphere at
      // the origin) says nothing about where the smoke actually is.
      frustumCulled={false}
    />
  );
});
