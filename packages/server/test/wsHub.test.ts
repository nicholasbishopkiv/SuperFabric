import { describe, it, expect } from "bun:test";
import { waitFor } from "./_waitFor.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { FakeExecutor } from "../src/executors/fake.js";
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
function makeHub(opts: { script?: { tool: string; input: unknown }[]; attach?: boolean; root?: string } = {}) {
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const exec = new FakeExecutor(opts.script ? { script: opts.script } : {});
  const rooms = new RoomManager(db, opts.root ?? tmpdir());
  const mgr = new SessionManager(db, store, exec, rooms);
  const hub = new WsHub(store, mgr, rooms);
  const { sock, sent } = fakeSocket();
  if (opts.attach !== false) hub.attach(sock);
  return { db, store, exec, rooms, mgr, hub, sock, sent };
}

/** The hub's private socket -> watermark table; asserted directly, it is the thing I1 broke. */
function subsFor(hub: WsHub): Map<SocketLike, Map<string, number>> {
  return (hub as unknown as { subs: Map<SocketLike, Map<string, number>> }).subs;
}

describe("WsHub", () => {
  it("replays events after subscribe and tails new ones", async () => {
    const db = openDb(":memory:");
    const store = new EventStore(db);
    const exec = new FakeExecutor();
    const rooms = new RoomManager(db, tmpdir());
    const mgr = new SessionManager(db, store, exec, rooms);
    const hub = new WsHub(store, mgr, rooms);
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
    const rooms = new RoomManager(db, tmpdir());
    const mgr = new SessionManager(db, store, exec, rooms);
    const hub = new WsHub(store, mgr, rooms);
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
    const rooms = new RoomManager(db, tmpdir());
    const mgr = new SessionManager(db, store, exec, rooms);
    const hub = new WsHub(store, mgr, rooms);
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
});
