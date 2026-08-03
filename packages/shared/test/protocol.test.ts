import { describe, it, expect } from "vitest";
import { AutonomyMode, ClientMessage, DEFAULT_AUTONOMY, RoomInfo, ServerMessage, SessionEvent } from "../src/protocol.js";

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
      const info = { id: "s1", state: "active", claudeSessionId: null, lastSeq: 0, roomId: null };
      expect(() => ServerMessage.parse({ kind: "sessions", sessions: [info] })).toThrow();
      expect(ServerMessage.parse({ kind: "sessions", sessions: [{ ...info, autonomy: "bypass" }] }))
        .toMatchObject({ sessions: [{ autonomy: "bypass" }] });
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
      const info = { id: "s1", state: "active", claudeSessionId: null, lastSeq: 0, autonomy: "auto" };
      // roomId is explicit on the wire: null means "not in a room", not "field forgotten"
      expect(() => ServerMessage.parse({ kind: "sessions", sessions: [info] })).toThrow();
      expect(ServerMessage.parse({ kind: "sessions", sessions: [{ ...info, roomId: null }] }))
        .toMatchObject({ sessions: [{ roomId: null }] });
      expect(ServerMessage.parse({ kind: "sessions", sessions: [{ ...info, roomId: "r1" }] }))
        .toMatchObject({ sessions: [{ roomId: "r1" }] });
    });
  });
});
