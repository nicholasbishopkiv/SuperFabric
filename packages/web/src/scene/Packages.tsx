import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { CatmullRomCurve3, InstancedMesh } from "three";
import { BoxGeometry, Color, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from "three";
import type { PackageInFlight } from "../store";
import { beltFan, useFabric, useWaitingMessages } from "../store";
import { conveyorCurve, pointAt, waitingSlot, waitingStackIndices } from "./conveyorPath";
import { PACKAGE_COLORS, packageToneIndex, WAITING_PACKAGE_COLOR } from "./palette";

/**
 * How many packages can be in flight at once. A factory that saturates this is a factory whose bus is
 * being hammered; the excess is simply not drawn rather than reallocating a buffer mid-flight.
 */
const CAPACITY = 128;

/** One geometry, one material, one draw call — hoisted, so N packages allocate nothing. */
const PACKAGE_GEOMETRY = new BoxGeometry(0.5, 0.5, 0.5);
/**
 * White, because the per-instance colour multiplies it: `instanceColor` is how one draw call gets to
 * draw four different tones of cardboard.
 */
const PACKAGE_MATERIAL = new MeshStandardMaterial({ color: "#ffffff", roughness: 0.7 });

/** The four cardboard tones, pre-parsed so a frame never allocates a `Color`. */
const PACKAGE_TONES = PACKAGE_COLORS.map((hex) => new Color(hex));

/**
 * How much a box may differ from the nominal half-metre, up and down. Small on purpose: a stream of
 * *identical* cubes reads as a repeating texture rather than as goods, and a stream of wildly
 * different ones reads as a bug.
 */
const SIZE_SPREAD = 0.22;

/**
 * A package's look, derived from its id so it never changes mid-flight and never needs storing.
 *
 * Tone and size only. **No meaning**: which kind of message a package carries is M3's to say, and a
 * colour vocabulary invented here would be one the operator cannot read and we would have to
 * un-teach them.
 */
function variantOf(id: string): { tone: Color; scale: number } {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const unit = (hash >>> 0) / 4294967296;
  return {
    // The tone comes from the shared `packageToneIndex`, not from this hash: the crate an agent
    // carries in and the crate left standing at a bay are the *same box* as this one, and they read
    // the tone from there.
    tone: PACKAGE_TONES[packageToneIndex(id)],
    scale: 1 - SIZE_SPREAD + unit * SIZE_SPREAD * 2,
  };
}

/** How high the box lifts at the middle of its trip, so it reads as travelling rather than sliding. */
const BOB = 0.15;

const scratchPoint = new Vector3();
const scratchMatrix = new Matrix4();
const scratchQuaternion = new Quaternion();
const scratchScale = new Vector3();
const UP = new Vector3(0, 1, 0);

interface Route {
  pkg: PackageInFlight;
  curve: CatmullRomCurve3;
  tone: Color;
  scale: number;
}

/**
 * Every package in flight, in **one** `instancedMesh`. Instancing from the start is deliberate: a busy
 * factory has dozens of boxes moving at once, and one draw call versus dozens is the difference
 * between a smooth floor and a slideshow.
 *
 * Positions come from the wall clock (`startedAt` + `durationMs`) rather than from accumulated frame
 * deltas, so a package is exactly where it should be even after the tab was backgrounded and rendered
 * no frames at all.
 */
export function Packages() {
  const packages = useFabric((s) => s.packages);
  const rooms = useFabric((s) => s.rooms);
  // The belts, for their fan offsets: a package has to ride the belt that was actually drawn.
  const conveyors = useFabric((s) => s.conveyors);
  const reapPackages = useFabric((s) => s.reapPackages);
  const meshRef = useRef<InstancedMesh>(null);

  // One curve per package. Rebuilt when the package list or a building's position changes, never per
  // frame: an arc-length lookup table is not something to compute 60 times a second.
  const routes = useMemo<Route[]>(() => {
    const byId = new Map(rooms.map((r) => [r.id, r]));
    const built: Route[] = [];
    for (const pkg of packages) {
      const from = byId.get(pkg.from);
      const to = byId.get(pkg.to);
      // A package addressed to a room this client has not been told about has nowhere to travel; the
      // reaper's timer still clears it.
      if (from === undefined || to === undefined) continue;
      // A `RoomInfo` is a `BeltEnd`: the curve needs the kind as well as the position, because it
      // starts and ends at the buildings' walls rather than at their centres.
      built.push({
        pkg,
        curve: conveyorCurve(from, to, undefined, beltFan(conveyors, pkg.from, pkg.to)),
        ...variantOf(pkg.id),
      });
    }
    return built;
  }, [packages, rooms, conveyors]);

  /** Writes one matrix per in-flight package and returns whether any of them has arrived. */
  function place(now: number): boolean {
    const mesh = meshRef.current;
    if (mesh === null) return false;
    let drawn = 0;
    let landed = false;
    for (const { pkg, curve, tone, scale } of routes) {
      const t = (now - pkg.startedAt) / pkg.durationMs;
      if (t >= 1) {
        // Arrived: stop drawing it this frame rather than parking a box on the destination roof.
        landed = true;
        continue;
      }
      if (drawn >= CAPACITY) break;
      pointAt(curve, t, scratchPoint);
      // Sit the box *on* the belt whatever size it is, then lift it as it travels.
      scratchPoint.y += (scale - 1) * 0.25 + Math.sin(t * Math.PI) * BOB;
      // A slow tumble makes the box read as a solid object rather than a sprite.
      scratchQuaternion.setFromAxisAngle(UP, t * Math.PI);
      scratchScale.setScalar(scale);
      scratchMatrix.compose(scratchPoint, scratchQuaternion, scratchScale);
      mesh.setMatrixAt(drawn, scratchMatrix);
      // The instance colours have to be written here rather than once: which slot a package occupies
      // changes every time one lands, so slot N is a different box from one frame to the next.
      mesh.setColorAt(drawn, tone);
      drawn++;
    }
    mesh.count = drawn;
    // Without this the GPU keeps last frame's transforms and the packages never move.
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    return landed;
  }

  // Place immediately when the list changes, so a new package appears at the start of its belt on the
  // very first rendered frame instead of at the origin.
  useLayoutEffect(() => {
    place(Date.now());
  }, [routes]);

  useFrame(() => {
    const now = Date.now();
    // Reaping inside the loop is safe: the store returns its own state when nothing landed, so this is
    // a no-op set, and the one that does land shrinks the list exactly once.
    if (place(now)) reapPackages(now);
  });

  return (
    <>
      <instancedMesh
        ref={meshRef}
        args={[PACKAGE_GEOMETRY, PACKAGE_MATERIAL, CAPACITY]}
        castShadow
        // Instance transforms are written by hand every frame, so the mesh's own bounding sphere (a
        // half-metre box at the origin) says nothing useful about where the packages actually are.
        frustumCulled={false}
      />
      <WaitingPackages />
    </>
  );
}

/** How many undelivered messages can be drawn at once. Past this the pile is a number, not a shape. */
const WAITING_CAPACITY = 96;

/**
 * A flat crate rather than a cube: the silhouette is the distinction that survives being small on
 * screen, in a way a colour difference alone does not.
 */
const WAITING_GEOMETRY = new BoxGeometry(0.62, 0.18, 0.62);
const WAITING_MATERIAL = new MeshStandardMaterial({ color: WAITING_PACKAGE_COLOR, roughness: 0.9 });

/**
 * Messages nobody has picked up yet, stacked at the door they were posted from.
 *
 * **Deliberately still.** These are written once, when the queue changes, and never touched by the
 * render loop — a pile-up is a state to read, and animating it would pin `frameloop` to `"always"`
 * for as long as a room stayed busy. `FactoryScene` invalidates on the store change instead, which
 * is one frame per change rather than sixty a second for ever.
 *
 * The transition to flight is not this component's job and does not need to be: a delivered message
 * leaves this list and enters `packages` under the *same id*, and its belt curve starts at the same
 * door, so the box picks up where the crate stood.
 */
function WaitingPackages() {
  const waiting = useWaitingMessages();
  const rooms = useFabric((s) => s.rooms);
  const conveyors = useFabric((s) => s.conveyors);
  const meshRef = useRef<InstancedMesh>(null);

  const slots = useMemo(() => {
    const byId = new Map(rooms.map((r) => [r.id, r]));
    const indices = waitingStackIndices(waiting);
    const placed: { point: Vector3; scale: number }[] = [];
    for (const [i, msg] of waiting.entries()) {
      const from = byId.get(msg.from);
      const to = byId.get(msg.to);
      // A message between rooms this client has not been told about has no door to stand at.
      if (from === undefined || to === undefined || msg.from === msg.to) continue;
      if (placed.length >= WAITING_CAPACITY) break;
      const { t, lift } = waitingSlot(indices[i]);
      const point = pointAt(conveyorCurve(from, to, undefined, beltFan(conveyors, msg.from, msg.to)), t);
      point.y += lift;
      // The pile settles as it grows: the crates further up are the older ones, slightly squashed
      // under the newer, which reads as weight rather than as a floating stack.
      placed.push({ point, scale: 1 - Math.min(indices[i], 5) * 0.03 });
    }
    return placed;
  }, [waiting, rooms, conveyors]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    for (const [i, { point, scale }] of slots.entries()) {
      scratchQuaternion.setFromAxisAngle(UP, 0);
      scratchScale.set(scale, 1, scale);
      scratchMatrix.compose(point, scratchQuaternion, scratchScale);
      mesh.setMatrixAt(i, scratchMatrix);
    }
    mesh.count = slots.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [slots]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[WAITING_GEOMETRY, WAITING_MATERIAL, WAITING_CAPACITY]}
      castShadow
      receiveShadow
      frustumCulled={false}
    />
  );
}
