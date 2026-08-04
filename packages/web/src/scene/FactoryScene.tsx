import { MapControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useCallback, useEffect } from "react";
import { useFabric, useHasMotion } from "../store";
import { Buildings } from "./Buildings";
import { CameraFraming } from "./CameraFraming";
import { Conveyors } from "./Conveyor";
import { Floor } from "./Floor";
import { FactoryLights } from "./lighting";
import { Packages } from "./Packages";
import { RoomDrag } from "./RoomDrag";
import {
  CAMERA_FAR,
  CAMERA_NEAR,
  ISO_CAMERA_POSITION,
  ISO_ZOOM,
  ISO_ZOOM_MAX,
  ISO_ZOOM_MIN,
  MAX_POLAR_ANGLE,
  MIN_POLAR_ANGLE,
} from "./layout";
import { LIGHT } from "./palette";

/**
 * The factory floor. It **opens** as an isometric plan view — an orthographic camera on the
 * [24, 20, 24] diagonal looking at the origin — and from there the operator may pan, zoom, orbit and
 * tilt it however they like. `⤢ fit` (and `f`) is the way back to the opening view.
 *
 * The frameloop contract: `"demand"` while nothing moves, `"always"` only while `hasMotion` is true.
 * An idle factory must not burn a GPU, and a working one must animate; those are the only two states.
 * Camera input is the third thing that needs frames and is *not* motion in that sense — it is
 * covered by `invalidate()` on the controls' `change` event, one frame per change (see `Controls`).
 */
export function FactoryScene() {
  const hasMotion = useHasMotion();
  const selectRoom = useFabric((s) => s.selectRoom);

  return (
    <Canvas
      // "variance" is a VSM shadow map: blurred in the map, so the edges spread with distance from
      // the caster. See `lighting.tsx` for why this is not drei's <SoftShadows>.
      shadows="variance"
      frameloop={hasMotion ? "always" : "demand"}
      // A press that hit no building is a press on the floor, and that deselects. Buildings
      // `stopPropagation` on pointer-down, so this never fires for one of them.
      onPointerMissed={() => selectRoom(null)}
      orthographic
      // See CAMERA_NEAR/CAMERA_FAR: negative near, and a frustum deep enough to survive a camera
      // tilted almost to the horizon over a ground plane thousands of units across.
      camera={{ position: [...ISO_CAMERA_POSITION], zoom: ISO_ZOOM, near: CAMERA_NEAR, far: CAMERA_FAR }}
      onCreated={({ camera }) => camera.lookAt(0, 0, 0)}
      style={{ position: "fixed", inset: 0, background: LIGHT.backdrop }}
    >
      <FactoryLights />
      <Floor />
      <Conveyors />
      <Buildings />
      <Packages />
      <Controls />
      {/* After the controls, so `makeDefault` has already registered the controls both of these
          need: the drag has to silence them, and the framing has to notice the operator using them. */}
      <RoomDrag />
      <CameraFraming />
      <RedrawOnStoreChange />
    </Canvas>
  );
}

/**
 * The camera the operator drives: left-drag pans, wheel zooms, **right-drag (or two fingers) orbits
 * and tilts** — that mapping is `MapControls`' own, and it is why panning stays the primary gesture
 * on a floor plan while rotation is there when it is wanted.
 *
 * Two things here are load-bearing:
 *
 * - **`invalidate()` on every change.** `frameloop="demand"` renders nothing on its own, and camera
 *   input is not part of `hasMotion` — without a frame per change the floor would freeze under a
 *   drag and only catch up when something unrelated happened to need a frame. drei's `MapControls`
 *   already calls `invalidate()` in its own `change` handler; this passes it again through `onChange`
 *   so the contract is stated where the camera is configured rather than relied upon from a
 *   dependency's internals.
 * - **The polar clamp**, which is what stops an orbit from swinging under the floor.
 * - **Damping off**, which drei turns on by default. Two reasons, and the second is a real bug it
 *   causes here. First, inertia means every gesture keeps asking for frames for another second or
 *   so after the operator has let go — an animation nobody requested, on a canvas whose whole
 *   contract is that it renders when something needs it. Second, damping keeps the *unspent* part of
 *   a drag inside the controls: `update()` applies a fraction of it per frame. When the polar clamp
 *   stops the camera moving, `change` stops firing, the demand loop stops, and that remainder is
 *   never spent — so the next programmatic move (`⤢ fit`) has a whole tilt applied on top of it and
 *   the camera snaps straight back to the clamp. Observed, not theorised: fitting after tilting to
 *   the horizon left the camera at the horizon. Without damping every `update()` consumes the drag
 *   entirely, so there is no stale rotation for a fit to inherit.
 */
function Controls() {
  const invalidate = useThree((s) => s.invalidate);
  // Not `onChange={invalidate}`: the handler is called with the controls' event object, and
  // `invalidate(frames)` takes a number.
  const redraw = useCallback(() => invalidate(), [invalidate]);
  return (
    <MapControls
      makeDefault
      enableRotate
      enableDamping={false}
      minZoom={ISO_ZOOM_MIN}
      maxZoom={ISO_ZOOM_MAX}
      minPolarAngle={MIN_POLAR_ANGLE}
      maxPolarAngle={MAX_POLAR_ANGLE}
      onChange={redraw}
    />
  );
}

/**
 * `frameloop="demand"` renders only when something asks it to. React state changes that alter the
 * scene do ask (r3f invalidates on commit), but drei's `<Html>` positions and the occlusion test are
 * updated inside the render loop — so an explicit `invalidate()` after a store change is what stops a
 * new building's label from appearing one interaction late.
 */
function RedrawOnStoreChange() {
  const invalidate = useThree((s) => s.invalidate);
  const rooms = useFabric((s) => s.rooms);
  const sessions = useFabric((s) => s.sessions);
  const selectedRoomId = useFabric((s) => s.selectedRoomId);
  // `packages` matters in both directions: one frame to draw a new box at the start of its belt, and
  // one more after the last one is reaped to erase it — by then `hasMotion` is false again and the
  // loop is back on demand, so that final frame has to be asked for.
  const packages = useFabric((s) => s.packages);
  // The waiting markers are static by design (see `WaitingPackages`), so nothing else will ever ask
  // for the frame that draws a new one — or erases the one that just left on a belt.
  const waiting = useFabric((s) => s.waiting);

  useEffect(() => {
    invalidate();
  }, [invalidate, rooms, sessions, selectedRoomId, packages, waiting]);

  return null;
}
