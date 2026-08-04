import type {
  AccountInfo, AccountUsage, ChronicleHit, MessageInfo, ProjectInfo, RoleSpec, RoomInfo, SessionInfo,
  TaskInfo,
} from "@superfabric/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_NONE_LABEL,
  accountLabel,
  agentStatus,
  beltDirections,
  beltFan,
  DEFAULT_PACKAGE_MS,
  hasMotion,
  initialFabricState,
  liveAgentCount,
  openTaskCount,
  orchestratorSession,
  roomAgents,
  roomlessSessions,
  roleLabel,
  ROLE_NONE_LABEL,
  roomPosition,
  roomStatusMap,
  TASK_STATUS_ORDER,
  tasksByStatus,
  unassignedTasks,
  useFabric,
} from "../src/store";

const apply = (msg: Parameters<ReturnType<typeof useFabric.getState>["apply"]>[0]) =>
  useFabric.getState().apply(msg);

beforeEach(() => {
  useFabric.setState({
    ...initialFabricState,
    events: {}, lastSeq: {}, contiguousSeq: {}, needsResync: {}, sessions: [], rooms: [], roomIds: [],
    selectedRoomId: null, drag: null, roomStatus: {}, conveyors: [], packages: [], packagedPairs: {},
    projects: [], activeProjectId: null, accounts: [], usage: [], roles: [], roleProblems: [],
    chronicle: { asked: "", answered: null, hits: [] },
  });
});

/** A `SessionInfo` with every field the protocol requires; cases override just what they are about. */
const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "s1", state: "active", claudeSessionId: null, lastSeq: 0,
  autonomy: "auto", model: null, roomId: null, accountId: null, roleId: null, pausedUntil: null,
  status: "idle", blocked: false, isOrchestrator: false, ...over,
});

const room = (over: Partial<RoomInfo> = {}): RoomInfo => ({
  id: "r1", name: "backend", path: "/p/backend", position: { x: 8, z: 0 },
  kind: "room", agentCount: 0, accountId: null, ...over,
});

