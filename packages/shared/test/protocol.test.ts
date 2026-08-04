import { describe, it, expect } from "vitest";
import {
  AGENT_MODELS, ATTACHMENTS_DIRNAME, AttachmentUploadResult, AutonomyMode, ClientMessage,
  DEFAULT_AUTONOMY, MAX_ATTACHMENT_BYTES, MessageInfo, MessageKind, ModelId,
  ProjectInfo, RoomInfo, ServerMessage, SessionEvent, SessionStatus, TaskInfo, TaskStatus,
} from "../src/protocol.js";

/** Every field `SessionInfo` requires, so a case can vary exactly the one it is about. */
const SESSION_INFO = {
  id: "s1", state: "active", claudeSessionId: null, lastSeq: 0,
  autonomy: "auto", model: null, roomId: null, status: "idle", blocked: false,
  isOrchestrator: false,
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

  describe("model", () => {
    it("accepts any non-empty id, because model ids are not our schema", () => {
      expect(ModelId.parse("claude-opus-5")).toBe("claude-opus-5");
      // a model released after this build shipped is still a legal choice
      expect(ModelId.parse("claude-something-7")).toBe("claude-something-7");
      expect(() => ModelId.parse("")).toThrow();
      expect(() => ModelId.parse("x".repeat(201))).toThrow();
    });

    it("offers a short curated list for the picker, in the current id scheme", () => {
      expect(AGENT_MODELS.length).toBeGreaterThan(0);
      // Short on purpose: a wrong id is a 404 at runtime, so the list is the ones we are sure of
      // and the free-text field covers the rest.
      expect(AGENT_MODELS.length).toBeLessThanOrEqual(6);
      for (const m of AGENT_MODELS) {
        expect(() => ModelId.parse(m.id)).not.toThrow();
        expect(m.id).toMatch(/^claude-[a-z]+-[0-9-]+$/);
        expect(m.label).not.toBe("");
        expect(m.note).not.toBe("");
      }
      // no duplicates: the picker is a list of distinct choices
      expect(new Set(AGENT_MODELS.map(m => m.id)).size).toBe(AGENT_MODELS.length);
    });

    it("accepts create_session with and without a model, and set_model either way", () => {
      expect(ClientMessage.parse({ kind: "create_session" })).toEqual({ kind: "create_session" });
      expect(ClientMessage.parse({ kind: "create_session", model: "claude-sonnet-5" }))
        .toMatchObject({ model: "claude-sonnet-5" });
      expect(ClientMessage.parse({ kind: "set_model", sessionId: "s1", model: "claude-opus-5" }))
        .toEqual({ kind: "set_model", sessionId: "s1", model: "claude-opus-5" });
      // null is how an agent is handed back to the CLI's default
      expect(ClientMessage.parse({ kind: "set_model", sessionId: "s1", model: null }))
        .toEqual({ kind: "set_model", sessionId: "s1", model: null });
      // …but "no model field at all" is not the same message, and is refused
      expect(() => ClientMessage.parse({ kind: "set_model", sessionId: "s1" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "set_model", sessionId: "s1", model: "" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "create_session", model: "" })).toThrow();
    });

    it("requires model on SessionInfo, nullable for the CLI's own default", () => {
      const { model: _omitted, ...info } = SESSION_INFO;
      expect(() => ServerMessage.parse({ kind: "sessions", sessions: [info] })).toThrow();
      expect(ServerMessage.parse({ kind: "sessions", sessions: [{ ...info, model: "claude-haiku-4-5" }] }))
        .toMatchObject({ sessions: [{ model: "claude-haiku-4-5" }] });
      expect(ServerMessage.parse({ kind: "sessions", sessions: [SESSION_INFO] }))
        .toMatchObject({ sessions: [{ model: null }] });
    });
  });

  // ---- M3b: the orchestrator is a flag on an ordinary session ----

  describe("the orchestrator", () => {
    it("parses ensure_orchestrator, which takes no arguments at all", () => {
      expect(ClientMessage.parse({ kind: "ensure_orchestrator" }).kind).toBe("ensure_orchestrator");
      // Deliberately argument-free: the room, the role and the tool surface are the server's to
      // decide, so there is nothing here for a client to get wrong.
      expect(ClientMessage.parse({ kind: "ensure_orchestrator", roomId: "r1" }))
        .toEqual({ kind: "ensure_orchestrator" });
    });

    it("parses route_task, which asks and never assigns", () => {
      expect(ClientMessage.parse({ kind: "route_task", taskId: "t1" }))
        .toEqual({ kind: "route_task", taskId: "t1" });
      // no room on it: naming one would be the operator assigning the task, which is `update_task`
      expect(ClientMessage.parse({ kind: "route_task", taskId: "t1", roomId: "r1" }))
        .toEqual({ kind: "route_task", taskId: "t1" });
      expect(() => ClientMessage.parse({ kind: "route_task" })).toThrow();
    });

    it("requires isOrchestrator on SessionInfo, as a flag and not a separate kind of session", () => {
      const { isOrchestrator: _omitted, ...info } = SESSION_INFO;
      expect(() => ServerMessage.parse({ kind: "sessions", sessions: [info] })).toThrow();
      expect(ServerMessage.parse({ kind: "sessions", sessions: [{ ...info, isOrchestrator: true }] }))
        .toMatchObject({ sessions: [{ isOrchestrator: true }] });
      expect(() => ServerMessage.parse({ kind: "sessions", sessions: [{ ...info, isOrchestrator: "yes" }] }))
        .toThrow();
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

  // ---- M3a: tasks and the factory bus ----

  describe("tasks", () => {
    it("exposes the five board columns", () => {
      expect(TaskStatus.options).toEqual(["open", "in_progress", "blocked", "review", "done"]);
      expect(() => TaskStatus.parse("todo")).toThrow();
    });

    it("parses a task and defaults its detail to an empty string", () => {
      const t = TaskInfo.parse({
        id: "t1", title: "Add the webhook", status: "open",
        roomId: null, agentId: null, blockedOnMessageId: null,
        createdAt: 1, updatedAt: 2,
      });
      expect(t.detail).toBe("");
      expect(t.roomId).toBeNull();
    });

    it("keeps roomId, agentId and blockedOnMessageId explicit and nullable", () => {
      const base = {
        id: "t1", title: "Add the webhook", detail: "", status: "open",
        roomId: null, agentId: null, blockedOnMessageId: null, createdAt: 1, updatedAt: 2,
      };
      // null is a value ("unassigned" / "not blocked"), never a forgotten field
      for (const field of ["roomId", "agentId", "blockedOnMessageId"] as const) {
        const { [field]: _omitted, ...missing } = base;
        expect(() => TaskInfo.parse(missing)).toThrow();
      }
      expect(TaskInfo.parse({ ...base, roomId: "r1", agentId: "s1", blockedOnMessageId: "m1" }))
        .toMatchObject({ roomId: "r1", agentId: "s1", blockedOnMessageId: "m1" });
    });

    it("rejects an empty or oversized title, an oversized detail, and a bad status", () => {
      const base = {
        id: "t1", title: "ok", status: "open",
        roomId: null, agentId: null, blockedOnMessageId: null, createdAt: 1, updatedAt: 2,
      };
      expect(() => TaskInfo.parse({ ...base, title: "" })).toThrow();
      expect(() => TaskInfo.parse({ ...base, title: "t".repeat(201) })).toThrow();
      expect(() => TaskInfo.parse({ ...base, detail: "d".repeat(4001) })).toThrow();
      expect(() => TaskInfo.parse({ ...base, status: "shipped" })).toThrow();
      expect(() => TaskInfo.parse({ ...base, createdAt: 1.5 })).toThrow();
    });

    it("parses the task client messages", () => {
      expect(ClientMessage.parse({ kind: "create_task", title: "Add the webhook" }))
        .toEqual({ kind: "create_task", title: "Add the webhook" });
      expect(ClientMessage.parse({ kind: "create_task", title: "t", detail: "d", roomId: "r1" }))
        .toMatchObject({ detail: "d", roomId: "r1" });
      expect(ClientMessage.parse({ kind: "update_task", taskId: "t1", status: "done" }))
        .toMatchObject({ taskId: "t1", status: "done" });
      // unassigning is expressible: null clears the room / the assignee
      expect(ClientMessage.parse({ kind: "update_task", taskId: "t1", roomId: null, agentId: null }))
        .toMatchObject({ roomId: null, agentId: null });
      expect(ClientMessage.parse({ kind: "list_tasks" }).kind).toBe("list_tasks");
      // The bus's traffic is askable-for, not only pushed: a queued message is state a tab needs on
      // connect, and the answer is the baseline that keeps later broadcasts from replaying history.
      expect(ClientMessage.parse({ kind: "list_messages" }).kind).toBe("list_messages");

      expect(() => ClientMessage.parse({ kind: "create_task" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "create_task", title: "" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "update_task", status: "done" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "update_task", taskId: "t1", status: "shipped" })).toThrow();
    });

    it("parses a tasks server message", () => {
      expect(ServerMessage.parse({ kind: "tasks", tasks: [] }).kind).toBe("tasks");
      expect(() => ServerMessage.parse({ kind: "tasks" })).toThrow();
    });
  });

  describe("bus messages", () => {
    const MESSAGE_INFO = {
      id: "m1", fromRoomId: "r1", toRoomId: "r2", kind: "request",
      body: "Please expose a webhook", taskId: null, deliveredAt: null, createdAt: 10,
    } as const;

    it("parses a message and keeps deliveredAt nullable but required", () => {
      const m = MessageInfo.parse(MESSAGE_INFO);
      expect(m.deliveredAt).toBeNull();
      expect(MessageInfo.parse({ ...MESSAGE_INFO, deliveredAt: 11 }).deliveredAt).toBe(11);
      const { deliveredAt: _omitted, ...missing } = MESSAGE_INFO;
      // the belt animates on this field, so "undelivered" must be a value on the wire
      expect(() => MessageInfo.parse(missing)).toThrow();
    });

    it("exposes the three message kinds and rejects anything else", () => {
      expect(MessageKind.options).toEqual(["request", "response", "info"]);
      expect(() => MessageInfo.parse({ ...MESSAGE_INFO, kind: "shout" })).toThrow();
    });

    it("requires both endpoints, a non-empty body, and an explicit taskId", () => {
      for (const field of ["fromRoomId", "toRoomId", "taskId"] as const) {
        const { [field]: _omitted, ...missing } = MESSAGE_INFO;
        expect(() => MessageInfo.parse(missing)).toThrow();
      }
      expect(() => MessageInfo.parse({ ...MESSAGE_INFO, body: "" })).toThrow();
      expect(() => MessageInfo.parse({ ...MESSAGE_INFO, body: "b".repeat(8001) })).toThrow();
      expect(MessageInfo.parse({ ...MESSAGE_INFO, taskId: "t1" }).taskId).toBe("t1");
    });

    it("parses a messages server message carrying deliveredAt", () => {
      const m = ServerMessage.parse({ kind: "messages", messages: [MESSAGE_INFO] });
      expect(m).toMatchObject({ kind: "messages", messages: [{ deliveredAt: null }] });
      expect(() => ServerMessage.parse({ kind: "messages" })).toThrow();
    });
  });

  // ---- M1b: projects and settable room folders ----

  describe("projects", () => {
    const PROJECT_INFO = {
      id: "p1", name: "My Project", root: "/home/op/code/my-project", lastOpenedAt: null,
    } as const;

    it("parses a project and keeps lastOpenedAt nullable but required", () => {
      expect(ProjectInfo.parse(PROJECT_INFO).lastOpenedAt).toBeNull();
      expect(ProjectInfo.parse({ ...PROJECT_INFO, lastOpenedAt: 42 }).lastOpenedAt).toBe(42);
      const { lastOpenedAt: _omitted, ...missing } = PROJECT_INFO;
      expect(() => ProjectInfo.parse(missing)).toThrow();
    });

    it("lets a project be named anything a folder can be called, unlike a room", () => {
      // A room name is a folder *segment* and is folded into a slug; a project name is a label.
      expect(ProjectInfo.parse({ ...PROJECT_INFO, name: "My Project" }).name).toBe("My Project");
      expect(() => ProjectInfo.parse({ ...PROJECT_INFO, name: "" })).toThrow();
      expect(() => ProjectInfo.parse({ ...PROJECT_INFO, name: "n".repeat(121) })).toThrow();
      expect(() => ProjectInfo.parse({ ...PROJECT_INFO, root: "" })).toThrow();
    });

    it("parses the project client messages", () => {
      expect(ClientMessage.parse({ kind: "list_projects" }).kind).toBe("list_projects");
      expect(ClientMessage.parse({ kind: "create_project", root: "/tmp/x" }))
        .toEqual({ kind: "create_project", root: "/tmp/x" });
      expect(ClientMessage.parse({ kind: "create_project", root: "/tmp/x", name: "X" }))
        .toMatchObject({ name: "X" });
      expect(ClientMessage.parse({ kind: "open_project", projectId: "p1" }))
        .toEqual({ kind: "open_project", projectId: "p1" });

      expect(() => ClientMessage.parse({ kind: "create_project" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "create_project", root: "" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "open_project" })).toThrow();
    });

    it("carries the active project alongside the list, because it is per-socket", () => {
      const m = ServerMessage.parse({
        kind: "projects", projects: [PROJECT_INFO], activeProjectId: "p1",
      });
      expect(m).toMatchObject({ kind: "projects", activeProjectId: "p1" });
      // a list with no active id would leave a tab unable to say which floor it is showing
      expect(() => ServerMessage.parse({ kind: "projects", projects: [PROJECT_INFO] })).toThrow();
      expect(() => ServerMessage.parse({ kind: "projects", activeProjectId: "p1" })).toThrow();
    });
  });

  describe("room folders", () => {
    it("accepts create_room with and without an explicit path", () => {
      expect(ClientMessage.parse({ kind: "create_room", name: "backend" }))
        .toEqual({ kind: "create_room", name: "backend" });
      expect(ClientMessage.parse({ kind: "create_room", name: "backend", path: "/srv/other-repo" }))
        .toMatchObject({ path: "/srv/other-repo" });
      expect(() => ClientMessage.parse({ kind: "create_room", name: "backend", path: "" })).toThrow();
      // the name is still a folder segment even when the folder is chosen explicitly
      expect(() => ClientMessage.parse({ kind: "create_room", name: "Backend", path: "/srv/x" })).toThrow();
    });

    it("parses set_room_path and requires both ends of it", () => {
      expect(ClientMessage.parse({ kind: "set_room_path", roomId: "r1", path: "/srv/other" }))
        .toEqual({ kind: "set_room_path", roomId: "r1", path: "/srv/other" });
      expect(() => ClientMessage.parse({ kind: "set_room_path", roomId: "r1" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "set_room_path", path: "/srv/other" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "set_room_path", roomId: "r1", path: "" })).toThrow();
    });
  });

  describe("notices and attachments", () => {
    it("parses a notice — the channel that is not an error", () => {
      expect(ServerMessage.parse({ kind: "notice", message: "saved to /p/attachments/a.png" }))
        .toEqual({ kind: "notice", message: "saved to /p/attachments/a.png" });
      expect(() => ServerMessage.parse({ kind: "notice" })).toThrow();
      // and it stays a *distinct* kind from `error`: a client must be able to paint them differently
      expect(ServerMessage.parse({ kind: "error", message: "nope" }).kind).toBe("error");
    });

    it("describes the upload endpoint's answer", () => {
      const body = AttachmentUploadResult.parse({
        saved: [{ name: "a.png", path: "/p/attachments/a.png", bytes: 12 }],
      });
      expect(body.saved[0]).toMatchObject({ name: "a.png", path: "/p/attachments/a.png" });
      expect(() => AttachmentUploadResult.parse({ saved: [{ name: "a.png" }] })).toThrow();
      expect(AttachmentUploadResult.parse({ saved: [] }).saved).toEqual([]);
    });

    it("fixes the destination folder and the size cap in one place", () => {
      expect(ATTACHMENTS_DIRNAME).toBe("attachments");
      expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
    });
  });
});
