import { describe, it, expect } from "vitest";
import { AutonomyMode, ClientMessage, DEFAULT_AUTONOMY, RoomInfo, ServerMessage, SessionEvent, SessionStatus } from "../src/protocol.js";

/** Every field `SessionInfo` requires, so a case can vary exactly the one it is about. */
const SESSION_INFO = {
  id: "s1", state: "active", claudeSessionId: null, lastSeq: 0,
  autonomy: "auto", roomId: null, status: "idle", blocked: false,
} as const;

describe("protocol", () => {
  it("parses a subscribe message", () => {
    const m = ClientMessage.parse({ kind: "subscribe", sessionId: "s1", afterSeq: 0 });
    expect(m.kind).toBe("subscribe");
  });
  it("parses an event envelope round-trip", () => {
    const ev: unknown = {
      kind: "event",
      sessionId: "s1",
      seq: 42,
      event: { type: "agent_text", text: "hello" },
    };
    const parsed = ServerMessage.parse(ev);
    expect(parsed).toEqual(ev);
  });
  it("rejects unknown event types", () => {
    expect(() => SessionEvent.parse({ type: "nope" })).toThrow();
  });

  describe("autonomy", () => {
    it("exposes exactly the three product modes, defaulting to auto", () => {
      expect(AutonomyMode.options).toEqual(["attended", "auto", "bypass"]);
      expect(DEFAULT_AUTONOMY).toBe("auto");
      // our own vocabulary, not the SDK's permissionMode strings
      expect(() => AutonomyMode.parse("bypassPermissions")).toThrow();
      expect(() => AutonomyMode.parse("acceptEdits")).toThrow();
    });

    it("accepts create_session with and without an autonomy, and set_autonomy", () => {
      expect(ClientMessage.parse({ kind: "create_session" })).toEqual({ kind: "create_session" });
      expect(ClientMessage.parse({ kind: "create_session", cwd: "/tmp", autonomy: "bypass" }))
        .toMatchObject({ autonomy: "bypass" });
      expect(ClientMessage.parse({ kind: "set_autonomy", sessionId: "s1", autonomy: "attended" }))
        .toEqual({ kind: "set_autonomy", sessionId: "s1", autonomy: "attended" });
      expect(() => ClientMessage.parse({ kind: "set_autonomy", sessionId: "s1" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "set_autonomy", sessionId: "s1", autonomy: "yolo" })).toThrow();
    });

    it("requires autonomy on SessionInfo", () => {
      const { autonomy: _omitted, ...info } = SESSION_INFO;
      expect(() => ServerMessage.parse({ kind: "sessions", sessions: [info] })).toThrow();
      expect(ServerMessage.parse({ kind: "sessions", sessions: [{ ...info, autonomy: "bypass" }] }))
        .toMatchObject({ sessions: [{ autonomy: "bypass" }] });
    });
  });

  // ---- M1a: the derived status the 3D floor reads instead of replaying transcripts ----

  describe("session status", () => {
    it("shares one vocabulary between the session_status event and SessionInfo", () => {
      expect(SessionStatus.options).toEqual(["starting", "working", "idle", "paused", "error", "done"]);
      for (const status of SessionStatus.options) {
        expect(SessionEvent.parse({ type: "session_status", status }).type).toBe("session_status");
        expect(ServerMessage.parse({ kind: "sessions", sessions: [{ ...SESSION_INFO, status }] }))
          .toMatchObject({ sessions: [{ status }] });
      }
    });

    it("requires status and blocked on SessionInfo, and rejects a status outside the enum", () => {
      const { status: _s, ...noStatus } = SESSION_INFO;
      const { blocked: _b, ...noBlocked } = SESSION_INFO;
      expect(() => ServerMessage.parse({ kind: "sessions", sessions: [noStatus] })).toThrow();
      expect(() => ServerMessage.parse({ kind: "sessions", sessions: [noBlocked] })).toThrow();
      expect(() => ServerMessage.parse({ kind: "sessions", sessions: [{ ...SESSION_INFO, status: "busy" }] }))
        .toThrow();
    });

    it("carries blocked as its own flag, not folded into status", () => {
      // "waiting on you" and "working" are different things to draw, so an agent can be both
      // working and blocked on the wire.
      expect(ServerMessage.parse({ kind: "sessions", sessions: [{ ...SESSION_INFO, status: "working", blocked: true }] }))
        .toMatchObject({ sessions: [{ status: "working", blocked: true }] });
    });
  });

  // ---- M1a: rooms ----

  describe("rooms", () => {
    it("parses a room info object", () => {
      const r = RoomInfo.parse({
        id: "r1", name: "backend", path: "/p/backend",
        position: { x: 3, z: -2 }, kind: "room", agentCount: 0,
      });
      expect(r.kind).toBe("room");
    });

    it("defaults a room's position to the origin", () => {
      const r = RoomInfo.parse({ id: "r1", name: "backend", path: "/p/backend", kind: "room", agentCount: 0 });
      expect(r.position).toEqual({ x: 0, z: 0 });
    });

    it("parses room client messages", () => {
      expect(ClientMessage.parse({ kind: "create_room", name: "payments" }).kind).toBe("create_room");
      expect(ClientMessage.parse({ kind: "move_room", roomId: "r1", position: { x: 1, z: 2 } }).kind).toBe("move_room");
      expect(ClientMessage.parse({ kind: "list_rooms" }).kind).toBe("list_rooms");
    });

    it("rejects a room name that is not a safe folder segment", () => {
      expect(() => ClientMessage.parse({ kind: "create_room", name: "../escape" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "create_room", name: "has/slash" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "create_room", name: "" })).toThrow();
      // a leading separator character is what makes traversal possible; keep every form out
      expect(() => ClientMessage.parse({ kind: "create_room", name: ".hidden" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "create_room", name: "-dash" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "create_room", name: "back\\slash" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "create_room", name: "Upper" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "create_room", name: "a".repeat(65) })).toThrow();
    });

    it("parses a rooms server message", () => {
      const m = ServerMessage.parse({ kind: "rooms", rooms: [] });
      expect(m.kind).toBe("rooms");
    });

    it("lets a session belong to a room, and reports it on SessionInfo", () => {
      expect(ClientMessage.parse({ kind: "create_session", roomId: "r1" }))
        .toMatchObject({ roomId: "r1" });
      const { roomId: _omitted, ...info } = SESSION_INFO;
      // roomId is explicit on the wire: null means "not in a room", not "field forgotten"
      expect(() => ServerMessage.parse({ kind: "sessions", sessions: [info] })).toThrow();
      expect(ServerMessage.parse({ kind: "sessions", sessions: [{ ...info, roomId: null }] }))
        .toMatchObject({ sessions: [{ roomId: null }] });
      expect(ServerMessage.parse({ kind: "sessions", sessions: [{ ...info, roomId: "r1" }] }))
        .toMatchObject({ sessions: [{ roomId: "r1" }] });
    });
  });
});
