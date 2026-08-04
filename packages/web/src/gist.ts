/**
 * One line about a tool call, for the two surfaces that show what an agent is doing: the console's
 * transcript and the thought bubble over the figure's head.
 *
 * It lives here rather than in either of them because there must be **one** answer. A second
 * summariser would drift from the first, and then the same `Bash` call would read one way in the
 * drawer and another on the floor — which is worse than either version alone, because the operator
 * would have to work out which of the two to believe.
 */

/**
 * The interesting field of a tool's input, in the order an operator would want it.
 *
 * A tool's input is arbitrary JSON and most of it is noise: what says *what the agent is doing* is the
 * command it is running, the file it is touching, the pattern it is looking for. The fallback is the
 * whole object, flattened — ugly, but never a lie about there being nothing there.
 */
export function toolGist(input: unknown, max = 120): string {
  if (input === null || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "description"]) {
    const v = o[key];
    if (typeof v === "string" && v !== "") return truncate(v, max);
  }
  return truncate(JSON.stringify(o), max);
}

/** One line, at most `max` characters, with an ellipsis where it was cut. */
export function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
