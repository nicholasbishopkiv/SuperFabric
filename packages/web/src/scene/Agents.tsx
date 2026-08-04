import type { RoomInfo } from "@superfabric/shared";
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef } from "react";
import type { Group } from "three";
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
} from "three";
import type { Errand, FactoryStatus } from "../store";
import {
  agentStatus,
  useBeltDirections,
  useRoomAgents,
  useRoomErrandDirections,
  useRoomErrands,
} from "../store";
import { errandAt, fetchPath, pathLength, walkAt, type WalkPath } from "./errands";
import { agentFacing, agentSlots, bayForDirection } from "./layout";
import {
  BYPASS_COLOR,
  CARRIED,
  DETAIL,
  FLOOR,
  PACKAGE_COLORS,
  packageToneIndex,
  PROJECT,
  ROLE_HAT,
  STATUS_COLOR,
} from "./palette";
import { type CarryKind, type HatShape, roleLook } from "./roleLook";

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
 * **The role is the hat and the hand, never the vest.** A role that read as a status would make the
 * whole floor lie, so it is carried by silhouette (one hat shape and one carried tool per work
 * family) and by value (five neutral hat colours under 15% saturation), with not one new hue on the
 * floor. `roleLook.ts` holds the table and the argument for it.
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
/**
 * The other four hats. See `roleLook.ts` for what each says; here they are three primitives at most,
 * because the whole point of carrying the role on a *shape* is that the shape has to survive being
 * twelve pixels across.
 */
/** A flat-topped bump cap, and the wider brim that goes with it. */
const FLAT_CROWN_GEOMETRY = new CylinderGeometry(0.172, 0.178, 0.11, 12);
const WIDE_BRIM_GEOMETRY = new BoxGeometry(0.44, 0.04, 0.42);
/** A peak at the front only, which is what turns a dome into a cap rather than a helmet. */
const PEAK_GEOMETRY = new BoxGeometry(0.28, 0.038, 0.2);
/** An ear defender. Two of these are the widest hat on the floor, and read as plant from far away. */
const MUFF_GEOMETRY = new BoxGeometry(0.075, 0.14, 0.13);
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
/**
 * One material per hat colour, for the whole factory — the five role neutrals plus the
 * orchestrator's. Keyed by the hex so `roleLook` can hand back a colour rather than a material and
 * still cost no allocation: eleven role looks across N agents must be N groups of draw calls, not N
 * materials, and every figure wearing the same hat batches with the others.
 */
const HAT_MATERIALS: Record<string, MeshStandardMaterial> = Object.fromEntries(
  [...new Set([...Object.values(ROLE_HAT), PROJECT.ridge])].map((hex) => [
    hex,
    new MeshStandardMaterial({ color: hex, roughness: 0.45 }),
  ]),
);
/** The hat every figure wore before roles existed, and what an unknown role still gets. */
const HELMET_MATERIAL = HAT_MATERIALS[ROLE_HAT.white];
/**
 * The orchestrator's hat, in the project block's own eaves colour: it works in the central building
 * and wears headquarters' slate rather than a workshop's white. A second, quieter cue than the
 * standard — legible up close, where the standard is legible from across the floor.
 *
 * It **outranks the role's own hat value**, and keeps the role's *shape*: which agent is senior is a
 * fact about the whole factory, and the shape still says what kind of work it does.
 */
const ORCHESTRATOR_HELMET_MATERIAL = HAT_MATERIALS[PROJECT.ridge];

// ---- what a role carries ------------------------------------------------------------------------
//
// Five tools, one per work family, all in neutrals the floor already owns (`CARRIED`): the tool's job
// is to change a silhouette, and one that also introduced a colour would be paying twice over for a
// single reading. Every geometry and material here is created once for the factory.

const TOOL_METAL = new MeshStandardMaterial({ color: CARRIED.metal, roughness: 0.45, metalness: 0.5 });
const TOOL_PALE = new MeshStandardMaterial({ color: CARRIED.pale, roughness: 0.8 });
const TOOL_DARK = new MeshStandardMaterial({ color: CARRIED.dark, roughness: 0.7 });

