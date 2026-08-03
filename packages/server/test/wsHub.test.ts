import { describe, it, expect } from "bun:test";
import { waitFor } from "./_waitFor.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { FakeExecutor } from "../src/executors/fake.js";
import { FactoryBus } from "../src/factoryBus.js";
import { TaskStore } from "../src/taskStore.js";
import { WsHub, type SocketLike } from "../src/wsHub.js";

function fakeSocket() {
  const sent: any[] = [];
  const sock: SocketLike = { send: (d: string) => sent.push(JSON.parse(d)) };
  return { sock, sent };
}

/**
 * A hub over an in-memory db with a scripted fake executor, plus one attached socket. `root` is the
 * project root the rooms live under; tests that actually create rooms pass a throwaway directory and
 * remove it afterwards.
 */
function makeHub(opts: {
  script?: { tool: string; input: unknown }[]; attach?: boolean; root?: string;
  sessionsDebounceMs?: number;
  /** false builds an M0-shaped hub with no task board and no bus. */
  stores?: boolean;
} = {}) {
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const exec = new FakeExecutor(opts.script ? { script: opts.script } : {});
  const projects = new ProjectManager(db, opts.root ?? tmpdir());
  const rooms = new RoomManager(db, projects);
  const tasks = new TaskStore(db, projects);
  const mgr = new SessionManager(db, store, exec, rooms, projects, { tasks });
  const bus = new FactoryBus({
    db, rooms, projects,
    deliver: (sessionId, text) => mgr.prompt(sessionId, text),
    roomAgents: (roomId) => mgr.roomAgents(roomId),
  });
  const withStores = opts.stores !== false;
  const hub = new WsHub(store, mgr, rooms, projects, {
    sessionsDebounceMs: opts.sessionsDebounceMs,
    tasks: withStores ? tasks : undefined,
    bus: withStores ? bus : undefined,
  });
  const { sock, sent } = fakeSocket();
  if (opts.attach !== false) hub.attach(sock);
  return { db, store, exec, projects, rooms, tasks, bus, mgr, hub, sock, sent };
}

/** The hub's private socket -> watermark table; asserted directly, it is the thing I1 broke. */
function subsFor(hub: WsHub): Map<SocketLike, Map<string, number>> {
  return (hub as unknown as { subs: Map<SocketLike, Map<string, number>> }).subs;
}

/**
 * The hub's single coalescing timer, shared by every pushed list (`sessions`, `tasks`, `messages`).
 * A pending broadcast must never be the reason the process refuses to exit, so tests assert it is
 * unref'd — whichever list scheduled it.
 */
function pendingTimer(hub: WsHub): { hasRef?: () => boolean } | null {
  return (hub as unknown as { broadcastTimer: { hasRef?: () => boolean } | null }).broadcastTimer;
}

