import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { busToolDefinitions } from "../src/busTools.js";
import { Chronicle, DECISIONS_DIRNAME, ftsQuery } from "../src/chronicle.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { FactoryBus } from "../src/factoryBus.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { TaskStore } from "../src/taskStore.js";
import { FakeExecutor } from "../src/executors/fake.js";

/** The text a tool handler produced, and whether it reported failure. */
function resultOf(res: Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>): { text: string; isError: boolean } {
  const text = (res.content ?? []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
  return { text, isError: res.isError === true };
}

/**
 * A factory with a real repository root, a real event log and a real chronicle. `clock` is settable
 * so a case can put two decisions in the same second on purpose — `unixepoch()` has one-second
 * resolution, so that collision is not a rare race, it is what happens when an agent records twice.
 */
function makeChronicle() {
  const root = mkdtempSync(join(tmpdir(), "superfabric-chronicle-"));
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const exec = new FakeExecutor();
  const projects = new ProjectManager(db, root);
  const rooms = new RoomManager(db, projects);
  const tasks = new TaskStore(db, projects);
  let clock = 1_800_000_000; // a fixed Tuesday, so the ADR's date is assertable
  const chronicle = new Chronicle(db, projects, () => clock);
  const bus = new FactoryBus({ db, rooms, projects, deliver: () => {}, roomAgents: () => [] });
  const mgr = new SessionManager(db, store, exec, rooms, projects, { bus, tasks, chronicle });

  rooms.ensureProjectRoom();
  const backend = rooms.createRoom("backend");
  const projectId = projects.defaultProject().id;

  const toolsFor = (roomId: string, sessionId?: string) =>
    busToolDefinitions({
      bus, tasks, rooms, chronicle, roomId, reportStatus: () => {},
      ...(sessionId !== undefined ? { sessionId } : {}),
    });

  const call = (defs: SdkMcpToolDefinition<any>[], name: string, args: Record<string, unknown>) => {
    const def = defs.find((d) => d.name === name);
    if (def === undefined) throw new Error(`no tool ${name}`);
    return def.handler(args as never, {});
  };

  return {
    root, db, store, exec, projects, rooms, tasks, chronicle, mgr, backend, projectId, toolsFor, call,
    decisionsDir: join(root, DECISIONS_DIRNAME),
    setClock: (t: number) => { clock = t; },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withChronicle(fn: (ctx: ReturnType<typeof makeChronicle>) => Promise<void> | void): Promise<void> {
  const ctx = makeChronicle();
  return Promise.resolve(fn(ctx)).finally(() => ctx.cleanup());
}

describe("FTS5 under bun:sqlite", () => {
  it("is available, which the whole feature depends on", () => {
    const db = openDb(":memory:");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((t) => t.name);
    expect(tables).toContain("chronicle_fts");
    // a virtual table, and specifically an fts5 one — not something that fell back to a plain table
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chronicle_fts'").get() as { sql: string }).sql;
    expect(sql).toMatch(/USING fts5/i);
  });
});

describe("recording a decision", () => {
  it("writes an ADR file in the repository and a row that indexes it", async () => {
    await withChronicle(({ chronicle, projectId, decisionsDir }) => {
      const record = chronicle.record({
        projectId,
        title: "Retries live in the payments room",
        context: "Both rooms wanted to own the retry loop for failed charges.",
        decision: "payments owns retries; backend exposes an idempotent charge endpoint.",
        alternatives: "backend owning it, which would have needed the billing calendar there too.",
        links: ["packages/payments/src/retry.ts"],
      });

      // the row
      expect(chronicle.get(record.id)).toMatchObject({
        title: "Retries live in the payments room",
        number: 1,
        projectId,
      });
      // …and the artefact it points at
      expect(record.path).toBe(join(decisionsDir, "0001-retries-live-in-the-payments-room.md"));
      expect(existsSync(record.path)).toBe(true);
    });
  });

  it("is repo-native: a grep in a checkout with nothing running finds the reasoning", async () => {
    await withChronicle(({ chronicle, projectId, decisionsDir, db }) => {
      chronicle.record({
        projectId,
        title: "Retries live in payments",
        context: "Both rooms wanted the retry loop.",
        decision: "payments owns retries.",
      });
      db.close(); // SuperFabric is not running; the repository is all there is

      const files = readdirSync(decisionsDir);
      expect(files).toEqual(["0001-retries-live-in-payments.md"]);
      const text = readFileSync(join(decisionsDir, files[0]!), "utf8");
      expect(text).toContain("Both rooms wanted the retry loop.");
      expect(text).toContain("payments owns retries.");
    });
  });

  it("writes ADR-shaped markdown, in this repository's own style", async () => {
    await withChronicle(({ chronicle, projectId }) => {
      const record = chronicle.record({
        projectId,
        title: "Retries live in payments",
        context: "Both rooms wanted it.",
        decision: "payments owns retries.",
        alternatives: "backend owning it.",
        links: ["docs/ARCHITECTURE.md", "https://example.com/rfc"],
      });
      const text = readFileSync(record.path, "utf8");

      expect(text).toMatch(/^# 0001 — Retries live in payments\n/);
      expect(text).toContain("Date: 2027-01-15 · Status: accepted");
      expect(text.indexOf("## Context")).toBeGreaterThan(0);
      expect(text.indexOf("## Decision")).toBeGreaterThan(text.indexOf("## Context"));
      expect(text.indexOf("## Alternatives")).toBeGreaterThan(text.indexOf("## Decision"));
      expect(text).toContain("- docs/ARCHITECTURE.md");
      expect(text).toContain("- https://example.com/rfc");
      expect(text.endsWith("\n")).toBe(true);
    });
  });

  it("omits sections it has nothing to put under, because a heading is a promise", async () => {
    await withChronicle(({ chronicle, projectId }) => {
      const record = chronicle.record({
        projectId, title: "Small call", context: "", decision: "we did the obvious thing.",
      });
      const text = readFileSync(record.path, "utf8");
      expect(text).not.toContain("## Alternatives");
      expect(text).not.toContain("## Links");
      // Context is always present — an ADR with no context is the failure mode this format exists
      // to prevent — but it says so rather than pretending.
      expect(text).toContain("## Context");
      expect(text).toContain("_Not recorded._");
    });
  });

  it("continues the numbering already on disk, so hand-written ADRs are not overwritten", async () => {
    await withChronicle(({ chronicle, projectId, decisionsDir }) => {
      // exactly this repository's own situation: 0001–0003 written by a person
      mkdirSync(decisionsDir, { recursive: true });
      for (const name of ["0001-bun-runtime-keep-vite.md", "0002-factory-tools.md", "0003-ui-library.md"]) {
        writeFileSync(join(decisionsDir, name), "# by hand\n");
      }
      const record = chronicle.record({ projectId, title: "The fourth", context: "", decision: "x" });
      expect(record.number).toBe(4);
      expect(record.path).toBe(join(decisionsDir, "0004-the-fourth.md"));
      expect(readFileSync(join(decisionsDir, "0001-bun-runtime-keep-vite.md"), "utf8")).toBe("# by hand\n");
    });
  });

  it("does not collide when two decisions land in the same second with the same title", async () => {
    await withChronicle(({ chronicle, projectId, decisionsDir }) => {
      const first = chronicle.record({ projectId, title: "Same name", context: "", decision: "a" });
      const second = chronicle.record({ projectId, title: "Same name", context: "", decision: "b" });

      expect(first.createdAt).toBe(second.createdAt); // the clock did not move
      expect(second.number).toBe(first.number + 1);
      expect(second.path).not.toBe(first.path);
      expect(readdirSync(decisionsDir).sort()).toEqual(["0001-same-name.md", "0002-same-name.md"]);
      expect(readFileSync(first.path, "utf8")).toContain("a");
      expect(readFileSync(second.path, "utf8")).toContain("b");
    });
  });

  it("refuses a decision with no title or nothing decided", async () => {
    await withChronicle(({ chronicle, projectId, decisionsDir }) => {
      expect(() => chronicle.record({ projectId, title: "  ", context: "", decision: "x" })).toThrow(/title/);
      expect(() => chronicle.record({ projectId, title: "x", context: "", decision: " " }))
        .toThrow(/what was decided/);
      expect(existsSync(decisionsDir) ? readdirSync(decisionsDir) : []).toEqual([]);
    });
  });

  it("folds an unusable title into a usable filename rather than refusing it", async () => {
    await withChronicle(({ chronicle, projectId }) => {
      const record = chronicle.record({
        projectId, title: "  Use HTTP/2 — *always*?  ", context: "", decision: "yes",
      });
      expect(record.path.endsWith("0001-use-http-2-always.md")).toBe(true);
      expect(record.title).toBe("Use HTTP/2 — *always*?"); // the title itself is untouched
    });
  });

  it("keeps each factory's decisions in its own repository", async () => {
    await withChronicle(({ chronicle, projects, projectId, root }) => {
      const otherRoot = mkdtempSync(join(tmpdir(), "superfabric-chronicle-other-"));
      try {
        const other = projects.create({ root: otherRoot }).id;
        chronicle.record({ projectId, title: "Mine", context: "", decision: "a" });
        chronicle.record({ projectId: other, title: "Theirs", context: "", decision: "b" });

        expect(readdirSync(join(root, DECISIONS_DIRNAME))).toEqual(["0001-mine.md"]);
        expect(readdirSync(join(otherRoot, DECISIONS_DIRNAME))).toEqual(["0001-theirs.md"]);
        expect(chronicle.list(projectId).map((d) => d.title)).toEqual(["Mine"]);
        expect(chronicle.list(other).map((d) => d.title)).toEqual(["Theirs"]);
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    });
  });
});

describe("searching the chronicle", () => {
  it("finds a decision by a word in its context", async () => {
    await withChronicle(({ chronicle, projectId }) => {
      const record = chronicle.record({
        projectId,
        title: "Retries live in payments",
        context: "Both rooms wanted to own the idempotency key.",
        decision: "payments owns it.",
      });
      const hits = chronicle.search(projectId, "idempotency");
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ kind: "decision", ref: record.id, title: "Retries live in payments" });
      expect(hits[0]!.snippet).toContain("idempotency");
      // enough to act on: what, when, who, and where the file is
      expect(hits[0]!.path).toBe(record.path);
      expect(hits[0]!.createdAt).toBe(record.createdAt);
    });
  });

  it("finds a decision by a word in its alternatives, not only its decision", async () => {
    await withChronicle(({ chronicle, projectId }) => {
      chronicle.record({
        projectId, title: "Queueing", context: "", decision: "in-process",
        alternatives: "we considered rabbitmq and rejected it as an extra daemon to run.",
      });
      expect(chronicle.search(projectId, "rabbitmq")).toHaveLength(1);
    });
  });

  it("finds an event by a word in what an agent actually said", async () => {
    await withChronicle(async ({ chronicle, mgr, exec, backend, projectId }) => {
      const session = mgr.createSession({ roomId: backend.id });
      mgr.prompt(session, "the webhook signature uses hmac-sha256");
      await exec.settle();

      const hits = chronicle.search(projectId, "hmac");
      expect(hits.length).toBeGreaterThan(0);
      const hit = hits[0]!;
      expect(hit.kind).toBe("event");
      expect(hit.ref).toBe(session);
      expect(hit.roomId).toBe(backend.id);
      expect(hit.snippet).toContain("hmac");
      expect(hit.path).toBeNull(); // an event has no file of its own; the transcript is the record
    });
  });

  it("answers decisions and what was said from one query", async () => {
    await withChronicle(async ({ chronicle, mgr, exec, backend, projectId }) => {
      const session = mgr.createSession({ roomId: backend.id });
      mgr.prompt(session, "should the webhook be retried?");
      await exec.settle();
      chronicle.record({
        projectId, title: "Webhook delivery", context: "flaky receivers", decision: "retry three times",
      });

      const kinds = chronicle.search(projectId, "webhook").map((h) => h.kind);
      expect(kinds).toContain("decision");
      expect(kinds).toContain("event");
    });
  });

  it("indexes what carries meaning and leaves the mechanical bulk out", async () => {
    await withChronicle(({ chronicle, store, mgr, backend, projectId }) => {
      const session = mgr.createSession({ roomId: backend.id });
      store.append(session, { type: "agent_text", text: "aardvark" });
      store.append(session, { type: "session_status", status: "working", detail: "badger" });
      // the bulk: a tool's input and output are evidence, not reasoning, and would double the file
      store.append(session, { type: "tool_use", toolName: "Read", input: { text: "capybara" } });
      store.append(session, { type: "tool_result", toolName: "Read", output: "dormouse" });
      store.append(session, { type: "session_error", message: "elephant" });

      expect(chronicle.search(projectId, "aardvark")).toHaveLength(1);
      expect(chronicle.search(projectId, "badger")).toHaveLength(1);
      expect(chronicle.search(projectId, "capybara")).toEqual([]);
      expect(chronicle.search(projectId, "dormouse")).toEqual([]);
      expect(chronicle.search(projectId, "elephant")).toEqual([]);
    });
  });

  it("returns nothing for an empty chronicle rather than throwing", async () => {
    await withChronicle(({ chronicle, projectId }) => {
      expect(chronicle.search(projectId, "anything at all")).toEqual([]);
      expect(chronicle.search("no-such-project", "anything")).toEqual([]);
    });
  });

  it("survives whatever an agent types, including FTS5's own operators", async () => {
    await withChronicle(({ chronicle, projectId }) => {
      chronicle.record({ projectId, title: "Webhooks", context: "flaky receivers", decision: "retry" });
      // an unbalanced quote is an FTS5 syntax error; a model must get an answer, not an exception
      for (const query of ['the "flaky', "NEAR(", "receivers*", "-receivers", "a:b", "()"]) {
        expect(() => chronicle.search(projectId, query)).not.toThrow();
      }
      // …and it still answers the question that was inside the broken syntax
      expect(chronicle.search(projectId, '"flaky receivers')).toHaveLength(1);
      expect(chronicle.search(projectId, "!!! ???")).toEqual([]);
    });
  });

  it("requires every term, so a multi-word question narrows rather than floods", async () => {
    await withChronicle(({ chronicle, projectId }) => {
      chronicle.record({ projectId, title: "A", context: "webhook retry policy", decision: "x" });
      chronicle.record({ projectId, title: "B", context: "webhook signing", decision: "y" });
      expect(chronicle.search(projectId, "webhook").map((h) => h.title).sort()).toEqual(["A", "B"]);
      expect(chronicle.search(projectId, "webhook retry").map((h) => h.title)).toEqual(["A"]);
    });
  });

  it("is newest first, so a superseded decision does not outrank the one that replaced it", async () => {
    await withChronicle(({ chronicle, projectId, setClock }) => {
      setClock(1_800_000_000);
      chronicle.record({ projectId, title: "Old", context: "retries retries retries", decision: "a" });
      setClock(1_800_000_100);
      chronicle.record({ projectId, title: "New", context: "retries", decision: "supersedes the old one" });
      expect(chronicle.search(projectId, "retries").map((h) => h.title)).toEqual(["New", "Old"]);
    });
  });

  it("honours the limit", async () => {
    await withChronicle(({ chronicle, projectId, setClock }) => {
      for (let i = 0; i < 5; i++) {
        setClock(1_800_000_000 + i);
        chronicle.record({ projectId, title: `Decision ${i}`, context: "retries", decision: "x" });
      }
      expect(chronicle.search(projectId, "retries", 2)).toHaveLength(2);
      expect(chronicle.search(projectId, "retries")).toHaveLength(5);
    });
  });

  it("never crosses factories, in either direction", async () => {
    await withChronicle(async ({ chronicle, projects, rooms, mgr, exec, projectId }) => {
      const otherRoot = mkdtempSync(join(tmpdir(), "superfabric-chronicle-other-"));
      try {
        const other = projects.create({ root: otherRoot }).id;
        rooms.ensureProjectRoom(other);
        const theirRoom = rooms.createRoom("vendor", { projectId: other });

        chronicle.record({ projectId: other, title: "Theirs", context: "pangolin", decision: "x" });
        const theirAgent = mgr.createSession({ roomId: theirRoom.id });
        mgr.prompt(theirAgent, "pangolin is the codename");
        await exec.settle();

        expect(chronicle.search(projectId, "pangolin")).toEqual([]);
        expect(chronicle.search(other, "pangolin").length).toBeGreaterThanOrEqual(2);
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    });
  });
});

describe("the FTS index is kept in step by triggers", () => {
  it("indexes an ordinary EventStore.append, with no chronicle in the call path at all", async () => {
    await withChronicle(({ db, store, mgr, chronicle, backend, projectId }) => {
      const session = mgr.createSession({ roomId: backend.id });
      // Nothing here knows the chronicle exists — which is the property the trigger buys.
      store.append(session, { type: "agent_text", text: "quokka" });
      expect(chronicle.search(projectId, "quokka")).toHaveLength(1);

      const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as
        { name: string }[]).map((t) => t.name);
      expect(triggers).toEqual(expect.arrayContaining(["events_ai", "decisions_ai"]));
    });
  });

  it("indexes a decision row written by hand, not only one written through Chronicle.record", async () => {
    await withChronicle(({ db, chronicle, projectId }) => {
      db.prepare(`
        INSERT INTO decisions (id, project_id, number, path, title, context, decision, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("d1", projectId, 1, "/tmp/0001-x.md", "By hand", "numbat", "x", 1_800_000_000);
      expect(chronicle.search(projectId, "numbat").map((h) => h.ref)).toEqual(["d1"]);
    });
  });
});

describe("the chronicle tools", () => {
  it("are in every room's tool set, not just the orchestrator's", async () => {
    await withChronicle(({ toolsFor, backend }) => {
      const names = toolsFor(backend.id).map((d) => d.name);
      expect(names).toContain("factory_record_decision");
      expect(names).toContain("factory_search_history");
    });
  });

  it("reach a real agent through SessionManager, stamped with its own session id", async () => {
    await withChronicle(async ({ db, store, projects, rooms, tasks, chronicle, backend, projectId }) => {
      const starts: any[] = [];
      const exec = {
        name: "recording",
        start(opts: any, ev: any) {
          starts.push(opts);
          ev.onEvent({ type: "session_status", status: "idle" });
          return {
            providerSessionId: Promise.resolve("c1"),
            send: () => {}, interrupt: async () => {}, stop: async () => {},
          };
        },
      };
      const bus = new FactoryBus({ db, rooms, projects, deliver: () => {}, roomAgents: () => [] });
      const mgr = new SessionManager(db, store, exec as never, rooms, projects, { bus, tasks, chronicle });
      const sessionId = mgr.createSession({ roomId: backend.id });

      const tools = (starts[0].mcpServers.factory as any).instance._registeredTools as Record<string, any>;
      expect(Object.keys(tools)).toContain("factory_record_decision");
      await tools.factory_record_decision.handler(
        { title: "From a real session", context: "", decision: "x" }, {},
      );
      expect(chronicle.list(projectId)[0]).toMatchObject({ agentId: sessionId, roomId: backend.id });
    });
  });

  it("are absent when the server has no chronicle, rather than failing at call time", async () => {
    await withChronicle(({ db, rooms, projects, tasks, backend }) => {
      // An M3a-shaped server: a bus and a board, no chronicle. A tool that could not write the ADR
      // file it promises is worse than no tool — the agent would believe it had recorded something.
      const bus = new FactoryBus({ db, rooms, projects, deliver: () => {}, roomAgents: () => [] });
      const names = busToolDefinitions({
        bus, tasks, rooms, roomId: backend.id, reportStatus: () => {},
      }).map((d) => d.name);
      expect(names).not.toContain("factory_record_decision");
      expect(names).not.toContain("factory_search_history");
      expect(names).toContain("factory_send");
    });
  });

  it("factory_record_decision writes the file and stamps the calling room and agent", async () => {
    await withChronicle(async ({ call, toolsFor, chronicle, backend, projectId }) => {
      const defs = toolsFor(backend.id, "session-7");
      const res = resultOf(await call(defs, "factory_record_decision", {
        title: "Retries live here",
        context: "we argued about it",
        decision: "backend owns retries",
        alternatives: "payments owning them",
        links: ["src/retry.ts"],
      }));
      expect(res.isError).toBe(false);

      const recorded = chronicle.list(projectId);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        title: "Retries live here", roomId: backend.id, agentId: "session-7", links: ["src/retry.ts"],
      });
      expect(res.text).toContain(recorded[0]!.path);
      expect(readFileSync(recorded[0]!.path, "utf8")).toContain("backend owns retries");
    });
  });

  it("takes the room and the author from the session, never from tool input", async () => {
    await withChronicle(async ({ call, toolsFor, chronicle, rooms, backend, projectId }) => {
      const other = rooms.createRoom("payments");
      const res = resultOf(await call(toolsFor(backend.id, "session-7"), "factory_record_decision", {
        title: "Spoofed", context: "", decision: "x",
        room_id: other.id, agent_id: "somebody-else", project_id: "elsewhere",
      }));
      expect(res.isError).toBe(false);
      expect(chronicle.list(projectId)[0]).toMatchObject({
        roomId: backend.id, agentId: "session-7", projectId,
      });
    });
  });

  it("factory_record_decision returns a tool error for an empty title, and writes nothing", async () => {
    await withChronicle(async ({ call, toolsFor, chronicle, backend, projectId }) => {
      const res = resultOf(await call(toolsFor(backend.id), "factory_record_decision", {
        title: "", context: "", decision: "x",
      }));
      expect(res.isError).toBe(true);
      expect(chronicle.list(projectId)).toEqual([]);
    });
  });

  it("factory_search_history reports what, when, who and a snippet", async () => {
    await withChronicle(async ({ call, toolsFor, backend }) => {
      await call(toolsFor(backend.id), "factory_record_decision", {
        title: "Retries live here", context: "the idempotency key argument", decision: "backend owns retries",
      });
      const res = resultOf(await call(toolsFor(backend.id), "factory_search_history", { query: "idempotency" }));

      expect(res.isError).toBe(false);
      expect(res.text).toContain("Retries live here");
      expect(res.text).toContain("2027-01-15");
      expect(res.text).toContain("backend");        // the room, by name rather than by id
      expect(res.text).toContain("idempotency");    // the snippet
      expect(res.text).toContain("0001-retries-live-here.md");
    });
  });

  it("factory_search_history says nothing is written down rather than erroring", async () => {
    await withChronicle(async ({ call, toolsFor, backend }) => {
      const res = resultOf(await call(toolsFor(backend.id), "factory_search_history", { query: "nothing here" }));
      expect(res.isError).toBe(false);
      expect(res.text).toMatch(/Nothing in this project's chronicle/);
    });
  });

  it("searches only the caller's own factory", async () => {
    await withChronicle(async ({ call, toolsFor, chronicle, projects, backend }) => {
      const otherRoot = mkdtempSync(join(tmpdir(), "superfabric-chronicle-other-"));
      try {
        const other = projects.create({ root: otherRoot }).id;
        chronicle.record({ projectId: other, title: "Theirs", context: "pangolin", decision: "x" });
        const res = resultOf(await call(toolsFor(backend.id), "factory_search_history", { query: "pangolin" }));
        expect(res.text).toMatch(/Nothing in this project's chronicle/);
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    });
  });

  it("tells agents to search before reworking, in the tool the model reads", async () => {
    await withChronicle(({ toolsFor, backend }) => {
      const defs = toolsFor(backend.id);
      const record = defs.find((d) => d.name === "factory_record_decision")!;
      const search = defs.find((d) => d.name === "factory_search_history")!;
      expect(record.description).toMatch(/why/i);
      expect(record.description).toMatch(/search first/i);
      expect(search.description).toMatch(/before reworking/i);
    });
  });
});

describe("ftsQuery", () => {
  it("re-quotes every term, so no punctuation can be a syntax error or an operator", () => {
    expect(ftsQuery("webhook retry")).toBe('"webhook" "retry"');
    expect(ftsQuery('the "flaky receiver')).toBe('"the" "flaky" "receiver"');
    expect(ftsQuery("NEAR(a, b)")).toBe('"near" "a" "b"');
  });

  it("is null when there is nothing searchable in it", () => {
    expect(ftsQuery("")).toBeNull();
    expect(ftsQuery("   ")).toBeNull();
    expect(ftsQuery("!!! ???")).toBeNull();
  });

  it("keeps non-ASCII words, because a charter is not necessarily in English", () => {
    expect(ftsQuery("платежи retry")).toBe('"платежи" "retry"');
  });
});
