import type { ScenePosition } from "@superfabric/shared";
import type { ThreeEvent } from "@react-three/fiber";
import { useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { useFabric, useIsDragging } from "../store";
import { send } from "../wsClient";
import { draggedPosition, FLOOR_SIZE, grabOffset } from "./layout";

/**
 * Drag-to-move for buildings, in one place. A `Building` only says "the pointer went down on me"
 * (`beginRoomDrag`); everything that follows — where the floor is under the pointer, what the camera
 * controls are allowed to do meanwhile, and the single `move_room` at the end — is here, because all
 * of it is about the drag rather than about any one building.
 *
 * Three things have to be true at once for a drag to feel like dragging:
 *
 * 1. **The camera must hold still.** drei's `MapControls` pans on pointer-down anywhere on the
 *    canvas, so without disabling it the floor slides under the building and the building appears
 *    not to move at all. `stopPropagation` in the building's handler stops the *scene* propagating
 *    the event; it does not unsubscribe a DOM listener that `MapControls` attached to the canvas
 *    itself, so the controls are switched off for the duration and restored afterwards.
 * 2. **The scene must render.** `frameloop="demand"` renders on demand only; `hasMotion` counts an
 *    active drag for exactly this reason.
 * 3. **The server must be told once.** Not per frame: a pointer produces dozens of positions a
 *    second, and each one would be a database write and a broadcast to every attached socket.
 */
export function RoomDrag() {
  const dragging = useIsDragging();
  // `makeDefault` on MapControls is what puts it here; without it this is null and the drag would
  // fight a pan it cannot see.
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;
  /** Set on the first move of a drag: the building's centre relative to the grabbed floor point. */
  const offset = useRef<ScenePosition | null>(null);
  /** Whether the pointer actually went anywhere. A press that did not move is a click, not a move. */
  const moved = useRef(false);

  // Nothing else may pan or zoom while a building is under the pointer.
  useEffect(() => {
    offset.current = null;
    moved.current = false;
    if (!dragging || controls === null) return;
    const wasEnabled = controls.enabled;
    controls.enabled = false;
    return () => {
      controls.enabled = wasEnabled;
    };
  }, [dragging, controls]);

  // Pointer-up ends the drag wherever it happens — including outside the canvas, which is exactly
  // where a fast drag ends. Committing here rather than on the plane's own `onPointerUp` also means
  // a drag that left the window does not leave a building stuck to the pointer.
  useEffect(() => {
    if (!dragging) return;

    function commit(): void {
      const { drag, endRoomDrag } = useFabric.getState();
      // Already committed. The guard is what makes "exactly one `move_room` per drag" true no matter
      // how many pointer-up-ish events the browser decides to send.
      if (drag === null) return;
      endRoomDrag();
      if (moved.current) send({ kind: "move_room", roomId: drag.roomId, position: drag.position });
    }

    window.addEventListener("pointerup", commit);
    window.addEventListener("pointercancel", commit);
    return () => {
      window.removeEventListener("pointerup", commit);
      window.removeEventListener("pointercancel", commit);
    };
  }, [dragging]);

  if (!dragging) return null;

  function onPointerMove(e: ThreeEvent<PointerEvent>): void {
    const { drag, dragRoomTo } = useFabric.getState();
    if (drag === null) return;
    // `e.point` is where the pointer's ray meets *this* plane, computed by the canvas's own
    // raycaster with the canvas's own camera — the one thing that cannot disagree with what the
    // operator sees.
    const point = { x: e.point.x, z: e.point.z };
    if (offset.current === null) offset.current = grabOffset(drag.position, point);
    const next = draggedPosition(point, offset.current);
    if (next.x !== drag.position.x || next.z !== drag.position.z) moved.current = true;
    dragRoomTo(next);
  }

  return (
    // The floor plane the drag is projected onto: mounted only while a drag is in progress, so at
    // every other moment it cannot swallow a click meant for the floor or a building. Invisible via
    // a fully transparent material rather than `visible={false}`, because an invisible object is not
    // a reliable raycast target.
    <mesh rotation-x={-Math.PI / 2} onPointerMove={onPointerMove}>
      <planeGeometry args={[FLOOR_SIZE, FLOOR_SIZE]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}
