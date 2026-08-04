import { Html } from "@react-three/drei";
import type { ComponentProps, ReactNode } from "react";

/**
 * The class drei's wrapper element is given, and the one `index.css` zeroes `pointer-events` on.
 * Exported so a test can check the component and the stylesheet against each other instead of
 * relying on a reader knowing that both halves exist.
 */
export const SCENE_OVERLAY_CLASS = "sf-scene-overlay";

/**
 * What it takes to stop a drei `<Html>` from swallowing the pointer.
 *
 * **This is the fix for a real bug: buildings could not be dragged.** Both scene overlays already
 * set `pointerEvents: "none"` — on their own content `<div>`, which reads like it should be enough
 * and is not. In non-transform mode drei renders *three* nested elements, and only the innermost is
 * ours:
 *
 * 1. the wrapper it appends to the canvas container, whose `style.cssText` it assigns itself as
 *    `position:absolute;top:0;left:0;transform:translate3d(…);transform-origin:0 0;` — **no
 *    `pointer-events`**, so it computes to `auto`;
 * 2. a div of its own carrying `{position:'absolute', transform:'translate3d(-50%,-50%,0)', ...style}`
 *    — the only place the `style` *prop* lands;
 * 3. our content, the one that had `pointerEvents: "none"` all along.
 *
 * With two hit-testable elements above it, a press anywhere on a label or a thought bubble hit the
 * DOM and never reached the canvas, so no raycast ran and `Building`'s `onPointerDown` never fired.
 * Measured, not deduced: `document.elementFromPoint` over a building's label returned the label's
 * `<p>`, and both drei elements computed to `pointer-events: auto`.
 *
 * It got much worse when thought bubbles arrived, which is why it surfaced then: bubbles hang over
 * the figures in *front* of a building and appear when a room is selected, so the first click
 * summoned the very element that covered the grab target.
 *
 * Both halves are applied rather than only the one that would do: `style` covers 2 (and through
 * inheritance 3), the class covers 1 — which is 0×0 today and so unhittable, but is given a real box
 * by drei's own `fullscreen` prop, and is the element a future drei version is most likely to change.
 */
export const SCENE_OVERLAY_PROPS = {
  wrapperClass: SCENE_OVERLAY_CLASS,
  style: { pointerEvents: "none" },
} as const;

/**
 * A line of DOM text over the factory floor — a building's name, an agent's thought — that the
 * pointer passes straight through.
 *
 * **Every `<Html>` in the scene goes through this.** `style` and `wrapperClass` are deliberately not
 * accepted: they are how the overlay stops being transparent to the pointer, so they are not the
 * caller's to set. Style the children instead. Anything in the scene that genuinely wants to be
 * clicked belongs in the HUD, where the DOM is allowed to own the pointer.
 */
export function SceneOverlay({
  children,
  ...rest
}: Omit<ComponentProps<typeof Html>, "style" | "wrapperClass"> & {
  children?: ReactNode;
}) {
  return (
    <Html {...rest} {...SCENE_OVERLAY_PROPS}>
      {children}
    </Html>
  );
}
