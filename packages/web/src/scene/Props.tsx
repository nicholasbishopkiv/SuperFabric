import type { RoomInfo } from "@superfabric/shared";
import { memo, useMemo } from "react";
import { BoxGeometry, CylinderGeometry, MeshStandardMaterial } from "three";
import { useRoomRoleIds } from "../store";
import { DETAIL, PROP } from "./palette";

import { type PropKind, roomProps } from "./props";

/**
 * A department's furniture: what the room works *at*, drawn in the yard between the wall and the
 * figures.
 *
 * `props.ts` decides which pieces exist and where they stand; this file is only how they are made.
 * All of it is boxes and two cylinders, in the buildings' own cool neutrals (`PROP`), because a prop
 * has to say "this is a workshop that builds things" and then lose every contest for attention to the
 * belts, the packages and the beacons.
 *
 * **The one thing that ever changes is a lamp or a screen**, and it does exactly what the glazing
 * does: `DETAIL.window` with `windowGlow` behind it while the room is working, `windowDark` and
 * unlit otherwise — the same two states, the same intensity constant, so the floor has one way of
 * saying "somebody is at this" rather than two. Steady, never pulsing: `frameloop="demand"` means a
 * pulse would have to enter `hasMotion`, and furniture is not worth a frame.
 *
 * No shadows on any of it, for the reason the figures cast none: a 0.8-unit object inside a 120-unit
 * shadow frustum contributes a couple of pixels, and N of them re-rendering the shadow map every
 * frame is a real cost for it.
 *
 * Every geometry and material is module-scope, so eight furnished rooms cost eight groups of draw
 * calls and one set of allocations.
 */

const FRAME = new MeshStandardMaterial({ color: PROP.frame, roughness: 0.5, metalness: 0.35 });
const TOP = new MeshStandardMaterial({ color: PROP.top, roughness: 0.8 });
const PANEL = new MeshStandardMaterial({ color: PROP.panel, roughness: 0.7 });
const PAPER = new MeshStandardMaterial({ color: PROP.paper, roughness: 0.9 });

/**
 * The lit and unlit faces of anything with a screen on it: the pair `Building` uses for its glazing,
 * in the glazing's own two colours, so "somebody is at this" is said one way on this floor rather than
 * two. The intensity is `PROP.screenGlowIntensity` rather than the window's — see there for why a
 * twentieth of the area needs more than a twentieth of the light to be visible at all.
 */
const SCREEN_LIT = new MeshStandardMaterial({
  color: DETAIL.window,
  emissive: DETAIL.windowGlow,
  emissiveIntensity: PROP.screenGlowIntensity,
  roughness: 0.25,
});
const SCREEN_DARK = new MeshStandardMaterial({ color: DETAIL.windowDark, roughness: 0.3 });

/** Shared bones: a worktop, a leg, a pedestal. Every prop is assembled from these plus its own part. */
const TOP_GEOMETRY = new BoxGeometry(0.95, 0.075, 0.5);
const LEG_GEOMETRY = new BoxGeometry(0.075, 0.6, 0.075);
const PEDESTAL_GEOMETRY = new BoxGeometry(0.34, 0.6, 0.34);
/** The height every worktop sits at, so a room of different furniture reads as one yard. */
const TOP_Y = 0.64;

/** bench: a vice at one end, which is the whole difference between a worktop and a table. */
const VICE_GEOMETRY = new BoxGeometry(0.17, 0.15, 0.19);
const VICE_JAW_GEOMETRY = new BoxGeometry(0.2, 0.05, 0.05);

/** rig: an instrument case with a readout, and a flask on a stand beside it. */
const INSTRUMENT_GEOMETRY = new BoxGeometry(0.42, 0.3, 0.26);
const READOUT_GEOMETRY = new BoxGeometry(0.3, 0.16, 0.02);
const FLASK_GEOMETRY = new CylinderGeometry(0.05, 0.09, 0.18, 8);

/** desk: a monitor on a stem, and a keyboard in front of it. */
const MONITOR_GEOMETRY = new BoxGeometry(0.46, 0.32, 0.035);
const SCREEN_GEOMETRY = new BoxGeometry(0.4, 0.26, 0.02);
const STEM_GEOMETRY = new BoxGeometry(0.07, 0.14, 0.07);
const KEYBOARD_GEOMETRY = new BoxGeometry(0.36, 0.025, 0.14);

/** drafting: a tilted board with a drawing pinned to it. */
const BOARD_GEOMETRY = new BoxGeometry(0.92, 0.62, 0.045);
const DRAWING_GEOMETRY = new BoxGeometry(0.66, 0.44, 0.01);
const DRAFTING_TILT = -0.62;

/** rack: a cabinet, its shelves, and a row of indicator lamps down one side. */
const CABINET_GEOMETRY = new BoxGeometry(0.62, 1.05, 0.5);
const SHELF_GEOMETRY = new BoxGeometry(0.58, 0.035, 0.02);
const LAMPS_GEOMETRY = new BoxGeometry(0.06, 0.62, 0.02);