describe("WsHub", () => {
  it("replays events after subscribe and tails new ones", async () => {
    const db = openDb(":memory:");
    const store = new EventStore(db);
    const exec = new FakeExecutor();
    const projects = new ProjectManager(db, tmpdir());
    const rooms = new RoomManager(db, projects);
    const mgr = new SessionManager(db, store, exec, rooms, projects);
    const hub = new WsHub(store, mgr, rooms, projects);
    const id = mgr.createSession({ cwd: "/tmp" });
    mgr.prompt(id, "first");
    await exec.settle();

    const { sock, sent } = fakeSocket();
    hub.attach(sock);
    hub.handleMessage(sock, JSON.stringify({ kind: "subscribe", sessionId: id, afterSeq: 0 }));
    const replayed = sent.filter(m => m.kind === "event").length;
    expect(replayed).toBeGreaterThan(0);

    hub.handleMessage(sock, JSON.stringify({ kind: "prompt", sessionId: id, text: "second" }));
    await exec.settle();
    const total = sent.filter(m => m.kind === "event").length;
    expect(total).toBeGreaterThan(replayed);
    // seq strictly increasing, no duplicates
    const seqs = sent.filter(m => m.kind === "event").map(m => m.seq);
    expect([...new Set(seqs)].length).toBe(seqs.length);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  });

  it("routes create_session, list_sessions, approval, and interrupt messages", async () => {
    const db = openDb(":memory:");
    const store = new EventStore(db);
    const exec = new FakeExecutor({ script: [{ tool: "Bash", input: {} }] });
    const projects = new ProjectManager(db, tmpdir());
    const rooms = new RoomManager(db, projects);
    const mgr = new SessionManager(db, store, exec, rooms, projects);
    const hub = new WsHub(store, mgr, rooms, projects);
    const { sock, sent } = fakeSocket();
    hub.attach(sock);

    hub.handleMessage(sock, JSON.stringify({ kind: "create_session", cwd: "/tmp" }));
    const sessionsMsg = sent.find(m => m.kind === "sessions");
    expect(sessionsMsg).toBeTruthy();
    const id = sessionsMsg.sessions[0].id;

    hub.handleMessage(sock, JSON.stringify({ kind: "list_sessions" }));
    expect(sent.filter(m => m.kind === "sessions").length).toBeGreaterThanOrEqual(2);

    hub.handleMessage(sock, JSON.stringify({ kind: "prompt", sessionId: id, text: "run it" }));
    await new Promise(r => setTimeout(r, 20));
    const approvalEvent = sent.find(m => m.kind === "event" && m.event.type === "approval_request");
    expect(approvalEvent).toBeTruthy();
    hub.handleMessage(sock, JSON.stringify({ kind: "approval", sessionId: id, approvalId: approvalEvent.event.approvalId, behavior: "allow" }));
    await exec.settle();
    expect(sent.some(m => m.kind === "event" && m.event.type === "approval_resolved")).toBe(true);

    hub.handleMessage(sock, JSON.stringify({ kind: "interrupt", sessionId: id }));
  });

  it("sends an error message for malformed input", () => {
    const db = openDb(":memory:");
    const store = new EventStore(db);
    const exec = new FakeExecutor();
    const projects = new ProjectManager(db, tmpdir());
    const rooms = new RoomManager(db, projects);
    const mgr = new SessionManager(db, store, exec, rooms, projects);
    const hub = new WsHub(store, mgr, rooms, projects);
    const { sock, sent } = fakeSocket();
    hub.attach(sock);
    hub.handleMessage(sock, "not json");
    expect(sent.some(m => m.kind === "error")).toBe(true);
  });

  // ---- C1: a frame that makes the dispatch throw must not escape handleMessage ----

  describe("dispatch failures", () => {
    const frames = [
      { kind: "prompt", sessionId: "nope", text: "hi" },
      { kind: "approval", sessionId: "nope", approvalId: "also-nope", behavior: "allow" },
      { kind: "create_session", cwd: "/definitely/not/a/real/path" },
    ];

    for (const frame of frames) {
      it(`replies error instead of throwing for ${frame.kind} on an unknown target`, () => {
        const { hub, sock, sent } = makeHub();
        expect(() => hub.handleMessage(sock, JSON.stringify(frame))).not.toThrow();
        expect(sent.filter(m => m.kind === "error")).toHaveLength(1);
      });
    }

    it("replies error for an interrupt on an unknown session without an unhandled rejection", async () => {
      const { hub, sock, sent } = makeHub();
      // The manager's interrupt() is a no-op for unknown ids today; make it reject to prove the
      // rejection is caught and reported rather than taking the process down.
      const mgr = (hub as unknown as { mgr: SessionManager }).mgr;
      mgr.interrupt = async () => { throw new Error("interrupt exploded"); };
      expect(() => hub.handleMessage(sock, JSON.stringify({ kind: "interrupt", sessionId: "nope" }))).not.toThrow();
      await waitFor(() => {
        if (!sent.some(m => m.kind === "error" && /interrupt exploded/.test(m.message))) throw new Error("not yet");
      });
    });
  });

  // ---- per-agent autonomy over the wire ----

  describe("set_autonomy", () => {
    it("creates a session in the requested mode and reports it back", () => {
      const { hub, sock, sent } = makeHub();
      hub.handleMessage(sock, JSON.stringify({ kind: "create_session", cwd: "/tmp", autonomy: "bypass" }));
      const sessions = sent.find(m => m.kind === "sessions").sessions;
      expect(sessions[0].autonomy).toBe("bypass");
    });

    it("switches a live session and replies with an updated sessions message", async () => {
      const { hub, mgr, sock, sent } = makeHub();
      const id = mgr.createSession({ cwd: "/tmp", autonomy: "auto" });
      hub.handleMessage(sock, JSON.stringify({ kind: "set_autonomy", sessionId: id, autonomy: "attended" }));
      await waitFor(() => {
        const last = sent.filter(m => m.kind === "sessions").at(-1);
        if (last === undefined) throw new Error("no sessions reply yet");
        if (last.sessions.find((s: any) => s.id === id).autonomy !== "attended") throw new Error("not yet");
      });
      expect(sent.some(m => m.kind === "error")).toBe(false);
      expect(mgr.listSessions()[0].autonomy).toBe("attended");
    });

    it("replies error for an unknown session without throwing", async () => {
      const { hub, sock, sent } = makeHub();
      expect(() => hub.handleMessage(sock, JSON.stringify({ kind: "set_autonomy", sessionId: "nope", autonomy: "bypass" })))
        .not.toThrow();
      await waitFor(() => {
        if (!sent.some(m => m.kind === "error" && /unknown session/.test(m.message))) throw new Error("not yet");
      });
      expect(sent.some(m => m.kind === "sessions")).toBe(false);
    });

    it("rejects an autonomy value outside the protocol enum", () => {
      const { hub, mgr, sock, sent } = makeHub();
      const id = mgr.createSession({ cwd: "/tmp", autonomy: "auto" });
      hub.handleMessage(sock, JSON.stringify({ kind: "set_autonomy", sessionId: id, autonomy: "bypassPermissions" }));
      expect(sent.some(m => m.kind === "error" && m.message === "bad message")).toBe(true);
      expect(mgr.listSessions()[0].autonomy).toBe("auto");
    });
  });

  // ---- M1a: rooms over the wire ----

  describe("rooms", () => {
    /** A hub whose rooms live under a throwaway project root, removed afterwards. */
    function withRoot<T>(fn: (ctx: ReturnType<typeof makeHub> & { root: string }) => T): T {
      const root = mkdtempSync(join(tmpdir(), "superfabric-hub-rooms-"));
      const ctx = makeHub({ root });
      ctx.rooms.ensureProjectRoom();
      try {
        return fn({ ...ctx, root });
      } finally {
        // The db is in-memory and deliberately left open: a session's providerSessionId lands on a
        // later microtask, and closing underneath it turns a passing test into a stray rejection.
        rmSync(root, { recursive: true, force: true });
      }
    }

    const lastRooms = (sent: any[]) => sent.filter(m => m.kind === "rooms").at(-1)?.rooms as any[] | undefined;

    it("create_room replies with a rooms message including the new room", () => {
      withRoot(({ root, hub, sock, sent }) => {
        hub.handleMessage(sock, JSON.stringify({ kind: "create_room", name: "backend" }));
        const rooms = lastRooms(sent)!;
        expect(rooms.map(r => r.kind)).toEqual(["project", "room"]);
        expect(rooms[1]).toMatchObject({ name: "backend", path: join(root, "backend"), agentCount: 0 });
        expect(existsSync(join(root, "backend", "CLAUDE.md"))).toBe(true);
        expect(sent.some(m => m.kind === "error")).toBe(false);
      });
    });

    it("list_rooms replies with the current rooms", () => {
      withRoot(({ hub, rooms, sock, sent }) => {
        rooms.createRoom("backend");
        rooms.createRoom("web");
        hub.handleMessage(sock, JSON.stringify({ kind: "list_rooms" }));
        expect(lastRooms(sent)!.map(r => r.name)).toEqual([rooms.listRooms()[0].name, "backend", "web"]);
      });
    });

    it("move_room replies with the updated rooms", () => {
      withRoot(({ hub, rooms, sock, sent }) => {
        const room = rooms.createRoom("backend");
        hub.handleMessage(sock, JSON.stringify({ kind: "move_room", roomId: room.id, position: { x: -3, z: 7.5 } }));
        expect(lastRooms(sent)!.find(r => r.id === room.id).position).toEqual({ x: -3, z: 7.5 });
        expect(sent.some(m => m.kind === "error")).toBe(false);
      });
    });

    it("create_session with a roomId puts the agent in the room and refreshes agentCount", () => {
      withRoot(({ hub, rooms, mgr, sock, sent }) => {
        const room = rooms.createRoom("backend");
        hub.handleMessage(sock, JSON.stringify({ kind: "create_session", roomId: room.id }));

        const sessions = sent.filter(m => m.kind === "sessions").at(-1).sessions;
        expect(sessions).toHaveLength(1);
        expect(sessions[0].roomId).toBe(room.id);
        // the same round trip carries the room list, so the building's label is already right
        expect(lastRooms(sent)!.find(r => r.id === room.id).agentCount).toBe(1);
        expect(mgr.listSessions()[0].roomId).toBe(room.id);
        expect(sent.some(m => m.kind === "error")).toBe(false);
      });
    });

    it("does not send a rooms message for a roomless create_session", () => {
      withRoot(({ hub, sock, sent }) => {
        hub.handleMessage(sock, JSON.stringify({ kind: "create_session", cwd: "/tmp" }));
        expect(sent.some(m => m.kind === "sessions")).toBe(true);
        expect(sent.some(m => m.kind === "rooms")).toBe(false);
      });
    });

    // ---- the M0 dispatch guard keeps holding for every new case ----

    it("replies error without throwing for a duplicate room name", () => {
      withRoot(({ root, hub, rooms, sock, sent }) => {
        rooms.createRoom("backend");
        writeFileSync(join(root, "backend", "CLAUDE.md"), "# mine\n");
        expect(() => hub.handleMessage(sock, JSON.stringify({ kind: "create_room", name: "backend" }))).not.toThrow();
        expect(sent.filter(m => m.kind === "error")).toHaveLength(1);
        expect(sent.some(m => m.kind === "rooms")).toBe(false);
        // the existing room's charter was not touched
        expect(readFileSync(join(root, "backend", "CLAUDE.md"), "utf8")).toBe("# mine\n");
      });
    });

    it("replies error without throwing for move_room on an unknown id", () => {
      withRoot(({ hub, sock, sent }) => {
        expect(() => hub.handleMessage(sock, JSON.stringify({ kind: "move_room", roomId: "nope", position: { x: 1, z: 1 } })))
          .not.toThrow();
        expect(sent.filter(m => m.kind === "error")).toHaveLength(1);
        expect(sent.some(m => m.kind === "rooms")).toBe(false);
      });
    });

    it("replies error without throwing for create_session with an unknown roomId", () => {
      withRoot(({ hub, db, sock, sent }) => {
        expect(() => hub.handleMessage(sock, JSON.stringify({ kind: "create_session", roomId: "nope" }))).not.toThrow();
        expect(sent.filter(m => m.kind === "error")).toHaveLength(1);
        expect(sent.some(m => m.kind === "sessions")).toBe(false);
        expect((db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c).toBe(0);
      });
    });

    it("rejects an unsafe room name before it reaches the filesystem", () => {
      withRoot(({ root, hub, sock, sent }) => {
        for (const name of ["../escape", "has/slash", ""]) {
          hub.handleMessage(sock, JSON.stringify({ kind: "create_room", name }));
        }
        expect(sent.filter(m => m.kind === "error")).toHaveLength(3);
        expect(sent.every(m => m.kind === "error" && m.message === "bad message")).toBe(true);
        expect(existsSync(join(root, "..", "escape"))).toBe(false);
      });
    });
  });

  // ---- M1a: room and session state is global, so it is broadcast, not replied ----

  describe("broadcast", () => {
    it("reaches a second attached socket when a room is created", () => {
      const root = mkdtempSync(join(tmpdir(), "superfabric-hub-broadcast-"));
      try {
        const { hub, sock, sent, rooms } = makeHub({ root });
        rooms.ensureProjectRoom();
        const second = fakeSocket();
        hub.attach(second.sock);

        hub.handleMessage(sock, JSON.stringify({ kind: "create_room", name: "backend" }));

        for (const seen of [sent, second.sent]) {
          const roomsMsg = seen.filter(m => m.kind === "rooms").at(-1);
          expect(roomsMsg.rooms.map((r: any) => r.name)).toEqual([rooms.listRooms()[0].name, "backend"]);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("reaches a second attached socket when a room moves", () => {
      const root = mkdtempSync(join(tmpdir(), "superfabric-hub-broadcast-"));
      try {
        const { hub, sock, rooms } = makeHub({ root });
        rooms.ensureProjectRoom();
        const room = rooms.createRoom("backend");
        const second = fakeSocket();
        hub.attach(second.sock);

        hub.handleMessage(sock, JSON.stringify({ kind: "move_room", roomId: room.id, position: { x: 2, z: -4 } }));

        expect(second.sent.filter(m => m.kind === "rooms").at(-1).rooms.find((r: any) => r.id === room.id).position)
          .toEqual({ x: 2, z: -4 });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("reaches a second attached socket when a session is created", () => {
      const { hub, sock } = makeHub();
      const second = fakeSocket();
      hub.attach(second.sock);

      hub.handleMessage(sock, JSON.stringify({ kind: "create_session", cwd: "/tmp" }));

      const sessions = second.sent.filter(m => m.kind === "sessions").at(-1).sessions;
      expect(sessions).toHaveLength(1);
      // the creator's auto-subscription is still its own: the other tab gets the list, not the tail
      expect(second.sent.some(m => m.kind === "event")).toBe(false);
    });

    it("reaches a second attached socket when autonomy is switched", async () => {
      const { hub, mgr, sock } = makeHub();
      const id = mgr.createSession({ cwd: "/tmp", autonomy: "auto" });
      const second = fakeSocket();
      hub.attach(second.sock);

      hub.handleMessage(sock, JSON.stringify({ kind: "set_autonomy", sessionId: id, autonomy: "bypass" }));
      await waitFor(() => {
        const last = second.sent.filter(m => m.kind === "sessions").at(-1);
        if (last?.sessions.find((s: any) => s.id === id)?.autonomy !== "bypass") throw new Error("not yet");
      });
    });

    it("sends nothing to a detached socket", () => {
      const root = mkdtempSync(join(tmpdir(), "superfabric-hub-broadcast-"));
      try {
        const { hub, sock, rooms } = makeHub({ root });
        rooms.ensureProjectRoom();
        const gone = fakeSocket();
        hub.attach(gone.sock);
        hub.detach(gone.sock);

        hub.handleMessage(sock, JSON.stringify({ kind: "create_room", name: "backend" }));
        hub.handleMessage(sock, JSON.stringify({ kind: "create_session", cwd: "/tmp" }));

        expect(gone.sent).toHaveLength(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("drops a socket whose send throws during a broadcast, and still reaches the others", () => {
      const { hub, sock, sent } = makeHub();
      const dead: SocketLike = { send: () => { throw new Error("socket is dead"); } };
      hub.attach(dead);
      const live = fakeSocket();
      hub.attach(live.sock);

      expect(() => hub.handleMessage(sock, JSON.stringify({ kind: "create_session", cwd: "/tmp" }))).not.toThrow();

      expect(subsFor(hub).has(dead)).toBe(false);
      expect(sent.some(m => m.kind === "sessions")).toBe(true);
      expect(live.sent.some(m => m.kind === "sessions")).toBe(true);
    });

    it("answers a list query only to the socket that asked", () => {
      const { hub, sock } = makeHub();
      const second = fakeSocket();
      hub.attach(second.sock);
      hub.handleMessage(sock, JSON.stringify({ kind: "list_sessions" }));
      hub.handleMessage(sock, JSON.stringify({ kind: "list_rooms" }));
      expect(second.sent).toHaveLength(0);
    });

    it("keeps an error on the socket that caused it", () => {
      const { hub, sock, sent } = makeHub();
      const second = fakeSocket();
      hub.attach(second.sock);
      hub.handleMessage(sock, JSON.stringify({ kind: "prompt", sessionId: "nope", text: "hi" }));
      expect(sent.filter(m => m.kind === "error")).toHaveLength(1);
      expect(second.sent).toHaveLength(0);
    });
  });

  // ---- the status broadcast: pushed from the log, coalesced, newest state ----

  describe("session status broadcast", () => {
    const DEBOUNCE_MS = 20;
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    /**
     * A hub with one session and a *freshly attached* watcher socket. Creating a session already
     * appends a `session_status`, which schedules a broadcast; waiting the window out first means
     * every message the watcher sees was caused by the case itself.
     */
    async function withWatcher() {
      const ctx = makeHub({ sessionsDebounceMs: DEBOUNCE_MS });
      const id = ctx.mgr.createSession({ cwd: "/tmp" });
      await sleep(DEBOUNCE_MS * 3);
      const watcher = fakeSocket();
      ctx.hub.attach(watcher.sock);
      const broadcasts = () => watcher.sent.filter(m => m.kind === "sessions");
      const session = () => broadcasts().at(-1)?.sessions.find((s: any) => s.id === id);
      return { ...ctx, id, watcher, broadcasts, session };
    }

    it("pushes a sessions message when a status event lands, without a subscription", async () => {
      const { store, id, watcher, session } = await withWatcher();
      store.append(id, { type: "session_status", status: "working" });
      await waitFor(() => {
        if (session()?.status !== "working") throw new Error("not yet");
      });
      // the watcher never subscribed, so it must not be getting the transcript
      expect(watcher.sent.some(m => m.kind === "event")).toBe(false);
    });

    it("coalesces rapid status changes into one broadcast carrying the newest state", async () => {
      const { store, id, broadcasts, session } = await withWatcher();
      store.append(id, { type: "session_status", status: "starting" });
      store.append(id, { type: "session_status", status: "working" });
      store.append(id, { type: "session_status", status: "idle" });

      await waitFor(() => {
        if (broadcasts().length === 0) throw new Error("not yet");
      });
      // let further windows pass, to prove no trailing duplicates queued up behind the first
      await sleep(DEBOUNCE_MS * 4);

      expect(broadcasts()).toHaveLength(1);
      expect(session().status).toBe("idle");
    });

    it("pushes blocked when an approval opens and again when it resolves", async () => {
      const { store, id, session } = await withWatcher();
      store.append(id, { type: "approval_request", approvalId: "a1", toolName: "Bash", input: {} });
      await waitFor(() => {
        if (session()?.blocked !== true) throw new Error("not yet");
      });

      store.append(id, { type: "approval_resolved", approvalId: "a1", behavior: "allow" });
      await waitFor(() => {
        if (session()?.blocked !== false) throw new Error("not yet");
      });
    });

    it("does not broadcast the session list for agent output", async () => {
      const { store, id, broadcasts } = await withWatcher();
      for (let i = 0; i < 50; i++) store.append(id, { type: "agent_text", text: `token ${i}` });
      store.append(id, { type: "turn_complete" });
      store.append(id, { type: "tool_use", toolName: "Read", input: {} });
      await sleep(DEBOUNCE_MS * 4);

      expect(broadcasts()).toHaveLength(0);
    });

    it("broadcasts a session_error so a floor with no subscription still shows the failure", async () => {
      const { store, id, broadcasts, session } = await withWatcher();
      store.append(id, { type: "session_error", message: "boom" });
      await waitFor(() => {
        if (broadcasts().length === 0) throw new Error("not yet");
      });
      expect(session().id).toBe(id);
    });

    it("does not keep the process alive: the pending timer is unref'd", async () => {
      const { store, id, hub } = await withWatcher();
      store.append(id, { type: "session_status", status: "working" });
      const timer = pendingTimer(hub);
      expect(timer).not.toBeNull();
      // Bun's Timer exposes hasRef() like Node's; an unref'd timer reports false.
      expect(timer!.hasRef?.()).toBe(false);
    });
  });

  // ---- M3a: tasks and bus traffic over the wire ----

  describe("tasks and messages", () => {
    const DEBOUNCE_MS = 20;
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    /** A hub with a throwaway project root, two rooms, and a short coalescing window. */
    async function withRooms<T>(fn: (ctx: ReturnType<typeof makeHub> & {
      chat: ReturnType<RoomManager["createRoom"]>; payments: ReturnType<RoomManager["createRoom"]>;
      settle: () => Promise<void>;
    }) => T | Promise<T>): Promise<T> {
      const root = mkdtempSync(join(tmpdir(), "superfabric-hub-tasks-"));
      const ctx = makeHub({ root, sessionsDebounceMs: DEBOUNCE_MS });
      ctx.rooms.ensureProjectRoom();
      const chat = ctx.rooms.createRoom("chat");
      const payments = ctx.rooms.createRoom("payments");
      try {
        return await fn({ ...ctx, chat, payments, settle: () => sleep(DEBOUNCE_MS * 3) });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    const lastTasks = (sent: any[]) => sent.filter(m => m.kind === "tasks").at(-1)?.tasks as any[] | undefined;
    const lastMessages = (sent: any[]) => sent.filter(m => m.kind === "messages").at(-1)?.messages as any[] | undefined;

    it("create_task persists the task and broadcasts the board", async () => {
      await withRooms(async ({ hub, tasks, sock, sent, chat, settle }) => {
        hub.handleMessage(sock, JSON.stringify({
          kind: "create_task", title: "Expose a webhook", detail: "for receipts", roomId: chat.id,
        }));
        await settle();

        expect(tasks.list()).toHaveLength(1);
        expect(lastTasks(sent)![0]).toMatchObject({
          title: "Expose a webhook", detail: "for receipts", roomId: chat.id, status: "open",
        });
        expect(sent.some(m => m.kind === "error")).toBe(false);
      });
    });

    it("create_task without a room lands unassigned rather than being refused", async () => {
      await withRooms(async ({ hub, sock, sent, settle }) => {
        // leaving the room out is the intended path: the orchestrator routes it (M3b)
        hub.handleMessage(sock, JSON.stringify({ kind: "create_task", title: "Someone should do this" }));
        await settle();
        expect(lastTasks(sent)![0]).toMatchObject({ roomId: null, agentId: null });
      });
    });

    it("update_task routes status, room and assignee, and broadcasts", async () => {
      await withRooms(async ({ hub, mgr, tasks, sock, sent, chat, settle }) => {
        const agent = mgr.createSession({ roomId: chat.id });
        const task = tasks.create({ title: "Expose a webhook" });

        hub.handleMessage(sock, JSON.stringify({
          kind: "update_task", taskId: task.id, status: "in_progress", roomId: chat.id, agentId: agent,
        }));
        await settle();

        expect(lastTasks(sent)![0]).toMatchObject({ status: "in_progress", roomId: chat.id, agentId: agent });
        expect(tasks.get(task.id)).toMatchObject({ status: "in_progress", agentId: agent });
      });
    });

    it("update_task with an explicit null clears the assignment", async () => {
      await withRooms(async ({ hub, mgr, tasks, sock, settle, chat }) => {
        const agent = mgr.createSession({ roomId: chat.id });
        const task = tasks.create({ title: "Expose a webhook", roomId: chat.id });
        tasks.update(task.id, { agentId: agent });

        hub.handleMessage(sock, JSON.stringify({ kind: "update_task", taskId: task.id, agentId: null }));
        await settle();
        expect(tasks.get(task.id)!.agentId).toBeNull();
      });
    });

    it("broadcasts the board when an agent moves a task, not only when a socket does", async () => {
      await withRooms(async ({ hub, tasks, sent, chat, settle }) => {
        const task = tasks.create({ title: "Expose a webhook", roomId: chat.id });
        const second = fakeSocket();
        hub.attach(second.sock);
        await settle();
        const before = sent.filter(m => m.kind === "tasks").length;

        // Exactly what `factory_task_update` does: the store, directly, with no frame from anyone.
        tasks.update(task.id, { status: "in_progress" });
        await settle();

        expect(sent.filter(m => m.kind === "tasks").length).toBe(before + 1);
        expect(lastTasks(sent)![0]).toMatchObject({ id: task.id, status: "in_progress" });
        // …and every attached tab sees it, not just the one that happened to ask.
        expect(lastTasks(second.sent)![0]).toMatchObject({ id: task.id, status: "in_progress" });
      });
    });

    it("broadcasts the board when the bus blocks a task on a request", async () => {
      await withRooms(async ({ hub, tasks, bus, sent, chat, payments, settle }) => {
        const task = tasks.create({ title: "Expose a webhook", roomId: chat.id });
        await settle();
        const before = sent.filter(m => m.kind === "tasks").length;

        const msg = bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "please" });
        tasks.update(task.id, { status: "blocked", blockedOnMessageId: msg.id });
        await settle();

        expect(sent.filter(m => m.kind === "tasks").length).toBe(before + 1);
        expect(lastTasks(sent)![0]).toMatchObject({ status: "blocked", blockedOnMessageId: msg.id });
      });
    });

    it("list_tasks answers only the socket that asked", async () => {
      await withRooms(({ hub, tasks, sock, sent }) => {
        tasks.create({ title: "Expose a webhook" });
        const second = fakeSocket();
        hub.attach(second.sock);

        hub.handleMessage(sock, JSON.stringify({ kind: "list_tasks" }));
        expect(lastTasks(sent)!.map(t => t.title)).toEqual(["Expose a webhook"]);
        expect(second.sent).toHaveLength(0);
      });
    });

    it("broadcasts a messages list when the bus carries a message", async () => {
      await withRooms(async ({ hub, mgr, bus, sent, chat, payments, settle }) => {
        mgr.createSession({ roomId: payments.id });
        const second = fakeSocket();
        hub.attach(second.sock);

        const msg = bus.send({
          fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "Please expose a webhook",
        });
        await settle();

        for (const seen of [sent, second.sent]) {
          const messages = lastMessages(seen)!;
          expect(messages).toHaveLength(1);
          // the belt animates off deliveredAt, so it has to be on the wire
          expect(messages[0]).toMatchObject({ id: msg.id, fromRoomId: chat.id, toRoomId: payments.id });
          expect(messages[0].deliveredAt).not.toBeNull();
        }
      });
    });

    it("list_messages answers only the socket that asked, queue included", async () => {
      await withRooms(({ hub, bus, sock, sent, chat, payments }) => {
        // Nobody is standing in payments, so this one stays queued — and a tab that connects has to
        // be told about it, or the pile-up at the sender's door is invisible until something moves.
        const msg = bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "nobody home" });
        const second = fakeSocket();
        hub.attach(second.sock);

        hub.handleMessage(sock, JSON.stringify({ kind: "list_messages" }));

        const messages = lastMessages(sent)!;
        expect(messages.map(m => m.id)).toEqual([msg.id]);
        expect(messages[0].deliveredAt).toBeNull();
        expect(second.sent).toHaveLength(0);
      });
    });

    it("replies error without throwing to list_messages on a server with no bus", () => {
      const { hub, sock, sent } = makeHub({ stores: false });
      expect(() => hub.handleMessage(sock, JSON.stringify({ kind: "list_messages" }))).not.toThrow();
      expect(sent.filter(m => m.kind === "error")).toHaveLength(1);
      expect(sent.some(m => m.kind === "messages")).toBe(false);
    });

    it("reports an undelivered message as undelivered", async () => {
      await withRooms(async ({ hub, bus, sock, sent, chat, payments, settle }) => {
        hub.attach(sock);
        bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "nobody home" });
        await settle();
        expect(lastMessages(sent)![0].deliveredAt).toBeNull();
      });
    });

    // ---- the dispatch guard keeps holding for every new case ----

    it("replies error without throwing for update_task on an unknown task", async () => {
      await withRooms(async ({ hub, sock, sent, settle }) => {
        expect(() => hub.handleMessage(sock, JSON.stringify({ kind: "update_task", taskId: "nope", status: "done" })))
          .not.toThrow();
        await settle();
        expect(sent.filter(m => m.kind === "error")).toHaveLength(1);
        expect(sent.some(m => m.kind === "tasks")).toBe(false);
      });
    });

    it("replies error without throwing for create_task in an unknown room", async () => {
      await withRooms(async ({ hub, tasks, sock, sent, settle }) => {
        expect(() => hub.handleMessage(sock, JSON.stringify({ kind: "create_task", title: "t", roomId: "nope" })))
          .not.toThrow();
        await settle();
        expect(sent.filter(m => m.kind === "error")).toHaveLength(1);
        expect(tasks.list()).toEqual([]);
      });
    });

    it("replies error without throwing for an assignee from another room", async () => {
      await withRooms(async ({ hub, mgr, tasks, sock, sent, chat, payments, settle }) => {
        const elsewhere = mgr.createSession({ roomId: payments.id });
        const task = tasks.create({ title: "Expose a webhook", roomId: chat.id });
        expect(() => hub.handleMessage(sock, JSON.stringify({
          kind: "update_task", taskId: task.id, agentId: elsewhere,
        }))).not.toThrow();
        await settle();
        expect(sent.filter(m => m.kind === "error")).toHaveLength(1);
        expect(tasks.get(task.id)!.agentId).toBeNull();
      });
    });

    it("rejects a task frame the protocol refuses before it reaches the store", async () => {
      await withRooms(async ({ hub, tasks, sock, sent, settle }) => {
        for (const frame of [
          { kind: "create_task" },
          { kind: "create_task", title: "" },
          { kind: "update_task", status: "done" },
          { kind: "update_task", taskId: "t1", status: "shipped" },
        ]) {
          hub.handleMessage(sock, JSON.stringify(frame));
        }
        await settle();
        expect(sent.filter(m => m.kind === "error")).toHaveLength(4);
        expect(sent.every(m => m.kind === "error" && m.message === "bad message")).toBe(true);
        expect(tasks.list()).toEqual([]);
      });
    });

    it("replies error without throwing on a server with no task board", () => {
      const { hub, sock, sent } = makeHub({ stores: false });
      for (const frame of [
        { kind: "create_task", title: "t" },
        { kind: "update_task", taskId: "t1", status: "done" },
        { kind: "list_tasks" },
      ]) {
        expect(() => hub.handleMessage(sock, JSON.stringify(frame))).not.toThrow();
      }
      expect(sent.filter(m => m.kind === "error")).toHaveLength(3);
      expect(sent.some(m => m.kind === "tasks")).toBe(false);
    });

    // ---- the same coalescing path as `sessions`, not a second timer ----

    it("coalesces a burst of task changes into one broadcast carrying the newest state", async () => {
      await withRooms(async ({ hub, tasks, sock, sent, settle }) => {
        const task = tasks.create({ title: "Expose a webhook" });
        for (const status of ["in_progress", "review", "done"]) {
          hub.handleMessage(sock, JSON.stringify({ kind: "update_task", taskId: task.id, status }));
        }
        await settle();

        expect(sent.filter(m => m.kind === "tasks")).toHaveLength(1);
        expect(lastTasks(sent)![0].status).toBe("done");
      });
    });

    it("coalesces a burst of bus traffic into one messages broadcast", async () => {
      await withRooms(async ({ bus, sent, chat, payments, settle }) => {
        for (let i = 0; i < 5; i++) {
          bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "info", body: `note ${i}` });
        }
        await settle();
        expect(sent.filter(m => m.kind === "messages")).toHaveLength(1);
        expect(lastMessages(sent)!).toHaveLength(5);
      });
    });

    it("shares one timer with sessions: a mixed burst is one frame per list", async () => {
      await withRooms(async ({ hub, store, mgr, bus, tasks, sock, sent, chat, payments, settle }) => {
        const id = mgr.createSession({ roomId: chat.id });
        await settle();
        const before = {
          sessions: sent.filter(m => m.kind === "sessions").length,
          tasks: sent.filter(m => m.kind === "tasks").length,
          messages: sent.filter(m => m.kind === "messages").length,
        };

        const task = tasks.create({ title: "Expose a webhook" });
        store.append(id, { type: "session_status", status: "working" });
        hub.handleMessage(sock, JSON.stringify({ kind: "update_task", taskId: task.id, status: "review" }));
        bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "info", body: "note" });
        store.append(id, { type: "session_status", status: "idle" });
        await settle();

        expect(sent.filter(m => m.kind === "sessions").length).toBe(before.sessions + 1);
        expect(sent.filter(m => m.kind === "tasks").length).toBe(before.tasks + 1);
        expect(sent.filter(m => m.kind === "messages").length).toBe(before.messages + 1);
      });
    });

    it("does not keep the process alive: a pending tasks broadcast is unref'd too", async () => {
      await withRooms(({ hub, sock }) => {
        hub.handleMessage(sock, JSON.stringify({ kind: "create_task", title: "Expose a webhook" }));
        const timer = pendingTimer(hub);
        expect(timer).not.toBeNull();
        expect(timer!.hasRef?.()).toBe(false);
      });
    });
  });

  // ---- I9: a detached socket must not resurrect itself ----

  it("ignores messages from a socket that was already detached", async () => {
    const { hub, mgr, exec, sock, sent } = makeHub();
    const id = mgr.createSession({ cwd: "/tmp" });
    hub.detach(sock);
    hub.handleMessage(sock, JSON.stringify({ kind: "subscribe", sessionId: id, afterSeq: 0 }));
    expect(sent.filter(m => m.kind === "event")).toHaveLength(0);
    mgr.prompt(id, "after detach");
    await exec.settle();
    expect(sent.filter(m => m.kind === "event")).toHaveLength(0);
  });

  // ---- I1: a failed send must not advance the watermark ----

  it("detaches a socket whose send throws and does not advance its watermark", async () => {
    const { hub, mgr, exec } = makeHub({ attach: false });
    const id = mgr.createSession({ cwd: "/tmp" });
    const seen: number[] = [];
    let explode = false;
    const sock: SocketLike = {
      send: (d: string) => {
        if (explode) throw new Error("socket is dead");
        const m = JSON.parse(d);
        if (m.kind === "event") seen.push(m.seq);
      },
    };
    hub.attach(sock);
    hub.handleMessage(sock, JSON.stringify({ kind: "subscribe", sessionId: id, afterSeq: 0 }));
    const watermark = () => subsFor(hub).get(sock)?.get(id);
    const before = watermark();
    expect(before).toBeGreaterThan(0);

    explode = true;
    mgr.prompt(id, "goes nowhere");
    await exec.settle();
    // the socket was dropped entirely, so no watermark survives to skip past the lost events
    expect(subsFor(hub).has(sock)).toBe(false);
    expect(seen.at(-1)).toBe(before);
  });

  // ---- I2: an afterSeq beyond the log must not mute the session ----

  it("clamps an afterSeq past the end of the log and keeps tailing", async () => {
    const { hub, mgr, exec, sock, sent } = makeHub();
    const id = mgr.createSession({ cwd: "/tmp" });
    mgr.prompt(id, "first");
    await exec.settle();
    const maxSeq = mgr.listSessions().find(s => s.id === id)!.lastSeq;

    hub.handleMessage(sock, JSON.stringify({ kind: "subscribe", sessionId: id, afterSeq: maxSeq + 993 }));
    expect(sent.some(m => m.kind === "error" && /beyond the log/.test(m.message))).toBe(true);

    mgr.prompt(id, "second");
    await exec.settle();
    const seqs = sent.filter(m => m.kind === "event").map(m => m.seq);
    expect(seqs.length).toBeGreaterThan(0);
    expect(Math.min(...seqs)).toBe(maxSeq + 1);
  });

  // ---- M1b: several factories, one server, one socket each ----

  describe("projects", () => {
    /**
     * A hub with two factories: the boot project (`home`, root `homeRoot`) and a second one (`away`),
     * each with its own throwaway root. `sock` starts on `home`.
     */
    function withTwoProjects<T>(fn: (ctx: ReturnType<typeof makeHub> & {
      homeRoot: string; awayRoot: string; home: string; away: string;
    }) => T): T {
      const homeRoot = mkdtempSync(join(tmpdir(), "superfabric-hub-home-"));
      const awayRoot = mkdtempSync(join(tmpdir(), "superfabric-hub-away-"));
      const ctx = makeHub({ root: homeRoot, sessionsDebounceMs: 20 });
      const home = ctx.projects.defaultProject().id;
      const away = ctx.projects.create({ root: awayRoot }).id;
      ctx.rooms.ensureProjectRoom(home);
      ctx.rooms.ensureProjectRoom(away);
      try {
        return fn({ ...ctx, homeRoot, awayRoot, home, away });
      } finally {
        rmSync(homeRoot, { recursive: true, force: true });
        rmSync(awayRoot, { recursive: true, force: true });
      }
    }

    const last = (sent: any[], kind: string) => sent.filter((m) => m.kind === kind).at(-1);
    const names = (sent: any[]) => (last(sent, "rooms")?.rooms as any[] | undefined)?.map((r) => r.name);

    it("list_projects answers with every project and this socket's active one", () => {
      withTwoProjects(({ hub, sock, sent, home, homeRoot, awayRoot }) => {
        hub.handleMessage(sock, JSON.stringify({ kind: "list_projects" }));
        const msg = last(sent, "projects");
        expect(msg.activeProjectId).toBe(home);
        expect(msg.projects.map((p: any) => p.root)).toEqual([homeRoot, awayRoot]);
      });
    });

    it("open_project re-scopes the socket and hands it a whole fresh factory", () => {
      withTwoProjects(({ hub, rooms, tasks, sock, sent, home, away }) => {
        rooms.createRoom("backend", { projectId: home });
        const awayRoom = rooms.createRoom("vendor", { projectId: away });
        tasks.create({ title: "ours", projectId: home });
        tasks.create({ title: "theirs", roomId: awayRoom.id, projectId: away });
        sent.length = 0;

        hub.handleMessage(sock, JSON.stringify({ kind: "open_project", projectId: away }));

        expect(last(sent, "projects").activeProjectId).toBe(away);
        // the whole set arrives unasked, because the client throws away what it held
        expect(names(sent)).toEqual([rooms.listRooms(away)[0]!.name, "vendor"]);
        expect(last(sent, "tasks").tasks.map((t: any) => t.title)).toEqual(["theirs"]);
        expect(last(sent, "messages")).toBeDefined();
        expect(sent.some((m) => m.kind === "error")).toBe(false);
      });
    });

    it("open_project forgets the previous floor's session subscriptions", async () => {
      await withTwoProjects(async ({ hub, mgr, exec, sock, sent, home, away }) => {
        const id = mgr.createSession({ cwd: "/tmp", projectId: home });
        hub.handleMessage(sock, JSON.stringify({ kind: "subscribe", sessionId: id, afterSeq: 0 }));
        hub.handleMessage(sock, JSON.stringify({ kind: "open_project", projectId: away }));
        sent.length = 0;

        // That transcript belongs to a floor this socket is no longer looking at.
        mgr.prompt(id, "hi");
        await exec.settle();
        expect(sent.filter((m) => m.kind === "event")).toEqual([]);
      });
    });

    it("replies error without throwing for an unknown project, leaving the socket where it was", () => {
      withTwoProjects(({ hub, rooms, sock, sent, home }) => {
        rooms.createRoom("backend", { projectId: home });
        hub.handleMessage(sock, JSON.stringify({ kind: "open_project", projectId: "nope" }));
        expect(sent.some((m) => m.kind === "error" && /unknown project/.test(m.message))).toBe(true);

        sent.length = 0;
        hub.handleMessage(sock, JSON.stringify({ kind: "list_rooms" }));
        expect(names(sent)).toEqual([rooms.listRooms(home)[0]!.name, "backend"]);
      });
    });

    it("create_project adds a factory with its central building and opens it", () => {
      withTwoProjects(({ hub, projects, sock, sent }) => {
        const third = mkdtempSync(join(tmpdir(), "superfabric-hub-third-"));
        try {
          hub.handleMessage(sock, JSON.stringify({ kind: "create_project", root: third, name: "Third" }));

          const created = projects.list().find((p) => p.root === third)!;
          expect(created.name).toBe("Third");
          expect(last(sent, "projects").activeProjectId).toBe(created.id);
          // a factory with no central building would draw an empty floor with nothing to join
          expect(names(sent)).toEqual([basename(third).toLowerCase()]);
          expect(sent.some((m) => m.kind === "error")).toBe(false);
        } finally {
          rmSync(third, { recursive: true, force: true });
        }
      });
    });

    it("replies error without throwing for a project root that is not a directory", () => {
      withTwoProjects(({ hub, projects, sock, sent }) => {
        hub.handleMessage(sock, JSON.stringify({ kind: "create_project", root: "/definitely/not/here" }));
        expect(sent.some((m) => m.kind === "error" && /does not exist/.test(m.message))).toBe(true);
        hub.handleMessage(sock, JSON.stringify({ kind: "create_project", root: "relative/dir" }));
        expect(sent.some((m) => m.kind === "error" && /absolute path/.test(m.message))).toBe(true);
        expect(projects.list()).toHaveLength(2);
      });
    });

    it("keeps two sockets on two floors apart: rooms, board and belts", async () => {
      await withTwoProjects(async ({ hub, rooms, tasks, bus, sock, sent, home, away }) => {
        const second = fakeSocket();
        hub.attach(second.sock);
        hub.handleMessage(second.sock, JSON.stringify({ kind: "open_project", projectId: away }));
        const awayChat = rooms.createRoom("chat", { projectId: away });
        const awayPay = rooms.createRoom("payments", { projectId: away });
        sent.length = 0;
        second.sent.length = 0;

        // A room created on the home floor, by the home socket.
        hub.handleMessage(sock, JSON.stringify({ kind: "create_room", name: "backend" }));
        expect(names(sent)).toEqual([rooms.listRooms(home)[0]!.name, "backend"]);
        // The other tab is watching another factory: this building is not on its floor.
        expect(names(second.sent) ?? []).not.toContain("backend");

        // The board is per factory too.
        tasks.create({ title: "ours", projectId: home });
        await waitFor(() => { expect(last(sent, "tasks")).toBeDefined(); });
        expect(last(sent, "tasks").tasks.map((t: any) => t.title)).toEqual(["ours"]);
        expect(last(second.sent, "tasks").tasks).toEqual([]);

        // …and so are the belts.
        bus.send({ fromRoomId: awayChat.id, toRoomId: awayPay.id, kind: "info", body: "theirs" });
        await waitFor(() => { expect(last(second.sent, "messages")).toBeDefined(); });
        expect(last(second.sent, "messages").messages.map((m: any) => m.body)).toEqual(["theirs"]);
        expect(last(sent, "messages").messages).toEqual([]);
      });
    });

    it("refuses to create a session in a room on another floor", () => {
      withTwoProjects(({ hub, rooms, mgr, sock, sent, home, away }) => {
        const awayRoom = rooms.createRoom("vendor", { projectId: away });
        hub.handleMessage(sock, JSON.stringify({ kind: "create_session", roomId: awayRoom.id }));
        expect(sent.some((m) => m.kind === "error" && /another project/.test(m.message))).toBe(true);
        expect(mgr.listSessions(away)).toEqual([]);
        expect(mgr.listSessions(home)).toEqual([]);
      });
    });

    it("refuses to move a building on another floor", () => {
      withTwoProjects(({ hub, rooms, sock, sent, away }) => {
        const awayRoom = rooms.createRoom("vendor", { projectId: away });
        hub.handleMessage(sock, JSON.stringify({
          kind: "move_room", roomId: awayRoom.id, position: { x: 1, z: 2 },
        }));
        expect(sent.filter((m) => m.kind === "error" && /another project/.test(m.message))).toHaveLength(1);
        expect(rooms.getRoom(awayRoom.id)!.position).toEqual(awayRoom.position);
      });
    });
  });

});
