import { Html } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { memo, useMemo } from "react";
import { BackSide } from "three";
import {
  useBeltDirections,
  useFabric,
  useIsSelected,
  useRoom,
  useRoomAgentCount,
  useRoomHasOrchestrator,
  useRoomPosition,
  useRoomStatus,
} from "../store";
import { Agents } from "./Agents";
import {
  BAY_WIDTH,
  beaconHeight,
  buildingSize,
  labelHeight,
  loadingBays,
  PROJECT_ROOF_HEIGHT,
  ROOM_ROOF_THICKNESS,
} from "./layout";
import { DETAIL, PROJECT, ROOM, roomAccent, SANDBOX_COLOR, SELECT_COLOR } from "./palette";
import { StatusBeacon } from "./StatusBeacon";

const LABEL_COLOR = "#1c1c1c";

/**
 * The word "orchestrator" on a building's label, in the project block's own wall colour — the same
 * slate the label's left stripe already uses for the central building, so the mark belongs to
 * headquarters rather than introducing a colour of its own. (The label sits on white, so the *dark*
 * end of the palette is what is legible here; the figure's standard is the light end, on the floor.)
 */
const ORCHESTRATOR_LABEL_COLOR = PROJECT.wall;

/**
 * How far outside the building the selection rim is drawn. Small: a rim is a rim, and a thick one
 * turns the building back into a coloured blob.
 */
const RIM_SCALE = 1.028;

/** The skirt at a building's base: this much wider than the walls, and this tall. */
const PLINTH_OVERHANG = 0.5;
const PLINTH_HEIGHT = 0.4;

/**
 * One building on the floor, procedural and low-poly: no assets, no loading. Memoized and
 * subscribing to its own room row, so a status tick or a sibling moving re-renders this component
 * only when *this* room changed.
 *
 * The detail on it is deliberately made of nothing but boxes and one cone. A building has a plinth,
 * a painted band in its own accent colour, glazing with the lights on behind it, roof plant, and a
 * recessed loading bay on **each wall a belt actually arrives at** — which is the one that mattered
 * most: before it, a package travelled a conveyor and slid into a featureless slab.
 */
