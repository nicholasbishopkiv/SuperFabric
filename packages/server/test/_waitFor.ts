/**
 * Poll `fn` until it stops throwing, or give up. `bun:test`'s `vi` shim has no `vi.waitFor`,
 * and this is the only thing the suite used it for: assert-and-retry on asynchronous side
 * effects (an event appended, a row persisted) without sleeping for a fixed guess.
 */
export async function waitFor(fn: () => void | Promise<void>, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < timeoutMs) {
    try {
      await fn();
      return;
    } catch (e) {
      last = e;
      await new Promise(r => setTimeout(r, 10));
    }
  }
  throw last ?? new Error("waitFor timed out");
}
