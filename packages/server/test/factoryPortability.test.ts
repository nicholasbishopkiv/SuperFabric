import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCOUNT_CREDENTIALS_FILE,
  FACTORY_EXPORT_FORMAT,
  FACTORY_EXPORT_VERSION,
  FactoryExport,
  PROJECT_CHARTER_FILE,
} from "@superfabric/shared";
import { AccountManager } from "../src/accountManager.js";
import { Chronicle, DECISIONS_DIRNAME } from "../src/chronicle.js";
import { openDb, type Db } from "../src/db.js";
import { FactoryPortability, relativeToRoot } from "../src/factoryPortability.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { TaskStore } from "../src/taskStore.js";

/**
 * Exporting a factory and building it back.
 *
 * **The test that matters most in this file is the one that greps the bytes.** "No secrets in the
 * export" is the kind of claim a document makes and a code path quietly breaks a milestone later, so
 * the export is serialised and searched for every token shape and every configured config directory —
 * and it fails if it finds one. A promise in a doc is not a test.
 *
 * Everything else is about the second property: an import goes through the ordinary `createRoom`, and
 * it **reports what it could not do**. A collision, a missing account label, an ADR that is not in the
 * repository, a room whose folder was somewhere else — each is a sentence in `problems`, because a
 * partial import that claims to be complete is worse than a refused one.
 *
 * Nothing here starts an agent or prompts a model.
 */

/** Token shapes that must never appear in an export. */
const SECRET_SHAPES = [
  // Claude Code's own OAuth material: access, refresh and the API-key form.
  "sk-ant-oat",
  "sk-ant-ort",
  "sk-ant-api",
  // The generic Anthropic key prefix, in case a shape above is ever renamed under it.
  "sk-ant-",
  // A webhook signing secret, the other credential shape a repository routinely holds.
  "whsec_",
  // The file the tokens live in. Its *name* appearing would mean something read it.
  ACCOUNT_CREDENTIALS_FILE,
];

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Factory {
  db: Db;
  projects: ProjectManager;
  rooms: RoomManager;
  accounts: AccountManager;
  tasks: TaskStore;
  chronicle: Chronicle;
  portability: FactoryPortability;
  root: string;
  projectId: string;
  /** Insert a session row directly: `createSession` would spawn a real CLI. */
  agent(opts: {
    id: string;
    roomId: string;
    roleId?: string;
    model?: string;
    autonomy?: string;
    accountId?: string;
    isOrchestrator?: boolean;
    state?: string;
  }): void;
  cleanup(): void;
}

