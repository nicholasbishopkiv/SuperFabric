import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useRef } from "react";
import type { Group } from "three";
import { AdditiveBlending, CanvasTexture, Euler, PlaneGeometry, SRGBColorSpace } from "three";
import type { FactoryStatus } from "../store";
import { ISO_CAMERA_POSITION } from "./layout";
import { STATUS_COLOR, STATUS_EMISSIVE } from "./palette";

/** Pulses per second while an agent in the room is working. Slow enough to read as breathing. */
const PULSE_HZ = 0.9;
const PULSE_MIN = 0.9;
const PULSE_MAX = 1.15;

/**
 * A soft radial falloff, drawn once into a 64px canvas and shared by every beacon on the floor. This
 * is what turns the lamp from a painted dot into something that looks like it is *emitting*: a hard
 * sphere has an edge, and light does not.
 *
 * Built here rather than shipped as an asset because it is eight lines of arithmetic, and an image
 * request for a gradient is a request too many for a tool that runs on localhost.
 */
function glowTexture(): CanvasTexture | null {
  // jsdom has a `document` but no 2D context; the scene never mounts there, so degrade quietly.
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.28, "rgba(255,255,255,0.55)");
  gradient.addColorStop(0.62, "rgba(255,255,255,0.14)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

const GLOW_TEXTURE = glowTexture();
const GLOW_GEOMETRY = new PlaneGeometry(1, 1);

/**
 * The orientation that makes a plane face the camera.
 *
 * A `<Billboard>` would recompute this every frame, and every frame is exactly what
 * `frameloop="demand"` does not render. It does not need recomputing: rotation is disabled on the
 * controls, so the camera's orientation is a constant of the scene and this can be worked out once
 * from where it stands. `YXZ` order so the yaw is applied *after* the pitch, which is what makes the
 * plane's normal come out along the camera direction.
 */
const BILLBOARD = new Euler(
  -Math.atan2(ISO_CAMERA_POSITION[1], Math.hypot(ISO_CAMERA_POSITION[0], ISO_CAMERA_POSITION[2])),
  Math.atan2(ISO_CAMERA_POSITION[0], ISO_CAMERA_POSITION[2]),
  0,
  "YXZ",
);

/** How wide the glow is, and how bright, per status. `idle` is a lamp that is on but not saying much. */
const GLOW_SIZE: Record<FactoryStatus, number> = { idle: 1.5, working: 2.6, blocked: 3, error: 3 };
const GLOW_OPACITY: Record<FactoryStatus, number> = { idle: 0.18, working: 0.6, blocked: 0.75, error: 0.75 };

/**
 * The lamp on top of a workshop: what the room is doing, readable from anywhere on the floor without
 * clicking anything. Colour comes from the shared palette, never from a hex written here.
 *
 * Motion is gated by the same contract as the canvas: it animates **only** while `working`, because
 * `frameloop="demand"` means no frames are rendered otherwise and an animation nobody renders is a
 * frozen mesh, not a subtle one. A `blocked` beacon is therefore bright and still — which is also the
 * right message: it is not making progress, it is waiting for you.
 *
 * The halo is a camera-facing additive quad rather than bloom. Bloom is an `EffectComposer` pass over
 * the whole frame and a ~200 kB dependency, to brighten a handful of pixels that are already the
 * brightest thing on screen; a shared 64px gradient does the same job for one draw call and no
 * frames.
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
      {/* A tight shell right against the bulb, so the lamp has a corona and not just a rim. */}
      <mesh>
        <sphereGeometry args={[0.42, 16, 12]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={status === "idle" ? 0.07 : 0.2}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      {/* The glow proper: additive, so it brightens whatever is behind it instead of tinting it. */}
      {GLOW_TEXTURE !== null && (
        <mesh geometry={GLOW_GEOMETRY} rotation={BILLBOARD} scale={GLOW_SIZE[status]}>
          <meshBasicMaterial
            map={GLOW_TEXTURE}
            color={color}
            transparent
            opacity={GLOW_OPACITY[status]}
            blending={AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      )}
      {/* The mast, so the lamp belongs to the building instead of floating over it. */}
      <mesh position-y={-0.62}>
        <cylinderGeometry args={[0.05, 0.05, 1.1, 6]} />
        <meshStandardMaterial color="#4a5158" roughness={0.5} metalness={0.4} />
      </mesh>
    </group>
  );
});
