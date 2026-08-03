import type { ClientMessage, ServerMessage } from "@superfabric/shared";
import { useFabric } from "./store";

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5_000;

let sock: WebSocket | null = null;
let reconnectDelayMs = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Sessions this tab wants to follow; replayed from `contiguousSeq` on every (re)connect. */
const subscribed = new Set<string>();
/** `sessionId:contiguousSeq` we already asked the server to resend from, so a gap is chased once. */
const resyncAsked = new Set<string>();

export function send(msg: ClientMessage): void {
  if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
}

export function connect(): void {
  if (sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${scheme}//${location.host}/ws`);
  sock = ws;

  ws.onopen = () => {
    reconnectDelayMs = RECONNECT_MIN_MS;
    useFabric.getState().setConnected(true);
    send({ kind: "list_sessions" });
    // The server hard-terminates sockets on shutdown, so a reconnect must re-ask for the tail of
    // every session we were following — from the last contiguous seq we hold, not from 0.
    const { contiguousSeq } = useFabric.getState();
    for (const sessionId of subscribed) {
      send({ kind: "subscribe", sessionId, afterSeq: contiguousSeq[sessionId] ?? 0 });
    }
  };

  ws.onmessage = (e) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(e.data)) as ServerMessage;
    } catch {
      return;
    }
    useFabric.getState().apply(msg);
    if (msg.kind === "event") resyncIfGapped(msg.sessionId);
  };

  ws.onclose = () => {
    if (sock === ws) sock = null;
    useFabric.getState().setConnected(false);
    scheduleReconnect();
  };

  // A failed connect fires error then close; close drives the retry, so nothing to do here.
  ws.onerror = () => {};
}

export function subscribe(sessionId: string): void {
  subscribed.add(sessionId);
  const { contiguousSeq } = useFabric.getState();
  send({ kind: "subscribe", sessionId, afterSeq: contiguousSeq[sessionId] ?? 0 });
}

/**
 * The tail can drop frames (the server only advances its watermark on a successful send, but a
 * reconnect or a slow socket can still leave a hole). When the store reports a gap, re-subscribe
 * from the last contiguous seq so the log fills it in. Asked once per gap point, so a still-open
 * gap does not produce one subscribe per subsequent event.
 */
function resyncIfGapped(sessionId: string): void {
  const { needsResync, contiguousSeq } = useFabric.getState();
  if (needsResync[sessionId] !== true) return;
  const from = contiguousSeq[sessionId] ?? 0;
  const key = `${sessionId}:${from}`;
  if (resyncAsked.has(key)) return;
  resyncAsked.add(key);
  send({ kind: "subscribe", sessionId, afterSeq: from });
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}
