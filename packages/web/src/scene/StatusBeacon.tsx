import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useRef } from "react";
import type { Group } from "three";
import type { FactoryStatus } from "../store";
import { STATUS_COLOR, STATUS_EMISSIVE } from "./palette";

/** Pulses per second while an agent in the room is working. Slow enough to read as breathing. */
const PULSE_HZ = 0.9;
const PULSE_MIN = 0.9;
const PULSE_MAX = 1.15;

/**
 * The lamp on top of a workshop: what the room is doing, readable from anywhere on the floor without
 * clicking anything. Colour comes from the shared palette, never from a hex written here.
 *
 * Motion is gated by the same contract as the canvas: it animates **only** while `working`, because
 * `frameloop="demand"` means no frames are rendered otherwise and an animation nobody renders is a
 * frozen mesh, not a subtle one. A `blocked` beacon is therefore bright and still — which is also the
 * right message: it is not making progress, it is waiting for you.
 */
export const StatusBeacon = memo(function StatusBeacon({
  status,
  y,
}: {
  status: FactoryStatus;
  y: number;
}) {
  const ref = useRef<Group>(null);
  const working = status === "working";
  const color = STATUS_COLOR[status];

  useFrame(({ clock }) => {
    const group = ref.current;
    if (group === null || !working) return;
    const phase = (Math.sin(clock.elapsedTime * PULSE_HZ * Math.PI * 2) + 1) / 2;
    group.scale.setScalar(PULSE_MIN + (PULSE_MAX - PULSE_MIN) * phase);
  });

  // Leaving `working` can happen on a frame that never renders again, so the scale has to be put
  // back explicitly rather than by the next tick of an animation that has stopped.
  useEffect(() => {
    if (!working) ref.current?.scale.setScalar(1);
  }, [working]);

  return (
    <group ref={ref} position-y={y}>
      <mesh>
        <sphereGeometry args={[0.28, 16, 12]} />
        {/* toneMapped={false} keeps the lamp at its palette colour instead of letting the renderer
            wash a bright emissive down towards white. */}
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={STATUS_EMISSIVE[status]}
          toneMapped={false}
        />
      </mesh>
      {/* A cheap halo: one transparent shell, no postprocessing, so the lamp reads as a light
          source rather than a painted ball. */}
      <mesh>
        <sphereGeometry args={[0.46, 16, 12]} />
        <meshBasicMaterial color={color} transparent opacity={status === "idle" ? 0.06 : 0.18} depthWrite={false} />
      </mesh>
      {/* The mast, so the lamp belongs to the building instead of floating over it. */}
      <mesh position-y={-0.62}>
        <cylinderGeometry args={[0.05, 0.05, 1.1, 6]} />
        <meshStandardMaterial color="#4a5158" />
      </mesh>
    </group>
  );
});
