import type { RoomInfo } from "@superfabric/shared";
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import type { Group } from "three";
import {
  BoxGeometry,
  ConeGeometry,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  SphereGeometry,
} from "three";
import type { FactoryStatus } from "../store";
import { agentStatus, useRoomAgents } from "../store";
import { agentFacing, agentSlots } from "./layout";
import { BYPASS_COLOR, DETAIL, FLOOR, PROJECT, STATUS_COLOR } from "./palette";

/**
 * A worker, in seven boxes and two spheres.
 *
 * The first pass was a capsule with a sphere on top, which from a fixed isometric camera reads as a
 * map pin: no shoulders, no front, no sense of which way it is facing. What a figure needs to stop
 * being a lollipop is a *waist* (two masses of different widths), *shoulders* (something wider than
 * the head, with arms hanging off it) and an *orientation*. All three are here and all of it is still
 * primitives — glTF characters are M5's.
 *
 * The status colour lives on the torso and nowhere else: a hi-viz vest is exactly the right metaphor
 * for "this is what this person's state is", and it keeps the loudest colour on the biggest facing
 * surface, where it is legible at low zoom. Trousers, arms, head and helmet are neutral, so the
 * figure still reads as a figure rather than as a coloured pill.
 *
 * Every geometry and every material is created **once for the whole factory**: eight agents in a room
 * must cost eight groups of draw calls, not eight geometry allocations, and every figure of the same
 * status shares one material so three.js can batch them.
 */
const LEG_HEIGHT = 0.46;
const TORSO_HEIGHT = 0.54;
const TORSO_TOP = LEG_HEIGHT + TORSO_HEIGHT;
const HEAD_RADIUS = 0.155;
const HEAD_Y = TORSO_TOP + HEAD_RADIUS + 0.03;
/** The top of the helmet: everything the bypass marker stacks above starts here. */
const CROWN_Y = HEAD_Y + HEAD_RADIUS + 0.1;

