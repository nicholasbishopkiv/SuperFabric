import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNNER_PROTOCOL_VERSION,
  RUNNER_SOCKET_FILE,
  RunnerServerMessage,
  type RunnerMessage,
  type SessionEvent,
} from "@superfabric/shared";
import { RunnerHub } from "../src/runnerHub.js";
import { startRunnerListener, type RunnerListener } from "../src/runnerListener.js";
import { waitFor } from "./_waitFor.js";

/**
 * The transport itself, over a real unix socket and a real WebSocket.
 *
 * `runnerHub.test.ts` proves the protocol with the socket taken away; this proves the socket. It is
 * the one place the decision that unblocked M4 is actually executed — Bun's `WebSocket` dialling
 * `ws+unix://`, and `ws` serving it off a bare `node:http` server — because that pairing is the
 * thing a Bun or `ws` upgrade could break, and it would break silently everywhere else (a container
 * that never attaches looks like a hundred other problems).
 *
 * A container is deliberately not involved: `docker run` in a unit test would need an image, a
 * daemon and two minutes. What the container adds over this is a bind mount, and `acceptance` in
 * `docs/ROADMAP.md` records that leg being run for real.
 */

const dirs: string[] = [];
const listeners: RunnerListener[] = [];

afterAll(async () => {
  for (const l of listeners) await l.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function serve(hub: RunnerHub): Promise<RunnerListener> {
  const dir = mkdtempSync(join(tmpdir(), "sf-sock-"));
  dirs.push(dir);
  const listener = await startRunnerListener({ hub, socketDir: join(dir, "run"), socketFile: RUNNER_SOCKET_FILE });
  listeners.push(listener);
  return listener;
}

/** Dial the socket the way a runner does, and collect what comes back. */
function dial(socketPath: string): {
  ws: WebSocket;
  received: RunnerServerMessage[];
  send(msg: RunnerMessage): void;
  open: Promise<void>;
  closed: Promise<void>;
} {
  const received: RunnerServerMessage[] = [];
  const ws = new WebSocket(`ws+unix://${socketPath}:/runner`);
  const open = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("the socket refused the connection")));
  });
  const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));
  ws.addEventListener("message", (ev: MessageEvent) => {
    received.push(RunnerServerMessage.parse(JSON.parse(String(ev.data))));
  });
  return { ws, received, send: (msg) => ws.send(JSON.stringify(msg)), open, closed };
}

describe("the runner socket", () => {
  it("is a 0600 socket a runner can dial, hello over, and stream events through", async () => {
    const hub = new RunnerHub();
    const events: SessionEvent[] = [];
    hub.register({
      id: "att-1",
      token: "s3cret",
      events: {
        onEvent: (e) => events.push(e),
        onProviderSession: () => {},
        requestApproval: async () => "deny",
      },
    });
    const listener = await serve(hub);

    // The filesystem is the first gate: the user the server runs as, and nobody else.
    const mode = statSync(listener.socketPath).mode & 0o777;
    expect(mode).toBe(0o600);

    const conn = dial(listener.socketPath);
    await conn.open;
    conn.send({
      kind: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION, sessionId: "att-1", token: "s3cret",
    });
    await waitFor(() => expect(conn.received[0]).toEqual({ kind: "attached", ackedSeq: 0 }));

    conn.send({
      kind: "frame", seq: 1, body: { type: "event", event: { type: "agent_text", text: "over a socket" } },
    });
    await waitFor(() => expect(events).toEqual([{ type: "agent_text", text: "over a socket" }]));
    await waitFor(() => expect(conn.received).toContainEqual({ kind: "ack", seq: 1 }));
    conn.ws.close();
  });

  it("refuses a wrong token over the real socket and closes the connection", async () => {
    const hub = new RunnerHub();
    const events: SessionEvent[] = [];
    hub.register({
      id: "att-1",
      token: "the-real-token",
      events: {
        onEvent: (e) => events.push(e),
        onProviderSession: () => {},
        requestApproval: async () => "deny",
      },
    });
    const listener = await serve(hub);

    const conn = dial(listener.socketPath);
    await conn.open;
    conn.send({
      kind: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION, sessionId: "att-1", token: "guessed",
    });
    await conn.closed;
    expect(conn.received).toEqual([
      { kind: "fatal", message: "this server is not expecting that runner" },
    ]);
    // And nothing it went on to say was ever applied.
    expect(events).toEqual([]);
  });

  it("takes a socket file a killed server left behind rather than refusing to start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-sock-"));
    dirs.push(dir);
    const socketDir = join(dir, "run");
    const first = await startRunnerListener({ hub: new RunnerHub(), socketDir, socketFile: RUNNER_SOCKET_FILE });
    // A SIGKILL leaves the inode: closing the *server* without the cleanup `close()` does.
    expect(statSync(first.socketPath).isSocket()).toBe(true);

    const hub = new RunnerHub();
    const second = await startRunnerListener({ hub, socketDir, socketFile: RUNNER_SOCKET_FILE });
    listeners.push(second);
    const conn = dial(second.socketPath);
    await conn.open;
    conn.ws.close();
    await first.close().catch(() => {});
  });

  it("refuses a socket path longer than a unix socket may be, and says what to change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-sock-"));
    dirs.push(dir);
    const tooLong = join(dir, "x".repeat(120));
    await expect(startRunnerListener({
      hub: new RunnerHub(), socketDir: tooLong, socketFile: RUNNER_SOCKET_FILE,
    })).rejects.toThrow(/longer than a unix socket may be/);
  });
});
