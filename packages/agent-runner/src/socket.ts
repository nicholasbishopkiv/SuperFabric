/**
 * The socket, as a seam.
 *
 * The runner's whole job is protocol behaviour under a socket that comes and goes, so the socket is
 * the thing the tests have to be able to take away at an awkward moment. An interface with one real
 * implementation costs a file and buys a reconnect test that runs in milliseconds with no server,
 * no container and no timing luck — the same trade the executor already makes with its injected
 * `query`.
 */

export interface RunnerSocket {
  /** Best-effort: a send on a socket that has already gone is a no-op, not a throw. */
  send(data: string): void;
  close(): void;
}

export interface RunnerSocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  /** The connection is gone, for any reason. The runner backs off and tries again. */
  onClose(): void;
}

export type ConnectFn = (url: string, handlers: RunnerSocketHandlers) => RunnerSocket;

/**
 * The real thing, over Bun's global `WebSocket` client.
 *
 * `onClose` is called at most once and covers the error path too: for the runner's purposes a
 * socket that errored and a socket that closed are the same event — reconnect — and a client that
 * reacted to both would double its backoff schedule.
 */
export const connectWebSocket: ConnectFn = (url, handlers) => {
  const ws = new WebSocket(url);
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    handlers.onClose();
  };
  ws.addEventListener("open", () => handlers.onOpen());
  ws.addEventListener("message", (ev: MessageEvent) => {
    handlers.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
  });
  ws.addEventListener("close", finish);
  ws.addEventListener("error", finish);
  return {
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close: () => ws.close(),
  };
};