/** A worktop on two legs: the base of the bench, the rig and the desk alike. */
function Worktop({ pedestal = false }: { pedestal?: boolean }) {
  return (
    <>
      <mesh geometry={TOP_GEOMETRY} material={TOP} position-y={TOP_Y} />
      {pedestal ? (
        <mesh geometry={PEDESTAL_GEOMETRY} material={PANEL} position-y={0.3} />
      ) : (
        <>
          <mesh geometry={LEG_GEOMETRY} material={FRAME} position={[-0.4, 0.3, 0]} />
          <mesh geometry={LEG_GEOMETRY} material={FRAME} position={[0.4, 0.3, 0]} />
        </>
      )}
    </>
  );
}

/** One piece of furniture, in its slot's frame: `+z` is out of the wall behind it. */
function Prop({ kind, lit }: { kind: PropKind; lit: boolean }) {
  const screen = lit ? SCREEN_LIT : SCREEN_DARK;
  switch (kind) {
    case "bench":
      return (
        <>
          <Worktop />
          <mesh geometry={VICE_GEOMETRY} material={FRAME} position={[0.33, TOP_Y + 0.11, 0.02]} />
          <mesh geometry={VICE_JAW_GEOMETRY} material={PANEL} position={[0.33, TOP_Y + 0.17, 0.02]} />
        </>
      );
    case "rig":
      return (
        <>
          <Worktop pedestal />
          <mesh geometry={INSTRUMENT_GEOMETRY} material={PANEL} position={[-0.2, TOP_Y + 0.19, -0.06]} />
          {/* The readout: this room's one lit face, on the side an operator can see. */}
          <mesh geometry={READOUT_GEOMETRY} material={screen} position={[-0.2, TOP_Y + 0.2, 0.08]} />
          <mesh geometry={FLASK_GEOMETRY} material={PAPER} position={[0.28, TOP_Y + 0.13, 0.04]} />
        </>
      );
    case "desk":
      return (
        <>
          <Worktop />
          <mesh geometry={STEM_GEOMETRY} material={FRAME} position={[-0.12, TOP_Y + 0.1, -0.1]} />
          <mesh geometry={MONITOR_GEOMETRY} material={PANEL} position={[-0.12, TOP_Y + 0.33, -0.12]} />
          <mesh geometry={SCREEN_GEOMETRY} material={screen} position={[-0.12, TOP_Y + 0.33, -0.09]} />
          <mesh geometry={KEYBOARD_GEOMETRY} material={PANEL} position={[-0.1, TOP_Y + 0.05, 0.12]} />
        </>
      );
    case "drafting":
      // Paper and a pencil: no lit face at all, because a drawing board has no screen and inventing
      // one to make every prop react would be decoration pretending to be a reading.
      return (
        <>
          <mesh geometry={LEG_GEOMETRY} material={FRAME} position={[-0.36, 0.3, 0.06]} />
          <mesh geometry={LEG_GEOMETRY} material={FRAME} position={[0.36, 0.3, 0.06]} />
          <group position={[0, TOP_Y + 0.16, -0.02]} rotation-x={DRAFTING_TILT}>
            <mesh geometry={BOARD_GEOMETRY} material={PANEL} />
            <mesh geometry={DRAWING_GEOMETRY} material={PAPER} position-z={0.03} />
          </group>
        </>
      );
    case "rack":
      return (
        <>
          <mesh geometry={CABINET_GEOMETRY} material={PANEL} position-y={0.525} />
          {[0.32, 0.55, 0.78].map((y) => (
            <mesh key={y} geometry={SHELF_GEOMETRY} material={FRAME} position={[0, y, 0.255]} />
          ))}
          {/* The indicator column: lit while the room works, dead when it does not. */}
          <mesh geometry={LAMPS_GEOMETRY} material={screen} position={[0.24, 0.6, 0.256]} />
        </>
      );
  }
}

/**
 * The furniture in one room's yard. Subscribes to the *set of roles* standing in the room rather than
 * to its sessions, so a status tick, a token or an agent walking to a bay changes nothing here — the
 * yard is only rebuilt when the disciplines present actually change.
 */
export const RoomProps = memo(function RoomProps({
  roomId,
  kind,
  beltDirections,
  working,
}: {
  roomId: string;
  kind: RoomInfo["kind"];
  /** The same flat `[dx0, dz0, …]` the building draws its loading bays from: a bay outranks a prop. */
  beltDirections: readonly number[];
  /** Somebody in this room is working, which is what lights a screen or a lamp. */
  working: boolean;
}) {
  const roleIds = useRoomRoleIds(roomId);
  const placed = useMemo(() => roomProps(kind, roleIds, beltDirections), [kind, roleIds, beltDirections]);

  return (
    <>
      {placed.map((prop) => (
        <group key={prop.kind} position={[prop.x, 0, prop.z]} rotation-y={prop.yaw}>
          <Prop kind={prop.kind} lit={working} />
        </group>
      ))}
    </>
  );
});