/** A rolled drawing, tucked under the arm: the planner's tool. */
const ROLL_GEOMETRY = new CylinderGeometry(0.045, 0.045, 0.52, 8);
/** A spanner: a shaft and a head. The builder's. */
const SPANNER_SHAFT_GEOMETRY = new BoxGeometry(0.055, 0.32, 0.045);
const SPANNER_HEAD_GEOMETRY = new BoxGeometry(0.13, 0.085, 0.055);
/** A magnifier: a ring on a handle. The checker's. */
const LENS_RING_GEOMETRY = new TorusGeometry(0.085, 0.019, 6, 14);
const LENS_HANDLE_GEOMETRY = new BoxGeometry(0.035, 0.16, 0.035);
/** A clipboard and its clip. The writer's. */
const CLIPBOARD_GEOMETRY = new BoxGeometry(0.24, 0.32, 0.025);
const CLIP_GEOMETRY = new BoxGeometry(0.17, 0.045, 0.04);
/** A valve handwheel. The operator's, and the roundest thing on any figure. */
const VALVE_GEOMETRY = new TorusGeometry(0.105, 0.026, 6, 16);

/**
 * Where a tool is carried: at the **left** side, at hip height.
 *
 * Not the right, and that is a collision rather than a preference — the right hand holds the crate on
 * an errand (`CARRIED_POSITION`) and the orchestrator's mast stands at `MAST_X`. On the body rather
 * than on the arm group, like the crate, so a swinging arm never swings a spanner through a torso.
 */
const TOOL_POSITION: readonly [number, number, number] = [-0.36, LEG_HEIGHT + 0.24, 0.06];
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

/**
 * How far the figure travels per step while walking a path, in world units.
 *
 * This is what makes a walk a walk rather than a slide: the bob and the arm swing are driven by
 * **distance covered**, not by the wall clock, so the feet keep up with the ground however long or
 * short the route is. A fixed-frequency bob over a variable-length path is exactly the moonwalk this
 * avoids.
 */
const STRIDE = 0.62;

/**
 * The yaw at which a figure faces the operator: the default camera stands on the `+x/+z` diagonal, and
 * a figure's front is its local `+z`, so this is `atan2(1, 1)`.
 *
 * Used for `blocked` and nothing else. A blocked agent has to read as *waiting on you* rather than as
 * quiet, and the cue is deliberately not a colour (it already has amber) or a motion (it is stopped):
 * it turns to face the camera and holds its hands out, which no other state does. It works from the
 * default view, which is the one an operator reads a stuck factory from.
 */
const CAMERA_FACING_YAW = Math.PI / 4;

/**
 * How far a blocked figure holds its arms **out from its sides**, in radians.
 *
 * Sideways rather than forward, and that is a measurement rather than a preference: swung forward,
 * the arms project straight onto the torso from a camera 32° above the horizon and the pose is
 * invisible at any zoom the operator actually uses. Held out, they *widen the silhouette*, which is
 * the one thing that survives a figure being forty pixels tall — the same reason the orchestrator's
 * standard is carried at its side rather than floated over its head.
 */
const WAITING_ARMS = 0.5;

/** A stable per-agent phase offset, so a room full of working agents does not bob in lockstep. */
function phaseOf(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 1000;
  return (hash / 1000) * Math.PI * 2;
}

/**
 * The crate an agent carries home from the bay. Deliberately the **same** cardboard as the box that
 * rode the belt (and one material per tone, so the four share draw calls), a little smaller so it
 * reads as being held rather than as standing on the figure.
 */
const CARRIED_GEOMETRY = new BoxGeometry(0.4, 0.4, 0.4);
const CARRIED_MATERIALS = PACKAGE_COLORS.map(
  (hex) => new MeshStandardMaterial({ color: hex, roughness: 0.7 }),
);
/** At the right hand, hanging just clear of the hip and slightly in front of the body. */
const CARRIED_POSITION: readonly [number, number, number] = [0.36, LEG_HEIGHT + 0.22, 0.08];
/** The arm that holds it stays down and a little back, so the crate looks gripped, not balanced. */
const CARRY_ARM = 0.22;

/**
 * The hat, in one of five silhouettes. Sits at the same height whatever the shape, so a room of
 * different roles reads as a row of people and not as a row of different-sized people.
 */
