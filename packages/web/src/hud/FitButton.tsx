import { ExpandIcon } from "lucide-react";
import { useEffect } from "react";
import { useFabric, useHudInsets } from "../store";
import { Button } from "../ui/button";

/**
 * "Fit" — put the whole factory back in frame, at the default isometric angle.
 *
 * The camera frames the floor by itself, but only until the operator touches it: after that the view
 * belongs to them and nothing may move it, or a new room appearing would yank the floor out from
 * under whatever they were looking at. That rule needs exactly one escape hatch, and this is it.
 * Also bound to `f`, because the one thing an operator does after losing the factory is reach for the
 * keyboard.
 *
 * Since the camera can be orbited and tilted, this is also the way *back*: it restores the opening
 * orientation along with the framing (see `CameraFraming`), so no orbit is a one-way trip.
 */
export function FitButton() {
  const requestCameraFit = useFabric((s) => s.requestCameraFit);
  // Pinned to the free strip's bottom-left corner rather than the viewport's, so the room panel
  // never paints over it and it never floats on top of the task board.
  const insets = useHudInsets();

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== "f" && e.key !== "F") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Never while the operator is typing a room name or a prompt.
      const el = document.activeElement;
      const tag = el === null ? "" : el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      requestCameraFit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestCameraFit]);

  return (
    <Button
      onClick={requestCameraFit}
      size="md"
      className="fixed z-40 bg-panel/80 backdrop-blur-xl"
      style={{ left: insets.left + 12, bottom: insets.bottom + 12 }}
      title="Frame the whole factory and restore the default view (f) — drag to pan, right-drag to orbit, wheel to zoom"
    >
      <ExpandIcon />
      fit
    </Button>
  );
}
