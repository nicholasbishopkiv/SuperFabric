import { describe, expect, it } from "vitest";
import { collapseRuns } from "../src/hud/collapseRuns";

/**
 * The console's wall of forty identical `· starting` lines, reduced to arithmetic so it can be
 * tested without a canvas — the same reason `conveyorPath.ts` and `errands.ts` are pure.
 */
const key = (s: string) => s;

describe("collapseRuns", () => {
  it("returns nothing for nothing", () => {
    expect(collapseRuns([], key)).toEqual([]);
  });

  it("leaves a single row alone", () => {
    expect(collapseRuns(["a"], key)).toEqual([{ first: "a", count: 1, index: 0 }]);
  });

  it("collapses a run", () => {
    expect(collapseRuns(["a", "a", "a"], key)).toEqual([{ first: "a", count: 3, index: 0 }]);
  });

  it("keeps non-adjacent repeats apart, because folding them would reorder the transcript", () => {
    expect(collapseRuns(["a", "b", "a"], key)).toEqual([
      { first: "a", count: 1, index: 0 },
      { first: "b", count: 1, index: 1 },
      { first: "a", count: 1, index: 2 },
    ]);
  });

  it("collapses a run that ends the list", () => {
    expect(collapseRuns(["a", "b", "b"], key)).toEqual([
      { first: "a", count: 1, index: 0 },
      { first: "b", count: 2, index: 1 },
    ]);
  });

  it("collapses two runs in a row", () => {
    expect(collapseRuns(["a", "a", "b", "b", "b"], key)).toEqual([
      { first: "a", count: 2, index: 0 },
      { first: "b", count: 3, index: 2 },
    ]);
  });

  it("keeps the first row of a run, not the last, so its timestamp is when the run began", () => {
    const rows = [
      { id: 1, t: "x" },
      { id: 2, t: "x" },
    ];
    expect(collapseRuns(rows, (r) => r.t)[0].first.id).toBe(1);
  });

  it("indexes each run by where it starts in the input", () => {
    const runs = collapseRuns(["a", "a", "a", "b"], key);
    expect(runs.map((r) => r.index)).toEqual([0, 3]);
  });
});
