import type { RoomInfo, SessionInfo } from "@superfabric/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { hasMotion, initialFabricState, liveAgentCount, useFabric } from "../src/store";

const apply = (msg: Parameters<ReturnType<typeof useFabric.getState>["apply"]>[0]) =>
  useFabric.getState().apply(msg);

beforeEach(() => {
  useFabric.setState({
    ...initialFabricState,
    events: {}, lastSeq: {}, contiguousSeq: {}, needsResync: {}, sessions: [], rooms: [], roomIds: [],
    selectedRoomId: null,
  });
});

/** A `SessionInfo` with every field the protocol requires; cases override just what they are about. */
const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "s1", state: "active", claudeSessionId: null, lastSeq: 0,
  autonomy: "auto", roomId: null, status: "idle", blocked: false, ...over,
});

const room = (over: Partial<RoomInfo> = {}): RoomInfo => ({
  id: "r1", name: "backend", path: "/p/backend", position: { x: 8, z: 0 },
  kind: "room", agentCount: 0, ...over,
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
    useFabric.setState({ sessions: [session({ id: "old", state: "done", lastSeq: 3 })] });

    apply({
      kind: "sessions",
      sessions: [
        session({ id: "s1", claudeSessionId: "c1", lastSeq: 7 }),
        session({ id: "s2", state: "paused", autonomy: "attended" }),
      ],
    });

    expect(useFabric.getState().sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("reflects each session's autonomy from a sessions message", () => {
    apply({
      kind: "sessions",
      sessions: [
        session({ id: "s1", claudeSessionId: "c1", lastSeq: 7, autonomy: "bypass" }),
        session({ id: "s2", claudeSessionId: "c2", lastSeq: 1, autonomy: "attended" }),
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
        session({ id: "s1", claudeSessionId: "c1", lastSeq: 9, autonomy: "attended" }),
        session({ id: "s2", claudeSessionId: "c2", lastSeq: 1, autonomy: "attended" }),
      ],
    });
    expect(useFabric.getState().sessions.find((s) => s.id === "s1")?.autonomy).toBe("attended");
  });

  it("carries the server's derived status and blocked flag through untouched", () => {
    apply({
      kind: "sessions",
      sessions: [
        session({ id: "s1", status: "working" }),
        session({ id: "s2", status: "error" }),
        session({ id: "s3", status: "working", blocked: true }),
      ],
    });
    expect(useFabric.getState().sessions.map((s) => [s.status, s.blocked])).toEqual([
      ["working", false],
      ["error", false],
      ["working", true],
    ]);
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

// ---- M1a: the factory floor ----

describe("rooms", () => {
  const project = room({ id: "p", name: "fabrica", path: "/p", kind: "project", position: { x: 0, z: 0 } });

  it("applies a rooms message as the whole floor", () => {
    apply({ kind: "rooms", rooms: [project, room()] });
    expect(useFabric.getState().rooms.map((r) => r.name)).toEqual(["fabrica", "backend"]);
    expect(useFabric.getState().roomIds).toEqual(["p", "r1"]);
  });

  it("replaces the list rather than merging into it", () => {
    apply({ kind: "rooms", rooms: [project, room({ id: "gone", name: "old" })] });
    apply({ kind: "rooms", rooms: [project, room({ id: "r2", name: "web" })] });
    expect(useFabric.getState().roomIds).toEqual(["p", "r2"]);
    expect(useFabric.getState().rooms.some((r) => r.id === "gone")).toBe(false);
  });

  it("keeps roomIds referentially stable when an unrelated session event arrives", () => {
    apply({ kind: "rooms", rooms: [project, room()] });
    const ids = useFabric.getState().roomIds;

    apply({ kind: "event", sessionId: "s", seq: 1, event: { type: "session_status", status: "working" } });
    apply({ kind: "sessions", sessions: [session({ roomId: "r1", status: "working" })] });

    // This is what stops every building re-rendering on every token: same contents, same array.
    expect(useFabric.getState().roomIds).toBe(ids);
  });

  it("keeps roomIds stable when a rooms message repeats the same rooms", () => {
    apply({ kind: "rooms", rooms: [project, room()] });
    const ids = useFabric.getState().roomIds;
    const rooms = useFabric.getState().rooms;

    // a fresh broadcast of an unchanged floor (a second tab connected, say)
    apply({ kind: "rooms", rooms: [{ ...project }, { ...room(), position: { x: 8, z: 0 } }] });

    expect(useFabric.getState().roomIds).toBe(ids);
    expect(useFabric.getState().rooms).toBe(rooms);
  });

  it("keeps the identity of rooms that did not change when one of them moves", () => {
    apply({ kind: "rooms", rooms: [project, room(), room({ id: "r2", name: "web" })] });
    const before = useFabric.getState().rooms;

    apply({
      kind: "rooms",
      rooms: [project, room({ position: { x: -3, z: 4 } }), room({ id: "r2", name: "web" })],
    });

    const after = useFabric.getState().rooms;
    expect(after[0]).toBe(before[0]);          // the project block did not move
    expect(after[1]).not.toBe(before[1]);      // this one did
    expect(after[1].position).toEqual({ x: -3, z: 4 });
    expect(after[2]).toBe(before[2]);          // and its neighbour must not re-render for it
  });

  it("notices a changed agent count", () => {
    apply({ kind: "rooms", rooms: [project, room()] });
    const before = useFabric.getState().rooms[1];
    apply({ kind: "rooms", rooms: [project, room({ agentCount: 2 })] });
    expect(useFabric.getState().rooms[1]).not.toBe(before);
    expect(useFabric.getState().rooms[1].agentCount).toBe(2);
  });

  it("selects and deselects a room", () => {
    apply({ kind: "rooms", rooms: [project, room()] });
    useFabric.getState().selectRoom("r1");
    expect(useFabric.getState().selectedRoomId).toBe("r1");
    useFabric.getState().selectRoom(null);
    expect(useFabric.getState().selectedRoomId).toBeNull();
  });

  it("drops a selection whose room disappeared from the floor", () => {
    apply({ kind: "rooms", rooms: [project, room()] });
    useFabric.getState().selectRoom("r1");
    apply({ kind: "rooms", rooms: [project] });
    expect(useFabric.getState().selectedRoomId).toBeNull();
  });

  it("keeps a selection that survived a rebuild", () => {
    apply({ kind: "rooms", rooms: [project, room()] });
    useFabric.getState().selectRoom("r1");
    apply({ kind: "rooms", rooms: [project, room({ agentCount: 1 }), room({ id: "r2", name: "web" })] });
    expect(useFabric.getState().selectedRoomId).toBe("r1");
  });
});

describe("liveAgentCount", () => {
  it("counts only the sessions still standing in the room", () => {
    const sessions = [
      session({ id: "a", roomId: "r1", state: "active" }),
      session({ id: "b", roomId: "r1", state: "paused" }),
      session({ id: "c", roomId: "r1", state: "done" }),
      session({ id: "d", roomId: "r1", state: "error" }),
      session({ id: "e", roomId: "r2", state: "active" }),
      session({ id: "f", roomId: null, state: "active" }),
    ];
    // the server's agentCount would say 4 here: it counts the finished and failed rows too
    expect(liveAgentCount(sessions, "r1")).toBe(2);
    expect(liveAgentCount(sessions, "r2")).toBe(1);
    expect(liveAgentCount(sessions, "nobody")).toBe(0);
  });

  it("attributes a roomless session to no room at all", () => {
    expect(liveAgentCount([session({ roomId: null })], "r1")).toBe(0);
  });
});

describe("hasMotion", () => {
  it("is false for an empty factory", () => {
    expect(hasMotion({ sessions: [] })).toBe(false);
  });

  it("is false while every agent is idle, paused, done or errored", () => {
    for (const status of ["idle", "paused", "done", "error"] as const) {
      expect(hasMotion({ sessions: [session({ status })] })).toBe(false);
    }
  });

  it("is true while any agent is starting or working", () => {
    for (const status of ["starting", "working"] as const) {
      expect(hasMotion({ sessions: [session({ status: "idle" }), session({ id: "s2", status })] })).toBe(true);
    }
  });
});