export const Building = memo(function Building({ roomId }: { roomId: string }) {
  const room = useRoom(roomId);
  // Not `room.position`: while this building is being dragged, the operator's pointer owns where it
  // stands and the server's last broadcast does not. `RoomDrag` explains why.
  const position = useRoomPosition(roomId);
  const agents = useRoomAgentCount(roomId);
  const status = useRoomStatus(roomId);
  const selected = useIsSelected(roomId);
  // Which building has the senior agent is a fact about the *factory*, so the label says it in words
  // as well: the standard on the figure answers "which one of them", the label answers "does this
  // factory have one at all" from a screenshot, with no figure to squint at.
  const hasOrchestrator = useRoomHasOrchestrator(roomId);
  const beltDirections = useBeltDirections(roomId);
  const selectRoom = useFabric((s) => s.selectRoom);
  const beginRoomDrag = useFabric((s) => s.beginRoomDrag);

  const kind = room?.kind;
  const bays = useMemo(
    () => (kind === undefined ? [] : loadingBays(kind, beltDirections)),
    [kind, beltDirections],
  );
  // Stable per name, so a department keeps its colour across reloads and machines.
  const accent = useMemo(() => roomAccent(room?.name ?? ""), [room?.name]);

  // The room list can drop a row (a rebuild from the server) while this component is still mounted.
  if (room === undefined || position === undefined || kind === undefined) return null;

  /**
   * Pointer-down does two things and starts a third: it selects the building (which the room panel
   * reads too), and it opens a drag that `RoomDrag` finishes. `stopPropagation` keeps the press off
   * every other building the ray passed through — and off the canvas's `onPointerMissed`, which
   * would otherwise deselect the room the press just selected.
   */
  const onPointerDown = (e: ThreeEvent<PointerEvent>): void => {
    e.stopPropagation();
    selectRoom(roomId);
    beginRoomDrag(roomId, position);
  };

  const isProject = kind === "project";
  const { width, height } = buildingSize(kind);
  const shell = isProject ? PROJECT : ROOM;
  // The project block is headquarters and wears no department colour; a workshop's trim is its own.
  const trim = isProject ? PROJECT.ridge : accent.band;
  const trimDeep = isProject ? PROJECT.roof : accent.deep;

  return (
    <group position={[position.x, 0, position.z]} onPointerDown={onPointerDown}>
      {/* The skirt the mass stands on, so the building meets the concrete instead of floating on it. */}
      <mesh castShadow receiveShadow position-y={PLINTH_HEIGHT / 2}>
        <boxGeometry args={[width + PLINTH_OVERHANG, PLINTH_HEIGHT, width + PLINTH_OVERHANG]} />
        <meshStandardMaterial color={shell.plinth} roughness={0.9} />
      </mesh>

      <mesh castShadow receiveShadow position-y={height / 2}>
        <boxGeometry args={[width, height, width]} />
        <meshStandardMaterial color={shell.wall} roughness={0.78} />
      </mesh>

      {/* The painted band: a workshop's identity, and the only place its accent colour appears at
          any size. A hair wider than the walls so the two are never fighting for the same pixels. */}
      <mesh position-y={height - 0.55}>
        <boxGeometry args={[width + 0.05, 0.34, width + 0.05]} />
        <meshStandardMaterial color={trim} roughness={0.7} />
      </mesh>

      {/* Glazing, on the two walls the fixed camera can see. Faintly lit from inside — a factory
          with the lights on. The glow is constant: decoration must never imply a status. */}
      {([[0, 1], [1, 0]] as const).map(([ax, az], i) => (
        <mesh
          key={i}
          position={[ax * (width / 2 + 0.03), height * 0.55, az * (width / 2 + 0.03)]}
          rotation-y={ax === 1 ? Math.PI / 2 : 0}
        >
          <boxGeometry args={[width * 0.56, isProject ? 0.7 : 0.5, 0.06]} />
          <meshStandardMaterial
            color={DETAIL.window}
            emissive={DETAIL.windowGlow}
            emissiveIntensity={DETAIL.windowGlowIntensity}
            roughness={0.25}
            metalness={0.1}
          />
        </mesh>
      ))}

      {isProject ? <ProjectRoof width={width} height={height} /> : <RoomRoof width={width} height={height} />}

      {bays.map((bay, i) => (
        <group key={i} position={[bay.x, 0, bay.z]} rotation-y={bay.yaw}>
          <LoadingBayMesh frame={isProject ? PROJECT.ridge : accent.light} canopy={trimDeep} />
        </group>
      ))}

      <StatusBeacon status={status} y={beaconHeight(kind)} />

      {/* Figures stand at the project block too, not only at the workshops: an agent created in the
          project room is a real agent, and a floor that hid it would be lying about what is running. */}
      <Agents roomId={roomId} kind={kind} />

      {selected && <SelectionRim width={width} height={height} />}

      {/*
        No `distanceFactor`: on an *orthographic* camera drei multiplies the label's scale by
        `camera.zoom`, which at zoom 38 blows a 13px label up 1140× and covers the whole floor with a
        white rectangle. A constant screen-space size is also the right behaviour for a plan view —
        the label stays exactly as readable at every zoom level, which is what the factor was for.
      */}
      <Html position={[0, labelHeight(kind), 0]} center occlude>
        <div
          style={{
            font: "600 13px system-ui, sans-serif",
            color: LABEL_COLOR,
            background: "rgba(255,255,255,0.88)",
            // Four sides rather than `border` plus `borderLeft`: React warns (correctly) that mixing
            // a shorthand with one of its longhands re-renders unpredictably.
            borderTop: `1px solid ${selected ? SELECT_COLOR : "#c3c9ce"}`,
            borderRight: `1px solid ${selected ? SELECT_COLOR : "#c3c9ce"}`,
            borderBottom: `1px solid ${selected ? SELECT_COLOR : "#c3c9ce"}`,
            // The department's own colour, as a stripe rather than as a wash: readable next to the
            // name without turning the label into a coloured chip.
            borderLeft: `4px solid ${isProject ? PROJECT.wall : accent.deep}`,
            borderRadius: 4,
            padding: "2px 7px",
            whiteSpace: "nowrap",
            // The mesh underneath owns the click; a label that swallowed it would make the
            // building unselectable from exactly the spot the operator aims at.
            pointerEvents: "none",
            userSelect: "none",
          }}
        >
          {room.name}
          {/* The project block normally shows no count — it is the factory, not a department. But an
              agent *can* be created in the project room, and then figures stand at the block; a
              label that stayed silent about them would contradict what the floor shows. */}
          {isProject && agents === 0 ? "" : ` · ${agents} agent${agents === 1 ? "" : "s"}`}
          {hasOrchestrator && (
            <span style={{ color: ORCHESTRATOR_LABEL_COLOR, fontWeight: 700 }}> · orchestrator</span>
          )}
          {/* Which departments are sandboxed has to be answerable from the floor, not only from the
              panel of whichever room happens to be selected — it is the question an operator asks
              before turning an agent loose. A word rather than a light on the roof: see
              `SANDBOX_COLOR` for why this one is deliberately quiet. */}
          {room.runtime === "container" && (
            <span style={{ color: SANDBOX_COLOR, fontWeight: 700 }}> · sandboxed</span>
          )}
        </div>
      </Html>
    </group>
  );
});

