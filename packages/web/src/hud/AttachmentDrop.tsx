import { useEffect, useRef, useState } from "react";
import { dragHasFiles, filesFromClipboard, uploadIntoComposer } from "../attachments";
import { useFabric, useSelectedRoomId } from "../store";
import { HUD as C } from "./theme";

/**
 * Paste and drop, for the whole window.
 *
 * Deliberately not attached to the console drawer or to any one panel: an operator drops a
 * screenshot *at the app*, not at a particular rectangle of it, and a drop target the size of a text
 * box is a drop target you miss. So the listeners live on `window` and the whole viewport is the
 * target — which also means the default has to be prevented everywhere, or a stray miss navigates
 * the tab to `file:///home/…/screenshot.png` and the operator loses the page they were working in.
 *
 * The overlay only appears for a drag that actually carries files (`dragHasFiles`), so dragging a
 * building across the floor or a text selection across a panel does not flash a drop target at
 * someone who is doing something else.
 */
export function AttachmentDrop() {
  const [dragging, setDragging] = useState(false);
  const uploading = useFabric((s) => s.uploading);
  const selectedRoomId = useSelectedRoomId();
  const room = useFabric((s) => s.rooms.find((r) => r.id === selectedRoomId));
  const project = useFabric((s) => s.projects.find((p) => p.id === s.activeProjectId));
  /**
   * `dragenter`/`dragleave` fire for every element the pointer crosses, so a single drag over a
   * busy HUD produces a stream of leaves that are not leaving. Counting enters and leaves is the
   * standard fix and the only one that does not flicker.
   */
  const depth = useRef(0);

  useEffect(() => {
    const onDragEnter = (e: DragEvent): void => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent): void => {
      if (!dragHasFiles(e.dataTransfer)) return;
      // Without this the drop never happens: the browser's default is to navigate to the file.
      e.preventDefault();
      if (e.dataTransfer !== null) e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (e: DragEvent): void => {
      if (!dragHasFiles(e.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent): void => {
      // Prevented unconditionally: a drop that carries no files still navigates the page away by
      // default, and losing the factory because a dragged link missed its target is not acceptable.
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = filesFromClipboard(e.dataTransfer);
      if (files.length > 0) void uploadIntoComposer(files);
    };
    const onPaste = (e: ClipboardEvent): void => {
      const files = filesFromClipboard(e.clipboardData);
      if (files.length === 0) return; // an ordinary text paste: leave it to whatever has focus
      e.preventDefault();
      void uploadIntoComposer(files);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("paste", onPaste);
    };
  }, []);

  if (!dragging && !uploading) return null;

  // Where it will land, said before the drop rather than after: with a room selected the file goes
  // into that room's folder, which is a different place and worth knowing in advance.
  const where = room !== undefined
    ? `${room.name}/attachments`
    : project !== undefined ? `${project.name}/attachments` : "the project's attachments folder";

  return (
    <div
      data-testid="attachment-drop"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        // Never intercept the pointer: the drop is handled on `window`, and an overlay that ate
        // events would break the drag it is describing.
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: dragging ? "rgba(10, 90, 120, 0.18)" : "transparent",
        border: dragging ? `3px dashed ${C.accent}` : "none",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          font: "600 16px system-ui, sans-serif",
          color: C.text,
          background: "#ffffffee",
          border: `1px solid ${C.line}`,
          borderRadius: 8,
          padding: "12px 18px",
          boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
          textAlign: "center",
        }}
      >
        {uploading ? "Saving…" : "Drop to save into "}
        {!uploading && <code style={{ font: "inherit", fontWeight: 400 }}>{where}</code>}
        <div style={{ font: "400 12px system-ui, sans-serif", color: C.dim, marginTop: 4 }}>
          The agent is handed the path, never the bytes.
        </div>
      </div>
    </div>
  );
}
