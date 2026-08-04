import { describe, it, expect } from "vitest";
import {
  ACCOUNT_CREDENTIALS_FILE, AGENT_MODELS, ATTACHMENTS_DIRNAME, AccountBurn, AccountInfo, AccountUsage,
  AttachmentUploadResult, AutonomyMode,
  CHRONICLE_SEARCH_LIMIT, ChronicleHit, ClientMessage,
  DEFAULT_AUTONOMY, FACTORY_EXPORT_FORMAT, FACTORY_EXPORT_NOTE, FACTORY_EXPORT_VERSION, FactoryExport,
  FactoryMetrics, LIMIT_PAUSE_PERCENT, LIMIT_WARN_PERCENT,
  MAX_ATTACHMENT_BYTES, MessageInfo, MessageKind, ModelId,
  ProjectInfo, RoleSpec, RoomInfo, ServerMessage, SessionEvent, SessionStatus, TaskInfo, TaskStatus,
  USAGE_POLL_INTERVAL_MS, UsageWindow,
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

  // ---- M3b: the chronicle on the wire ----

  describe("the chronicle", () => {
    const HIT = {
      kind: "decision", title: "Retries live in payments", snippet: "the webhook…",
      createdAt: 1_770_000_000, ref: "d1", seq: 0, roomId: "r1", path: "/p/docs/decisions/0001-x.md",
    } as const;

    it("parses search_chronicle, defaulting the query to the newest decisions", () => {
      // No query at all is a real request, not a malformed one: it is what opening the surface asks.
      expect(ClientMessage.parse({ kind: "search_chronicle" }))
        .toEqual({ kind: "search_chronicle", query: "" });
      expect(ClientMessage.parse({ kind: "search_chronicle", query: "webhook", limit: 5 }))
        .toEqual({ kind: "search_chronicle", query: "webhook", limit: 5 });
      // FTS5 operators are the server's problem (`ftsQuery`), so the wire takes them verbatim.
      expect(ClientMessage.parse({ kind: "search_chronicle", query: 'the "retry policy' }).query)
        .toBe('the "retry policy');
      expect(() => ClientMessage.parse({ kind: "search_chronicle", limit: 0 })).toThrow();
      expect(() => ClientMessage.parse({ kind: "search_chronicle", limit: 51 })).toThrow();
      expect(() => ClientMessage.parse({ kind: "search_chronicle", query: "x".repeat(501) })).toThrow();
    });

    it("answers with the hits and the query they answer", () => {
      const msg = ServerMessage.parse({ kind: "chronicle", query: "webhook", hits: [HIT] });
      expect(msg).toEqual({ kind: "chronicle", query: "webhook", hits: [HIT] });
      // The echo is what lets a client drop a stale answer, so it is required rather than optional.
      expect(() => ServerMessage.parse({ kind: "chronicle", hits: [] })).toThrow();
      expect(ServerMessage.parse({ kind: "chronicle", query: "", hits: [] }).kind).toBe("chronicle");
    });

    it("keeps a hit's two sources apart, and only a decision has a file", () => {
      expect(ChronicleHit.parse({ ...HIT, kind: "event", seq: 12, path: null }))
        .toMatchObject({ kind: "event", path: null });
      expect(() => ChronicleHit.parse({ ...HIT, kind: "prompt" })).toThrow();
      // `path` is nullable but never absent: "no file" is a fact the panel has to be told.
      const { path: _omitted, ...noPath } = HIT;
      expect(() => ChronicleHit.parse(noPath)).toThrow();
    });

    it("has a default result count both sides can agree on", () => {
      expect(CHRONICLE_SEARCH_LIMIT).toBe(10);
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

  describe("accounts", () => {
    const ACCOUNT = {
      id: "a1", label: "Work", configDir: "/home/me/.claude-work",
      credentialsPresent: false, createdAt: 1_800_000_000, lastUsedAt: null,
      login: { status: "idle", url: null, message: null },
    } as const;

    it("parses an account, login state and all", () => {
      expect(AccountInfo.parse(ACCOUNT)).toEqual(ACCOUNT);
    });

    it("requires a label and a config directory", () => {
      expect(() => AccountInfo.parse({ ...ACCOUNT, label: "" })).toThrow();
      expect(() => AccountInfo.parse({ ...ACCOUNT, configDir: "" })).toThrow();
    });

    it("carries the four states an in-app login can be in, plus idle", () => {
      for (const status of ["idle", "starting", "awaiting_code", "finishing", "failed"]) {
        expect(AccountInfo.parse({ ...ACCOUNT, login: { status, url: null, message: null } })
          .login.status).toBe(status);
      }
      expect(() => AccountInfo.parse({ ...ACCOUNT, login: { status: "confused", url: null, message: null } }))
        .toThrow();
    });

    it("names the file that means a login finished, once, for both sides", () => {
      expect(ACCOUNT_CREDENTIALS_FILE).toBe(".credentials.json");
    });

    it("carries the account list as its own server message", () => {
      const m = ServerMessage.parse({ kind: "accounts", accounts: [ACCOUNT] });
      expect(m.kind === "accounts" && m.accounts[0]!.label).toBe("Work");
      expect(ServerMessage.parse({ kind: "accounts", accounts: [] })).toEqual({ kind: "accounts", accounts: [] });
    });

    it("parses the five account client messages", () => {
      expect(ClientMessage.parse({ kind: "list_accounts" }).kind).toBe("list_accounts");
      expect(ClientMessage.parse({ kind: "create_account", label: "Work", configDir: "/c" }).kind)
        .toBe("create_account");
      expect(ClientMessage.parse({ kind: "remove_account", accountId: "a1" }).kind).toBe("remove_account");
      expect(ClientMessage.parse({ kind: "begin_account_login", accountId: "a1" }).kind)
        .toBe("begin_account_login");
      expect(ClientMessage.parse({ kind: "submit_account_login_code", accountId: "a1", code: "x" }).kind)
        .toBe("submit_account_login_code");
      expect(ClientMessage.parse({ kind: "cancel_account_login", accountId: "a1" }).kind)
        .toBe("cancel_account_login");
    });

    it("refuses an account with no label or no directory on the wire too", () => {
      expect(() => ClientMessage.parse({ kind: "create_account", label: "", configDir: "/c" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "create_account", label: "Work", configDir: "" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "submit_account_login_code", accountId: "a1", code: "" }))
        .toThrow();
    });

    it("null is a real value on both bindings: it means the ambient ~/.claude", () => {
      // Distinguishable from "leave it alone", which is what an omitted field would mean — the two
      // are different instructions and the wire has to be able to say either.
      expect(ClientMessage.parse({ kind: "set_room_account", roomId: "r1", accountId: null }))
        .toEqual({ kind: "set_room_account", roomId: "r1", accountId: null });
      expect(ClientMessage.parse({ kind: "set_session_account", sessionId: "s1", accountId: null }))
        .toEqual({ kind: "set_session_account", sessionId: "s1", accountId: null });
      expect(() => ClientMessage.parse({ kind: "set_room_account", roomId: "r1" })).toThrow();
      expect(() => ClientMessage.parse({ kind: "set_session_account", sessionId: "s1" })).toThrow();
    });

    it("an agent may be created on a named account, or on none", () => {
      expect(ClientMessage.parse({ kind: "create_session", roomId: "r1", accountId: "a1" }))
        .toMatchObject({ accountId: "a1" });
      // Omitted is the normal path: the room's default decides.
      expect(ClientMessage.parse({ kind: "create_session", roomId: "r1" }))
        .not.toHaveProperty("accountId");
    });

    it("a room and a session both report which account they are on, defaulting to none", () => {
      const room = RoomInfo.parse({
        id: "r1", name: "backend", path: "/p/backend", kind: "room", agentCount: 0,
      });
      // A client written before accounts existed sends no field, and the answer is the pre-M2
      // behaviour rather than a parse failure.
      expect(room.accountId).toBeNull();
      expect(RoomInfo.parse({
        id: "r1", name: "backend", path: "/p/backend", kind: "room", agentCount: 0, accountId: "a1",
      }).accountId).toBe("a1");

      expect(ServerMessage.parse({ kind: "sessions", sessions: [SESSION_INFO] }))
        .toMatchObject({ sessions: [{ accountId: null }] });
      expect(ServerMessage.parse({ kind: "sessions", sessions: [{ ...SESSION_INFO, accountId: "a1" }] }))
        .toMatchObject({ sessions: [{ accountId: "a1" }] });
    });
  });

  describe("runtimes", () => {
    const ROOM = { id: "r1", name: "backend", path: "/p/backend", kind: "room", agentCount: 0 };

    it("a room defaults to the host, which is what every room did before M4", () => {
      // The default is the whole compatibility story: a database written before the column existed,
      // and a client built before the field existed, both mean "on this machine, as the operator".
      expect(RoomInfo.parse(ROOM).runtime).toBe("host");
      expect(RoomInfo.parse({ ...ROOM, runtime: "container" }).runtime).toBe("container");
      expect(() => RoomInfo.parse({ ...ROOM, runtime: "vm" })).toThrow();
    });

    it("a session reports the runtime it is actually running in, and null when it is not running", () => {
      // Deliberately not defaulted to "host": a stopped agent runs nowhere, and a floor that showed
      // a runtime for one would be describing a process that does not exist.
      expect(ServerMessage.parse({ kind: "sessions", sessions: [SESSION_INFO] }))
        .toMatchObject({ sessions: [{ runtime: null }] });
      expect(ServerMessage.parse({ kind: "sessions", sessions: [{ ...SESSION_INFO, runtime: "container" }] }))
        .toMatchObject({ sessions: [{ runtime: "container" }] });
    });

    it("parses set_room_runtime and refuses a runtime it does not know", () => {
      expect(ClientMessage.parse({ kind: "set_room_runtime", roomId: "r1", runtime: "container" }))
        .toEqual({ kind: "set_room_runtime", roomId: "r1", runtime: "container" });
      expect(() => ClientMessage.parse({ kind: "set_room_runtime", roomId: "r1", runtime: "vm" })).toThrow();
      // No default on the wire: a message that does not say which runtime it wants is not a message
      // about runtimes, and guessing would be choosing for the operator.
      expect(() => ClientMessage.parse({ kind: "set_room_runtime", roomId: "r1" })).toThrow();
    });
  });
  describe("limits", () => {
    const WINDOW = {
      key: "five_hour", label: "5-hour", utilization: 43,
      resetsAt: "2026-08-04T04:10:00.849724+00:00",
    };
    const USAGE = {
      accountId: "a1", source: "endpoint", approximate: false, windows: [WINDOW],
      readAt: 1_754_269_200, note: null, limited: false, limitedUntil: null,
    };

    it("takes a window whose key this build has never heard of", () => {
      // The endpoint is undocumented and already invents keys (`weekly_scoped:Opus`,
      // `seven_day_cowork`). A closed enum here would mean a release is needed before a window
      // Anthropic added this morning can be shown at all.
      expect(UsageWindow.parse({ ...WINDOW, key: "fortnightly_gerbil", label: "Fortnightly Gerbil" }).key)
        .toBe("fortnightly_gerbil");
    });

    it("refuses a utilization outside 0–100 and allows a window with no reset time", () => {
      expect(() => UsageWindow.parse({ ...WINDOW, utilization: 140 })).toThrow();
      expect(() => UsageWindow.parse({ ...WINDOW, utilization: -1 })).toThrow();
      expect(UsageWindow.parse({ ...WINDOW, resetsAt: null }).resetsAt).toBeNull();
    });

    it("defaults a window's detail to null, so an older sender still parses", () => {
      expect(UsageWindow.parse(WINDOW).detail).toBeNull();
    });

    it("carries `approximate` as a required fact, not an optional flourish", () => {
      // An estimate shown as a measurement is the failure this field exists to prevent, so it may
      // never be omitted and default to "trustworthy".
      const { approximate: _omitted, ...withoutIt } = USAGE;
      expect(() => AccountUsage.parse(withoutIt)).toThrow();
      expect(AccountUsage.parse({ ...USAGE, source: "estimate", approximate: true }).approximate).toBe(true);
    });

    it("allows an account that has never been read — null readAt, no windows", () => {
      const fresh = AccountUsage.parse({ ...USAGE, readAt: null, windows: [] });
      expect(fresh.readAt).toBeNull();
      expect(fresh.windows).toEqual([]);
    });

    it("puts the meters on the wire, and asks for them without naming a project", () => {
      expect(ServerMessage.parse({ kind: "usage", usage: [USAGE] })).toMatchObject({ kind: "usage" });
      // Machine-wide, like `list_accounts`: a subscription's quota is the operator's, not a floor's.
      expect(ClientMessage.parse({ kind: "list_usage" }).kind).toBe("list_usage");
    });

    it("says *how* an account is known to be limited, because the scheduler branches on it", () => {
      // A reading from the estimate may never cut an agent off; the provider refusing a turn may.
      expect(AccountUsage.parse(USAGE).limitedBy).toBeNull();
      expect(AccountUsage.parse({ ...USAGE, limited: true, limitedBy: "rate_limit_error" }).limitedBy)
        .toBe("rate_limit_error");
      expect(() => AccountUsage.parse({ ...USAGE, limitedBy: "vibes" })).toThrow();
    });

    it("carries a paused agent's countdown, and allows a pause with no known end", () => {
      expect(ServerMessage.parse({ kind: "sessions", sessions: [SESSION_INFO] }))
        .toMatchObject({ sessions: [{ pausedUntil: null }] });
      expect(ServerMessage.parse({
        kind: "sessions",
        sessions: [{ ...SESSION_INFO, state: "paused", status: "paused", pausedUntil: 1_754_269_200 }],
      })).toMatchObject({ sessions: [{ pausedUntil: 1_754_269_200 }] });
    });

    it("keeps the thresholds and the poll floor in one place for both sides", () => {
      expect(LIMIT_WARN_PERCENT).toBeLessThan(LIMIT_PAUSE_PERCENT);
      expect(LIMIT_PAUSE_PERCENT).toBeLessThan(100);
      // docs/RESEARCH.md §2: ~180 s is what is safe against an endpoint nobody documented.
      expect(USAGE_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(180_000);
    });
  });

  describe("roles", () => {
    const MINIMAL = {
      id: "architect", name: "Architect", summary: "Shape, not code.",
      promptAppend: "You are the architect.",
    } as const;

    it("parses a minimal role, and everything optional is absent rather than guessed", () => {
      const role = RoleSpec.parse(MINIMAL);
      // Absent, not defaulted: a role with no model can never be the reason an agent is on one.
      expect(role.model).toBeUndefined();
      expect(role.autonomy).toBeUndefined();
      expect(role.skills).toEqual([]);
      expect(role.mcpServers).toEqual({});
      expect(role.allowedTools).toEqual([]);
    });

    it("rejects an unknown field, because a typo that parses is the worst config-file failure", () => {
      // `skill:` for `skills:` would otherwise ship a role whose whole point silently never arrives.
      expect(() => RoleSpec.parse({ ...MINIMAL, skill: ["tdd"] })).toThrow();
    });

    it("holds the id to something usable as a filename, and the summary to one line's worth", () => {
      expect(() => RoleSpec.parse({ ...MINIMAL, id: "Architect Room" })).toThrow();
      expect(() => RoleSpec.parse({ ...MINIMAL, id: "-leading" })).toThrow();
      expect(() => RoleSpec.parse({ ...MINIMAL, summary: "" })).toThrow();
      expect(() => RoleSpec.parse({ ...MINIMAL, promptAppend: "" })).toThrow();
    });

    it("takes the three outside-facing MCP transports and refuses anything else", () => {
      const role = RoleSpec.parse({
        ...MINIMAL,
        mcpServers: { pw: { type: "stdio", command: "npx", args: ["-y", "x"] } },
      });
      expect(role.mcpServers.pw).toEqual({ type: "stdio", command: "npx", args: ["-y", "x"], env: {} });
      expect(RoleSpec.parse({ ...MINIMAL, mcpServers: { r: { type: "http", url: "http://x" } } })
        .mcpServers.r).toEqual({ type: "http", url: "http://x", headers: {} });
      // The in-process variant holds a live object, so it cannot come from a file — and the only one
      // this product has is the factory bus, which a role must never be able to replace.
      expect(() => RoleSpec.parse({ ...MINIMAL, mcpServers: { f: { type: "sdk", instance: {} } } }))
        .toThrow();
    });

    it("puts the library on the wire with its failures attached", () => {
      const msg = ServerMessage.parse({
        kind: "roles",
        roles: [MINIMAL],
        problems: [{ file: "/p/roles/broken.yaml", message: "is not valid YAML" }],
      });
      expect(msg).toMatchObject({ kind: "roles", problems: [{ file: "/p/roles/broken.yaml" }] });
      expect(ClientMessage.parse({ kind: "list_roles" }).kind).toBe("list_roles");
    });

    it("carries a role onto a new agent, and lets a live one be cleared with null", () => {
      expect(ClientMessage.parse({ kind: "create_session", roomId: "r1", roleId: "architect" }))
        .toMatchObject({ roleId: "architect" });
      // Omitted is a plain agent, which is what every session before roles was. Absent rather than
      // defaulted, so `CreateSessionOptions.roleId` stays "the caller said nothing".
      expect(ClientMessage.parse({ kind: "create_session", roomId: "r1" }))
        .not.toHaveProperty("roleId");
      expect(ClientMessage.parse({ kind: "set_role", sessionId: "s1", roleId: null }).kind)
        .toBe("set_role");
      expect(() => ClientMessage.parse({ kind: "set_role", sessionId: "s1", roleId: "Not An Id" }))
        .toThrow();
    });

    it("reports a session's role, defaulting to none for a row written before roles existed", () => {
      expect(ServerMessage.parse({ kind: "sessions", sessions: [SESSION_INFO] }))
        .toMatchObject({ sessions: [{ roleId: null }] });
      expect(ServerMessage.parse({
        kind: "sessions", sessions: [{ ...SESSION_INFO, roleId: "architect" }],
      })).toMatchObject({ sessions: [{ roleId: "architect" }] });
    });
  });
  /**
   * M5: burn rate and cost.
   *
   * The wire's job here is to make an unknown projection *representable* — a null hour figure with a
   * reason beside it — because a schema that required a number would have forced a guess into it.
   */
  describe("burn rate and cost", () => {
    const BURN = {
      accountId: "a1", windowKey: "five_hour", windowLabel: "5-hour", percentPerHour: 12.5,
      secondsToLimit: 7200, resetsFirst: false, approximate: false, samples: 21, spanSeconds: 3600,
      unknown: null,
    } as const;
    const ROLLUPS = { day: { usd: 0.42, turns: 3 }, week: { usd: 1.75, turns: 11 } } as const;

    it("carries a projection, and carries the absence of one just as precisely", () => {
      expect(AccountBurn.parse(BURN).secondsToLimit).toBe(7200);
      // The shape that matters: no figure, and the reason in the operator's words. A schema that made
      // `secondsToLimit` required would have forced a guess into this position.
      const unknown = AccountBurn.parse({
        ...BURN, windowKey: null, windowLabel: null, percentPerHour: null, secondsToLimit: null,
        samples: 1, spanSeconds: 0, unknown: "only 1 reading of 5-hour so far — a rate needs two",
      });
      expect(unknown.secondsToLimit).toBeNull();
      expect(unknown.unknown).toContain("a rate needs two");
    });

    it("puts the metrics on the wire with the ambient account reported separately", () => {
      const metrics = FactoryMetrics.parse({
        accounts: [{ accountId: "a1", burn: BURN, cost: ROLLUPS }],
        ambient: ROLLUPS,
        rooms: [{ roomId: "r1", cost: ROLLUPS }],
      });
      expect(metrics.accounts[0]!.cost.week.usd).toBe(1.75);
      // Agents on the operator's own `~/.claude` have no account row to hang spend on, so they get
      // their own bucket rather than an invented entry in the account list.
      expect(metrics.ambient.day.turns).toBe(3);
      expect(ServerMessage.parse({ kind: "metrics", metrics }).kind).toBe("metrics");
      expect(ClientMessage.parse({ kind: "list_metrics" }).kind).toBe("list_metrics");
    });

    it("refuses a negative dollar figure and a utilisation-free projection", () => {
      expect(() => FactoryMetrics.parse({
        accounts: [], ambient: { day: { usd: -1, turns: 0 }, week: { usd: 0, turns: 0 } }, rooms: [],
      })).toThrow();
    });

  });

});