/** A bus message with every field the protocol requires; cases override just what they are about. */
const message = (over: Partial<MessageInfo> = {}): MessageInfo => ({
  id: "m1", fromRoomId: "r1", toRoomId: "r2", kind: "request", body: "need a webhook",
  taskId: null, deliveredAt: null, createdAt: 1_000, ...over,
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

  it("reflects each session's model, and re-renders the row when it changes", () => {
    apply({
      kind: "sessions",
      sessions: [session({ id: "s1", model: null }), session({ id: "s2", model: "claude-haiku-4-5" })],
    });
    expect(useFabric.getState().sessions.map((s) => [s.id, s.model])).toEqual([
      ["s1", null],
      ["s2", "claude-haiku-4-5"],
    ]);

    const before = useFabric.getState().sessions;
    // Unchanged rows keep their identity, so a rebroadcast repaints nothing…
    apply({
      kind: "sessions",
      sessions: [session({ id: "s1", model: null }), session({ id: "s2", model: "claude-haiku-4-5" })],
    });
    expect(useFabric.getState().sessions[0]).toBe(before[0]);

    // …but a switched model is a new row, or the picker would go on showing the old one.
    apply({
      kind: "sessions",
      sessions: [session({ id: "s1", model: "claude-opus-5" }), session({ id: "s2", model: "claude-haiku-4-5" })],
    });
    const after = useFabric.getState().sessions;
    expect(after[0]).not.toBe(before[0]);
    expect(after[0].model).toBe("claude-opus-5");
    expect(after[1]).toBe(before[1]);
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
  it("collapses the six session statuses onto the five the floor paints", () => {
    expect(agentStatus(session({ status: "idle" }))).toBe("idle");
    expect(agentStatus(session({ status: "done" }))).toBe("idle");
    expect(agentStatus(session({ status: "working" }))).toBe("working");
    expect(agentStatus(session({ status: "error" }))).toBe("error");
    // `paused` used to fold into `idle`, and that was wrong the moment anything could pause an agent
    // without being asked — see the `paused agent` cases below.
    expect(agentStatus(session({ status: "paused" }))).toBe("paused");
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

describe("dragging a building", () => {
  const project = room({ id: "p", name: "fabrica", path: "/p", kind: "project", position: { x: 0, z: 0 } });
  const floor = () => apply({ kind: "rooms", rooms: [project, room({ position: { x: 14, z: 0 } })] });
  const drag = () => useFabric.getState().drag;

  it("starts where the building already stands, so it never jumps on pointer-down", () => {
    floor();
    useFabric.getState().beginRoomDrag("r1", { x: 14, z: 0 });
    expect(drag()).toEqual({ roomId: "r1", position: { x: 14, z: 0 } });
    expect(roomPosition(useFabric.getState(), "r1")).toEqual({ x: 14, z: 0 });
  });

  it("moves the building locally, without touching the server's row", () => {
    floor();
    useFabric.getState().beginRoomDrag("r1", { x: 14, z: 0 });
    useFabric.getState().dragRoomTo({ x: 9, z: -3 });

    expect(roomPosition(useFabric.getState(), "r1")).toEqual({ x: 9, z: -3 });
    // the committed row is still exactly what the server last said
    expect(useFabric.getState().rooms[1].position).toEqual({ x: 14, z: 0 });
  });

  it("only overrides the building being dragged", () => {
    floor();
    useFabric.getState().beginRoomDrag("r1", { x: 14, z: 0 });
    useFabric.getState().dragRoomTo({ x: 9, z: -3 });
    expect(roomPosition(useFabric.getState(), "p")).toEqual({ x: 0, z: 0 });
  });

  it("clears on pointer-up, and the server's position takes over again", () => {
    floor();
    useFabric.getState().beginRoomDrag("r1", { x: 14, z: 0 });
    useFabric.getState().dragRoomTo({ x: 9, z: -3 });
    useFabric.getState().endRoomDrag();

    expect(drag()).toBeNull();
    expect(roomPosition(useFabric.getState(), "r1")).toEqual({ x: 14, z: 0 });
  });

  it("ignores a move with no drag in progress", () => {
    floor();
    const before = useFabric.getState();
    useFabric.getState().dragRoomTo({ x: 1, z: 1 });
    expect(useFabric.getState()).toBe(before);
    expect(drag()).toBeNull();
  });

  it("is a no-op when the pointer reports the same position twice", () => {
    floor();
    useFabric.getState().beginRoomDrag("r1", { x: 14, z: 0 });
    const held = drag();
    useFabric.getState().dragRoomTo({ x: 14, z: 0 });
    // a pointer sends far more events than distinct floor cells; an unchanged position must not
    // re-render the building or rebuild the belts hanging off it
    expect(drag()).toBe(held);
  });

  it("lets the local position win over a rooms broadcast that arrives mid-drag", () => {
    floor();
    useFabric.getState().beginRoomDrag("r1", { x: 14, z: 0 });
    useFabric.getState().dragRoomTo({ x: 9, z: -3 });

    // the server rebroadcasts the whole floor every 250 ms; this one still carries the old position
    // (and would carry a stale *new* one for as long as the debounce lasts)
    apply({ kind: "rooms", rooms: [project, room({ position: { x: 14, z: 0 }, agentCount: 1 })] });

    expect(drag()).toEqual({ roomId: "r1", position: { x: 9, z: -3 } });
    expect(roomPosition(useFabric.getState(), "r1")).toEqual({ x: 9, z: -3 });
  });

  it("drops the drag when the dragged building leaves the floor", () => {
    floor();
    useFabric.getState().beginRoomDrag("r1", { x: 14, z: 0 });
    apply({ kind: "rooms", rooms: [project] });
    expect(drag()).toBeNull();
  });

  it("reports no position at all for a room this client does not have", () => {
    floor();
    expect(roomPosition(useFabric.getState(), "nobody")).toBeUndefined();
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

describe("the orchestrator", () => {
  it("is whichever session carries the flag, and nothing else about it is special", () => {
    const sessions = [
      session({ id: "junior", roomId: "r1" }),
      session({ id: "senior", roomId: "p", isOrchestrator: true }),
    ];
    expect(orchestratorSession(sessions)?.id).toBe("senior");
    // …and it is still an ordinary agent of its room: the floor draws it with the others.
    expect(roomAgents(sessions, "p").map((s) => s.id)).toEqual(["senior"]);
  });

  it("is undefined for a factory that has not been given one", () => {
    expect(orchestratorSession([session({ id: "a" }), session({ id: "b" })])).toBeUndefined();
  });

  it("repaints the figure when an agent becomes the orchestrator", () => {
    // `applySessions` preserves the identity of rows that did not change, so a field left out of
    // `sameSession` is a field whose change never reaches the floor. This is that regression test.
    apply({ kind: "sessions", sessions: [session({ id: "s1", roomId: "p" })] });
    const before = useFabric.getState().sessions[0];
    apply({ kind: "sessions", sessions: [session({ id: "s1", roomId: "p", isOrchestrator: true })] });
    const after = useFabric.getState().sessions[0];
    expect(after).not.toBe(before);
    expect(after.isOrchestrator).toBe(true);
  });

  it("says which room it stands in, so the central building can mark itself", () => {
    apply({ kind: "rooms", rooms: [room({ id: "p", name: "shop", kind: "project" }), room({ id: "r1" })] });
    apply({ kind: "sessions", sessions: [session({ id: "s1", roomId: "p", isOrchestrator: true })] });
    const { sessions } = useFabric.getState();
    expect(orchestratorSession(sessions)?.roomId).toBe("p");
  });
});

describe("the chronicle", () => {
  const hit = (over: Partial<ChronicleHit> = {}): ChronicleHit => ({
    kind: "decision", title: "Retries live in payments", snippet: "the webhook…",
    createdAt: 1_800_000_000, ref: "d1", seq: 0, roomId: "r1",
    path: "/p/docs/decisions/0001-retries.md", ...over,
  });

  it("shows the answer to the question that is being asked", () => {
    useFabric.getState().askChronicle("webhook");
    apply({ kind: "chronicle", query: "webhook", hits: [hit()] });
    const { chronicle } = useFabric.getState();
    expect(chronicle.answered).toBe("webhook");
    expect(chronicle.hits.map((h) => h.title)).toEqual(["Retries live in payments"]);
  });

  it("drops an answer to a question the operator has already moved past", () => {
    useFabric.getState().askChronicle("web");
    useFabric.getState().askChronicle("webhook");
    // The slower answer to the earlier prefix lands second. Showing it would put the results for a
    // word that is no longer in the box under a box that says something else.
    apply({ kind: "chronicle", query: "web", hits: [hit({ ref: "stale" })] });
    expect(useFabric.getState().chronicle.hits).toEqual([]);
    expect(useFabric.getState().chronicle.answered).toBeNull();

    apply({ kind: "chronicle", query: "webhook", hits: [hit({ ref: "fresh" })] });
    expect(useFabric.getState().chronicle.hits.map((h) => h.ref)).toEqual(["fresh"]);
  });

  it("keeps the hits on screen while the same question is re-asked", () => {
    useFabric.getState().askChronicle("webhook");
    apply({ kind: "chronicle", query: "webhook", hits: [hit()] });
    const before = useFabric.getState().chronicle;
    useFabric.getState().askChronicle("webhook");
    // A genuine no-op: pressing Enter again must not blank the list being read.
    expect(useFabric.getState().chronicle).toBe(before);
  });

  it("empties while a new question is outstanding, so stale hits are never read as fresh", () => {
    useFabric.getState().askChronicle("webhook");
    apply({ kind: "chronicle", query: "webhook", hits: [hit()] });
    useFabric.getState().askChronicle("retries");
    const { chronicle } = useFabric.getState();
    expect(chronicle.asked).toBe("retries");
    expect(chronicle.answered).toBeNull(); // the surface draws this as "searching…"
  });

  it("distinguishes a recorded decision from something an agent said", () => {
    useFabric.getState().askChronicle("webhook");
    apply({
      kind: "chronicle",
      query: "webhook",
      hits: [hit(), hit({ kind: "event", ref: "s1", seq: 12, title: "agent_text", path: null })],
    });
    const { hits } = useFabric.getState().chronicle;
    expect(hits.map((h) => h.kind)).toEqual(["decision", "event"]);
    // Only a decision has a file; an event's record is the transcript.
    expect(hits[1].path).toBeNull();
  });

  it("is dropped with the rest of the factory when the project changes", () => {
    apply({
      kind: "projects",
      projects: [
        { id: "p1", name: "shop", root: "/code/shop", lastOpenedAt: null },
        { id: "p2", name: "vendor", root: "/code/vendor", lastOpenedAt: null },
      ],
      activeProjectId: "p1",
    });
    useFabric.getState().askChronicle("webhook");
    apply({ kind: "chronicle", query: "webhook", hits: [hit()] });

    apply({
      kind: "projects",
      projects: [
        { id: "p1", name: "shop", root: "/code/shop", lastOpenedAt: null },
        { id: "p2", name: "vendor", root: "/code/vendor", lastOpenedAt: null },
      ],
      activeProjectId: "p2",
    });
    // Those ADRs are files in a repository this floor is not looking at any more.
    expect(useFabric.getState().chronicle).toEqual({ asked: "", answered: null, hits: [] });
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

  it("fans the spine's belts by index, centred on zero", () => {
    apply({
      kind: "rooms",
      rooms: [project, room({ id: "r1" }), room({ id: "r2", name: "web" }), room({ id: "r3", name: "qa" })],
    });
    expect(useFabric.getState().conveyors.map((c) => c.fan)).toEqual([-1, 0, 1]);
  });

  it("gives a room-to-room belt no fan — it is the only belt between those two rooms", () => {
    apply({ kind: "rooms", rooms: [project, room({ id: "r1" }), room({ id: "r2", name: "web" })] });
    useFabric.getState().sendPackage("r1", "r2", 50);
    const belt = useFabric.getState().conveyors.find((c) => key(c) === "r1|r2");
    expect(belt?.fan).toBe(0);
  });

  it("answers the fan of a pair whichever way round it is asked, so a package rides its own belt", () => {
    apply({ kind: "rooms", rooms: [project, room({ id: "r1" }), room({ id: "r2", name: "web" })] });
    const { conveyors } = useFabric.getState();
    for (const c of conveyors) {
      expect(beltFan(conveyors, c.from, c.to)).toBe(c.fan);
      expect(beltFan(conveyors, c.to, c.from)).toBe(c.fan);
    }
    // a pair with no belt at all is unfanned rather than undefined
    expect(beltFan(conveyors, "r1", "nope")).toBe(0);
  });

  it("re-fans when a room is added, so the new belt is part of the fan rather than beside it", () => {
    apply({ kind: "rooms", rooms: [project, room({ id: "r1" }), room({ id: "r2", name: "web" })] });
    expect(useFabric.getState().conveyors.map((c) => c.fan)).toEqual([-0.5, 0.5]);
    apply({
      kind: "rooms",
      rooms: [project, room({ id: "r1" }), room({ id: "r2", name: "web" }), room({ id: "r3", name: "qa" })],
    });
    expect(useFabric.getState().conveyors.map((c) => c.fan)).toEqual([-1, 0, 1]);
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

describe("beltDirections", () => {
  const project = room({ id: "p", name: "fabrica", path: "/p", kind: "project", position: { x: 0, z: 0 } });

  it("is empty for a room the client has never heard of", () => {
    expect(beltDirections(useFabric.getState(), "nope")).toEqual([]);
  });

  it("points at every building this room has a belt to, as flat numbers", () => {
    apply({
      kind: "rooms",
      rooms: [
        project,
        room({ id: "r1", position: { x: 12, z: 5 } }),
        room({ id: "r2", name: "web", position: { x: -5, z: 12 } }),
      ],
    });
    // from the project block, out to both workshops
    expect(beltDirections(useFabric.getState(), "p")).toEqual([12, 5, -5, 12]);
    // and from a workshop, back to the project block
    expect(beltDirections(useFabric.getState(), "r1")).toEqual([-12, -5]);
  });

  it("follows a building while it is being dragged, so its loading bay follows its belt", () => {
    apply({
      kind: "rooms",
      rooms: [project, room({ id: "r1", position: { x: 12, z: 5 } })],
    });
    useFabric.getState().beginRoomDrag("r1", { x: 12, z: 5 });
    useFabric.getState().dragRoomTo({ x: 0, z: 14 });
    expect(beltDirections(useFabric.getState(), "p")).toEqual([0, 14]);
  });

  it("returns a shallow-equal array for an unchanged floor, which is what stops a render loop", () => {
    // `useBeltDirections` compares element by element; an array of objects would never match and
    // the building would re-render for ever.
    apply({ kind: "rooms", rooms: [project, room({ id: "r1", position: { x: 12, z: 5 } })] });
    const a = beltDirections(useFabric.getState(), "p");
    const b = beltDirections(useFabric.getState(), "p");
    expect(a).not.toBe(b);
    expect(a.every((v, i) => Object.is(v, b[i]))).toBe(true);
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

describe("the task board", () => {
  const task = (over: Partial<TaskInfo> = {}): TaskInfo => ({
    id: "t1", title: "Expose a webhook", detail: "", status: "open", roomId: null,
    agentId: null, blockedOnMessageId: null, createdAt: 1_000, updatedAt: 1_000, ...over,
  });

  it("takes the whole board from a tasks message", () => {
    apply({ kind: "tasks", tasks: [task({ id: "t1" }), task({ id: "t2", status: "done" })] });
    expect(useFabric.getState().tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("keeps unchanged cards' identity so one moving task repaints one row", () => {
    apply({ kind: "tasks", tasks: [task({ id: "t1" }), task({ id: "t2" })] });
    const [first, second] = useFabric.getState().tasks;

    apply({ kind: "tasks", tasks: [task({ id: "t1" }), task({ id: "t2", status: "done", updatedAt: 1_100 })] });
    const after = useFabric.getState().tasks;
    expect(after[0]).toBe(first);
    expect(after[1]).not.toBe(second);
  });

  it("is a genuine no-op when the rebroadcast changed nothing", () => {
    apply({ kind: "tasks", tasks: [task()] });
    const before = useFabric.getState().tasks;
    apply({ kind: "tasks", tasks: [task()] });
    expect(useFabric.getState().tasks).toBe(before);
  });

  it("groups by status in the board's reading order, keeping empty groups", () => {
    apply({ kind: "tasks", tasks: [
      task({ id: "a", status: "done" }),
      task({ id: "b", status: "blocked", blockedOnMessageId: "m1" }),
      task({ id: "c", status: "blocked" }),
    ] });
    const groups = tasksByStatus(useFabric.getState().tasks);
    expect(groups.map((g) => g.status)).toEqual([...TASK_STATUS_ORDER]);
    expect(groups.map((g) => g.tasks.map((t) => t.id))).toEqual([[], [], ["b", "c"], [], ["a"]]);
  });

  it("collects the cards nobody owns yet, which is what the board offers to route", () => {
    const tasks = [
      task({ id: "t1", roomId: null }),
      task({ id: "t2", roomId: "r1" }),
      task({ id: "t3", roomId: null, status: "in_progress" }),
      // Finished and never routed is history, not work waiting on a decision.
      task({ id: "t4", roomId: null, status: "done" }),
    ];
    expect(unassignedTasks(tasks).map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(unassignedTasks([])).toEqual([]);
  });

  it("counts a room's unfinished tasks, and only that room's", () => {
    const tasks = [
      task({ id: "a", roomId: "r1" }),
      task({ id: "b", roomId: "r1", status: "blocked" }),
      task({ id: "c", roomId: "r1", status: "done" }),
      task({ id: "d", roomId: "r2" }),
      task({ id: "e", roomId: null }),
    ];
    // `done` is excluded: the badge is a workload, and a room whose cards are all finished is clear.
    expect(openTaskCount(tasks, "r1")).toBe(2);
    expect(openTaskCount(tasks, "r2")).toBe(1);
    expect(openTaskCount(tasks, "nope")).toBe(0);
  });
});

describe("bus messages on the belts", () => {
  const project = room({ id: "p", name: "fabrica", path: "/p", kind: "project", position: { x: 0, z: 0 } });
  const messages = (list: MessageInfo[]) => apply({ kind: "messages", messages: list });
  /** The snapshot every connection opens with. Everything after it is news. */
  const connected = () => {
    useFabric.getState().setConnected(true);
    messages([]);
  };

  beforeEach(() => {
    apply({ kind: "rooms", rooms: [project, room({ id: "r1" }), room({ id: "r2", name: "web" })] });
  });

  it("adopts the first snapshot as history instead of replaying it on the belts", () => {
    // A tab that connects to a factory with an hour of traffic behind it must not show that hour
    // as a burst of packages: the animation means "this is happening now".
    useFabric.getState().setConnected(true);
    messages([
      message({ id: "old-1", deliveredAt: 1_001 }),
      message({ id: "old-2", fromRoomId: "r2", toRoomId: "r1", deliveredAt: 1_002 }),
    ]);
    expect(useFabric.getState().packages).toEqual([]);
    expect(useFabric.getState().messagesLoaded).toBe(true);
  });

  it("puts a package on the belt for a delivery it has not seen before", () => {
    connected();
    const before = Date.now();
    messages([message({ id: "m1", deliveredAt: 2_000 })]);

    const [pkg, ...rest] = useFabric.getState().packages;
    expect(rest).toEqual([]);
    // Keyed by the message's own id: the package *is* that message, not a look-alike.
    expect(pkg.id).toBe("m1");
    expect([pkg.from, pkg.to]).toEqual(["r1", "r2"]);
    expect(pkg.startedAt).toBeGreaterThanOrEqual(before);
  });

  it("does not re-animate a message the next snapshot still carries", () => {
    connected();
    messages([message({ id: "m1", deliveredAt: 2_000 })]);
    // `list()` is a snapshot of the newest 200, rebroadcast whole on every change — a second
    // message arriving means the first one is sent again, and it must not fly twice.
    messages([
      message({ id: "m2", fromRoomId: "r2", toRoomId: "r1", deliveredAt: 2_100 }),
      message({ id: "m1", deliveredAt: 2_000 }),
    ]);
    expect(useFabric.getState().packages.map((p) => p.id)).toEqual(["m1", "m2"]);
  });

  it("animates several new deliveries in the order they were sent, not the order they arrive", () => {
    connected();
    // The snapshot is newest-first; the belts should still leave oldest-first.
    messages([
      message({ id: "later", deliveredAt: 2_200, createdAt: 2_200 }),
      message({ id: "earlier", deliveredAt: 2_100, createdAt: 2_100 }),
    ]);
    expect(useFabric.getState().packages.map((p) => p.id)).toEqual(["earlier", "later"]);
  });

  it("shows an undelivered message as a waiting marker at its sender, not as a package", () => {
    connected();
    messages([message({ id: "m1", deliveredAt: null })]);

    expect(useFabric.getState().packages).toEqual([]);
    expect(useFabric.getState().waiting).toEqual([
      { id: "m1", from: "r1", to: "r2", kind: "request", createdAt: 1_000 },
    ]);
  });

  it("flips the same message from waiting to in flight when it is finally delivered", () => {
    connected();
    messages([message({ id: "m1", deliveredAt: null })]);
    expect(useFabric.getState().waiting.map((w) => w.id)).toEqual(["m1"]);

    messages([message({ id: "m1", deliveredAt: 2_500 })]);

    // One object changing state: it leaves the pile and rides the belt under the same id, so the
    // box starts at the door the marker was standing at rather than appearing from nothing.
    expect(useFabric.getState().waiting).toEqual([]);
    expect(useFabric.getState().packages.map((p) => p.id)).toEqual(["m1"]);
  });

  it("keeps the pile's identity when a rebroadcast changed nothing about it", () => {
    connected();
    messages([message({ id: "m1", deliveredAt: null })]);
    const first = useFabric.getState().waiting;
    messages([message({ id: "m1", deliveredAt: null })]);
    expect(useFabric.getState().waiting).toBe(first);
  });

  it("stacks a pile-up in creation order", () => {
    connected();
    messages([
      message({ id: "b", createdAt: 1_200 }),
      message({ id: "a", createdAt: 1_100 }),
    ]);
    expect(useFabric.getState().waiting.map((w) => w.id)).toEqual(["a", "b"]);
  });

  it("earns a belt between two rooms that a real message used, delivered or not", () => {
    const belts = () => useFabric.getState().conveyors.map((c) => [c.from, c.to].sort().join("|")).sort();
    connected();
    messages([message({ id: "m1", fromRoomId: "r1", toRoomId: "r2", deliveredAt: null })]);
    // The crate has to stand at the mouth of a belt that is actually drawn.
    expect(belts()).toEqual(["p|r1", "p|r2", "r1|r2"]);
  });

  it("ignores a room talking to itself: there is no belt to ride", () => {
    connected();
    messages([message({ id: "m1", fromRoomId: "r1", toRoomId: "r1", deliveredAt: 2_000 })]);
    expect(useFabric.getState().packages).toEqual([]);
    expect(useFabric.getState().conveyors.map((c) => [c.from, c.to].sort().join("|")).sort())
      .toEqual(["p|r1", "p|r2"]);
  });

  it("forgets messages the snapshot no longer carries, so the record cannot grow for ever", () => {
    connected();
    messages([message({ id: "m1", deliveredAt: 2_000 })]);
    useFabric.getState().reapPackages(Date.now() + 10_000);
    // m1 has fallen off the end of the newest-200 window.
    messages([message({ id: "m2", deliveredAt: 2_100 })]);
    expect(Object.keys(useFabric.getState().animatedMessages)).toEqual(["m2"]);
  });

  it("re-baselines after a reconnect instead of replaying what it missed", () => {
    connected();
    messages([message({ id: "m1", deliveredAt: 2_000 })]);
    useFabric.getState().reapPackages(Date.now() + 10_000);

    useFabric.getState().setConnected(false);
    useFabric.getState().setConnected(true);
    // Everything that happened while the tab was away arrives in one snapshot; it is history now.
    messages([
      message({ id: "m9", deliveredAt: 3_000 }),
      message({ id: "m1", deliveredAt: 2_000 }),
    ]);
    expect(useFabric.getState().packages).toEqual([]);
  });
});

describe("hasMotion", () => {
  const still = { sessions: [], packages: [], drag: null };

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

  it("is true while a building is being dragged, and false again when it is let go", () => {
    // Without this the demand frameloop renders the frame the pointer went down and then nothing:
    // the building freezes mid-drag while the operator hauls on it.
    apply({ kind: "rooms", rooms: [room({ id: "r1" })] });
    useFabric.getState().beginRoomDrag("r1", { x: 14, z: 0 });
    expect(hasMotion(useFabric.getState())).toBe(true);

    useFabric.getState().endRoomDrag();
    expect(hasMotion(useFabric.getState())).toBe(false);
  });

  it("is true while a package is in flight, and false again once it is reaped", () => {
    apply({ kind: "rooms", rooms: [room({ id: "p", kind: "project", position: { x: 0, z: 0 } }), room({ id: "r1" })] });
    useFabric.getState().sendPackage("p", "r1", 100);
    expect(hasMotion(useFabric.getState())).toBe(true);

    useFabric.getState().reapPackages(Date.now() + 200);
    expect(hasMotion(useFabric.getState())).toBe(false);
  });

  it("is true while a package from a real bus message flies, and false again afterwards", () => {
    apply({ kind: "rooms", rooms: [room({ id: "r1" }), room({ id: "r2", name: "web", position: { x: 0, z: 8 } })] });
    useFabric.getState().setConnected(true);
    apply({ kind: "messages", messages: [] });
    apply({ kind: "messages", messages: [message({ id: "m1", deliveredAt: 2_000 })] });
    expect(hasMotion(useFabric.getState())).toBe(true);

    useFabric.getState().reapPackages(Date.now() + DEFAULT_PACKAGE_MS + 200);
    expect(hasMotion(useFabric.getState())).toBe(false);
  });

  it("is false while messages sit undelivered: a pile-up is a state, not an animation", () => {
    // Counting the queue as motion would pin frameloop="always" for as long as a room stayed busy.
    apply({ kind: "rooms", rooms: [room({ id: "r1" }), room({ id: "r2", name: "web", position: { x: 0, z: 8 } })] });
    useFabric.getState().setConnected(true);
    apply({ kind: "messages", messages: [message({ id: "m1", deliveredAt: null })] });
    expect(useFabric.getState().waiting).toHaveLength(1);
    expect(hasMotion(useFabric.getState())).toBe(false);
  });
});

// ---- M1b: switching factories ----

describe("projects", () => {
  const project = (over: Partial<ProjectInfo> = {}): ProjectInfo => ({
    id: "p1", name: "shop", root: "/code/shop", lastOpenedAt: null, ...over,
  });
  const other = project({ id: "p2", name: "vendor", root: "/code/vendor" });

  /** A floor with a building, an agent, a card, a belt and a queued crate — a factory in use. */
  function fillFactory(): void {
    apply({
      kind: "rooms",
      rooms: [
        room({ id: "p", name: "shop", kind: "project", position: { x: 0, z: 0 } }),
        room({ id: "r1" }),
        room({ id: "r2", name: "web", position: { x: 0, z: 8 } }),
      ],
    });
    apply({ kind: "sessions", sessions: [session({ id: "s1", roomId: "r1", status: "working" })] });
    apply({
      kind: "tasks",
      tasks: [{
        id: "t1", title: "Expose a webhook", detail: "", status: "open",
        roomId: "r1", agentId: null, blockedOnMessageId: null, createdAt: 1, updatedAt: 1,
      }],
    });
    useFabric.getState().selectRoom("r1");
    useFabric.getState().setConnected(true);
    apply({ kind: "messages", messages: [message({ id: "m1", deliveredAt: null })] });
    apply({ kind: "event", sessionId: "s1", seq: 1, event: { type: "agent_text", text: "working" } });
  }

  it("records the list and the active project the server says this socket is on", () => {
    apply({ kind: "projects", projects: [project(), other], activeProjectId: "p1" });
    const s = useFabric.getState();
    expect(s.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(s.activeProjectId).toBe("p1");
  });

  it("keeps the floor that arrived in the same round trip as the first projects frame", () => {
    // On connect the client asks for projects first, but the answers can land either way round.
    fillFactory();
    apply({ kind: "projects", projects: [project()], activeProjectId: "p1" });
    expect(useFabric.getState().roomIds).toHaveLength(3);
    expect(useFabric.getState().tasks).toHaveLength(1);
  });

  it("drops the previous factory entirely when the active project changes", () => {
    apply({ kind: "projects", projects: [project(), other], activeProjectId: "p1" });
    fillFactory();
    // sanity: there is something to lose
    const before = useFabric.getState();
    expect(before.rooms.length).toBeGreaterThan(0);
    expect(before.conveyors.length).toBeGreaterThan(0);
    expect(before.waiting).toHaveLength(1);
    expect(before.events["s1"]).toHaveLength(1);

    apply({ kind: "projects", projects: [project(), other], activeProjectId: "p2" });

    const s = useFabric.getState();
    // A stale building from another factory standing on this floor is the symptom of merging here.
    expect(s.rooms).toEqual([]);
    expect(s.roomIds).toEqual([]);
    expect(s.sessions).toEqual([]);
    expect(s.tasks).toEqual([]);
    expect(s.waiting).toEqual([]);
    expect(s.packages).toEqual([]);
    expect(s.conveyors).toEqual([]);
    expect(s.packagedPairs).toEqual({});
    expect(s.animatedMessages).toEqual({});
    expect(s.roomStatus).toEqual({});
    expect(s.events).toEqual({});
    expect(s.lastSeq).toEqual({});
    expect(s.contiguousSeq).toEqual({});
    expect(s.selectedRoomId).toBeNull();
    // …and the tab's own state is not a casualty of the switch
    expect(s.activeProjectId).toBe("p2");
    expect(s.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(s.connected).toBe(true);
  });

  it("re-baselines the bus, so the new factory's queue does not fly down a belt", () => {
    apply({ kind: "projects", projects: [project(), other], activeProjectId: "p1" });
    fillFactory();
    expect(useFabric.getState().messagesLoaded).toBe(true);

    apply({ kind: "projects", projects: [project(), other], activeProjectId: "p2" });
    expect(useFabric.getState().messagesLoaded).toBe(false);

    // The new floor's first snapshot is history: it is adopted, not animated.
    apply({ kind: "rooms", rooms: [room({ id: "r1" }), room({ id: "r2", name: "web", position: { x: 0, z: 8 } })] });
    apply({ kind: "messages", messages: [message({ id: "m9", deliveredAt: 3_000 })] });
    expect(useFabric.getState().packages).toEqual([]);
  });

  it("asks the camera to re-frame, because the new floor is somewhere else", () => {
    apply({ kind: "projects", projects: [project(), other], activeProjectId: "p1" });
    const before = useFabric.getState().fitRequests;
    apply({ kind: "projects", projects: [project(), other], activeProjectId: "p2" });
    expect(useFabric.getState().fitRequests).toBe(before + 1);
  });

  it("changes nothing when the same frame arrives twice", () => {
    apply({ kind: "projects", projects: [project(), other], activeProjectId: "p1" });
    fillFactory();
    const before = useFabric.getState();
    // Every tab is told when anyone adds or opens a project, so a no-op frame is the common case.
    apply({ kind: "projects", projects: [project(), other], activeProjectId: "p1" });
    const after = useFabric.getState();
    expect(after.rooms).toBe(before.rooms);
    expect(after.projects).toBe(before.projects);
    expect(after.fitRequests).toBe(before.fitRequests);
  });

  it("takes a changed project list without touching the floor", () => {
    apply({ kind: "projects", projects: [project()], activeProjectId: "p1" });
    fillFactory();
    const rooms = useFabric.getState().rooms;
    // Another tab created a project: the switcher gains an entry, this floor does not change.
    apply({ kind: "projects", projects: [project(), other], activeProjectId: "p1" });
    expect(useFabric.getState().projects.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(useFabric.getState().rooms).toBe(rooms);
  });
});

describe("accounts", () => {
  const account = (over: Partial<AccountInfo> = {}): AccountInfo => ({
    id: "a1", label: "Work", configDir: "/home/me/.claude-work",
    credentialsPresent: true, createdAt: 1_800_000_000, lastUsedAt: null,
    login: { status: "idle", url: null, message: null }, ...over,
  });

  it("stores the account list", () => {
    apply({ kind: "accounts", accounts: [account(), account({ id: "a2", label: "Personal" })] });
    expect(useFabric.getState().accounts.map((a) => a.label)).toEqual(["Work", "Personal"]);
  });

  it("keeps unchanged rows identical, so one login does not repaint the others", () => {
    apply({ kind: "accounts", accounts: [account(), account({ id: "a2", label: "Personal" })] });
    const before = useFabric.getState().accounts;

    // The list is rebroadcast on every chunk the CLI prints while a login runs.
    apply({
      kind: "accounts",
      accounts: [
        account(),
        account({
          id: "a2", label: "Personal", credentialsPresent: false,
          login: { status: "awaiting_code", url: "https://claude.com/x", message: null },
        }),
      ],
    });
    const after = useFabric.getState().accounts;
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]!.login.url).toBe("https://claude.com/x");
  });

  it("an identical rebroadcast changes nothing at all", () => {
    apply({ kind: "accounts", accounts: [account()] });
    const before = useFabric.getState().accounts;
    apply({ kind: "accounts", accounts: [account()] });
    expect(useFabric.getState().accounts).toBe(before);
  });

  it("survives a project switch, because a subscription is not a repository's", () => {
    const projects = [
      { id: "p1", name: "shop", root: "/code/shop", lastOpenedAt: null },
      { id: "p2", name: "vendor", root: "/code/vendor", lastOpenedAt: null },
    ];
    apply({ kind: "projects", projects, activeProjectId: "p1" });
    apply({ kind: "accounts", accounts: [account()] });
    apply({ kind: "rooms", rooms: [room({ id: "r1" })] });
    apply({ kind: "projects", projects, activeProjectId: "p2" });
    // The floor is dropped — and the accounts are not, because they are the same on every floor.
    expect(useFabric.getState().rooms).toEqual([]);
    expect(useFabric.getState().accounts.map((a) => a.label)).toEqual(["Work"]);
  });

  it("a room's binding repaints the room, so a re-bind is not invisible", () => {
    apply({ kind: "rooms", rooms: [room({ id: "r1" })] });
    const before = useFabric.getState().rooms[0];
    apply({ kind: "rooms", rooms: [room({ id: "r1", accountId: "a1" })] });
    expect(useFabric.getState().rooms[0]).not.toBe(before);
    expect(useFabric.getState().rooms[0]!.accountId).toBe("a1");
  });

  it("an agent's binding repaints the agent, for the same reason", () => {
    apply({ kind: "sessions", sessions: [session({ id: "s1" })] });
    const before = useFabric.getState().sessions[0];
    apply({ kind: "sessions", sessions: [session({ id: "s1", accountId: "a1" })] });
    expect(useFabric.getState().sessions[0]).not.toBe(before);
    expect(useFabric.getState().sessions[0]!.accountId).toBe("a1");
  });

  describe("accountLabel", () => {
    it("names the bound account", () => {
      expect(accountLabel([account()], "a1")).toBe("Work");
    });

    it("null is the ambient ~/.claude, and it is called something", () => {
      expect(accountLabel([account()], null)).toBe(ACCOUNT_NONE_LABEL);
      expect(ACCOUNT_NONE_LABEL).not.toBe("");
    });

    it("an id with no row shows the id, never 'default'", () => {
      // "An account I cannot describe" and "no account" are different facts, and the second is a
      // claim about whose quota is being spent.
      expect(accountLabel([account()], "a-gone")).toBe("a-gone");
      expect(accountLabel([], "a1")).toBe("a1");
    });
  });
});

describe("roles", () => {
  const role = (over: Partial<RoleSpec> = {}): RoleSpec => ({
    id: "architect", name: "Architect", summary: "Shape, not code.",
    promptAppend: "You are the architect.", skills: [], mcpServers: {}, allowedTools: [], ...over,
  });

  it("stores the library and the files that did not load", () => {
    apply({
      kind: "roles",
      roles: [role(), role({ id: "qa", name: "QA", summary: "Evidence." })],
      problems: [{ file: "/p/roles/broken.yaml", message: "is not valid YAML" }],
    });
    expect(useFabric.getState().roles.map((r) => r.id)).toEqual(["architect", "qa"]);
    // The problems ride with the list: a picker one entry shorter than the folder tells the operator
    // nothing they can act on.
    expect(useFabric.getState().roleProblems).toHaveLength(1);
  });

  it("survives a project switch, because a role is a file on the machine", () => {
    const projects = [
      { id: "p1", name: "shop", root: "/code/shop", lastOpenedAt: null },
      { id: "p2", name: "vendor", root: "/code/vendor", lastOpenedAt: null },
    ];
    apply({ kind: "projects", projects, activeProjectId: "p1" });
    apply({ kind: "roles", roles: [role()], problems: [] });
    apply({ kind: "rooms", rooms: [room({ id: "r1" })] });
    apply({ kind: "projects", projects, activeProjectId: "p2" });
    expect(useFabric.getState().rooms).toEqual([]);
    expect(useFabric.getState().roles.map((r) => r.id)).toEqual(["architect"]);
  });

  it("an agent's role repaints the agent, so a change of role is not invisible", () => {
    apply({ kind: "sessions", sessions: [session({ id: "s1" })] });
    const before = useFabric.getState().sessions[0];
    apply({ kind: "sessions", sessions: [session({ id: "s1", roleId: "architect" })] });
    expect(useFabric.getState().sessions[0]).not.toBe(before);
    expect(useFabric.getState().sessions[0]!.roleId).toBe("architect");
  });

  describe("roleLabel", () => {
    it("names the role", () => {
      expect(roleLabel([role()], "architect")).toBe("Architect");
    });

    it("null is a plain agent, and it is called something", () => {
      expect(roleLabel([role()], null)).toBe(ROLE_NONE_LABEL);
      expect(ROLE_NONE_LABEL).not.toBe("");
    });

    it("an id with no spec shows the id, never 'no role'", () => {
      // A preset the operator deleted out from under a running agent must not read as "plain".
      expect(roleLabel([role()], "gone")).toBe("gone");
      expect(roleLabel([], "architect")).toBe("architect");
    });
  });
});

describe("limit meters", () => {
  const usage = (over: Partial<AccountUsage> = {}): AccountUsage => ({
    accountId: "a1", source: "endpoint", approximate: false, readAt: 1_800_000_000,
    note: null, limited: false, limitedUntil: null, limitedBy: null,
    windows: [{
      key: "five_hour", label: "5-hour", utilization: 43,
      resetsAt: "2026-08-04T04:10:00Z", detail: null,
    }],
    ...over,
  });

  it("stores the meters", () => {
    apply({ kind: "usage", usage: [usage(), usage({ accountId: "a2", approximate: true })] });
    expect(useFabric.getState().usage.map((u) => u.accountId)).toEqual(["a1", "a2"]);
    expect(useFabric.getState().usage[1]!.approximate).toBe(true);
  });

  it("an identical poll changes nothing, so three bars do not repaint every three minutes", () => {
    apply({ kind: "usage", usage: [usage()] });
    const before = useFabric.getState().usage;
    apply({ kind: "usage", usage: [usage()] });
    expect(useFabric.getState().usage).toBe(before);
  });

  it("a moved needle repaints only the account it moved on", () => {
    apply({ kind: "usage", usage: [usage(), usage({ accountId: "a2" })] });
    const before = useFabric.getState().usage;
    apply({
      kind: "usage",
      usage: [
        usage(),
        usage({ accountId: "a2", windows: [{ ...usage().windows[0]!, utilization: 91 }] }),
      ],
    });
    const after = useFabric.getState().usage;
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  });

  it("survives a project switch, because a quota is not a repository's either", () => {
    const projects = [
      { id: "p1", name: "shop", root: "/code/shop", lastOpenedAt: null },
      { id: "p2", name: "vendor", root: "/code/vendor", lastOpenedAt: null },
    ];
    apply({ kind: "projects", projects, activeProjectId: "p1" });
    apply({ kind: "usage", usage: [usage()] });
    apply({ kind: "projects", projects, activeProjectId: "p2" });
    expect(useFabric.getState().usage).toHaveLength(1);
  });
});

describe("a paused agent", () => {
  it("reads as paused, not as idle", () => {
    // The two facts an operator most needs to tell apart on a floor that has gone still: "quiet
    // because there is nothing to do" and "stopped because the subscription is spent".
    expect(agentStatus(session({ state: "paused", status: "paused" }))).toBe("paused");
    expect(agentStatus(session({ state: "active", status: "idle" }))).toBe("idle");
  });

  it("is paused if either the row or its log says so", () => {
    // `state` is what the scheduler wrote and what survives a reboot; `status` is the newest thing
    // the agent's own log said. Either alone is enough.
    expect(agentStatus(session({ state: "paused", status: "idle" }))).toBe("paused");
    expect(agentStatus(session({ state: "active", status: "paused" }))).toBe("paused");
  });

  it("still loses to a waiting approval and to a failure", () => {
    expect(agentStatus(session({ state: "paused", status: "paused", blocked: true }))).toBe("blocked");
    expect(agentStatus(session({ state: "paused", status: "error" }))).toBe("error");
  });

  it("makes its room read as paused even when a sibling is working", () => {
    // Half-stopped is the part nobody would otherwise notice, so it outranks `working`.
    const map = roomStatusMap([{ id: "r1" }], [
      session({ id: "s1", roomId: "r1", status: "working" }),
      session({ id: "s2", roomId: "r1", state: "paused", status: "paused" }),
    ]);
    expect(map.r1).toBe("paused");
  });

  it("carries its countdown, and null when nothing knows when it lifts", () => {
    apply({ kind: "sessions", sessions: [session({ id: "s1", state: "paused", status: "paused", pausedUntil: 1_800_000_500 })] });
    expect(useFabric.getState().sessions[0]!.pausedUntil).toBe(1_800_000_500);
    apply({ kind: "sessions", sessions: [session({ id: "s1", state: "paused", status: "paused", pausedUntil: null })] });
    expect(useFabric.getState().sessions[0]!.pausedUntil).toBeNull();
  });
});
