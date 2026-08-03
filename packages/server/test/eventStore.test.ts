import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";

describe("EventStore", () => {
  it("appends with monotonic seq per session and replays after a given seq", () => {
    const store = new EventStore(openDb(":memory:"));
    const a1 = store.append("A", { type: "agent_text", text: "one" });
    const a2 = store.append("A", { type: "agent_text", text: "two" });
    const b1 = store.append("B", { type: "agent_text", text: "other" });
    expect([a1, a2, b1]).toEqual([1, 2, 1]);
    const replay = store.listAfter("A", 1);
    expect(replay).toEqual([{ seq: 2, event: { type: "agent_text", text: "two" } }]);
  });
  it("reports maxSeq per session, 0 for a session with no events", () => {
    const store = new EventStore(openDb(":memory:"));
    expect(store.maxSeq("A")).toBe(0);
    store.append("A", { type: "agent_text", text: "one" });
    store.append("A", { type: "agent_text", text: "two" });
    store.append("B", { type: "agent_text", text: "other" });
    expect(store.maxSeq("A")).toBe(2);
    expect(store.maxSeq("B")).toBe(1);
    expect(store.maxSeq("never-existed")).toBe(0);
  });

  it("notifies subscribers on append", () => {
    const store = new EventStore(openDb(":memory:"));
    const seen: number[] = [];
    store.onAppend((sessionId, seq) => { if (sessionId === "A") seen.push(seq); });
    store.append("A", { type: "agent_thinking" });
    expect(seen).toEqual([1]);
  });
});
