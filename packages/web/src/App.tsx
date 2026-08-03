import { useEffect } from "react";
import { ConsoleDrawer } from "./hud/ConsoleDrawer";
import { FitButton } from "./hud/FitButton";
import { RoomPanel } from "./hud/RoomPanel";
import { TaskPanel } from "./hud/TaskPanel";
import { FactoryScene } from "./scene/FactoryScene";
import { connect } from "./wsClient";

/**
 * The shell: the 3D factory floor fills the viewport and every 2D surface is an overlay on top of it.
 * The socket is opened here rather than inside any one panel — the floor needs rooms and session
 * statuses whether or not the console drawer is open. `connect()` is idempotent, so StrictMode's
 * double-mounted effect opens one socket.
 */
export default function App() {
  useEffect(() => {
    connect();
  }, []);

  return (
    <>
      <FactoryScene />
      {/* Three overlays, three edges: rooms on the left, the one-agent console on the right, the
          task board along the bottom between them. The top is left clear on purpose. */}
      <RoomPanel />
      <ConsoleDrawer />
      <TaskPanel />
      {/* Last, so it paints over the panel's own corner. */}
      <FitButton />
    </>
  );
}
