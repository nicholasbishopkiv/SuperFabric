import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { CatmullRomCurve3, InstancedMesh } from "three";
import { BoxGeometry, Matrix4, MeshStandardMaterial, Vector3 } from "three";
import type { PackageInFlight } from "../store";
import { useFabric } from "../store";
import { conveyorCurve, pointAt } from "./conveyorPath";
import { PACKAGE_COLOR } from "./palette";

/**
 * How many packages can be in flight at once. A factory that saturates this is a factory whose bus is
 * being hammered; the excess is simply not drawn rather than reallocating a buffer mid-flight.
 */
const CAPACITY = 128;

/** One geometry, one material, one draw call — hoisted, so N packages allocate nothing. */
const PACKAGE_GEOMETRY = new BoxGeometry(0.5, 0.5, 0.5);
const PACKAGE_MATERIAL = new MeshStandardMaterial({ color: PACKAGE_COLOR, roughness: 0.65 });

/** How high the box lifts at the middle of its trip, so it reads as travelling rather than sliding. */
const BOB = 0.15;

const scratchPoint = new Vector3();
const scratchMatrix = new Matrix4();

interface Route {
  pkg: PackageInFlight;
  curve: CatmullRomCurve3;
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
      built.push({ pkg, curve: conveyorCurve(from, to) });
    }
    return built;
  }, [packages, rooms]);

  /** Writes one matrix per in-flight package and returns whether any of them has arrived. */
  function place(now: number): boolean {
    const mesh = meshRef.current;
    if (mesh === null) return false;
    let drawn = 0;
    let landed = false;
    for (const { pkg, curve } of routes) {
      const t = (now - pkg.startedAt) / pkg.durationMs;
      if (t >= 1) {
        // Arrived: stop drawing it this frame rather than parking a box on the destination roof.
        landed = true;
        continue;
      }
      if (drawn >= CAPACITY) break;
      pointAt(curve, t, scratchPoint);
      scratchPoint.y += Math.sin(t * Math.PI) * BOB;
      // A slow tumble makes the box read as a solid object rather than a sprite.
      scratchMatrix.makeRotationY(t * Math.PI);
      scratchMatrix.setPosition(scratchPoint);
      mesh.setMatrixAt(drawn++, scratchMatrix);
    }
    mesh.count = drawn;
    // Without this the GPU keeps last frame's transforms and the packages never move.
    mesh.instanceMatrix.needsUpdate = true;
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
    <instancedMesh
      ref={meshRef}
      args={[PACKAGE_GEOMETRY, PACKAGE_MATERIAL, CAPACITY]}
      castShadow
      // Instance transforms are written by hand every frame, so the mesh's own bounding sphere (a
      // half-metre box at the origin) says nothing useful about where the packages actually are.
      frustumCulled={false}
    />
  );
}
