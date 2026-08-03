import type { RoomInfo, SessionInfo } from "@superfabric/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentStatus,
  hasMotion,
  initialFabricState,
  liveAgentCount,
  roomAgents,
  roomlessSessions,
  useFabric,
} from "../src/store";

const apply = (msg: Parameters<ReturnType<typeof useFabric.getState>["apply"]>[0]) =>
  useFabric.getState().apply(msg);

beforeEach(() => {
  useFabric.setState({
    ...initialFabricState,
    events: {}, lastSeq: {}, contiguousSeq: {}, needsResync: {}, sessions: [], rooms: [], roomIds: [],
    selectedRoomId: null, roomStatus: {}, conveyors: [], packages: [], packagedPairs: {},
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

describe("agentStatus", () => {
  it("collapses the six session statuses onto the four the floor paints", () => {
    expect(agentStatus(session({ status: "idle" }))).toBe("idle");
    expect(agentStatus(session({ status: "paused" }))).toBe("idle");
    expect(agentStatus(session({ status: "done" }))).toBe("idle");
    expect(agentStatus(session({ status: "working" }))).toBe("working");
    expect(agentStatus(session({ status: "error" }))).toBe("error");
  });

  it("reads a starting agent as working, the way the beacon paints it", () => {
    // `hasMotion` deliberately disagrees: see its doc comment. Colour and frameloop are not the
    // same question — a spawned-but-unprompted agent looks busy and must not pin the frameloop.
    expect(agentStatus(session({ status: "starting" }))).toBe("working");
  });

  it("puts blocked above working and error above blocked", () => {
    expect(agentStatus(session({ status: "working", blocked: true }))).toBe("blocked");
    expect(agentStatus(session({ status: "idle", blocked: true }))).toBe("blocked");
    expect(agentStatus(session({ status: "error", blocked: true }))).toBe("error");
  });
});

describe("roomStatus", () => {
  const project = room({ id: "p", name: "fabrica", path: "/p", kind: "project", position: { x: 0, z: 0 } });
  const floor = [project, room({ id: "r1" }), room({ id: "r2", name: "web" })];

  /** Apply a floor and a session list, then read the derived status of one room. */
  function statusOf(sessions: SessionInfo[], roomId: string) {
    apply({ kind: "rooms", rooms: floor });
    apply({ kind: "sessions", sessions });
    return useFabric.getState().roomStatus[roomId];
  }

  it("is idle for a room with no sessions at all", () => {
    expect(statusOf([], "r1")).toBe("idle");
    expect(statusOf([session({ roomId: "r2", status: "working" })], "r1")).toBe("idle");
  });

  it("is working while any session in the room is working or starting", () => {
    expect(statusOf([session({ roomId: "r1", status: "working" })], "r1")).toBe("working");
    expect(statusOf([session({ roomId: "r1", status: "starting" })], "r1")).toBe("working");
  });

  it("is blocked while any session in the room holds an unresolved approval", () => {
    expect(statusOf([session({ roomId: "r1", status: "idle", blocked: true })], "r1")).toBe("blocked");
  });

  it("prefers blocked over a working sibling", () => {
    const sessions = [
      session({ id: "a", roomId: "r1", status: "working" }),
      session({ id: "b", roomId: "r1", status: "idle", blocked: true }),
    ];
    expect(statusOf(sessions, "r1")).toBe("blocked");
  });

  it("prefers error over everything else in the room", () => {
    const sessions = [
      session({ id: "a", roomId: "r1", status: "working" }),
      session({ id: "b", roomId: "r1", blocked: true }),
      session({ id: "c", roomId: "r1", status: "error" }),
    ];
    expect(statusOf(sessions, "r1")).toBe("error");
  });

  it("clears blocked once the approval is resolved", () => {
    apply({ kind: "rooms", rooms: floor });
    apply({ kind: "sessions", sessions: [session({ roomId: "r1", status: "working", blocked: true })] });
    expect(useFabric.getState().roomStatus["r1"]).toBe("blocked");

    // the server answers `blocked: false` on the next broadcast after the operator allowed it
    apply({ kind: "sessions", sessions: [session({ roomId: "r1", status: "working", blocked: false })] });
    expect(useFabric.getState().roomStatus["r1"]).toBe("working");
  });

  it("gives a roomless session's status to no room", () => {
    apply({ kind: "rooms", rooms: floor });
    apply({ kind: "sessions", sessions: [session({ roomId: null, status: "error", blocked: true })] });
    expect(useFabric.getState().roomStatus).toEqual({ p: "idle", r1: "idle", r2: "idle" });
  });

  it("keeps each room's status independent", () => {
    const sessions = [
      session({ id: "a", roomId: "r1", status: "working" }),
      session({ id: "b", roomId: "r2", status: "error" }),
    ];
    apply({ kind: "rooms", rooms: floor });
    apply({ kind: "sessions", sessions });
    expect(useFabric.getState().roomStatus).toEqual({ p: "idle", r1: "working", r2: "error" });
  });

  it("gains an entry for a room that appears after the sessions did", () => {
    apply({ kind: "sessions", sessions: [session({ roomId: "r1", status: "working" })] });
    apply({ kind: "rooms", rooms: floor });
    expect(useFabric.getState().roomStatus["r1"]).toBe("working");
  });

  it("keeps the map's identity when a session churns without changing any room's status", () => {
    apply({ kind: "rooms", rooms: floor });
    apply({ kind: "sessions", sessions: [session({ roomId: "r1", status: "working" })] });
    const before = useFabric.getState().roomStatus;

    apply({
      kind: "sessions",
      sessions: [session({ roomId: "r1", status: "working", claudeSessionId: "c1", lastSeq: 9 })],
    });

    expect(useFabric.getState().roomStatus).toBe(before);
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

describe("roomAgents", () => {
  const crowd = [
    session({ id: "a", roomId: "r1", status: "working" }),
    session({ id: "b", roomId: "r1", status: "idle", blocked: true }),
    session({ id: "c", roomId: "r2", status: "starting", autonomy: "bypass" }),
    session({ id: "d", roomId: null, status: "working" }),
  ];

  it("groups the agents by the room they stand in", () => {
    expect(roomAgents(crowd, "r1").map((s) => s.id)).toEqual(["a", "b"]);
    expect(roomAgents(crowd, "r2").map((s) => s.id)).toEqual(["c"]);
    expect(roomAgents(crowd, "nobody")).toEqual([]);
  });

  it("puts a roomless agent in no room at all", () => {
    expect(roomAgents(crowd, "r1").some((s) => s.id === "d")).toBe(false);
    expect(roomAgents(crowd, "r2").some((s) => s.id === "d")).toBe(false);
  });

  it("derives status per agent, so two agents in one room can differ", () => {
    expect(roomAgents(crowd, "r1").map(agentStatus)).toEqual(["working", "blocked"]);
  });

  it("carries each agent's own autonomy, so the ungated one can be marked", () => {
    expect(roomAgents(crowd, "r2").map((s) => s.autonomy)).toEqual(["bypass"]);
  });

  it("stands exactly the agents the building's label counts", () => {
    const sessions = [
      session({ id: "a", roomId: "r1", state: "active" }),
      session({ id: "b", roomId: "r1", state: "paused" }),
      session({ id: "c", roomId: "r1", state: "done" }),
      session({ id: "d", roomId: "r1", state: "error" }),
    ];
    // a figure standing next to a label that says "2 agents" would be a lie either way round
    expect(roomAgents(sessions, "r1")).toHaveLength(liveAgentCount(sessions, "r1"));
    expect(roomAgents(sessions, "r1").map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("roomlessSessions", () => {
  it("is exactly what the floor cannot draw", () => {
    const sessions = [
      session({ id: "a", roomId: "r1" }),
      session({ id: "b", roomId: null }),
      session({ id: "c", roomId: null, state: "done" }),
    ];
    // `roomAgents` and `roomlessSessions` between them must account for every session, or the
    // operator has something running that no surface shows.
    expect(roomlessSessions(sessions).map((s) => s.id)).toEqual(["b", "c"]);
    expect(roomAgents(sessions, "r1").map((s) => s.id)).toEqual(["a"]);
  });

  it("keeps finished and failed sessions, unlike a room's figures", () => {
    const sessions = [
      session({ id: "a", roomId: null, state: "done" }),
      session({ id: "b", roomId: null, state: "error" }),
    ];
    // a room's figures are what is standing there *now*; this is a list of what is hidden, and a
    // finished roomless session is still hidden everywhere else
    expect(roomlessSessions(sessions)).toHaveLength(2);
  });

  it("is empty once every session has a room", () => {
    expect(roomlessSessions([session({ roomId: "r1" })])).toEqual([]);
  });
});

describe("clearError", () => {
  it("forgets the last server error", () => {
    apply({ kind: "error", message: "room already exists: backend" });
    expect(useFabric.getState().lastError).toBe("room already exists: backend");
    useFabric.getState().clearError();
    expect(useFabric.getState().lastError).toBeNull();
  });

  it("is a genuine no-op when there was no error, so nothing re-renders for it", () => {
    const before = useFabric.getState();
    useFabric.getState().clearError();
    expect(useFabric.getState()).toBe(before);
  });
});

describe("conveyors", () => {
  const project = room({ id: "p", name: "fabrica", path: "/p", kind: "project", position: { x: 0, z: 0 } });
  const key = (c: { from: string; to: string }) => [c.from, c.to].sort().join("|");
  const belts = () => useFabric.getState().conveyors.map(key).sort();

  it("has no belts on an empty floor", () => {
    expect(useFabric.getState().conveyors).toEqual([]);
  });

  it("joins every workshop to the project building", () => {
    apply({ kind: "rooms", rooms: [project, room({ id: "r1" }), room({ id: "r2", name: "web" })] });
    expect(belts()).toEqual(["p|r1", "p|r2"]);
  });

  it("does not connect the project building to itself", () => {
    apply({ kind: "rooms", rooms: [project] });
    expect(useFabric.getState().conveyors).toEqual([]);
  });

  it("adds a belt for a pair of rooms that exchanged a package", () => {
    apply({ kind: "rooms", rooms: [project, room({ id: "r1" }), room({ id: "r2", name: "web" })] });
    useFabric.getState().sendPackage("r1", "r2", 50);
    expect(belts()).toEqual(["p|r1", "p|r2", "r1|r2"]);
  });

  it("does not double up a belt that already exists", () => {
    apply({ kind: "rooms", rooms: [project, room({ id: "r1" }) ] });
    useFabric.getState().sendPackage("p", "r1", 50);
    useFabric.getState().sendPackage("r1", "p", 50);
    expect(belts()).toEqual(["p|r1"]);
  });

  it("counts a pair as one belt however the package was addressed", () => {
    apply({ kind: "rooms", rooms: [project, room({ id: "r1" }), room({ id: "r2", name: "web" })] });
    useFabric.getState().sendPackage("r1", "r2", 50);
    useFabric.getState().sendPackage("r2", "r1", 50);
    expect(belts()).toEqual(["p|r1", "p|r2", "r1|r2"]);
  });

  it("keeps a belt after its package has been reaped — the channel exists now", () => {
    apply({ kind: "rooms", rooms: [project, room({ id: "r1" }), room({ id: "r2", name: "web" })] });
    useFabric.getState().sendPackage("r1", "r2", 50);
    useFabric.getState().reapPackages(Date.now() + 1000);
    expect(useFabric.getState().packages).toEqual([]);
    expect(belts()).toContain("r1|r2");
  });

  it("keeps the belt list referentially stable when nothing about it changed", () => {
    apply({ kind: "rooms", rooms: [project, room({ id: "r1" })] });
    const before = useFabric.getState().conveyors;

    apply({ kind: "sessions", sessions: [session({ roomId: "r1", status: "working" })] });
    apply({ kind: "rooms", rooms: [project, room({ id: "r1", agentCount: 1 })] });
    useFabric.getState().sendPackage("p", "r1", 50);

    expect(useFabric.getState().conveyors).toBe(before);
  });
});

describe("packages", () => {
  const project = room({ id: "p", name: "fabrica", path: "/p", kind: "project", position: { x: 0, z: 0 } });

  beforeEach(() => {
    apply({ kind: "rooms", rooms: [project, room({ id: "r1" }), room({ id: "r2", name: "web" })] });
  });

  it("sends a package between the two rooms it was addressed to", () => {
    const before = Date.now();
    useFabric.getState().sendPackage("r1", "r2", 1234);

    const [pkg, ...rest] = useFabric.getState().packages;
    expect(rest).toEqual([]);
    expect(pkg.from).toBe("r1");
    expect(pkg.to).toBe("r2");
    expect(pkg.durationMs).toBe(1234);
    expect(pkg.startedAt).toBeGreaterThanOrEqual(before);
    expect(pkg.id).not.toBe("");
  });

  it("gives every package its own id, even two sent in the same millisecond", () => {
    useFabric.getState().sendPackage("r1", "r2", 50);
    useFabric.getState().sendPackage("r1", "r2", 50);
    const [a, b] = useFabric.getState().packages;
    expect(a.id).not.toBe(b.id);
  });

  it("refuses to send a package from a room to itself", () => {
    useFabric.getState().sendPackage("r1", "r1");
    expect(useFabric.getState().packages).toEqual([]);
  });

  it("reaps a package whose travel time has elapsed and keeps the ones still flying", () => {
    const now = Date.now();
    useFabric.getState().sendPackage("r1", "r2", 100);
    useFabric.getState().sendPackage("p", "r1", 10_000);

    useFabric.getState().reapPackages(now + 200);

    expect(useFabric.getState().packages.map((p) => [p.from, p.to])).toEqual([["p", "r1"]]);
  });

  it("leaves the list alone when nothing has landed", () => {
    useFabric.getState().sendPackage("r1", "r2", 10_000);
    const before = useFabric.getState().packages;
    useFabric.getState().reapPackages(Date.now());
    expect(useFabric.getState().packages).toBe(before);
  });
});

describe("hasMotion", () => {
  const still = { sessions: [], packages: [] };

  it("is false for an empty factory", () => {
    expect(hasMotion(still)).toBe(false);
  });

  it("is false while every agent is idle, paused, done or errored", () => {
    for (const status of ["idle", "paused", "done", "error"] as const) {
      expect(hasMotion({ ...still, sessions: [session({ status })] })).toBe(false);
    }
  });

  it("is true while any agent is working", () => {
    expect(hasMotion({
      ...still,
      sessions: [session({ status: "idle" }), session({ id: "s2", status: "working" })],
    })).toBe(true);
  });

  it("is false for an agent that is only 'starting'", () => {
    // A Claude Code session that has been spawned but never prompted reports `starting` forever;
    // counting it would leave the canvas on frameloop="always" for the rest of the session.
    expect(hasMotion({ ...still, sessions: [session({ status: "starting" })] })).toBe(false);
  });

  it("is true while a package is in flight, and false again once it is reaped", () => {
    apply({ kind: "rooms", rooms: [room({ id: "p", kind: "project", position: { x: 0, z: 0 } }), room({ id: "r1" })] });
    useFabric.getState().sendPackage("p", "r1", 100);
    expect(hasMotion(useFabric.getState())).toBe(true);

    useFabric.getState().reapPackages(Date.now() + 200);
    expect(hasMotion(useFabric.getState())).toBe(false);
  });
});
