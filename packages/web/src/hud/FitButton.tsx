import { useEffect } from "react";
import { useFabric } from "../store";
import { HUD } from "./theme";

/**
 * "Fit" — put the whole factory back in frame.
 *
 * The camera frames the floor by itself, but only until the operator pans or zooms: after that the
 * view belongs to them and nothing may move it, or a new room appearing would yank the floor out
 * from under whatever they were looking at. That rule needs exactly one escape hatch, and this is
 * it. Also bound to `f`, because the one thing an operator does after losing the factory is reach
 * for the keyboard.
 */
export function FitButton() {
  const requestCameraFit = useFabric((s) => s.requestCameraFit);

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
    <button
      onClick={requestCameraFit}
      title="Frame the whole factory (f)"
      style={{
        position: "fixed",
        left: 12,
        bottom: 12,
        font: "600 13px system-ui, sans-serif",
        color: HUD.text,
        background: HUD.panel,
        border: `1px solid ${HUD.line}`,
        borderRadius: 6,
        padding: "5px 10px",
        cursor: "pointer",
      }}
    >
      ⤢ fit
    </button>
  );
}
