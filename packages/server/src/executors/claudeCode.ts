
/**
 * Coarse classification of executor failures. Rate limits are the one class the runner has to
 * react to differently (back off / surface a wait-until), everything else is opaque.
 */
export function classifyExecutorError(err: unknown): "rate_limited" | "unknown" {
  const s = String(err).toLowerCase();
  return /429|rate.?limit|usage limit reached/.test(s) ? "rate_limited" : "unknown";
}