function Hat({ shape, material }: { shape: HatShape; material: MeshStandardMaterial }) {
  const y = HEAD_Y - 0.02;
  switch (shape) {
    case "hard":
      return (
        <>
          <mesh geometry={HELMET_GEOMETRY} material={material} position-y={y} />
          <mesh geometry={BRIM_GEOMETRY} material={material} position-y={y} />
        </>
      );
    case "flat":
      return (
        <>
          <mesh geometry={FLAT_CROWN_GEOMETRY} material={material} position-y={y + 0.075} />
          <mesh geometry={WIDE_BRIM_GEOMETRY} material={material} position-y={y + 0.01} />
        </>
      );
    case "visor":
      return (
        <>
          <mesh geometry={HELMET_GEOMETRY} material={material} position-y={y} scale-y={0.86} />
          {/* Front only: a peak all the way round would be the hard hat again. */}
          <mesh geometry={PEAK_GEOMETRY} material={material} position={[0, y + 0.01, 0.17]} />
        </>
      );
    case "soft":
      // The same dome, squashed and a little wider than the head it sits on: a soft cap has no brim
      // and sits low, which is most of what tells it from a helmet — but without the overhang it
      // reads as a bare head at working zoom, which was visible in the first screenshot of it.
      return <mesh geometry={HELMET_GEOMETRY} material={material} position-y={y} scale={[1.14, 0.68, 1.14]} />;
    case "muffs":
      return (
        <>
          <mesh geometry={HELMET_GEOMETRY} material={material} position-y={y} />
          <mesh geometry={BRIM_GEOMETRY} material={material} position-y={y} />
          {/* The defenders themselves are plant metal, not hat: they are equipment, and the contrast
              is what makes the widened silhouette read as two objects rather than as a fat head. */}
          <mesh geometry={MUFF_GEOMETRY} material={TOOL_METAL} position={[-0.175, y - 0.05, 0]} />
          <mesh geometry={MUFF_GEOMETRY} material={TOOL_METAL} position={[0.175, y - 0.05, 0]} />
        </>
      );
  }
}

/** What the figure carries at its left side. `none` draws nothing at all — see `CarryKind`. */
function CarriedTool({ carry }: { carry: CarryKind }) {
  if (carry === "none") return null;
  return (
    <group position={TOOL_POSITION}>
      {carry === "roll" && (
        // Tilted, so it reads as tucked under an arm rather than as a pipe standing beside a leg.
        <mesh geometry={ROLL_GEOMETRY} material={TOOL_PALE} rotation={[0.24, 0, 0.42]} />
      )}
      {carry === "spanner" && (
        <>
          <mesh geometry={SPANNER_SHAFT_GEOMETRY} material={TOOL_METAL} />
          <mesh geometry={SPANNER_HEAD_GEOMETRY} material={TOOL_METAL} position-y={0.17} />
        </>
      )}
      {carry === "lens" && (
        <>
          <mesh geometry={LENS_RING_GEOMETRY} material={TOOL_METAL} position-y={0.13} />
          <mesh geometry={LENS_HANDLE_GEOMETRY} material={TOOL_DARK} />
        </>
      )}
      {carry === "clipboard" && (
        <>
          {/* Turned a few degrees out of the body, so the board has a face from the camera's side. */}
          <mesh geometry={CLIPBOARD_GEOMETRY} material={TOOL_PALE} rotation-y={-0.5} />
          <mesh geometry={CLIP_GEOMETRY} material={TOOL_METAL} position-y={0.15} rotation-y={-0.5} />
        </>
      )}
      {carry === "valve" && (
        <mesh geometry={VALVE_GEOMETRY} material={TOOL_METAL} rotation={[0, Math.PI / 2, 0.2]} />
      )}
    </group>
  );
}

/** One agent's walk to a bay and back: the clock the store fixed, and the route it implies. */
interface Fetch {
  errand: Errand;
  path: WalkPath;
}

/**
 * One agent, doing one of four things.
 *
 * - **Fetching** (`fetch` is set) — walking a path from its post to the loading bay a belt arrives at,
 *   facing the direction of travel, and carrying the crate home at its side. The bob and the arm swing
 *   are the same two lines as the working shuffle, driven along the path (see `STRIDE`).
 * - **Working** — the shuffle and swing in place at its post.
 * - **Blocked** — turned to the operator, hands out, and completely still.
 * - **Anything else** — on its mark, facing out of its building, still.
 *
 * Animation happens **only** in the first two, for the same reason the beacon's does:
 * `frameloop="demand"` renders no frames otherwise, so an idle figure has to be genuinely still rather
 * than nominally animated. Its colour is its *own* status, not its room's — the whole point of a
 * figure each is that you can see which one of them is the one that is stuck.
 */
