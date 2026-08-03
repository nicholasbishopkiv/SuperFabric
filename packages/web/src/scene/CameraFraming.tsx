import { useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import type { OrthographicCamera } from "three";
import { useFabric, useHudInsets, useRoomIds } from "../store";
import { ISO_CAMERA_POSITION, isoFraming } from "./layout";

/** The bits of `MapControls` this needs, without importing the class. */
interface OrbitLike {
  target: { set(x: number, y: number, z: number): void };
  update(): boolean | void;
  addEventListener(type: "start", fn: () => void): void;
  removeEventListener(type: "start", fn: () => void): void;
}

/**
 * Keeps the whole factory in frame — and then gets out of the way.
 *
 * Nothing used to re-frame anything: the camera looked at the origin at a fixed zoom, so a
 * six-room factory put half its workshops behind the HUD panels and a ring-14 building was simply
 * off screen below the fold. This fits the screen-space bounding box of every building into the
 * rectangle the panels leave uncovered (`isoFraming` does that arithmetic, and is unit-tested), and
 * re-does it when a room is added or removed, when a panel is collapsed or expanded, and when the
 * window is resized.
 *
 * **It stops the first time the operator pans or zooms.** A camera that keeps re-framing is worse
 * than one that never does: the operator leans in on one workshop, an unrelated room appears, and
 * the floor jumps. `MapControls` fires `start` on real user input and never for a programmatic
 * change, so that event is an exact "the view is theirs now" signal. The `fit` control (and `f`)
 * hands it back, which is the single documented way to re-arm the automatic framing.
 *
 * Deliberately *not* re-framing on a building being **moved**: a drag is the operator arranging
 * their floor, and having the camera lurch on pointer-up would make every drag feel like a mistake.
 * The room *ids* are the dependency, not their positions.
 */
export function CameraFraming() {
  const camera = useThree((s) => s.camera) as OrthographicCamera;
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  // `makeDefault` on MapControls is what publishes this; null until it has mounted.
  const controls = useThree((s) => s.controls) as OrbitLike | null;

  const roomIds = useRoomIds();
  const insets = useHudInsets();
  const fitRequests = useFabric((s) => s.fitRequests);

  /** True once the operator has panned or zoomed: from then on the view is theirs. */
  const manual = useRef(false);
  const seenFit = useRef(fitRequests);

  useEffect(() => {
    if (controls === null) return;
    const onStart = (): void => {
      manual.current = true;
    };
    controls.addEventListener("start", onStart);
    return () => controls.removeEventListener("start", onStart);
  }, [controls]);

  useEffect(() => {
    if (fitRequests !== seenFit.current) {
      seenFit.current = fitRequests;
      manual.current = false;
    } else if (manual.current) {
      return;
    }

    // Read positions rather than subscribing to them: see the note about drags above.
    const rooms = useFabric.getState().rooms;
    const { zoom, target } = isoFraming(rooms, size.width, size.height, insets.left, insets.right);
    camera.zoom = zoom;
    camera.position.set(
      target[0] + ISO_CAMERA_POSITION[0],
      target[1] + ISO_CAMERA_POSITION[1],
      target[2] + ISO_CAMERA_POSITION[2],
    );
    camera.updateProjectionMatrix();
    if (controls !== null) {
      controls.target.set(target[0], target[1], target[2]);
      controls.update();
    } else {
      camera.lookAt(target[0], target[1], target[2]);
    }
    // `frameloop="demand"`: moving a camera outside React's commit renders nothing on its own.
    invalidate();
  }, [roomIds, size.width, size.height, insets.left, insets.right, fitRequests, camera, controls, invalidate]);

  return null;
}