const LEGS_GEOMETRY = new BoxGeometry(0.34, LEG_HEIGHT, 0.24);
const TORSO_GEOMETRY = new BoxGeometry(0.44, TORSO_HEIGHT, 0.28);
/** A shoulder yoke: wider than the torso, so the silhouette has a top to it. */
const SHOULDER_GEOMETRY = new BoxGeometry(0.52, 0.1, 0.3);
const ARM_GEOMETRY = new BoxGeometry(0.1, 0.42, 0.13);
const HEAD_GEOMETRY = new SphereGeometry(HEAD_RADIUS, 12, 10);
/** A hard hat: the top half of a sphere, plus a brim, which is a helmet in two primitives. */
const HELMET_GEOMETRY = new SphereGeometry(0.175, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
const BRIM_GEOMETRY = new BoxGeometry(0.36, 0.045, 0.34);
/** The bypass marker: a ring at the feet and a spike over the head. */
const RING_GEOMETRY = new RingGeometry(0.3, 0.42, 20);
const SPIKE_GEOMETRY = new ConeGeometry(0.1, 0.24, 8);

/**
 * The orchestrator's marker: a standard on a mast, above everyone else's heads.
 *
 * **Shape, not a new colour.** The floor's colour vocabulary is spoken for — the four statuses,
 * bypass magenta, selection cyan — and adding a seventh meaning to it would cost more than it buys:
 * an operator who has to learn one more hue reads the four that matter more slowly. So the senior
 * agent is told apart by silhouette (the only figure with a standard) in colours the scene already
 * owns: the mast is the same grey metal as a roof vent, and the flag is `FLOOR.paint`, the bone
 * white of the painted markings on the slab, which is deliberately not safety yellow and means
 * nothing anywhere else.
 *
 * It is *carried*, at the figure's side rather than floating over its head: a pole rising from hand
 * height past the helmet, with the flag near its top. That keeps it attached to the body it belongs
 * to (a marker with a gap under it reads as a separate object), widens the silhouette — which is
 * what makes it legible at low zoom — and leaves the space directly above the head free, so a
 * bypass spike and a standard never grow through each other.
 */
const MAST_GEOMETRY = new BoxGeometry(0.05, 0.95, 0.05);
const STANDARD_GEOMETRY = new BoxGeometry(0.34, 0.22, 0.03);
/** Beside the right arm (`±0.27`), clear of the bypass spike, which stands at x = 0. */
const MAST_X = 0.32;
const MAST_FOOT_Y = LEG_HEIGHT + 0.5;
const MAST_CENTRE_Y = MAST_FOOT_Y + 0.475;
/** The flag flies from the top of the pole, hanging off it on one side. */
const STANDARD_Y = MAST_FOOT_Y + 0.79;
const STANDARD_X = MAST_X + 0.18;

/** The vest, and the only place an agent's status appears on its body. */
const VEST_MATERIALS: Record<FactoryStatus, MeshStandardMaterial> = {
  idle: new MeshStandardMaterial({ color: STATUS_COLOR.idle, roughness: 0.7 }),
  working: new MeshStandardMaterial({ color: STATUS_COLOR.working, roughness: 0.55 }),
  paused: new MeshStandardMaterial({ color: STATUS_COLOR.paused, roughness: 0.7 }),
  blocked: new MeshStandardMaterial({ color: STATUS_COLOR.blocked, roughness: 0.55 }),
  error: new MeshStandardMaterial({ color: STATUS_COLOR.error, roughness: 0.55 }),
};
/** Everything that is not the vest. Neutral, so the figure reads as a person wearing one. */
const TROUSER_MATERIAL = new MeshStandardMaterial({ color: "#3d4550", roughness: 0.85 });
const SLEEVE_MATERIAL = new MeshStandardMaterial({ color: "#4b5460", roughness: 0.8 });
const SKIN_MATERIAL = new MeshStandardMaterial({ color: "#e3c6a8", roughness: 0.85 });
const HELMET_MATERIAL = new MeshStandardMaterial({ color: "#eef0ee", roughness: 0.45 });
/**
 * The orchestrator's hat, in the project block's own eaves colour: it works in the central building
 * and wears headquarters' slate rather than a workshop's white. A second, quieter cue than the
 * standard — legible up close, where the standard is legible from across the floor.
 */
const ORCHESTRATOR_HELMET_MATERIAL = new MeshStandardMaterial({
  color: PROJECT.ridge,
  roughness: 0.45,
});
/** Unlit on purpose: the ungated marker must be equally obvious on a shaded side of the floor. */
const BYPASS_MATERIAL = new MeshBasicMaterial({ color: BYPASS_COLOR });
/**
 * The pole and the flag, both unlit for the same reason the bypass marker is: a marker that goes
 * dark on the shaded side of a building is a marker you have to hunt for. The pole is the scene's
 * grey plant metal, the flag the bone white of the painted markings on the slab.
 */
const MAST_MATERIAL = new MeshBasicMaterial({ color: DETAIL.vent });
const STANDARD_MATERIAL = new MeshBasicMaterial({ color: FLOOR.paint });

/** Steps per second while working. Slow — this is a figure at a workbench, not a sprinter. */
const BOB_HZ = 1.5;
const BOB_HEIGHT = 0.09;
/** How far a working figure shuffles along the arc, in world units. */
const SHUFFLE = 0.3;
/** How far the arms swing while working, in radians. */
const ARM_SWING = 0.5;

/** A stable per-agent phase offset, so a room full of working agents does not bob in lockstep. */
function phaseOf(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 1000;
  return (hash / 1000) * Math.PI * 2;
}

/**
 * One agent. Animates **only** while working, for the same reason the beacon does: `frameloop="demand"`
 * renders no frames otherwise, so an idle figure has to be genuinely still rather than nominally
 * animated. Its colour is its *own* status, not its room's — the whole point of a figure each is that
 * you can see which one of them is the one that is stuck.
 */
const AgentFigure = memo(function AgentFigure({
  id,
  status,
  bypass,
  orchestrator,
  x,
  z,
}: {
  id: string;
  status: FactoryStatus;
  bypass: boolean;
  /** This is the factory's senior agent. See `MAST_GEOMETRY` for why it is a shape and not a hue. */
  orchestrator: boolean;
  x: number;
  z: number;
}) {
  const ref = useRef<Group>(null);
  const leftArm = useRef<Group>(null);
  const rightArm = useRef<Group>(null);
  const working = status === "working";
  const phase = useMemo(() => phaseOf(id), [id]);
  // Shuffle along the arc's tangent, which for a point on a circle centred on the building is the
  // perpendicular to its own radius — so the figure paces across the front rather than into the wall.
  const radius = Math.hypot(x, z) || 1;
  const tangentX = -z / radius;
  const tangentZ = x / radius;

  useFrame(({ clock }) => {
    const group = ref.current;
    if (group === null || !working) return;
    const t = clock.elapsedTime * BOB_HZ * Math.PI + phase;
    group.position.y = Math.abs(Math.sin(t)) * BOB_HEIGHT;
    const along = Math.sin(t * 0.22) * SHUFFLE;
    group.position.x = x + tangentX * along;
    group.position.z = z + tangentZ * along;
    // Arms swing with the step, out of phase with each other. This is what makes the bob read as
    // walking rather than as a mesh being scaled up and down.
    const swing = Math.sin(t) * ARM_SWING;
    if (leftArm.current !== null) leftArm.current.rotation.x = swing;
    if (rightArm.current !== null) rightArm.current.rotation.x = -swing;
  });

  // Stopping work can happen on a frame that is never followed by another one, so the figure has to be
  // put back on its mark explicitly rather than drifting to a halt wherever the last frame left it.
  useEffect(() => {
    if (working) return;
    ref.current?.position.set(x, 0, z);
    if (leftArm.current !== null) leftArm.current.rotation.x = 0;
    if (rightArm.current !== null) rightArm.current.rotation.x = 0;
  }, [working, x, z]);

  const vest = VEST_MATERIALS[status];
  const helmet = orchestrator ? ORCHESTRATOR_HELMET_MATERIAL : HELMET_MATERIAL;

  return (
    <group ref={ref} position={[x, 0, z]}>
      {/* Faced outward from the building, so nobody has their back to the camera or their nose in
          the wall. The whole body turns, which is why this wraps everything below it. */}
      <group rotation-y={agentFacing(x, z)}>
        {/* No castShadow anywhere on a figure: a 1.5-unit body inside a 120-unit shadow frustum
            contributes a couple of pixels, and N figures re-rendering the shadow map every frame is
            a real cost for it. */}
        <mesh geometry={LEGS_GEOMETRY} material={TROUSER_MATERIAL} position-y={LEG_HEIGHT / 2} />
        <mesh geometry={TORSO_GEOMETRY} material={vest} position-y={LEG_HEIGHT + TORSO_HEIGHT / 2} />
        <mesh geometry={SHOULDER_GEOMETRY} material={vest} position-y={TORSO_TOP - 0.02} />

        {/* Arms pivot at the shoulder, which is why each is a group with the mesh hung below it. */}
        <group ref={leftArm} position={[-0.27, TORSO_TOP - 0.06, 0]}>
          <mesh geometry={ARM_GEOMETRY} material={SLEEVE_MATERIAL} position-y={-0.21} />
        </group>
        <group ref={rightArm} position={[0.27, TORSO_TOP - 0.06, 0]}>
          <mesh geometry={ARM_GEOMETRY} material={SLEEVE_MATERIAL} position-y={-0.21} />
        </group>

        <mesh geometry={HEAD_GEOMETRY} material={SKIN_MATERIAL} position-y={HEAD_Y} />
        <mesh geometry={HELMET_GEOMETRY} material={helmet} position-y={HEAD_Y - 0.02} />
        <mesh geometry={BRIM_GEOMETRY} material={helmet} position-y={HEAD_Y - 0.02} />

        {/* The standard is inside the facing group, so it turns with the figure and shows its face
            to the camera rather than its edge. */}
        {orchestrator && (
          <>
            <mesh
              geometry={MAST_GEOMETRY}
              material={MAST_MATERIAL}
              position={[MAST_X, MAST_CENTRE_Y, 0]}
            />
            <mesh
              geometry={STANDARD_GEOMETRY}
              material={STANDARD_MATERIAL}
              position={[STANDARD_X, STANDARD_Y, 0]}
            />
          </>
        )}
      </group>

      {bypass && (
        <>
          <mesh
            geometry={RING_GEOMETRY}
            material={BYPASS_MATERIAL}
            rotation-x={-Math.PI / 2}
            position-y={0.04}
          />
          <mesh geometry={SPIKE_GEOMETRY} material={BYPASS_MATERIAL} position-y={CROWN_Y + 0.16} />
        </>
      )}
    </group>
  );
});

/**
 * The agents standing in front of one building, on the arc `agentSlots` lays out. Subscribes to the
 * room's own sessions, so a status tick moves these figures and not the building behind them.
 */
export const Agents = memo(function Agents({
  roomId,
  kind,
}: {
  roomId: string;
  kind: RoomInfo["kind"];
}) {
  const agents = useRoomAgents(roomId);
  const slots = useMemo(() => agentSlots(agents.length, kind), [agents.length, kind]);

  return (
    <>
      {agents.map((agent, i) => (
        <AgentFigure
          key={agent.id}
          id={agent.id}
          status={agentStatus(agent)}
          bypass={agent.autonomy === "bypass"}
          orchestrator={agent.isOrchestrator}
          x={slots[i][0]}
          z={slots[i][1]}
        />
      ))}
    </>
  );
});
