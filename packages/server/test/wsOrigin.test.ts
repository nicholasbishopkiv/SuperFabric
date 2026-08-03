import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The real handshake, end to end: starts the actual server on a spare port with a throwaway data
 * directory and checks which browser origins get in. No prompts are ever sent — an idle server
 * spawns no CLI and spends no quota. The origin policy itself is unit-tested in origin.test.ts.
 *
 * The upgrade requests are written by hand over a socket rather than through a WebSocket client,
 * for two reasons: it is the only way to assert the exact HTTP status a rejected handshake gets
 * (a client only ever reports an opaque failure), and Bun's `ws` compatibility shim silently
 * drops the `origin` option — a test built on it would send no `Origin` at all and pass while
 * checking nothing. The acceptance case still uses a real WebSocket, so the server is proved to
 * both let the origin in and answer it.
 */

const PORT = 4711;
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let child: ChildProcessWithoutNullStreams;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "superfabric-wsorigin-"));
  // Bun runs the TypeScript entrypoint directly — no build step and no loader flag.
  child = spawn("bun", [join(serverRoot, "src/index.ts")], {
    cwd: serverRoot,
    env: { ...process.env, PORT: String(PORT), SUPERFABRIC_DATA: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  let log = "";
  child.stdout.on("data", (d: Buffer) => { log += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { log += d.toString(); });

  const deadline = Date.now() + 30_000;
  while (!log.includes("listening on")) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    if (Date.now() > deadline) throw new Error(`server did not start in time:\n${log}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}, 40_000);

afterAll(async () => {
  child?.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 50));
  if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Send a valid WebSocket upgrade request and report the status the server replied with:
 * 101 when the handshake was accepted, anything else when it was refused. `origin === undefined`
 * omits the header entirely, which is exactly what a non-browser client does.
 */
function handshakeStatus(origin: string | undefined): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const sock = connect(PORT, "127.0.0.1");
    const timer = setTimeout(() => { sock.destroy(); rejectPromise(new Error("handshake timed out")); }, 10_000);
    const done = (fn: () => void) => { clearTimeout(timer); sock.destroy(); fn(); };

    sock.on("connect", () => {
      const lines = [
        "GET /ws HTTP/1.1",
        `Host: 127.0.0.1:${PORT}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        ...(origin === undefined ? [] : [`Origin: ${origin}`]),
      ];
      sock.write(`${lines.join("\r\n")}\r\n\r\n`);
    });

    let head = "";
    sock.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const eol = head.indexOf("\r\n");
      if (eol === -1) return;
      const status = Number(head.slice(0, eol).split(" ")[1]);
      done(() => (Number.isFinite(status) ? resolvePromise(status) : rejectPromise(new Error(`bad status line: ${head.slice(0, eol)}`))));
    });
    sock.on("error", (err) => done(() => rejectPromise(err)));
    sock.on("close", () => done(() => rejectPromise(new Error(`connection closed before a status line: ${JSON.stringify(head)}`))));
  });
}

describe("ws handshake origin policy (real server)", () => {
  it("rejects a drive-by website with 403", async () => {
    expect(await handshakeStatus("https://evil.example.com")).toBe(403);
  });

  it("accepts the Vite dev origin and serves it", async () => {
    expect(await handshakeStatus("http://localhost:5173")).toBe(101);

    // ...and the connection that gets in is a working one.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
      headers: { Origin: "http://localhost:5173" },
    } as unknown as string[]);
    const sessions = await new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => { ws.close(); rejectPromise(new Error("no reply")); }, 10_000);
      ws.addEventListener("open", () => ws.send(JSON.stringify({ kind: "list_sessions" })));
      ws.addEventListener("message", (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data)) as { kind: string; sessions?: unknown };
        if (msg.kind !== "sessions") return;
        clearTimeout(timer);
        resolvePromise(msg.sessions);
        ws.close();
      });
      ws.addEventListener("error", () => { clearTimeout(timer); rejectPromise(new Error("websocket error")); });
    });
    expect(Array.isArray(sessions)).toBe(true);
  });

  it("accepts a client that sends no Origin header at all", async () => {
    expect(await handshakeStatus(undefined)).toBe(101);
  });
});
