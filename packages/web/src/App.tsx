import { useEffect } from "react";
import { AttachmentDrop } from "./hud/AttachmentDrop";
import { ChroniclePanel } from "./hud/ChroniclePanel";
import { ConsoleDrawer } from "./hud/ConsoleDrawer";
import { FirstRun } from "./hud/FirstRun";
import { FitButton } from "./hud/FitButton";
import { NoticeBar } from "./hud/NoticeBar";
import { Onboarding } from "./hud/Onboarding";
import { RoomPanel } from "./hud/RoomPanel";
import { TaskPanel } from "./hud/TaskPanel";
import { TopLeftBar } from "./hud/TopLeftBar";
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
      {/* Shades the frame so the warm slab does not run flush into a cool near-black panel. Purely
          decorative, never hit-tested — see `.floor-vignette` in `index.css`, where the
          `pointer-events` rule is the load-bearing part. */}
      <div className="floor-vignette" aria-hidden />
      {/* Three overlays, three edges: rooms on the left, the one-agent console on the right, the
          task board along the bottom between them. The top edge carries only the two switchers —
          which factory this tab is looking at, and which accounts it can run agents on — and is
          otherwise left clear. */}
      <RoomPanel />
      <ConsoleDrawer />
      <TaskPanel />
      <TopLeftBar />
      {/* The other end of the free top strip: the chronicle, on the same row as the switcher and
          offset by the console's width. A popover rather than a fourth edge — see `ChroniclePanel`. */}
      <ChroniclePanel />
      {/* The one place the server speaks: `error` and `notice`, centred in the strip the panels
          leave free. No panel renders either any more — see `NoticeBar`. */}
      <NoticeBar />
      {/* First contact, and only then: a project with a CLAUDE.md never sees this at all. It is over
          the floor rather than in a panel because on an un-onboarded factory the floor is empty and
          the interview is the only thing there is to do. */}
      <Onboarding />
      {/* Before any of that: a server with no factory at all asks for a folder and explains itself.
          It and `Onboarding` can never both be showing — onboarding needs a project to be about. */}
      <FirstRun />
      {/* Last, so it paints over the panel's own corner. */}
      <FitButton />
      {/* Not a panel: a window-wide paste/drop surface that only draws anything while a file is
          actually being dragged in. It lives here because a drop belongs to the app, not to a
          rectangle of it. */}
      <AttachmentDrop />
    </>
  );
}
