import { useEffect, useRef } from "react";
import { useFabric } from "../store";

/**
 * Report an overlay panel's width to the store, so the camera can frame the factory in the floor
 * that is actually visible rather than in the middle of a canvas half of which is behind a panel.
 *
 * A `ResizeObserver` rather than a constant, because the width is genuinely dynamic: the panels are
 * `min(320px, 32vw)` and `min(560px, 46vw)`, they collapse to a button, and the viewport can be
 * dragged. Anything hard-coded here would be wrong in three of those four states — and reading the
 * panels' DOM from inside the scene would couple the floor to the HUD's markup, which is the same
 * mistake in the other direction.
 */
export function useHudInset<T extends HTMLElement>(side: "left" | "right"): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const { setHudInset } = useFabric.getState();
    const report = (): void => setHudInset(side, el.getBoundingClientRect().width);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => {
      observer.disconnect();
      // A panel that unmounts is not covering anything any more.
      useFabric.getState().setHudInset(side, 0);
    };
  }, [side]);

  return ref;
}
