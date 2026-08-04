import { useEffect } from "react";
import { AttachmentDrop } from "./hud/AttachmentDrop";
import { ConsoleDrawer } from "./hud/ConsoleDrawer";
import { FitButton } from "./hud/FitButton";
import { NoticeBar } from "./hud/NoticeBar";
import { ProjectSwitcher } from "./hud/ProjectSwitcher";
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
          task board along the bottom between them. The top edge carries only the project switcher —
          which factory this tab is looking at — and is otherwise left clear. */}
      <RoomPanel />
      <ConsoleDrawer />
      <TaskPanel />
      <ProjectSwitcher />
      {/* The one place the server speaks: `error` and `notice`, centred in the strip the panels
          leave free. No panel renders either any more — see `NoticeBar`. */}
      <NoticeBar />
      {/* Last, so it paints over the panel's own corner. */}
      <FitButton />
      {/* Not a panel: a window-wide paste/drop surface that only draws anything while a file is
          actually being dragged in. It lives here because a drop belongs to the app, not to a
          rectangle of it. */}
      <AttachmentDrop />
    </>
  );
}
