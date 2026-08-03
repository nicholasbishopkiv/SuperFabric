/**
 * WebSocket origin policy.
 *
 * Browsers do not apply CORS to WebSocket handshakes: without an explicit check, *any* page the
 * operator happens to visit can open a socket to 127.0.0.1:<port>, create a session with an
 * arbitrary cwd, prompt the agent and approve its own tool calls — arbitrary code execution as the
 * operator, on the operator's subscription. So the handshake is allow-listed:
 *
 * - the server's own origin (`http://127.0.0.1:<port>` / `http://localhost:<port>`), which is how
 *   the built UI is served;
 * - the Vite dev server (`http://localhost:5173` / `http://127.0.0.1:5173`);
 * - anything in `SUPERFABRIC_ALLOWED_ORIGINS` (comma-separated), for a custom dev port or a
 *   reverse proxy in front of the server.
 *
 * A missing or empty `Origin` header is ALLOWED: non-browser clients (the `ws` CLI, curl, our own
 * test scripts, future SuperFabric tooling) send none, while browsers always send one. That keeps
 * local tooling working and still closes the drive-by-website vector, which is what the header can
 * actually tell us apart. It is not an authentication mechanism — see the README's Security note.
 */

const VITE_DEV_PORT = 5173;

export function allowedOrigins(port: number, extra?: string): Set<string> {
  const set = new Set<string>();
  for (const host of ["127.0.0.1", "localhost"]) {
    set.add(`http://${host}:${port}`);
    set.add(`http://${host}:${VITE_DEV_PORT}`);
  }
  for (const raw of (extra ?? "").split(",")) {
    const o = raw.trim().toLowerCase();
    if (o !== "") set.add(o);
  }
  return set;
}

/** `origin` is the raw `Origin` header, absent for non-browser clients. */
export function isOriginAllowed(origin: string | undefined | null, port: number, extra?: string): boolean {
  if (origin === undefined || origin === null || origin.trim() === "") return true;
  return allowedOrigins(port, extra).has(origin.trim().toLowerCase());
}
