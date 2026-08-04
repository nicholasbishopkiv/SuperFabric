import { Grid } from "@react-three/drei";
import { useFabric } from "../store";
import { FLOOR_SIZE, paintedZones, SLAB_THICKNESS, slabHalf } from "./layout";
import { FLOOR } from "./palette";

/**
 * The factory shell.
 *
 * The first pass was one unbounded grey plane with a grid on it, which is why the floor read as a
 * diagram: nothing said where the factory ended, so the buildings looked like markers on graph paper
 * rather than plant standing in a building. What is here instead:
 *
 * - a **poured slab**, warm-neutral concrete, thick enough to show a lip where it is edge-on. Its
 *   size is derived from the buildings (`slabHalf`) with an apron that grows with the factory, so
 *   the plant is always inside its own shell however many rings of rooms it grows — and the kerb is
 *   always well outside the frame at the reading distance, so the edge is something you go looking
 *   for rather than the first thing you see;
 * - **darker, cooler ground** outside it, `FLOOR_SIZE` across, which at the widest zoom the controls
 *   allow still runs past the horizon in every direction: the world does not end where the concrete
 *   does;
 * - **painted markings**: a hazard line inset from the kerb, and a zone circle under each ring that
 *   has buildings on it — the paint describes the layout rather than decorating it;
 * - a **kerb** all the way round with steel stanchions at the corners, which is the thing at the
 *   perimeter that tells the eye where the building stops.
 *
 * All of it is static geometry with no animation, so none of it touches the `frameloop` contract.
 * And all of it is deliberately quiet: the belts and the packages have to stay the loudest things on
 * screen, so the grid is a whisper and the paint is bone white rather than safety yellow (yellow is
 * `blocked`, and the floor is not allowed to borrow a status colour).
 */
export function Floor() {
  const rooms = useFabric((s) => s.rooms);
  // Keyed on the derived numbers, not on the room list: a room gaining an agent must not rebuild
  // the slab, and neither must a building being dragged three quarters of a metre.
  const half = slabHalf(rooms);
  const painted = paintedZones(rooms);

  const size = half * 2;
  /** Where the painted hazard line runs: just inside the kerb. */
  const laneHalf = half - 1.6;

  return (
    <group>
      {/* The world outside the slab. Large, flat and dull: it exists so the slab has an edge. */}
      <mesh receiveShadow rotation-x={-Math.PI / 2} position-y={-SLAB_THICKNESS - 0.02}>
        <planeGeometry args={[FLOOR_SIZE, FLOOR_SIZE]} />
        <meshStandardMaterial color={FLOOR.ground} roughness={1} />
      </mesh>

      {/* The slab itself: a box, not a plane, so the pour has a visible thickness at the kerb. */}
      <mesh receiveShadow position-y={-SLAB_THICKNESS / 2 - 0.01}>
        <boxGeometry args={[size, SLAB_THICKNESS, size]} />
        <meshStandardMaterial color={FLOOR.slab} roughness={0.95} />
      </mesh>

      {/* Joints in the pour, clipped to the slab. Fainter than the first pass by design. */}
      <Grid
        args={[size, size]}
        cellSize={1}
        cellThickness={0.5}
        cellColor={FLOOR.joint}
        sectionSize={5}
        sectionThickness={0.9}
        sectionColor={FLOOR.section}
        fadeDistance={half * 3}
        fadeStrength={1}
        followCamera={false}
        infiniteGrid={false}
      />

      {/* Painted zone circles, one per occupied ring. */}
      {painted.map((radius) => (
        <mesh key={radius} rotation-x={-Math.PI / 2} position-y={0.014}>
          <ringGeometry args={[radius - 0.09, radius + 0.09, 128]} />
          <meshBasicMaterial color={FLOOR.paint} transparent opacity={0.5} />
        </mesh>
      ))}

      {/* The hazard line inset from the kerb: four painted strips, drawn as one open rectangle. */}
      {([[0, laneHalf], [0, -laneHalf], [laneHalf, 0], [-laneHalf, 0]] as const).map(([x, z], i) => (
        <mesh
          key={i}
          rotation-x={-Math.PI / 2}
          position={[x, 0.012, z]}
          rotation-z={x === 0 ? 0 : Math.PI / 2}
        >
          <planeGeometry args={[laneHalf * 2, 0.22]} />
          <meshBasicMaterial color={FLOOR.paint} transparent opacity={0.6} />
        </mesh>
      ))}

      {/* The kerb: four low walls on the slab's edge. This is the perimeter the eye reads. */}
      {([[0, half], [0, -half], [half, 0], [-half, 0]] as const).map(([x, z], i) => {
        const alongX = x === 0;
        return (
          <group key={i} position={[x, 0, z]}>
            <mesh castShadow receiveShadow position-y={0.22}>
              <boxGeometry args={alongX ? [size, 0.44, 0.7] : [0.7, 0.44, size]} />
              <meshStandardMaterial color={FLOOR.kerb} roughness={0.9} />
            </mesh>
            <mesh position-y={0.46}>
              <boxGeometry args={alongX ? [size, 0.06, 0.7] : [0.7, 0.06, size]} />
              <meshStandardMaterial color={FLOOR.kerbTop} roughness={0.8} />
            </mesh>
          </group>
        );
      })}

      {/* Steel stanchions: one at each corner and one at the middle of each run, tall enough to
          register from a plan view without competing with a building. */}
      {stanchionSpots(half).map(([x, z], i) => (
        <group key={i} position={[x, 0, z]}>
          <mesh castShadow position-y={1.2}>
            <boxGeometry args={[0.3, 2.4, 0.3]} />
            <meshStandardMaterial color={FLOOR.stanchion} roughness={0.5} metalness={0.4} />
          </mesh>
          <mesh position-y={2.47}>
            <boxGeometry args={[0.54, 0.14, 0.54]} />
            <meshStandardMaterial color={FLOOR.kerbTop} roughness={0.7} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Corners of the kerb plus the middle of each run — eight posts, however big the slab is. */
function stanchionSpots(half: number): [number, number][] {
  const h = half - 0.1;
  return [
    [h, h], [h, -h], [-h, h], [-h, -h],
    [h, 0], [-h, 0], [0, h], [0, -h],
  ];
}
