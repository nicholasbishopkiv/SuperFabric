import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

/**
 * The real handshake, end to end: starts the actual server on a spare port with a throwaway data
 * directory and checks which browser origins get in. No prompts are ever sent — an idle server
 * spawns no CLI and spends no quota. The origin policy itself is unit-tested in origin.test.ts.
 */

const PORT = 4711;
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let child: ChildProcessWithoutNullStreams;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "superfabric-wsorigin-"));
  child = spawn(process.execPath, ["--import", "tsx", join(serverRoot, "src/index.ts")], {
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

function handshake(origin: string): Promise<{ opened: boolean; status?: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin });
    const timer = setTimeout(() => { ws.terminate(); rejectPromise(new Error("handshake timed out")); }, 10_000);
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      ws.terminate();
      resolvePromise({ opened: false, status: res.statusCode });
    });
    ws.on("open", () => { clearTimeout(timer); resolvePromise({ opened: true }); ws.close(); });
    ws.on("error", (err) => { clearTimeout(timer); rejectPromise(err); });
  });
}

describe("ws handshake origin policy (real server)", () => {
  it("rejects a drive-by website with 403", async () => {
    const res = await handshake("https://evil.example.com");
    expect(res.opened).toBe(false);
    expect(res.status).toBe(403);
  });

  it("accepts the Vite dev origin and serves it", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin: "http://localhost:5173" });
    const sessions = await new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => { ws.terminate(); rejectPromise(new Error("no reply")); }, 10_000);
      ws.on("open", () => ws.send(JSON.stringify({ kind: "list_sessions" })));
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { kind: string; sessions?: unknown };
        if (msg.kind !== "sessions") return;
        clearTimeout(timer);
        resolvePromise(msg.sessions);
        ws.close();
      });
      ws.on("error", (err) => { clearTimeout(timer); rejectPromise(err); });
    });
    expect(Array.isArray(sessions)).toBe(true);
  });

  it("accepts a client that sends no Origin header at all", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => { ws.terminate(); rejectPromise(new Error("handshake timed out")); }, 10_000);
      ws.on("open", () => { clearTimeout(timer); resolvePromise(); ws.close(); });
      ws.on("error", (err) => { clearTimeout(timer); rejectPromise(err); });
    });
  });
});
