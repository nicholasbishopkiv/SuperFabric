import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryExport, FactoryImportResult, ServerMessage } from "@superfabric/shared";
import { AccountManager } from "../src/accountManager.js";
import { Chronicle } from "../src/chronicle.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { FactoryPortability } from "../src/factoryPortability.js";
import { FakeExecutor } from "../src/executors/fake.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { TaskStore } from "../src/taskStore.js";
import { WsHub, type SocketLike } from "../src/wsHub.js";

/**
 * Moving a factory over the wire.
 *
 * Two properties: an export is refused for a floor this socket is not looking at (a room id or a
 * project id a client happens to hold must not be a way to read another factory's shape), and an import
 * answers with its **problems** as a message of its own rather than as a one-line notice — a collision
 * is a reported outcome, not an error frame.
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

function makeHub(opts: { withPortability?: boolean } = {}) {
  const root = tempDir("sf-hub-m5-");
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const projects = new ProjectManager(db, root);
  const rooms = new RoomManager(db, projects);
  const accounts = new AccountManager(db);
  const tasks = new TaskStore(db, projects);
  const chronicle = new Chronicle(db, projects);
  const mgr = new SessionManager(db, store, new FakeExecutor(), rooms, projects, { accounts, tasks });
  const portability = new FactoryPortability({ db, projects, rooms, accounts, tasks, chronicle });
  const hub = new WsHub(store, mgr, rooms, projects, {
    sessionsDebounceMs: 5, accounts, tasks, chronicle,
    ...(opts.withPortability !== false ? { portability } : {}),
  });
  const projectId = projects.defaultProject().id;
  rooms.ensureProjectRoom(projectId);
  const { sock, sent } = fakeSocket();
  hub.attach(sock);
  return {
    root, db, projects, rooms, accounts, tasks, chronicle, portability, hub, sock, sent,
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

describe("export_project", () => {
  it("answers the asking socket with its own floor", () => {
    const h = makeHub();
    h.rooms.createRoom("backend", { projectId: h.projectId });
    h.send({ kind: "export_project" });
    const factory = latest(h.sent, "factory_export")?.factory as FactoryExport;
    expect(factory.rooms.map((r) => r.name)).toContain("backend");
  });

  it("refuses to export a factory this tab is not looking at", () => {
    const h = makeHub();
    const second = h.projects.create({ root: tempDir("sf-hub-m5-other-"), name: "second" });
    h.rooms.ensureProjectRoom(second.id);
    h.send({ kind: "export_project", projectId: second.id });
    expect(latest(h.sent, "factory_export")).toBeUndefined();
    expect(errors(h.sent).join(" ")).toContain("only be exported from the floor this tab is looking at");
  });

  it("is refused on a server that cannot move a factory", () => {
    const h = makeHub({ withPortability: false });
    h.send({ kind: "export_project" });
    expect(errors(h.sent).join(" ")).toContain("cannot export or import a factory");
  });
});

describe("import_factory", () => {
  it("answers with the result, moves this socket onto the new floor, and re-sends the switcher", () => {
    const source = makeHub();
    source.rooms.createRoom("backend", { projectId: source.projectId });
    source.rooms.createRoom("docs", { projectId: source.projectId });
    source.send({ kind: "export_project" });
    const factory = latest(source.sent, "factory_export")!.factory;

    const target = makeHub();
    const into = tempDir("sf-hub-m5-into-");
    // A second tab, so the "everybody hears about the new project" half is observable.
    const watcher = fakeSocket();
    target.hub.attach(watcher.sock);

    target.send({ kind: "import_factory", root: into, factory });

    const result = latest(target.sent, "factory_import")?.result as FactoryImportResult;
    expect(result.roomsCreated).toEqual(["backend", "docs"]);
    expect(result.projectCreated).toBe(true);
    // This socket is now looking at what it imported, with a full fresh set of lists.
    const projects = latest(target.sent, "projects")!;
    expect(projects.activeProjectId).toBe(result.projectId);
    expect(latest(target.sent, "rooms")!.rooms.map((r) => r.name)).toContain("backend");
    // And the other tab was told the switcher gained an entry, without its own floor changing.
    const watched = latest(watcher.sent, "projects")!;
    expect(watched.projects.map((p) => p.id)).toContain(result.projectId);
    expect(watched.activeProjectId).not.toBe(result.projectId);
  });

  it("reports a collision as part of the result rather than as a bare error", () => {
    const source = makeHub();
    source.rooms.createRoom("backend", { projectId: source.projectId });
    source.rooms.createRoom("frontend", { projectId: source.projectId });
    source.send({ kind: "export_project" });
    const factory = latest(source.sent, "factory_export")!.factory;

    const target = makeHub();
    target.rooms.createRoom("backend", { projectId: target.projectId });
    target.send({ kind: "import_factory", root: target.root, factory });

    const result = latest(target.sent, "factory_import")!.result;
    expect(result.roomsCreated).toEqual(["frontend"]);
    expect(result.problems.some((p) => p.includes('"backend" was not created'))).toBe(true);
    // The whole request still succeeded: a reported collision is not an error frame.
    expect(errors(target.sent)).toEqual([]);
  });

  it("refuses a file that is not an export, with a message naming what is wrong", () => {
    const h = makeHub();
    h.send({ kind: "import_factory", root: h.root, factory: { format: "something-else" } });
    expect(latest(h.sent, "factory_import")).toBeUndefined();
    expect(errors(h.sent).join(" ")).toContain("not a SuperFabric factory export");
  });

  it("indexes a decision whose ADR arrived with the repository", () => {
    const source = makeHub();
    const backend = source.rooms.createRoom("backend", { projectId: source.projectId });
    source.chronicle.record({
      projectId: source.projectId, roomId: backend.id,
      title: "Retries live in backend", context: "two rooms claimed it", decision: "backend owns it",
    });
    source.send({ kind: "export_project" });
    const factory = latest(source.sent, "factory_export")!.factory;
    expect(factory.decisions).toHaveLength(1);

    const target = makeHub();
    const into = tempDir("sf-hub-m5-into-");
    mkdirSync(join(into, "docs", "decisions"), { recursive: true });
    writeFileSync(join(into, factory.decisions[0]!.relativePath), "# 0001 — Retries live in backend\n");
    target.send({ kind: "import_factory", root: into, factory });

    const result = latest(target.sent, "factory_import")!.result;
    expect(result.decisionsIndexed).toBe(1);
    target.send({ kind: "search_chronicle", query: "retries" });
    expect(latest(target.sent, "chronicle")!.hits.length).toBeGreaterThan(0);
  });
});
