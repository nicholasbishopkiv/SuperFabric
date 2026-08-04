import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCENE_OVERLAY_CLASS, SCENE_OVERLAY_PROPS } from "../src/scene/SceneOverlay";

/**
 * The regression guard for "перетаскивание сломано": a drei `<Html>` overlay that hit-tests covers
 * the building under it, and a covered building cannot be grabbed. `SceneOverlay` is the fix, and
 * these tests are what stop the next overlay from reintroducing the bug — jsdom has no WebGL, so
 * (as everywhere else in this package) what gets tested is the data and the source, not a mount.
 */

const SCENE_DIR = join(import.meta.dirname, "../src/scene");

const sceneFiles = (): string[] =>
  readdirSync(SCENE_DIR).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));

const read = (file: string): string => readFileSync(join(SCENE_DIR, file), "utf8");

/**
 * The file with its comments removed.
 *
 * Needed because these files talk about `<Html>` at length — the whole reason `SceneOverlay` exists
 * is written down next to the code that uses it — and a rule that fired on prose would be a rule
 * everyone learns to work around by not explaining themselves.
 */
const code = (file: string): string =>
  read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("SCENE_OVERLAY_PROPS", () => {
  it("turns off pointer events on both drei elements above our own", () => {
    // `style` is the only prop that reaches drei's inner div; the class is the only handle on the
    // wrapper element, whose inline cssText drei writes itself.
    expect(SCENE_OVERLAY_PROPS.style.pointerEvents).toBe("none");
    expect(SCENE_OVERLAY_PROPS.wrapperClass).toBe(SCENE_OVERLAY_CLASS);
  });

  it("is backed by a stylesheet rule, so the class is not merely decorative", () => {
    // The two halves live in different files and neither works alone. If someone renames the class
    // in one of them, this fails instead of the floor quietly becoming undraggable again.
    const css = readFileSync(join(import.meta.dirname, "../src/index.css"), "utf8");
    const rule = new RegExp(`\\.${SCENE_OVERLAY_CLASS}\\s*\\{[^}]*pointer-events:\\s*none`);
    expect(css).toMatch(rule);
    // `!important` is load-bearing: drei assigns `pointer-events` inline on that same element.
    expect(css).toMatch(
      new RegExp(`\\.${SCENE_OVERLAY_CLASS}\\s*\\{[^}]*pointer-events:\\s*none\\s*!important`),
    );
  });
});

describe("every DOM overlay in the scene goes through SceneOverlay", () => {
  it("has no other file importing Html from drei", () => {
    const imports = /import\s*(?:type\s*)?\{[^}]*\bHtml\b[^}]*\}\s*from\s*["']@react-three\/drei["']/;
    const jsx = /<Html[\s/>]/;
    const offenders = sceneFiles().filter(
      (f) => f !== "SceneOverlay.tsx" && (imports.test(code(f)) || jsx.test(code(f))),
    );
    // A raw `<Html>` is interactive by default, sits over a building, and breaks dragging without
    // breaking anything a test would otherwise notice. Use `SceneOverlay`.
    expect(offenders).toEqual([]);
  });

  it("still has the two overlays the floor is supposed to have", () => {
    // Guards the guard: an assertion that only ever passes because nothing uses `<Html>` at all
    // would keep passing after the labels were deleted.
    const users = sceneFiles().filter((f) => /<SceneOverlay\b/.test(code(f)));
    expect(users.sort()).toEqual(["Agents.tsx", "Building.tsx"]);
  });

  it("does not let a caller re-enable pointer events through the props it forwards", () => {
    // `style` and `wrapperClass` are omitted from the component's prop type; TypeScript enforces
    // that at build time (`pnpm -F @superfabric/web build` type-checks), and this pins the intent
    // so the Omit is not "tidied away" later.
    const src = read("SceneOverlay.tsx");
    expect(src).toMatch(/Omit<\s*ComponentProps<typeof Html>,\s*"style" \| "wrapperClass"\s*>/);
  });
});
