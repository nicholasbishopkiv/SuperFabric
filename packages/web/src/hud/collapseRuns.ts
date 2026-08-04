/**
 * Consecutive identical rows, folded into one row with a count.
 *
 * The console's worst reading was forty consecutive `· starting` lines at 11px, which is not a
 * transcript but a texture. Collapsing runs removes most of it while hiding nothing: the count says
 * exactly how many there were, and `first` is kept rather than `last` so the row's timestamp is when
 * the run *began* — which is the question someone scrolling back is actually asking.
 *
 * **Adjacent only, deliberately.** Folding non-adjacent repeats would reorder a transcript, and a
 * transcript whose order is a lie is worse than a long one.
 *
 * Pure, and in its own module, because this package mounts no components: a pure function is the one
 * thing a test here can check, which is why `conveyorPath.ts` and `errands.ts` are shaped the same
 * way.
 */
export interface Run<T> {
  first: T;
  count: number;
  /** Index of `first` in the input, so a caller can key on it without a second pass. */
  index: number;
}

export function collapseRuns<T>(rows: readonly T[], keyOf: (row: T) => string): Run<T>[] {
  const runs: Run<T>[] = [];
  let currentKey: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const key = keyOf(rows[i]);
    if (runs.length > 0 && key === currentKey) {
      runs[runs.length - 1].count++;
      continue;
    }
    runs.push({ first: rows[i], count: 1, index: i });
    currentKey = key;
  }
  return runs;
}
