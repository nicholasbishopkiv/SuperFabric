import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryMetrics, ServerMessage } from "@superfabric/shared";
import { AccountManager } from "../src/accountManager.js";
import { Chronicle } from "../src/chronicle.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { FakeExecutor } from "../src/executors/fake.js";
import { MetricsStore } from "../src/metricsStore.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { TaskStore } from "../src/taskStore.js";
import { WsHub, type SocketLike } from "../src/wsHub.js";

/**
 * Burn rate and cost over the wire.
 *
 * The property this file exists for is **scope**: the account half of a metrics frame is machine-wide
 * and the room half is not, so a tab must never be shown another floor's spend. Plus the shape every
 * optional collaborator here has — a server that computes no metrics says so rather than answering
 * with zeroes, because "you have spent nothing" is a dangerous thing to show someone who has.
 */

function fakeSocket() {
  const sent: ServerMessage[] = [];
  const sock: SocketLike = { send: (d: string) => sent.push(JSON.parse(d) as ServerMessage) };
  return { sock, sent };
}

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeHub(opts: { withMetrics?: boolean } = {}) {
  const root = tempDir("sf-hub-m5-");
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const projects = new ProjectManager(db, root);
  const rooms = new RoomManager(db, projects);
  const accounts = new AccountManager(db);
  const tasks = new TaskStore(db, projects);
  const chronicle = new Chronicle(db, projects);
  const mgr = new SessionManager(db, store, new FakeExecutor(), rooms, projects, { accounts, tasks });
  const metrics = new MetricsStore(db, accounts, projects);
  const hub = new WsHub(store, mgr, rooms, projects, {
    sessionsDebounceMs: 5, accounts, tasks, chronicle,
    ...(opts.withMetrics !== false ? { metrics } : {}),
  });
  const projectId = projects.defaultProject().id;
  rooms.ensureProjectRoom(projectId);
  const { sock, sent } = fakeSocket();
  hub.attach(sock);
  return {
    root, db, projects, rooms, accounts, tasks, chronicle, metrics, hub, sock, sent,
    projectId,
    send: (msg: unknown) => hub.handleMessage(sock, JSON.stringify(msg)),
    /** A session row plus a costed turn, without spawning anything. */
    spend: (opts2: { id: string; roomId: string; usd: number }) => {
      db.prepare("INSERT INTO sessions (id, cwd, project_id, room_id) VALUES (?, ?, ?, ?)")
        .run(opts2.id, root, projectId, opts2.roomId);
      db.prepare("INSERT INTO events (session_id, seq, type, payload) VALUES (?, 1, ?, ?)")
        .run(opts2.id, "turn_complete", JSON.stringify({ type: "turn_complete", costUsd: opts2.usd }));
    },
  };
}

const latest = <K extends ServerMessage["kind"]>(
  sent: ServerMessage[], kind: K,
): Extract<ServerMessage, { kind: K }> | undefined => {
  for (let i = sent.length - 1; i >= 0; i--) {
    if (sent[i]!.kind === kind) return sent[i] as Extract<ServerMessage, { kind: K }>;
  }
  return undefined;
};

const errors = (sent: ServerMessage[]): string[] =>
  sent.filter((m): m is Extract<ServerMessage, { kind: "error" }> => m.kind === "error")
    .map((m) => m.message);

describe("list_metrics", () => {
  it("answers the asking socket with this floor's rooms and every account", () => {
    const h = makeHub();
    h.accounts.create({ label: "work", configDir: join(h.root, "cfg-work") });
    const backend = h.rooms.createRoom("backend", { projectId: h.projectId });
    h.spend({ id: "s1", roomId: backend.id, usd: 0.42 });

    h.send({ kind: "list_metrics" });
    const metrics = latest(h.sent, "metrics")?.metrics as FactoryMetrics;
    expect(metrics.accounts).toHaveLength(1);
    expect(metrics.accounts[0]!.burn.unknown).not.toBeNull();
    expect(metrics.rooms).toEqual([{
      roomId: backend.id,
      cost: { day: { usd: 0.42, turns: 1 }, week: { usd: 0.42, turns: 1 } },
    }]);
    // The spend was on no account, so it belongs to the ambient bucket rather than to "work".
    expect(metrics.ambient.day.usd).toBe(0.42);
    expect(metrics.accounts[0]!.cost.day.usd).toBe(0);
  });

  it("shows a socket only its own factory's rooms", () => {
    const h = makeHub();
    const mine = h.rooms.createRoom("mine", { projectId: h.projectId });
    const elsewhere = tempDir("sf-hub-m5-other-");
    const second = h.projects.create({ root: elsewhere, name: "second" });
    h.rooms.ensureProjectRoom(second.id);
    const theirs = h.rooms.createRoom("theirs", { projectId: second.id });
    h.spend({ id: "m1", roomId: mine.id, usd: 0.1 });
    h.db.prepare("INSERT INTO sessions (id, cwd, project_id, room_id) VALUES (?, ?, ?, ?)")
      .run("t1", elsewhere, second.id, theirs.id);
    h.db.prepare("INSERT INTO events (session_id, seq, type, payload) VALUES (?, 1, ?, ?)")
      .run("t1", "turn_complete", JSON.stringify({ type: "turn_complete", costUsd: 5 }));

    h.send({ kind: "list_metrics" });
    expect(latest(h.sent, "metrics")!.metrics.rooms.map((r) => r.roomId)).toEqual([mine.id]);

    h.send({ kind: "open_project", projectId: second.id });
    h.send({ kind: "list_metrics" });
    expect(latest(h.sent, "metrics")!.metrics.rooms.map((r) => r.roomId)).toEqual([theirs.id]);
  });

  it("is refused, not answered with zeroes, on a server that computes none", () => {
    const h = makeHub({ withMetrics: false });
    h.send({ kind: "list_metrics" });
    expect(latest(h.sent, "metrics")).toBeUndefined();
    expect(errors(h.sent).join(" ")).toContain("does not compute metrics");
  });
});
