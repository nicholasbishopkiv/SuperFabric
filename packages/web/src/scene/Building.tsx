import { Html } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { memo } from "react";
import { BackSide } from "three";
import {
  useFabric,
  useIsSelected,
  useRoom,
  useRoomAgentCount,
  useRoomPosition,
  useRoomStatus,
} from "../store";
import { Agents } from "./Agents";
import {
  beaconHeight,
  buildingSize,
  labelHeight,
  PROJECT_ROOF_HEIGHT,
  ROOM_ROOF_THICKNESS,
} from "./layout";
import { SELECT_COLOR } from "./palette";
import { StatusBeacon } from "./StatusBeacon";

const COLORS = {
  project: "#5a6b7c",
  projectRoof: "#3f4c59",
  room: "#8a9aa8",
  roomRoof: "#6b7885",
  label: "#1c1c1c",
};

/**
 * How far outside the building the selection rim is drawn. Small: a rim is a rim, and a thick one
 * turns the building back into a coloured blob.
 */
const RIM_SCALE = 1.04;

/**
 * One building on the floor, procedural and low-poly: no assets, no loading. Memoized and
 * subscribing to its own room row, so a status tick or a sibling moving re-renders this component
 * only when *this* room changed.
 */
export const Building = memo(function Building({ roomId }: { roomId: string }) {
  const room = useRoom(roomId);
  // Not `room.position`: while this building is being dragged, the operator's pointer owns where it
  // stands and the server's last broadcast does not. `RoomDrag` explains why.
  const position = useRoomPosition(roomId);
  const agents = useRoomAgentCount(roomId);
  const status = useRoomStatus(roomId);
  const selected = useIsSelected(roomId);
  const selectRoom = useFabric((s) => s.selectRoom);
  const beginRoomDrag = useFabric((s) => s.beginRoomDrag);

  // The room list can drop a row (a rebuild from the server) while this component is still mounted.
  if (room === undefined || position === undefined) return null;

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

  const isProject = room.kind === "project";
  const { width, height } = buildingSize(room.kind);
  // A 4-sided cone needs to reach the box's corners, not its edges, to cover the footprint.
  const roofRadius = (width * Math.SQRT2) / 2 + 0.1;

  return (
    <group position={[position.x, 0, position.z]} onPointerDown={onPointerDown}>
      <mesh castShadow receiveShadow position-y={height / 2}>
        <boxGeometry args={[width, height, width]} />
        <meshStandardMaterial color={isProject ? COLORS.project : COLORS.room} />
      </mesh>

      {isProject ? (
        // A pitched four-sided roof, rotated 45° so its faces line up with the block's.
        <mesh castShadow position-y={height + PROJECT_ROOF_HEIGHT / 2} rotation-y={Math.PI / 4}>
          <coneGeometry args={[roofRadius, PROJECT_ROOF_HEIGHT, 4]} />
          <meshStandardMaterial color={COLORS.projectRoof} />
        </mesh>
      ) : (
        // A workshop gets a flatter roof: a thin slab with a slight overhang.
        <mesh castShadow position-y={height + ROOM_ROOF_THICKNESS / 2}>
          <boxGeometry args={[width + 0.4, ROOM_ROOF_THICKNESS, width + 0.4]} />
          <meshStandardMaterial color={COLORS.roomRoof} />
        </mesh>
      )}

      <StatusBeacon status={status} y={beaconHeight(room.kind)} />

      {/* Figures stand at the project block too, not only at the workshops: an agent created in the
          project room is a real agent, and a floor that hid it would be lying about what is running. */}
      <Agents roomId={roomId} kind={room.kind} />

      {selected && <SelectionRim width={width} height={height} />}

      {/*
        No `distanceFactor`: on an *orthographic* camera drei multiplies the label's scale by
        `camera.zoom`, which at zoom 38 blows a 13px label up 1140× and covers the whole floor with a
        white rectangle. A constant screen-space size is also the right behaviour for a plan view —
        the label stays exactly as readable at every zoom level, which is what the factor was for.
      */}
      <Html position={[0, labelHeight(room.kind), 0]} center occlude>
        <div
          style={{
            font: "600 13px system-ui, sans-serif",
            color: COLORS.label,
            background: "rgba(255,255,255,0.86)",
            border: `1px solid ${selected ? SELECT_COLOR : "#c3c9ce"}`,
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
        </div>
      </Html>
    </group>
  );
});

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
      <mesh rotation-x={-Math.PI / 2} position-y={0.03}>
        <ringGeometry args={[width * 0.86, width * 0.96, 64]} />
        <meshBasicMaterial color={SELECT_COLOR} toneMapped={false} transparent opacity={0.9} />
      </mesh>
    </>
  );
}
