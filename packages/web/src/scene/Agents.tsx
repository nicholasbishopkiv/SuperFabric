import type { RoomInfo } from "@superfabric/shared";
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import type { Group } from "three";
import {
  CapsuleGeometry,
  ConeGeometry,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  SphereGeometry,
} from "three";
import type { FactoryStatus } from "../store";
import { agentStatus, useRoomAgents } from "../store";
import { agentSlots } from "./layout";
import { BYPASS_COLOR, STATUS_COLOR } from "./palette";

/**
 * Geometries and materials are created **once for the whole factory**, not once per figure: eight
 * agents in a room must cost eight draw calls, not eight geometry allocations, and every figure of the
 * same status shares one material so three.js can batch them.
 */
const BODY_RADIUS = 0.22;
const BODY_LENGTH = 0.7;
/** Total height of the capsule, so the head can sit exactly on top of it. */
const BODY_HEIGHT = BODY_LENGTH + BODY_RADIUS * 2;
const HEAD_RADIUS = 0.22;

const BODY_GEOMETRY = new CapsuleGeometry(BODY_RADIUS, BODY_LENGTH, 4, 10);
const HEAD_GEOMETRY = new SphereGeometry(HEAD_RADIUS, 12, 10);
/** The bypass marker: a ring at the feet and a spike over the head. */
const RING_GEOMETRY = new RingGeometry(0.3, 0.42, 20);
const SPIKE_GEOMETRY = new ConeGeometry(0.1, 0.24, 8);

const BODY_MATERIALS: Record<FactoryStatus, MeshStandardMaterial> = {
  idle: new MeshStandardMaterial({ color: STATUS_COLOR.idle, roughness: 0.7 }),
  working: new MeshStandardMaterial({ color: STATUS_COLOR.working, roughness: 0.55 }),
  blocked: new MeshStandardMaterial({ color: STATUS_COLOR.blocked, roughness: 0.55 }),
  error: new MeshStandardMaterial({ color: STATUS_COLOR.error, roughness: 0.55 }),
};
/** Neutral, so the figure still reads as a figure rather than a coloured pill. */
const HEAD_MATERIAL = new MeshStandardMaterial({ color: "#ece5da", roughness: 0.8 });
/** Unlit on purpose: the ungated marker must be equally obvious on a shaded side of the floor. */
const BYPASS_MATERIAL = new MeshBasicMaterial({ color: BYPASS_COLOR });

/** Steps per second while working. Slow — this is a figure at a workbench, not a sprinter. */
const BOB_HZ = 1.5;
const BOB_HEIGHT = 0.11;
/** How far a working figure shuffles along the arc, in world units. */
const SHUFFLE = 0.3;

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
  x,
  z,
}: {
  id: string;
  status: FactoryStatus;
  bypass: boolean;
  x: number;
  z: number;
}) {
  const ref = useRef<Group>(null);
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
  });

  // Stopping work can happen on a frame that is never followed by another one, so the figure has to be
  // put back on its mark explicitly rather than drifting to a halt wherever the last frame left it.
  useEffect(() => {
    if (!working) ref.current?.position.set(x, 0, z);
  }, [working, x, z]);

  return (
    <group ref={ref} position={[x, 0, z]}>
      {/* No castShadow: a 1.5-unit figure inside a 120-unit shadow frustum contributes a couple of
          pixels, and N figures re-rendering the shadow map every frame is a real cost for it. */}
      <mesh geometry={BODY_GEOMETRY} material={BODY_MATERIALS[status]} position-y={BODY_HEIGHT / 2} />
      <mesh geometry={HEAD_GEOMETRY} material={HEAD_MATERIAL} position-y={BODY_HEIGHT + HEAD_RADIUS * 0.72} />
      {bypass && (
        <>
          <mesh
            geometry={RING_GEOMETRY}
            material={BYPASS_MATERIAL}
            rotation-x={-Math.PI / 2}
            position-y={0.04}
          />
          <mesh
            geometry={SPIKE_GEOMETRY}
            material={BYPASS_MATERIAL}
            position-y={BODY_HEIGHT + HEAD_RADIUS * 2 + 0.16}
          />
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
          x={slots[i][0]}
          z={slots[i][1]}
        />
      ))}
    </>
  );
});
