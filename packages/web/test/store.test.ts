import { beforeEach, describe, expect, it } from "vitest";
import { initialFabricState, useFabric } from "../src/store";

const apply = (msg: Parameters<ReturnType<typeof useFabric.getState>["apply"]>[0]) =>
  useFabric.getState().apply(msg);

beforeEach(() => {
  useFabric.setState({
    ...initialFabricState,
    events: {}, lastSeq: {}, contiguousSeq: {}, needsResync: {}, sessions: [],
  });
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
      sessions: [{ id: "old", state: "done", claudeSessionId: null, lastSeq: 3, autonomy: "auto", roomId: null }],
    });

    apply({
      kind: "sessions",
      sessions: [
        { id: "s1", state: "active", claudeSessionId: "c1", lastSeq: 7, autonomy: "auto", roomId: null },
        { id: "s2", state: "paused", claudeSessionId: null, lastSeq: 0, autonomy: "attended", roomId: null },
      ],
    });

    expect(useFabric.getState().sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("reflects each session's autonomy from a sessions message", () => {
    apply({
      kind: "sessions",
      sessions: [
        { id: "s1", state: "active", claudeSessionId: "c1", lastSeq: 7, autonomy: "bypass", roomId: null },
        { id: "s2", state: "active", claudeSessionId: "c2", lastSeq: 1, autonomy: "attended", roomId: null },
      ],
    });
    expect(useFabric.getState().sessions.map((s) => [s.id, s.autonomy])).toEqual([
      ["s1", "bypass"],
      ["s2", "attended"],
    ]);

    // a later sessions message is the source of truth: a toggled mode replaces the old one
    apply({
      kind: "sessions",
      sessions: [
        { id: "s1", state: "active", claudeSessionId: "c1", lastSeq: 9, autonomy: "attended", roomId: null },
        { id: "s2", state: "active", claudeSessionId: "c2", lastSeq: 1, autonomy: "attended", roomId: null },
      ],
    });
    expect(useFabric.getState().sessions.find((s) => s.id === "s1")?.autonomy).toBe("attended");
  });

  it("surfaces server errors in lastError", () => {
    expect(useFabric.getState().lastError).toBeNull();
    apply({ kind: "error", message: "bad message" });
    expect(useFabric.getState().lastError).toBe("bad message");
  });

  it("does not flag a resync while the tail stays contiguous", () => {
    for (const seq of [1, 2, 3]) {
      apply({ kind: "event", sessionId: "s", seq, event: { type: "agent_text", text: `#${seq}` } });
    }
    const { needsResync, contiguousSeq, lastSeq } = useFabric.getState();
    expect(needsResync["s"]).toBe(false);
    expect(contiguousSeq["s"]).toBe(3);
    expect(lastSeq["s"]).toBe(3);
  });

  it("flags a resync when the tail skips a seq, and keeps the event", () => {
    apply({ kind: "event", sessionId: "s", seq: 1, event: { type: "agent_text", text: "a" } });
    apply({ kind: "event", sessionId: "s", seq: 3, event: { type: "agent_text", text: "c" } });

    const { needsResync, contiguousSeq, lastSeq, events } = useFabric.getState();
    expect(needsResync["s"]).toBe(true);
    // the resubscribe must ask from the last hole-free seq, not from the highest one applied
    expect(contiguousSeq["s"]).toBe(1);
    expect(lastSeq["s"]).toBe(3);
    expect(events["s"].map((r) => r.seq)).toEqual([1, 3]);
  });

  it("clears the resync flag once the gap is filled, in seq order", () => {
    apply({ kind: "event", sessionId: "s", seq: 1, event: { type: "agent_text", text: "a" } });
    apply({ kind: "event", sessionId: "s", seq: 4, event: { type: "agent_text", text: "d" } });
    expect(useFabric.getState().needsResync["s"]).toBe(true);

    // the replay the client asks for, arriving after the event that exposed the gap
    apply({ kind: "event", sessionId: "s", seq: 2, event: { type: "agent_text", text: "b" } });
    expect(useFabric.getState().needsResync["s"]).toBe(true);
    apply({ kind: "event", sessionId: "s", seq: 3, event: { type: "agent_text", text: "c" } });

    const { needsResync, contiguousSeq, events } = useFabric.getState();
    expect(needsResync["s"]).toBe(false);
    expect(contiguousSeq["s"]).toBe(4);
    expect(events["s"].map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(events["s"].map((r) => (r.event as { text: string }).text)).toEqual(["a", "b", "c", "d"]);
  });

  it("does not re-insert an event that already filled a gap", () => {
    apply({ kind: "event", sessionId: "s", seq: 1, event: { type: "agent_text", text: "a" } });
    apply({ kind: "event", sessionId: "s", seq: 3, event: { type: "agent_text", text: "c" } });
    apply({ kind: "event", sessionId: "s", seq: 3, event: { type: "agent_text", text: "c" } });
    expect(useFabric.getState().events["s"].map((r) => r.seq)).toEqual([1, 3]);
  });

  it("tracks gaps per session", () => {
    apply({ kind: "event", sessionId: "a", seq: 1, event: { type: "agent_text", text: "a1" } });
    apply({ kind: "event", sessionId: "b", seq: 2, event: { type: "agent_text", text: "b2" } });
    expect(useFabric.getState().needsResync).toEqual({ a: false, b: true });
  });

  it("leaves unrelated state untouched when an event is deduped", () => {
    apply({ kind: "event", sessionId: "s", seq: 5, event: { type: "agent_text", text: "x" } });
    const before = useFabric.getState().events;

    apply({ kind: "event", sessionId: "s", seq: 5, event: { type: "agent_text", text: "x" } });

    // Same object identity: a deduped replay must not churn React subscribers.
    expect(useFabric.getState().events).toBe(before);
  });
});