/**
 * A workshop's flat roof: a slab with an overhang, a fascia under its lip so the overhang casts a
 * line rather than a smudge, two vents and a skylight. The plant is what tells a roof from a lid.
 */
function RoomRoof({ width, height }: { width: number; height: number }) {
  const over = width + 0.4;
  return (
    <group position-y={height}>
      <mesh castShadow position-y={ROOM_ROOF_THICKNESS / 2}>
        <boxGeometry args={[over, ROOM_ROOF_THICKNESS, over]} />
        <meshStandardMaterial color={ROOM.roof} roughness={0.85} />
      </mesh>
      {/* The lip, a shade darker, so the eaves read as an edge. */}
      <mesh position-y={-0.04}>
        <boxGeometry args={[over + 0.04, 0.1, over + 0.04]} />
        <meshStandardMaterial color={ROOM.fascia} roughness={0.9} />
      </mesh>
      {/* Two extract vents, on the side the camera looks at. */}
      {([-0.95, 0.55] as const).map((x, i) => (
        <group key={i} position={[x, ROOM_ROOF_THICKNESS, -0.9]}>
          <mesh castShadow position-y={0.2}>
            <cylinderGeometry args={[0.19, 0.22, 0.4, 8]} />
            <meshStandardMaterial color={DETAIL.vent} roughness={0.5} metalness={0.4} />
          </mesh>
          <mesh position-y={0.43}>
            <cylinderGeometry args={[0.28, 0.24, 0.08, 8]} />
            <meshStandardMaterial color={ROOM.fascia} roughness={0.7} />
          </mesh>
        </group>
      ))}
      {/* A skylight: pale, low, and slightly proud of the slab. */}
      <mesh position={[0.5, ROOM_ROOF_THICKNESS + 0.05, 0.85]} rotation-y={Math.PI / 12}>
        <boxGeometry args={[1.7, 0.1, 0.62]} />
        <meshStandardMaterial color={DETAIL.skylight} roughness={0.2} metalness={0.05} />
      </mesh>
    </group>
  );
}

/**
 * The project block's roof: a steep four-sided pitch with a light eaves band under it and a finial on
 * top. The pitch is `PROJECT_ROOF_HEIGHT` and the colour is deliberately much lighter than the walls
 * — the two together are what stop it reading as the flat dark cap it used to be.
 */