const AgentFigure = memo(function AgentFigure({
  id,
  status,
  roleId,
  bypass,
  orchestrator,
  x,
  z,
  fetch,
}: {
  id: string;
  status: FactoryStatus;
  /**
   * What this agent arrived as, or `null` for a plain one. Carried on the hat and in the hand and
   * **never on the vest** — see `roleLook.ts` for why a role is a shape rather than a colour.
   */
  roleId: string | null;
  bypass: boolean;
  /** This is the factory's senior agent. See `MAST_GEOMETRY` for why it is a shape and not a hue. */
  orchestrator: boolean;
  x: number;
  z: number;
  /** This agent has been sent to a bay to meet a crate, or `undefined` if it is at its post. */
  fetch?: Fetch;
}) {
  const ref = useRef<Group>(null);
  const body = useRef<Group>(null);
  const leftArm = useRef<Group>(null);
  const rightArm = useRef<Group>(null);
  const crate = useRef<Group>(null);
  const working = status === "working";
  const blocked = status === "blocked";
  const phase = useMemo(() => phaseOf(id), [id]);
  // Shuffle along the arc's tangent, which for a point on a circle centred on the building is the
  // perpendicular to its own radius — so the figure paces across the front rather than into the wall.
  const radius = Math.hypot(x, z) || 1;
  const tangentX = -z / radius;
  const tangentZ = x / radius;
  const walkLength = useMemo(() => (fetch === undefined ? 0 : pathLength(fetch.path)), [fetch]);
  // Where the figure stands and which way it looks when nothing is animating it.
  const restYaw = blocked ? CAMERA_FACING_YAW : agentFacing(x, z);

  useFrame(({ clock }) => {
    const group = ref.current;
    if (group === null) return;

    if (fetch !== undefined) {
      // Wall clock, not accumulated frame deltas: the errand's whole schedule is absolute, so a walk
      // is exactly where it should be even after the tab rendered no frames at all.
      const { phase: leg, t, carrying } = errandAt(fetch.errand, Date.now());
      const step = walkAt(fetch.path, t);
      // A step cycle per `STRIDE` of ground covered, so the feet match the distance.
      const walked = t * walkLength;
      const cycle = leg === "out" || leg === "back" ? (walked / STRIDE) * Math.PI : 0;
      group.position.set(step.x, Math.abs(Math.sin(cycle)) * BOB_HEIGHT, step.z);
      // Facing the way it is going — and, once it has stopped at the bay, still facing the bay,
      // because that is the direction the last segment of the walk pointed in.
      if (body.current !== null) body.current.rotation.y = step.yaw;
      const swing = Math.sin(cycle) * ARM_SWING;
      if (leftArm.current !== null) leftArm.current.rotation.set(swing, 0, 0);
      // The carrying arm stays down: one hand holds the crate, the other still swings.
      if (rightArm.current !== null) rightArm.current.rotation.set(carrying ? CARRY_ARM : -swing, 0, 0);
      if (crate.current !== null) crate.current.visible = carrying;
      return;
    }

    if (!working) return;
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

  // Stopping work — or finishing an errand — can happen on a frame that is never followed by another
  // one, so the figure has to be put back on its mark explicitly rather than drifting to a halt
  // wherever the last frame left it. The yaw is restored here too: `rotation-y` is a declarative prop
  // that React will not rewrite unless its value changed, and the frame loop has been mutating it.
  useEffect(() => {
    if (working || fetch !== undefined) return;
    ref.current?.position.set(x, 0, z);
    if (body.current !== null) body.current.rotation.y = restYaw;
    const splay = blocked ? WAITING_ARMS : 0;
    if (leftArm.current !== null) leftArm.current.rotation.set(0, 0, splay);
    if (rightArm.current !== null) rightArm.current.rotation.set(0, 0, -splay);
    if (crate.current !== null) crate.current.visible = false;
  }, [working, blocked, fetch, x, z, restYaw]);

  const vest = VEST_MATERIALS[status];
  const look = roleLook(roleId);
  // The role decides the hat's shape; seniority overrules its colour and nothing else.
  const helmet = orchestrator
    ? ORCHESTRATOR_HELMET_MATERIAL
    : (HAT_MATERIALS[look.color] ?? HELMET_MATERIAL);
  const splay = blocked ? WAITING_ARMS : 0;

  return (
    <group ref={ref} position={[x, 0, z]}>
      {/* Faced outward from the building, so nobody has their back to the camera or their nose in
          the wall — except a blocked figure, which turns to the operator. The whole body turns, which
          is why this wraps everything below it. */}
      <group ref={body} rotation-y={restYaw}>
        {/* No castShadow anywhere on a figure: a 1.5-unit body inside a 120-unit shadow frustum
            contributes a couple of pixels, and N figures re-rendering the shadow map every frame is
            a real cost for it. */}
        <mesh geometry={LEGS_GEOMETRY} material={TROUSER_MATERIAL} position-y={LEG_HEIGHT / 2} />
        <mesh geometry={TORSO_GEOMETRY} material={vest} position-y={LEG_HEIGHT + TORSO_HEIGHT / 2} />
        <mesh geometry={SHOULDER_GEOMETRY} material={vest} position-y={TORSO_TOP - 0.02} />

        {/* Arms pivot at the shoulder, which is why each is a group with the mesh hung below it. */}
        <group ref={leftArm} position={[-0.27, TORSO_TOP - 0.06, 0]} rotation-z={splay}>
          <mesh geometry={ARM_GEOMETRY} material={SLEEVE_MATERIAL} position-y={-0.21} />
        </group>
        <group ref={rightArm} position={[0.27, TORSO_TOP - 0.06, 0]} rotation-z={-splay}>
          <mesh geometry={ARM_GEOMETRY} material={SLEEVE_MATERIAL} position-y={-0.21} />
        </group>

        {/* The crate, on the return leg only — mounted for the whole errand and made visible when the
            box is actually in hand, so no mesh is created or destroyed mid-walk. */}
        {fetch !== undefined && (
          <group ref={crate} visible={false} position={CARRIED_POSITION}>
            <mesh
              geometry={CARRIED_GEOMETRY}
              material={CARRIED_MATERIALS[packageToneIndex(fetch.errand.crateId)]}
            />
          </group>
        )}

        {/* The role, in the hand: five tools, one per work family, and the same vocabulary the room's
            props are drawn from. Inside the facing group so it turns with the body. */}
        <CarriedTool carry={look.carry} />

        <mesh geometry={HEAD_GEOMETRY} material={SKIN_MATERIAL} position-y={HEAD_Y} />
        {/* The role, on the head: a silhouette per work family in one of five neutral values. It is
            emphatically **not** a status — see `ROLE_HAT` for why there is no hue left to spend. */}
        <Hat shape={look.shape} material={helmet} />

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
 *
 * It also resolves this room's errands into routes. **Which** agent goes and **when** it leaves are
 * the store's (`scheduleErrands`, so a re-render cannot swap two agents mid-walk); the *route* is
 * derived here from the same three pure functions the store used, so the two can never disagree about
 * where the walk goes.
 */
export const Agents = memo(function Agents({
  roomId,
  kind,
}: {
  roomId: string;
  kind: RoomInfo["kind"];
}) {
  const agents = useRoomAgents(roomId);
  const errands = useRoomErrands(roomId);
  // Which way each errand's crate came from, and which way this room's belts leave: between them they
  // say which of the drawn doors the agent is walking to. Flat numbers — see `useBeltDirections`.
  const errandDirections = useRoomErrandDirections(roomId);
  const beltDirections = useBeltDirections(roomId);
  const slots = useMemo(() => agentSlots(agents.length, kind), [agents.length, kind]);

  const fetches = useMemo(() => {
    const byAgent = new Map<string, Fetch>();
    for (const [i, errand] of errands.entries()) {
      const index = agents.findIndex((a) => a.id === errand.agentId);
      const post = slots[index];
      // An errand whose agent has since left the room has nobody to walk it; `reapErrands` drops it
      // when its clock runs out, and until then nothing is drawn.
      if (post === undefined) continue;
      const bay = bayForDirection(
        kind,
        beltDirections,
        errandDirections[i * 2] ?? 0,
        errandDirections[i * 2 + 1] ?? 0,
      );
      if (bay === undefined) continue;
      byAgent.set(errand.agentId, { errand, path: fetchPath(kind, post, bay) });
    }
    return byAgent;
  }, [errands, errandDirections, beltDirections, agents, slots, kind]);

  return (
    <>
      {agents.map((agent, i) => (
        <AgentFigure
          key={agent.id}
          id={agent.id}
          status={agentStatus(agent)}
          roleId={agent.roleId}
          bypass={agent.autonomy === "bypass"}
          orchestrator={agent.isOrchestrator}
          x={slots[i][0]}
          z={slots[i][1]}
          fetch={fetches.get(agent.id)}
        />
      ))}
    </>
  );
});
