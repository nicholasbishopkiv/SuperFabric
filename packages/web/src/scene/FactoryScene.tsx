import { MapControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { useFabric, useHasMotion } from "../store";
import { Buildings } from "./Buildings";
import { Conveyors } from "./Conveyor";
import { Floor } from "./Floor";
import { Packages } from "./Packages";
import { ISO_CAMERA_POSITION, ISO_ZOOM, ISO_ZOOM_MAX, ISO_ZOOM_MIN } from "./layout";

/**
 * The factory floor as an isometric plan view: an orthographic camera on the [24, 20, 24] diagonal
 * looking at the origin, with pan and zoom but deliberately no rotation — the operator reads a floor
 * plan, they do not fly a camera.
 *
 * The frameloop contract: `"demand"` while nothing moves, `"always"` only while `hasMotion` is true.
 * An idle factory must not burn a GPU, and a working one must animate; those are the only two states.
 */
export function FactoryScene() {
  const hasMotion = useHasMotion();

  return (
    <Canvas
      shadows
      frameloop={hasMotion ? "always" : "demand"}
      orthographic
      // near is negative on purpose: an orthographic camera looking down a diagonal would otherwise
      // clip the geometry standing between it and the origin.
      camera={{ position: [...ISO_CAMERA_POSITION], zoom: ISO_ZOOM, near: -200, far: 600 }}
      onCreated={({ camera }) => camera.lookAt(0, 0, 0)}
      style={{ position: "fixed", inset: 0, background: "#e9ecef" }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight
        position={[10, 18, 6]}
        intensity={1.5}
        castShadow
        shadow-mapSize={[2048, 2048]}
        // The default shadow frustum is a 10-unit box; the floor is 200 across, so it has to be
        // widened or buildings on the ring cast no shadow at all.
        shadow-camera-left={-60}
        shadow-camera-right={60}
        shadow-camera-top={60}
        shadow-camera-bottom={-60}
        shadow-camera-near={-100}
        shadow-camera-far={200}
      />
      <Floor />
      <Conveyors />
      <Buildings />
      <Packages />
      <MapControls
        makeDefault
        enableRotate={false}
        minZoom={ISO_ZOOM_MIN}
        maxZoom={ISO_ZOOM_MAX}
      />
      <RedrawOnStoreChange />
    </Canvas>
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

  useEffect(() => {
    invalidate();
  }, [invalidate, rooms, sessions, selectedRoomId, packages]);

  return null;
}
