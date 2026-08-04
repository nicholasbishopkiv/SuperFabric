import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { RUNNER_WS_PATH } from "@superfabric/shared";
import { WebSocketServer, type WebSocket } from "ws";
import type { RunnerHub } from "./runnerHub.js";

/**
 * Where containers reach the factory.
 *
 * **A unix socket, by default and by preference** — see `RUNNER_SOCKET_DIR` in
 * `@superfabric/shared` for the full argument. In one line: it needs nothing from the host's
 * network stack (the bridge-gateway route is blocked outright on any machine running `ufw`, and the
 * fix is a firewall rule that is the operator's to add, not ours), it adds no listener to a product
 * whose security posture is "bind loopback and nothing else", and it lets the container's own egress
 * allow-list stay strict because the container never needs a route back to us at all.
 *
 * A TCP listener is kept as an explicit, opt-in fallback for the case the socket cannot serve:
 * a remote or rootless Docker daemon that does not share this machine's filesystem. It is off unless
 * `SUPERFABRIC_RUNNER_TCP_PORT` is set, and the README says what firewall rule it then needs.
 */

/** The socket's own permissions: the user the server runs as, and nobody else. */
const SOCKET_MODE = 0o600;

/**
 * `sockaddr_un.sun_path` is 108 bytes on Linux (104 on macOS), and a path over it fails at `bind`
 * with a message that does not mention the length. Checked here so the operator is told what is
 * wrong and what to do, rather than being handed `ENAMETOOLONG` from inside `listen`.
 */
const MAX_SOCKET_PATH = 100;

export interface RunnerListenerOptions {
  hub: RunnerHub;
  /**
   * Directory the socket lives in — bind-mounted into every container, read-only. A directory of its
   * own (rather than the data directory itself) because a container must see the socket and *only*
   * the socket: the event log, the roles and the accounts' credentials all live in the data
   * directory, and none of them is any of a contained agent's business.
   */
  socketDir: string;
  socketFile: string;
  /** Opt-in TCP fallback. Omitted => no network listener exists at all. */
  tcpPort?: number;
  /**
   * What the TCP fallback binds to. `0.0.0.0` is the only address a container can reach over the
   * bridge, which is exactly why this is not the default transport.
   */
  tcpHost?: string;
  log?: (line: string) => void;
}

export interface RunnerListener {
  /** Absolute path of the socket, for the bind mount. */
  readonly socketPath: string;
  /** The TCP port actually listening, or null. */
  readonly tcpPort: number | null;
  close(): Promise<void>;
}

export async function startRunnerListener(opts: RunnerListenerOptions): Promise<RunnerListener> {
  const log = opts.log ?? (() => {});
  const socketPath = path.join(opts.socketDir, opts.socketFile);
  if (socketPath.length > MAX_SOCKET_PATH) {
    throw new Error(
      `the runner socket path is ${socketPath.length} characters (${socketPath}), which is longer `
      + `than a unix socket may be (${MAX_SOCKET_PATH}). Point SUPERFABRIC_DATA at a shorter path, `
      + "or set SUPERFABRIC_RUNNER_SOCKET_DIR",
    );
  }
  // 0700: the directory is mounted into containers read-only, so nothing in one can write here
  // anyway — this is about other users of the machine.
  mkdirSync(opts.socketDir, { recursive: true, mode: 0o700 });
  // A socket file left behind by a server that was killed rather than shut down. `bind` would fail
  // with EADDRINUSE on it, and it is ours: nothing else on the machine writes into this directory.
  if (existsSync(socketPath) && statSync(socketPath).isSocket()) rmSync(socketPath);

  const bound: Bound[] = [];
  const unix = await listen(opts, log, (s) => new Promise<void>((r) => s.listen(socketPath, () => r())));
  chmodSync(socketPath, SOCKET_MODE);
  bound.push(unix);
  log(`runners attach over ${socketPath}`);

  let tcpPort: number | null = null;
  if (opts.tcpPort !== undefined) {
    const host = opts.tcpHost ?? "0.0.0.0";
    const tcp = await listen(opts, log, (s) => new Promise<void>((r) => s.listen(opts.tcpPort!, host, () => r())));
    bound.push(tcp);
    tcpPort = opts.tcpPort;
    log(
      `runners may also attach over tcp ${host}:${opts.tcpPort} — this is a network listener `
      + "reachable from every container on this machine; the unix socket needs no such thing",
    );
  }

  return {
    socketPath,
    tcpPort,
    close: async () => {
      // `close()` on an HTTP server waits for every open connection, and a runner's connection is
      // open by definition — it is a long-lived socket that only ends when the container does. So
      // the sockets go first, exactly as the browser hub's shutdown does it: the containers are
      // already reconnecting, and the next boot's listener is what they will find.
      await Promise.all(bound.map(({ server, wss }) => new Promise<void>((resolve) => {
        wss.close(() => resolve());
        for (const client of wss.clients) client.terminate();
        server.close();
      })));
      // The socket file is ours and means "a server is listening here". Leaving it behind would tell
      // the next boot's cleanup that something is running when nothing is.
      try { if (existsSync(socketPath)) rmSync(socketPath); } catch { /* already gone */ }
    },
  };
}

/** One bound listener: the HTTP server, and the WebSocket server riding its upgrades. */
interface Bound {
  server: Server;
  wss: WebSocketServer;
}

/**
 * One HTTP server whose only purpose is to carry a WebSocket upgrade at `RUNNER_WS_PATH`.
 *
 * Not Fastify, and not the browser hub's server. Fastify because there is no HTTP surface here at
 * all — every other path answers 404 and always will. Not the browser hub's server because `ws`
 * attached with `{ server }` aborts any upgrade whose path it does not recognise, so two
 * `WebSocketServer`s on one HTTP server would each 400 the other's clients.
 */
function listen(
  opts: RunnerListenerOptions,
  log: (line: string) => void,
  bind: (server: Server) => Promise<void>,
): Promise<Bound> {
  const server = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("this endpoint serves the SuperFabric agent-runner protocol over a WebSocket\n");
  });
  const wss = new WebSocketServer({
    server,
    path: RUNNER_WS_PATH,
    // The largest legitimate frame is one `SessionEvent` — a tool result, at worst. The same 1 MiB
    // the browser hub uses, and for the same reason: it is handed straight to `JSON.parse`.
    maxPayload: 1024 * 1024,
    // Deliberately **no** origin check. A runner is not a browser and sends no `Origin`; the
    // allow-list in `origin.ts` exists to stop a web page driving the operator's agents, and it has
    // nothing to say about a program. What guards this listener is the filesystem (the socket is
    // 0600) and the per-container token — see `RunnerHub.authenticate`.
  });
  wss.on("connection", (sock: WebSocket) => {
    const handlers = opts.hub.attach({
      send: (data) => sock.send(data),
      close: () => sock.close(),
    });
    sock.on("message", (raw) => handlers.message(raw.toString()));
    sock.on("close", () => handlers.close());
    sock.on("error", () => handlers.close());
  });
  server.on("error", (err) => log(`runner listener error: ${String(err)}`));
  return bind(server).then(() => ({ server, wss }));
}
