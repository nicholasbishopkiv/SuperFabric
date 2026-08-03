import { Grid } from "@react-three/drei";
import { FLOOR_SIZE } from "./layout";

/**
 * The factory floor: one large shadow-receiving plane with a grid on it. The plane sits a hair below
 * y = 0 so the grid lines are never fighting it for the same depth.
 */
export function Floor() {
  return (
    <group>
      <mesh receiveShadow rotation-x={-Math.PI / 2} position-y={-0.02}>
        <planeGeometry args={[FLOOR_SIZE, FLOOR_SIZE]} />
        <meshStandardMaterial color="#d5d9dd" />
      </mesh>
      <Grid
        args={[FLOOR_SIZE, FLOOR_SIZE]}
        cellSize={1}
        cellThickness={0.6}
        cellColor="#b9c0c6"
        sectionSize={5}
        sectionThickness={1.1}
        sectionColor="#8d979f"
        fadeDistance={120}
        fadeStrength={1.2}
        followCamera={false}
        infiniteGrid={false}
      />
    </group>
  );
}
