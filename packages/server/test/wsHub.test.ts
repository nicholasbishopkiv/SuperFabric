import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { SessionManager } from "../src/sessionManager.js";
import { FakeExecutor } from "../src/executors/fake.js";
import { WsHub, type SocketLike } from "../src/wsHub.js";

function fakeSocket() {
  const sent: any[] = [];
  const sock: SocketLike = { send: (d: string) => sent.push(JSON.parse(d)) };
  return { sock, sent };
}

describe("WsHub", () => {
  it("replays events after subscribe and tails new ones", async () => {
    const db = openDb(":memory:");
    const store = new EventStore(db);
    const exec = new FakeExecutor();
    const mgr = new SessionManager(db, store, exec);
    const hub = new WsHub(store, mgr);
    const id = mgr.createSession("/tmp");
    mgr.prompt(id, "first");
    await exec.settle();

    const { sock, sent } = fakeSocket();
    hub.attach(sock);
    hub.handleMessage(sock, JSON.stringify({ kind: "subscribe", sessionId: id, afterSeq: 0 }));
    const replayed = sent.filter(m => m.kind === "event").length;
    expect(replayed).toBeGreaterThan(0);

    hub.handleMessage(sock, JSON.stringify({ kind: "prompt", sessionId: id, text: "second" }));
    await exec.settle();
    const total = sent.filter(m => m.kind === "event").length;
    expect(total).toBeGreaterThan(replayed);
    // seq strictly increasing, no duplicates
    const seqs = sent.filter(m => m.kind === "event").map(m => m.seq);
    expect([...new Set(seqs)].length).toBe(seqs.length);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  });

  it("routes create_session, list_sessions, approval, and interrupt messages", async () => {
    const db = openDb(":memory:");
    const store = new EventStore(db);
    const exec = new FakeExecutor({ script: [{ tool: "Bash", input: {} }] });
    const mgr = new SessionManager(db, store, exec);
    const hub = new WsHub(store, mgr);
    const { sock, sent } = fakeSocket();
    hub.attach(sock);

    hub.handleMessage(sock, JSON.stringify({ kind: "create_session", cwd: "/tmp" }));
    const sessionsMsg = sent.find(m => m.kind === "sessions");
    expect(sessionsMsg).toBeTruthy();
    const id = sessionsMsg.sessions[0].id;

    hub.handleMessage(sock, JSON.stringify({ kind: "list_sessions" }));
    expect(sent.filter(m => m.kind === "sessions").length).toBeGreaterThanOrEqual(2);

    hub.handleMessage(sock, JSON.stringify({ kind: "prompt", sessionId: id, text: "run it" }));
    await new Promise(r => setTimeout(r, 20));
    const approvalEvent = sent.find(m => m.kind === "event" && m.event.type === "approval_request");
    expect(approvalEvent).toBeTruthy();
    hub.handleMessage(sock, JSON.stringify({ kind: "approval", sessionId: id, approvalId: approvalEvent.event.approvalId, behavior: "allow" }));
    await exec.settle();
    expect(sent.some(m => m.kind === "event" && m.event.type === "approval_resolved")).toBe(true);

    hub.handleMessage(sock, JSON.stringify({ kind: "interrupt", sessionId: id }));
  });

  it("sends an error message for malformed input", () => {
    const db = openDb(":memory:");
    const store = new EventStore(db);
    const exec = new FakeExecutor();
    const mgr = new SessionManager(db, store, exec);
    const hub = new WsHub(store, mgr);
    const { sock, sent } = fakeSocket();
    hub.attach(sock);
    hub.handleMessage(sock, "not json");
    expect(sent.some(m => m.kind === "error")).toBe(true);
  });
});