function ProjectRoof({ width, height }: { width: number; height: number }) {
  // A 4-sided cone needs to reach the box's corners, not its edges, to cover the footprint.
  const radius = (width * Math.SQRT2) / 2 + 0.15;
  return (
    <group position-y={height}>
      {/* Eaves: a light band on the wall head, catching the key light under the overhang. */}
      <mesh castShadow position-y={0.09}>
        <boxGeometry args={[width + 0.55, 0.18, width + 0.55]} />
        <meshStandardMaterial color={PROJECT.ridge} roughness={0.65} />
      </mesh>
      <mesh castShadow position-y={0.18 + PROJECT_ROOF_HEIGHT / 2} rotation-y={Math.PI / 4}>
        <coneGeometry args={[radius, PROJECT_ROOF_HEIGHT, 4]} />
        <meshStandardMaterial color={PROJECT.roof} roughness={0.72} />
      </mesh>
      {/* The finial, so the apex is a thing and not a mathematical point. */}
      <mesh position-y={0.18 + PROJECT_ROOF_HEIGHT + 0.14}>
        <boxGeometry args={[0.42, 0.32, 0.42]} />
        <meshStandardMaterial color={PROJECT.ridge} roughness={0.5} metalness={0.3} />
      </mesh>
    </group>
  );
}

/**
 * A loading bay, in the local frame `loadingBays` puts it in: `+z` is out of the wall.
 *
 * A genuine recess would need the wall to have a hole in it, and a hole in a box is CSG. What this
 * does instead is what a low-poly factory does: a near-black opening, a bright frame around it and a
 * canopy over it, which together read as a door in shade — and the belt already stops
 * `BELT_EDGE_MARGIN` short of the wall, so a package visibly runs *into* the opening.
 */
function LoadingBayMesh({ frame, canopy }: { frame: string; canopy: string }) {
  return (
    <>
      <mesh position={[0, 0.92, 0.03]}>
        <boxGeometry args={[BAY_WIDTH + 0.3, 1.9, 0.06]} />
        <meshStandardMaterial color={frame} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.8, 0.06]}>
        <boxGeometry args={[BAY_WIDTH, 1.6, 0.06]} />
        <meshStandardMaterial color={DETAIL.bay} roughness={1} />
      </mesh>
      {/* The dock lip the belt runs onto. */}
      <mesh position={[0, 0.06, 0.24]}>
        <boxGeometry args={[BAY_WIDTH + 0.1, 0.12, 0.5]} />
        <meshStandardMaterial color={canopy} roughness={0.8} />
      </mesh>
      <mesh castShadow position={[0, 1.95, 0.28]}>
        <boxGeometry args={[BAY_WIDTH + 0.55, 0.14, 0.62]} />
        <meshStandardMaterial color={canopy} roughness={0.75} />
      </mesh>
    </>
  );
}

/**
 * What "selected" looks like: a rim around the building and a ring on the floor under it.
 *
 * The first pass repainted the whole building orange with an emissive bump, which destroyed exactly
 * the information the operator selected it to read — a selected workshop stopped being a workshop and
 * became an orange box, indistinguishable from a selected project block. Selection has to **add**.
 *
 * The rim is the classic inverted hull: the same box, scaled a few percent, drawn back-faces-only.
 * The front faces are culled, so all that survives is the sliver sticking out past the silhouette —
 * an outline, for one extra draw call and no shader. The ground ring is there because a building
 * seen almost edge-on has very little silhouette to rim.
 *
 * `toneMapped={false}` on both: this is UI drawn in the scene, and it should be the cyan it says it
 * is rather than whatever the renderer's tone curve would prefer.
 */
function SelectionRim({ width, height }: { width: number; height: number }) {
  return (
    <>
      <mesh position-y={height / 2} scale={RIM_SCALE}>
        <boxGeometry args={[width, height, width]} />
        <meshBasicMaterial color={SELECT_COLOR} side={BackSide} toneMapped={false} />
      </mesh>
      {/* Hugging the footprint's corners (a square of half-width h has its corners at 1.41h), so the
          ring reads as belonging to this building rather than as a circle drawn near it. */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.03}>
        <ringGeometry args={[width * 0.78, width * 0.85, 64]} />
        <meshBasicMaterial color={SELECT_COLOR} toneMapped={false} transparent opacity={0.75} />
      </mesh>
    </>
  );
}
