import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The regression guard for `Props.tsx` beside `props.ts`.
 *
 * Two modules in one directory whose paths differ only by case resolve to *one* file on macOS and
 * Windows, so `import { RoomProps } from "./Props"` silently loaded `props.ts` and the page died
 * with "does not provide an export named 'RoomProps'". Nothing catches it on a case-sensitive
 * filesystem: it builds, it tests, it ships, and it breaks on the next contributor's laptop. Hence
 * a test rather than a note.
 */

const SRC_DIR = join(import.meta.dirname, "../src");

const MODULE_EXT = /\.(tsx?|jsx?|mts|cts)$/;

/** Every module path under `src`, as `<dir>/<basename-without-extension>`. */
const modulePaths = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return modulePaths(full);
    if (!MODULE_EXT.test(entry.name)) return [];
    return [relative(SRC_DIR, full).replace(MODULE_EXT, "")];
  });

describe("module names", () => {
  it("has no two modules whose paths differ only by case", () => {
    const paths = modulePaths(SRC_DIR);

    // A scan that found nothing would pass this test forever without checking anything, and on the
    // filesystems where the bug lives it cannot be caught any other way — the two files cannot both
    // exist on the machine running the test, so this is the only proof the guard is looking at all.
    expect(paths.length).toBeGreaterThan(20);

    const byLowercase = new Map<string, string[]>();
    for (const path of paths) {
      const key = path.toLowerCase();
      byLowercase.set(key, [...(byLowercase.get(key) ?? []), path]);
    }

    const collisions = [...byLowercase.values()].filter((paths) => paths.length > 1);
    expect(collisions).toEqual([]);
  });
});
