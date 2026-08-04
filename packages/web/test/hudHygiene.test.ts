import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Properties of the HUD that are easy to state and easy to lose, checked against the source in the
 * idiom of `sceneOverlay.test.ts` — this package mounts no components, so the source is what there
 * is to test.
 */

const HUD_DIR = join(import.meta.dirname, "../src/hud");
const hudFiles = (): string[] => readdirSync(HUD_DIR).filter((f) => f.endsWith(".tsx"));
const read = (file: string): string => readFileSync(join(HUD_DIR, file), "utf8");

/**
 * Every JSX opening tag in a file, with the text of its attributes and the line it starts on.
 *
 * Attribute-aware rather than line-based, because the thing being tested is *which element* carries
 * an attribute, and a prop is regularly several lines below the tag it belongs to. Brace depth is
 * tracked so a `>` inside an expression (`{a > b}`, an arrow function) does not end the tag early.
 */
function openingTags(src: string): { tag: string; attrs: string; line: number }[] {
  const found: { tag: string; attrs: string; line: number }[] = [];
  for (const match of src.matchAll(/<([A-Za-z][\w.]*)/g)) {
    let i = match.index + match[0].length;
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
      i++;
    }
    found.push({
      tag: match[1],
      attrs: src.slice(match.index + match[0].length, i),
      line: src.slice(0, match.index).split("\n").length,
    });
  }
  return found;
}

/**
 * A `title` attribute becomes a native tooltip only on a **DOM** element. On one of our own
 * components it is an ordinary prop whose meaning that component defines — `PanelSection title=` is
 * a section heading, and `Button`/`Badge` route theirs into a real tooltip — so flagging those would
 * be flagging correct code. JSX's own rule tells the two apart: lowercase is the DOM.
 */
/**
 * The palette invariant, made mechanical.
 *
 * Semantic colours are generated from `scene/palette.ts` by `hud/tokens.ts` and referenced as
 * Tailwind tokens (`text-status-blocked`) or imported as values (`STATUS_COLOR.blocked`). A hex
 * typed into the HUD is how a room's dot in a panel ends up disagreeing with its beacon on the roof
 * — the exact drift the two-file arrangement exists to make impossible.
 *
 * `rgba(…)` is deliberately not caught: the panel chrome's inset highlight is a neutral, it means
 * nothing, and it is not in the palette's vocabulary at all.
 */
describe("the HUD never retypes a palette colour", () => {
  it.each(hudFiles())("%s carries no literal hex", (file) => {
    const offenders = read(file)
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /#[0-9a-fA-F]{3,8}\b/.test(line))
      .filter(([, line]) => !/^\s*(\*|\/\/)/.test(line))
      .map(([n, line]) => `${n}: ${line.trim()}`);
    expect(
      offenders,
      `${file}: semantic colours come from scene/palette.ts through hud/tokens.ts. Reference a token `
        + `(text-status-blocked) or import STATUS_COLOR — a retyped hex is how a room's dot in a `
        + `panel ends up disagreeing with its beacon on the roof.`,
    ).toEqual([]);
  });
});

describe("no native tooltips survive in the HUD", () => {
  it.each(hudFiles())("%s puts no title= on a DOM element", (file) => {
    const offenders = openingTags(read(file))
      .filter((t) => t.tag[0] === t.tag[0].toLowerCase())
      .filter((t) => /\stitle=/.test(t.attrs))
      .map((t) => `${t.line}: <${t.tag}>`);
    expect(
      offenders,
      `${file}: a native title= cannot be styled, waits about a second, never appears on touch and `
        + `is invisible to a screenshot — which matters because half of what this HUD explains in a `
        + `tooltip is why a number is approximate. Wrap it in <Hint text="…"> from ui/tooltip, and `
        + `keep any aria-label: a tooltip is not an accessible name.`,
    ).toEqual([]);
  });
});
