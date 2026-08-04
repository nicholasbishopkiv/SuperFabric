import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@superfabric/shared";

/**
 * The client is module-scoped (one socket per tab), so every case re-imports it fresh against a
 * fake WebSocket. What matters here is the gap half of I1: a hole in the tail must trigger a
 * resubscribe from the last contiguous seq, and a contiguous tail must not.
 */

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  readonly sent: ClientMessage[] = [];
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(raw: string): void { this.sent.push(JSON.parse(raw) as ClientMessage); }
  close(): void { this.readyState = 3; }
  deliver(msg: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

const globals = globalThis as unknown as Record<string, unknown>;

async function freshClient() {
  vi.resetModules();
  FakeWebSocket.instances = [];
  globals.WebSocket = FakeWebSocket;
  globals.location = { protocol: "http:", host: "localhost:5173" };
  const store = await import("../src/store");
  store.useFabric.setState({
    ...store.initialFabricState,
    events: {}, lastSeq: {}, contiguousSeq: {}, needsResync: {}, sessions: [],
  });
  const client = await import("../src/wsClient");
  client.connect();
  const sock = FakeWebSocket.instances[0]!;
  sock.onopen?.();
  return { client, store, sock };
}

const event = (seq: number): ServerMessage => ({
  kind: "event", sessionId: "s", seq, event: { type: "agent_text", text: `#${seq}` },
});

const subscribes = (sock: FakeWebSocket) =>
  sock.sent.filter((m): m is Extract<ClientMessage, { kind: "subscribe" }> => m.kind === "subscribe");

beforeEach(() => { FakeWebSocket.instances = []; });
afterEach(() => { delete globals.WebSocket; delete globals.location; });

describe("wsClient", () => {
  it("asks for the whole floor on open: sessions, rooms, bus traffic and the board", async () => {
    const { sock } = await freshClient();
    // The bus's snapshot is part of the floor: a message queued for a busy room is drawn on it, and
    // this answer is the baseline that stops later broadcasts replaying old deliveries as packages.
    // The board is server state too — a reload must not have to wait for a task to change.
    // Projects come first: the answer says which factory this socket is on, and every list that
    // follows is scoped to it.
    expect(sock.sent.map((m) => m.kind))
      .toEqual(["list_projects", "list_sessions", "list_rooms", "list_messages", "list_tasks",
        "list_accounts"]);
  });

  it("re-asks for the floor after a reconnect", async () => {
    const { client, sock } = await freshClient();
    sock.onclose?.();
    vi.useFakeTimers();
    try {
      client.connect();
    } finally {
      vi.useRealTimers();
    }
    const reconnected = FakeWebSocket.instances.at(-1)!;
    reconnected.onopen?.();
    expect(reconnected.sent.map((m) => m.kind)).toContain("list_rooms");
  });
});

describe("wsClient projects", () => {
  it("open_project forgets the sessions this tab was following", async () => {
    const { client, sock } = await freshClient();
    client.subscribe("s");
    client.openProject("p2");
    expect(sock.sent.at(-1)).toEqual({ kind: "open_project", projectId: "p2" });

    // Those transcripts belong to the floor we just left; a reconnect must not ask for them again.
    sock.onclose?.();
    vi.useFakeTimers();
    try { client.connect(); } finally { vi.useRealTimers(); }
    const reconnected = FakeWebSocket.instances.at(-1)!;
    reconnected.onopen?.();
    expect(subscribes(reconnected)).toEqual([]);
  });

  it("create_project sends the root, and a name only when there is one", async () => {
    const { client, sock } = await freshClient();
    client.createProject("/code/shop");
    expect(sock.sent.at(-1)).toEqual({ kind: "create_project", root: "/code/shop" });
    client.createProject("/code/shop", "Shop");
    expect(sock.sent.at(-1)).toEqual({ kind: "create_project", root: "/code/shop", name: "Shop" });
    client.createProject("/code/shop", "");
    expect(sock.sent.at(-1)).toEqual({ kind: "create_project", root: "/code/shop" });
  });
});

describe("wsClient chronicle", () => {
  it("records the question before sending it, so the answer can be recognised", async () => {
    const { client, store, sock } = await freshClient();
    client.searchChronicle("webhook");
    expect(sock.sent.at(-1)).toEqual({ kind: "search_chronicle", query: "webhook" });
    expect(store.useFabric.getState().chronicle).toMatchObject({ asked: "webhook", answered: null });

    sock.deliver({
      kind: "chronicle",
      query: "webhook",
      hits: [{
        kind: "decision", title: "Retries live in payments", snippet: "…", createdAt: 1_800_000_000,
        ref: "d1", seq: 0, roomId: null, path: "/p/docs/decisions/0001-retries.md",
      }],
    });
    expect(store.useFabric.getState().chronicle.hits).toHaveLength(1);
  });

  it("asks for the newest decisions with an empty query", async () => {
    const { client, sock } = await freshClient();
    client.searchChronicle("");
    expect(sock.sent.at(-1)).toEqual({ kind: "search_chronicle", query: "" });
  });
});

describe("wsClient gap handling", () => {
  it("does not resubscribe while the tail is contiguous", async () => {
    const { client, sock } = await freshClient();
    client.subscribe("s");
    expect(subscribes(sock)).toEqual([{ kind: "subscribe", sessionId: "s", afterSeq: 0 }]);

    sock.deliver(event(1));
    sock.deliver(event(2));
    sock.deliver(event(3));
    expect(subscribes(sock)).toHaveLength(1);
  });

  it("resubscribes from the last contiguous seq when a gap appears, once per gap", async () => {
    const { client, store, sock } = await freshClient();
    client.subscribe("s");
    sock.deliver(event(1));
    sock.deliver(event(2));
    sock.deliver(event(5)); // 3 and 4 were lost

    expect(subscribes(sock).at(-1)).toEqual({ kind: "subscribe", sessionId: "s", afterSeq: 2 });
    // a still-open gap must not produce one subscribe per subsequent event
    sock.deliver(event(6));
    expect(subscribes(sock)).toHaveLength(2);

    // the server replays the hole; a partial fill moves the contiguous point, so the client may
    // ask once more from there — bounded by the size of the hole, never one per event
    sock.deliver(event(3));
    expect(subscribes(sock).at(-1)).toEqual({ kind: "subscribe", sessionId: "s", afterSeq: 3 });
    sock.deliver(event(4));
    expect(store.useFabric.getState().needsResync["s"]).toBe(false);
    expect(store.useFabric.getState().events["s"].map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    // no further asks once the log is whole again
    const asks = subscribes(sock).length;
    sock.deliver(event(7));
    expect(subscribes(sock)).toHaveLength(asks);
    expect(subscribes(sock).map((m) => m.afterSeq)).toEqual([0, 2, 3]);
  });

  it("resubscribes from the contiguous seq (not the highest applied) after a reconnect", async () => {
    const { client, sock } = await freshClient();
    client.subscribe("s");
    sock.deliver(event(1));
    sock.deliver(event(3));

    sock.onclose?.();
    // the retry is on a timer; drive the reconnect directly instead of waiting on it
    vi.useFakeTimers();
    try {
      client.connect();
    } finally {
      vi.useRealTimers();
    }
    const reconnected = FakeWebSocket.instances.at(-1)!;
    expect(reconnected).not.toBe(sock);
    reconnected.onopen?.();
    expect(subscribes(reconnected)).toEqual([{ kind: "subscribe", sessionId: "s", afterSeq: 1 }]);
  });
});
