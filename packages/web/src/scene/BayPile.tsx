import { memo, useLayoutEffect, useRef } from "react";
import type { InstancedMesh } from "three";
import { BoxGeometry, Color, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from "three";
import { bayCrateSlot, BAY_PILE_COLUMNS, BAY_PILE_ROWS } from "./errands";
import { PACKAGE_COLORS, packageToneIndex } from "./palette";

/**
 * Crates that came down a belt, reached a loading bay, and that **nobody carried in**.
 *
 * This is the visible half of "a room with nobody home looks like a room with nobody home". A package
 * arriving at a staffed room is met by an agent and gone in a few seconds; one arriving at a room whose
 * agents are all blocked, paused or absent stands on the dock and the next one stands beside it. The
 * pile is the information, so it is drawn as goods rather than as a warning: the same cardboard the box
 * had on the belt, in the same tone, because it is the same box.
 *
 * **Deliberately still**, exactly like the queue of undelivered messages at a sender's door: written
 * once when the pile changes and never touched by the render loop. Animating it would pin
 * `frameloop="always"` for as long as a room stayed unstaffed — which is to say, precisely while
 * nothing is happening.
 *
 * Drawn in the **bay's** own frame (`+z` out of the wall), which is the frame `Building` already puts
 * its loading bays in, so the pile stands at the door rather than at a computed world position.
 */
const CRATE_GEOMETRY = new BoxGeometry(0.44, 0.4, 0.44);
/** White, because the per-instance colour multiplies it — one draw call, four tones of cardboard. */
const CRATE_MATERIAL = new MeshStandardMaterial({ color: "#ffffff", roughness: 0.72 });
const CRATE_TONES = PACKAGE_COLORS.map((hex) => new Color(hex));

/** As many as the pile has slots for. Past that they stack in place; see `bayCrateSlot`. */
const CAPACITY = BAY_PILE_COLUMNS * BAY_PILE_ROWS;

const scratchPosition = new Vector3();
const scratchMatrix = new Matrix4();
const scratchQuaternion = new Quaternion();
const scratchScale = new Vector3();
const UP = new Vector3(0, 1, 0);

export const BayPile = memo(function BayPile({ ids }: { ids: readonly string[] }) {
  const meshRef = useRef<InstancedMesh>(null);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const drawn = Math.min(ids.length, CAPACITY);
    for (let i = 0; i < drawn; i++) {
      const slot = bayCrateSlot(i);
      scratchPosition.set(slot.x, slot.y, slot.z);
      // A small stable yaw per crate, so a stack of boxes reads as boxes thrown down rather than as a
      // machined column. Derived from the id, so it never changes while the crate stands there.
      scratchQuaternion.setFromAxisAngle(UP, ((packageToneIndex(ids[i]) - 1.5) * 0.11));
      scratchScale.setScalar(1);
      scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);
      mesh.setMatrixAt(i, scratchMatrix);
      mesh.setColorAt(i, CRATE_TONES[packageToneIndex(ids[i])]);
    }
    mesh.count = drawn;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }, [ids]);

  if (ids.length === 0) return null;
  return (
    <instancedMesh
      ref={meshRef}
      args={[CRATE_GEOMETRY, CRATE_MATERIAL, CAPACITY]}
      castShadow
      receiveShadow
      frustumCulled={false}
    />
  );
});