function factory(opts: { root?: string; name?: string } = {}): Factory {
  const root = opts.root ?? tempDir("sf-export-");
  const db = openDb(":memory:");
  const projects = new ProjectManager(db, root);
  const rooms = new RoomManager(db, projects);
  const accounts = new AccountManager(db);
  const tasks = new TaskStore(db, projects);
  const chronicle = new Chronicle(db, projects);
  const portability = new FactoryPortability({ db, projects, rooms, accounts, tasks, chronicle });
  const projectId = projects.defaultProject().id;
  rooms.ensureProjectRoom(projectId);
  return {
    db, projects, rooms, accounts, tasks, chronicle, portability, root, projectId,
    agent: (a) => {
      db.prepare(`
        INSERT INTO sessions (id, cwd, project_id, room_id, role_id, model, autonomy, account_id,
                              is_orchestrator, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        a.id, root, projectId, a.roomId, a.roleId ?? null, a.model ?? null, a.autonomy ?? "auto",
        a.accountId ?? null, a.isOrchestrator === true ? 1 : 0, a.state ?? "active",
      );
    },
    cleanup: () => { db.close(); },
  };
}

/** An account whose config directory holds a credentials file with realistic token material in it. */
function loggedInAccount(f: Factory, label: string): { id: string; configDir: string } {
  const configDir = tempDir(`sf-cfg-${label}-`);
  const account = f.accounts.create({ label, configDir });
  writeFileSync(
    join(account.configDir, ACCOUNT_CREDENTIALS_FILE),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-EXAMPLEACCESSTOKENDONOTLEAKMEEVER",
        refreshToken: "sk-ant-ort01-EXAMPLEREFRESHTOKENDONOTLEAKMEEVER",
        expiresAt: 1_800_000_000_000,
      },
      webhookSecret: "whsec_EXAMPLEWEBHOOKSIGNINGSECRET",
    }),
  );
  return { id: account.id, configDir: account.configDir };
}

/** A populated factory: two accounts, three rooms, agents, a board and a recorded decision. */
function populated(): Factory {
  const f = factory();
  const work = loggedInAccount(f, "work");
  const other = loggedInAccount(f, "other");

  const backend = f.rooms.createRoom("backend", { projectId: f.projectId, summary: "the API" });
  const docs = f.rooms.createRoom("docs", { projectId: f.projectId, summary: "no product code" });
  f.rooms.setAccount(backend.id, work.id);
  f.rooms.setRuntime(backend.id, "container");
  f.rooms.moveRoom(backend.id, { x: 12, z: -4 });
  f.rooms.setAccount(docs.id, other.id);
  f.rooms.moveRoom(docs.id, { x: -8, z: 6 });

  const projectRoom = f.rooms.listRooms(f.projectId).find((r) => r.kind === "project")!;
  f.agent({ id: "arch", roomId: backend.id, roleId: "architect", model: "claude-opus-5", accountId: work.id });
  f.agent({ id: "be", roomId: backend.id, roleId: "backend", autonomy: "bypass", accountId: work.id });
  f.agent({ id: "writer", roomId: docs.id, roleId: "tech-writer", accountId: other.id });
  f.agent({ id: "boss", roomId: projectRoom.id, isOrchestrator: true, accountId: work.id });
  // A finished agent is history, not staffing: it must not come back as a described post.
  f.agent({ id: "gone", roomId: docs.id, state: "done" });

  const open = f.tasks.create({ title: "Ship the webhook", detail: "with retries", projectId: f.projectId, roomId: backend.id });
  f.tasks.update(open.id, { status: "in_progress" });
  f.tasks.create({ title: "Write the guide", projectId: f.projectId, roomId: docs.id });
  f.tasks.create({ title: "Decide the release cadence", projectId: f.projectId });

  f.chronicle.record({
    projectId: f.projectId,
    roomId: backend.id,
    title: "Webhook retries are owned by backend",
    context: "Two rooms both thought they owned delivery.",
    decision: "backend owns retry policy; docs publishes it.",
  });
  return f;
}

describe("no secret material appears in an export", () => {
  it("carries no token, no credentials file and no config-dir path", () => {
    const f = populated();
    const configDirs = f.accounts.list().map((a) => a.configDir);
    // Prove the fixture is actually holding secrets, so a passing grep means something.
    for (const dir of configDirs) {
      const raw = readFileSync(join(dir, ACCOUNT_CREDENTIALS_FILE), "utf8");
      expect(raw).toContain("sk-ant-oat01");
      expect(raw).toContain("whsec_");
    }

    const bytes = JSON.stringify(f.portability.export(f.projectId));

    for (const shape of SECRET_SHAPES) {
      expect(bytes.includes(shape)).toBe(false);
    }
    for (const dir of configDirs) {
      expect(bytes.includes(dir)).toBe(false);
    }
    // Not one absolute path of any kind: not the project root, not a room folder, not a home
    // directory. A shared factory describes a shape, not a filesystem.
    expect(bytes.includes(f.root)).toBe(false);
    expect(bytes.includes(tmpdir())).toBe(false);
    // And no account *id*, which is meaningless elsewhere and would invite a silent mis-binding.
    for (const account of f.accounts.list()) expect(bytes.includes(account.id)).toBe(false);
    f.cleanup();
  });

  it("refers to accounts by the label the operator typed", () => {
    const f = populated();
    const exported = f.portability.export(f.projectId);
    expect(exported.accountLabels).toEqual(["other", "work"]);
    expect(exported.rooms.find((r) => r.name === "backend")!.accountLabel).toBe("work");
    expect(exported.rooms.find((r) => r.name === "docs")!.accountLabel).toBe("other");
    // And says so in the file, for whoever opens the JSON rather than the docs.
    expect(exported.note).toContain("NO credentials");
    expect(exported.note).toContain("re-bind");
    f.cleanup();
  });

  it("is its own schema, so a file that is not one of ours is refused by name", () => {
    const f = factory();
    const target = tempDir("sf-import-");
    expect(() => f.portability.import({ root: target, factory: { hello: "world" } }))
      .toThrow(/not a SuperFabric factory export/);
    expect(() => f.portability.import({
      root: target,
      factory: { format: FACTORY_EXPORT_FORMAT, version: 99 },
    })).toThrow(/not a SuperFabric factory export/);
    f.cleanup();
  });
});

describe("a factory round-trips", () => {
  it("rebuilds the rooms, their positions, runtimes and board in a fresh root", () => {
    const source = populated();
    const exported = source.portability.export(source.projectId);
    expect(FactoryExport.safeParse(exported).success).toBe(true);
    expect(exported.format).toBe(FACTORY_EXPORT_FORMAT);
    expect(exported.version).toBe(FACTORY_EXPORT_VERSION);
    source.cleanup();

    // A different server, a different machine as far as anything here can tell.
    const target = factory({ root: tempDir("sf-import-") });
    // The same account labels exist here, with entirely different directories and ids.
    const work = loggedInAccount(target, "work");
    const other = loggedInAccount(target, "other");

    const result = target.portability.import({ root: target.root, factory: exported });

    expect(result.projectCreated).toBe(false); // the boot project already claims this root
    expect(result.roomsCreated).toEqual(["backend", "docs"]);
    expect(result.tasksCreated).toBe(3);
    expect(result.agentsDescribed).toBe(4);

    const rooms = target.rooms.listRooms(result.projectId);
    const backend = rooms.find((r) => r.name === "backend")!;
    const docs = rooms.find((r) => r.name === "docs")!;
    expect(backend.position).toEqual({ x: 12, z: -4 });
    expect(backend.runtime).toBe("container");
    expect(backend.accountId).toBe(work.id);
    expect(backend.path).toBe(join(target.root, "backend"));
    expect(docs.position).toEqual({ x: -8, z: 6 });
    expect(docs.runtime).toBe("host");
    expect(docs.accountId).toBe(other.id);
    // Rooms are folders: the import made them, with a charter, through the ordinary path.
    expect(existsSync(join(target.root, "backend", PROJECT_CHARTER_FILE))).toBe(true);

    const board = target.tasks.list(result.projectId);
    expect(board.map((t) => t.title).sort()).toEqual([
      "Decide the release cadence", "Ship the webhook", "Write the guide",
    ]);
    const shipped = board.find((t) => t.title === "Ship the webhook")!;
    expect(shipped.status).toBe("in_progress");
    expect(shipped.roomId).toBe(backend.id);
    expect(board.find((t) => t.title === "Decide the release cadence")!.roomId).toBeNull();

    // The staffing is described, never started: nothing spawned a CLI.
    expect(target.db.prepare("SELECT COUNT(*) c FROM sessions").get()).toEqual({ c: 0 });
    expect(result.problems.some((p) => p.includes("4 agent(s) were described"))).toBe(true);
    target.cleanup();
  });

  it("carries the central building's position without creating a second one", () => {
    const source = factory();
    const projectRoom = source.rooms.listRooms(source.projectId).find((r) => r.kind === "project")!;
    source.rooms.moveRoom(projectRoom.id, { x: 3, z: 3 });
    const exported = source.portability.export(source.projectId);
    source.cleanup();

    const target = factory({ root: tempDir("sf-import-") });
    const result = target.portability.import({ root: target.root, factory: exported });
    const rebuilt = target.rooms.listRooms(result.projectId);
    expect(rebuilt.filter((r) => r.kind === "project")).toHaveLength(1);
    expect(rebuilt.find((r) => r.kind === "project")!.position).toEqual({ x: 3, z: 3 });
    target.cleanup();
  });

  it("creates a project for a root that has none, taking the name from the file", () => {
    const source = factory();
    source.rooms.createRoom("shop", { projectId: source.projectId });
    const exported = source.portability.export(source.projectId);
    source.cleanup();

    const target = factory({ root: tempDir("sf-import-") });
    const elsewhere = tempDir("sf-elsewhere-");
    const result = target.portability.import({ root: elsewhere, factory: exported });
    expect(result.projectCreated).toBe(true);
    expect(result.projectName).toBe(exported.project.name);
    expect(target.projects.byRoot(elsewhere)!.id).toBe(result.projectId);
    expect(result.roomsCreated).toEqual(["shop"]);
    expect(existsSync(join(elsewhere, "shop", PROJECT_CHARTER_FILE))).toBe(true);
    target.cleanup();
  });
});

describe("an import reports what it could not do", () => {
  it("reports a room that already exists rather than silently skipping it", () => {
    const source = factory();
    source.rooms.createRoom("backend", { projectId: source.projectId });
    source.rooms.createRoom("frontend", { projectId: source.projectId });
    const exported = source.portability.export(source.projectId);
    source.cleanup();

    const target = factory({ root: tempDir("sf-import-") });
    // The operator already has a `backend` on this floor. It must not be replaced, and the import must
    // not pretend it created it.
    const existing = target.rooms.createRoom("backend", { projectId: target.projectId });
    writeFileSync(join(existing.path, PROJECT_CHARTER_FILE), "# mine\n\nDo not overwrite me.\n");

    const result = target.portability.import({ root: target.root, factory: exported });
    expect(result.roomsCreated).toEqual(["frontend"]);
    expect(result.problems.some((p) => /"backend" was not created/.test(p))).toBe(true);
    // The charter that was already there is untouched — the never-overwrite rule, still holding
    // because the import went through the same `createRoom`.
    expect(readFileSync(join(existing.path, PROJECT_CHARTER_FILE), "utf8")).toContain("Do not overwrite me.");
    target.cleanup();
  });

  it("reports an account label this machine does not have, and leaves the room unbound", () => {
    const source = populated();
    const exported = source.portability.export(source.projectId);
    source.cleanup();

    const target = factory({ root: tempDir("sf-import-") });
    // Only one of the two labels exists here.
    const work = loggedInAccount(target, "work");

    const result = target.portability.import({ root: target.root, factory: exported });
    expect(result.problems.some((p) => p.includes('labelled "other"'))).toBe(true);
    expect(result.problems.some((p) => p.includes('labelled "work"'))).toBe(false);
    const rooms = target.rooms.listRooms(result.projectId);
    expect(rooms.find((r) => r.name === "backend")!.accountId).toBe(work.id);
    // Unbound rather than bound to whatever was nearest: the ambient `~/.claude` is the honest default.
    expect(rooms.find((r) => r.name === "docs")!.accountId).toBeNull();
    target.cleanup();
  });

  it("reports a task whose room did not make it, and creates the card unassigned", () => {
    const source = factory();
    const backend = source.rooms.createRoom("backend", { projectId: source.projectId });
    source.tasks.create({ title: "Fix the retry", projectId: source.projectId, roomId: backend.id });
    const exported = source.portability.export(source.projectId);
    source.cleanup();

    const target = factory({ root: tempDir("sf-import-") });
    // A file that names a room it does not describe — a hand-edited export, or a room dropped from a
    // future version's shape. The card must still land, unassigned, and say why.
    const orphaned = { ...exported, rooms: [], tasks: exported.tasks };

    const result = target.portability.import({ root: target.root, factory: orphaned });
    expect(result.tasksCreated).toBe(1);
    expect(result.problems.some((p) => /"Fix the retry".*"backend".*not on this floor/s.test(p))).toBe(true);
    expect(target.tasks.list(result.projectId)[0]!.roomId).toBeNull();
    target.cleanup();
  });

  it("indexes a decision whose ADR is in the repository and reports one whose is not", () => {
    const source = populated();
    const exported = source.portability.export(source.projectId);
    expect(exported.decisions).toHaveLength(1);
    expect(exported.decisions[0]!.relativePath).toBe("docs/decisions/0001-webhook-retries-are-owned-by-backend.md");
    source.cleanup();

    // The ADR travelled with the repository, as an ADR does.
    const withAdr = factory({ root: tempDir("sf-import-") });
    const dir = join(withAdr.root, DECISIONS_DIRNAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "0001-webhook-retries-are-owned-by-backend.md"),
      "# 0001 — Webhook retries are owned by backend\n\nbackend owns retry policy.\n",
    );
    const kept = withAdr.portability.import({ root: withAdr.root, factory: exported });
    expect(kept.decisionsIndexed).toBe(1);
    expect(kept.problems.some((p) => p.includes("was not indexed"))).toBe(false);
    // Indexed means findable: the FTS trigger fired on the row the import inserted.
    expect(withAdr.chronicle.search(kept.projectId, "retry").length).toBeGreaterThan(0);
    // The number continues from the file on disk, not from the imported row.
    expect(withAdr.chronicle.list(kept.projectId)[0]!.number).toBe(1);
    withAdr.cleanup();

    // The repository did not come with it.
    const withoutAdr = factory({ root: tempDir("sf-import-") });
    const lost = withoutAdr.portability.import({ root: withoutAdr.root, factory: exported });
    expect(lost.decisionsIndexed).toBe(0);
    expect(lost.problems.some((p) => /0001.*not indexed.*docs\/decisions/s.test(p))).toBe(true);
    // No orphan index entry: the row is never written without the file it indexes.
    expect(withoutAdr.chronicle.list(lost.projectId)).toEqual([]);
    withoutAdr.cleanup();
  });

  it("reports a room whose folder was outside the exporting root", () => {
    const source = factory();
    const elsewhere = tempDir("sf-outside-");
    source.rooms.createRoom("vendor", { projectId: source.projectId, path: join(elsewhere, "vendor") });
    const exported = source.portability.export(source.projectId);
    expect(exported.rooms.find((r) => r.name === "vendor")!.relativePath).toBeNull();
    // And the outside path is not in the file either.
    expect(JSON.stringify(exported).includes(elsewhere)).toBe(false);
    source.cleanup();

    const target = factory({ root: tempDir("sf-import-") });
    const result = target.portability.import({ root: target.root, factory: exported });
    expect(result.roomsCreated).toEqual(["vendor"]);
    expect(result.problems.some((p) => /"vendor" lived outside/.test(p))).toBe(true);
    expect(target.rooms.listRooms(result.projectId).find((r) => r.name === "vendor")!.path)
      .toBe(join(target.root, "vendor"));
    target.cleanup();
  });

  it("says so rather than dropping tasks and decisions on a server that has neither", () => {
    const source = populated();
    const exported = source.portability.export(source.projectId);
    source.cleanup();

    const bare = factory({ root: tempDir("sf-import-") });
    const noExtras = new FactoryPortability({
      db: bare.db, projects: bare.projects, rooms: bare.rooms, accounts: bare.accounts,
    });
    const result = noExtras.import({ root: bare.root, factory: exported });
    expect(result.tasksCreated).toBe(0);
    expect(result.decisionsIndexed).toBe(0);
    expect(result.problems.some((p) => /task\(s\) were in the file but this server has no task board/.test(p)))
      .toBe(true);
    expect(result.problems.some((p) => /decision\(s\) were in the file but this server has no chronicle/.test(p)))
      .toBe(true);
    bare.cleanup();
  });

  it("refuses a root that does not exist rather than creating one", () => {
    const f = factory();
    const missing = join(tempDir("sf-import-"), "not", "there");
    expect(() => f.portability.import({ root: missing, factory: f.portability.export(f.projectId) }))
      .toThrow(/does not exist/);
    expect(existsSync(missing)).toBe(false);
    f.cleanup();
  });
});

describe("relativeToRoot", () => {
  it("describes a folder inside the root and refuses one outside it", () => {
    const root = "/srv/factory";
    expect(relativeToRoot(root, "/srv/factory")).toBe(".");
    expect(relativeToRoot(root, "/srv/factory/backend")).toBe("backend");
    expect(relativeToRoot(root, "/srv/factory/docs/decisions/0001-x.md")).toBe("docs/decisions/0001-x.md");
    expect(relativeToRoot(root, "/srv/elsewhere")).toBeNull();
    // A sibling whose name merely starts with the root's is not inside it.
    expect(relativeToRoot(root, "/srv/factory-two/backend")).toBeNull();
  });
});
