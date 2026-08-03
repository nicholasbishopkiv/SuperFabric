import { beforeEach, describe, expect, it } from "vitest";
import { initialFabricState, useFabric } from "../src/store";

const apply = (msg: Parameters<ReturnType<typeof useFabric.getState>["apply"]>[0]) =>
  useFabric.getState().apply(msg);

beforeEach(() => {
  useFabric.setState({ ...initialFabricState, events: {}, lastSeq: {}, sessions: [] });
});

describe("event store", () => {
  it("ignores duplicate and older seqs on replay", () => {
    apply({ kind: "event", sessionId: "s", seq: 1, event: { type: "agent_text", text: "a" } });
    apply({ kind: "event", sessionId: "s", seq: 1, event: { type: "agent_text", text: "a" } });
    apply({ kind: "event", sessionId: "s", seq: 2, event: { type: "agent_text", text: "b" } });
    apply({ kind: "event", sessionId: "s", seq: 1, event: { type: "agent_text", text: "a" } });

    const { events, lastSeq } = useFabric.getState();
    expect(events["s"].map((r) => r.seq)).toEqual([1, 2]);
    expect(events["s"].map((r) => (r.event as { text: string }).text)).toEqual(["a", "b"]);
    expect(lastSeq["s"]).toBe(2);
  });

  it("keeps events from different sessions apart", () => {
    apply({ kind: "event", sessionId: "a", seq: 1, event: { type: "agent_text", text: "from a" } });
    apply({ kind: "event", sessionId: "b", seq: 1, event: { type: "agent_text", text: "from b" } });
    apply({ kind: "event", sessionId: "b", seq: 2, event: { type: "user_prompt", text: "hi b" } });

    const { events, lastSeq } = useFabric.getState();
    expect(events["a"]).toHaveLength(1);
    expect(events["b"]).toHaveLength(2);
    expect(lastSeq).toEqual({ a: 1, b: 2 });
  });

  it("replaces the session list on a sessions message", () => {
    useFabric.setState({
      sessions: [{ id: "old", state: "done", claudeSessionId: null, lastSeq: 3 }],
    });

    apply({
      kind: "sessions",
      sessions: [
        { id: "s1", state: "active", claudeSessionId: "c1", lastSeq: 7 },
        { id: "s2", state: "paused", claudeSessionId: null, lastSeq: 0 },
      ],
    });

    expect(useFabric.getState().sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("surfaces server errors in lastError", () => {
    expect(useFabric.getState().lastError).toBeNull();
    apply({ kind: "error", message: "bad message" });
    expect(useFabric.getState().lastError).toBe("bad message");
  });

  it("leaves unrelated state untouched when an event is deduped", () => {
    apply({ kind: "event", sessionId: "s", seq: 5, event: { type: "agent_text", text: "x" } });
    const before = useFabric.getState().events;

    apply({ kind: "event", sessionId: "s", seq: 5, event: { type: "agent_text", text: "x" } });

    // Same object identity: a deduped replay must not churn React subscribers.
    expect(useFabric.getState().events).toBe(before);
  });
});
