import { Html } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { memo, useCallback } from "react";
import { useFabric, useIsSelected, useRoom, useRoomAgentCount } from "../store";
import { buildingSize } from "./layout";

const COLORS = {
  project: "#5a6b7c",
  projectRoof: "#3f4c59",
  room: "#8a9aa8",
  roomRoof: "#6b7885",
  selected: "#e08a00",
  label: "#1c1c1c",
};

/** How brightly a selected building glows. Emissive, so it reads as selected from any angle. */
const SELECTED_EMISSIVE = 0.55;

/**
 * One building on the floor, procedural and low-poly: no assets, no loading. Memoized and
 * subscribing to its own room row, so a status tick or a sibling moving re-renders this component
 * only when *this* room changed.
 */
export const Building = memo(function Building({ roomId }: { roomId: string }) {
  const room = useRoom(roomId);
  const agents = useRoomAgentCount(roomId);
  const selected = useIsSelected(roomId);
  const selectRoom = useFabric((s) => s.selectRoom);

  const onClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      // Only the building actually under the pointer, not everything the ray passed through.
      e.stopPropagation();
      selectRoom(selected ? null : roomId);
    },
    [roomId, selected, selectRoom],
  );

  // The room list can drop a row (a rebuild from the server) while this component is still mounted.
  if (room === undefined) return null;

  const isProject = room.kind === "project";
  const { width, height } = buildingSize(room.kind);
  const emissive = selected ? COLORS.selected : "#000000";
  const emissiveIntensity = selected ? SELECTED_EMISSIVE : 0;
  // A 4-sided cone needs to reach the box's corners, not its edges, to cover the footprint.
  const roofRadius = (width * Math.SQRT2) / 2 + 0.1;
  const labelHeight = height + (isProject ? 3.4 : 1.6);

  return (
    <group position={[room.position.x, 0, room.position.z]} onClick={onClick}>
      <mesh castShadow receiveShadow position-y={height / 2}>
        <boxGeometry args={[width, height, width]} />
        <meshStandardMaterial
          color={isProject ? COLORS.project : COLORS.room}
          emissive={emissive}
          emissiveIntensity={emissiveIntensity}
        />
      </mesh>

      {isProject ? (
        // A pitched four-sided roof, rotated 45° so its faces line up with the block's.
        <mesh castShadow position-y={height + 1} rotation-y={Math.PI / 4}>
          <coneGeometry args={[roofRadius, 2, 4]} />
          <meshStandardMaterial
            color={COLORS.projectRoof}
            emissive={emissive}
            emissiveIntensity={emissiveIntensity}
          />
        </mesh>
      ) : (
        // A workshop gets a flatter roof: a thin slab with a slight overhang.
        <mesh castShadow position-y={height + 0.15}>
          <boxGeometry args={[width + 0.4, 0.3, width + 0.4]} />
          <meshStandardMaterial
            color={COLORS.roomRoof}
            emissive={emissive}
            emissiveIntensity={emissiveIntensity}
          />
        </mesh>
      )}

      {selected && (
        // An unmistakable ground ring under the selection: the emissive bump alone is subtle on a
        // building seen edge-on.
        <mesh rotation-x={-Math.PI / 2} position-y={0.03}>
          <ringGeometry args={[width * 0.85, width * 0.98, 48]} />
          <meshBasicMaterial color={COLORS.selected} />
        </mesh>
      )}

      <Html position={[0, labelHeight, 0]} center distanceFactor={30} occlude>
        <div
          style={{
            font: "600 13px system-ui, sans-serif",
            color: COLORS.label,
            background: "rgba(255,255,255,0.86)",
            border: `1px solid ${selected ? COLORS.selected : "#c3c9ce"}`,
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
          {isProject ? "" : ` · ${agents} agent${agents === 1 ? "" : "s"}`}
        </div>
      </Html>
    </group>
  );
});
