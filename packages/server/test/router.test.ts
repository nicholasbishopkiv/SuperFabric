import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { busToolDefinitions, orchestratorToolDefinitions } from "../src/busTools.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { FactoryBus, type RoomAgent } from "../src/factoryBus.js";
import { ensureOrchestrator } from "../src/orchestrator.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { TaskRouter, charterSummary } from "../src/router.js";
import { SessionManager } from "../src/sessionManager.js";
import { TaskStore } from "../src/taskStore.js";
import { FakeExecutor } from "../src/executors/fake.js";

/** The text a tool handler produced, and whether it reported failure. */
function resultOf(res: Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>): { text: string; isError: boolean } {
  const text = (res.content ?? []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
  return { text, isError: res.isError === true };
}

/**
 * A whole factory: a project room, two workshops with real charters on disk, a real bus, board and
 * router. Sessions run on a `FakeExecutor`, so delivery is a real injected turn that lands in a real
 * event log — nothing here prompts anything.
 */
function makeFactory() {
  const root = mkdtempSync(join(tmpdir(), "superfabric-router-"));
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const exec = new FakeExecutor();
  const projects = new ProjectManager(db, root);
  const rooms = new RoomManager(db, projects);
  const tasks = new TaskStore(db, projects);

  let mgr!: SessionManager;
  const bus = new FactoryBus({
    db, rooms, projects,
    deliver: (sessionId, text) => mgr.prompt(sessionId, text),
    roomAgents: (roomId) => mgr.roomAgents(roomId),
  });
  const router = new TaskRouter({
    bus, tasks, rooms,
    orchestratorFor: (projectId) => mgr.orchestratorFor(projectId),
    roomAgents: (roomId) => mgr.roomAgents(roomId),
  });
  mgr = new SessionManager(db, store, exec, rooms, projects, { bus, tasks, router });

  const projectRoom = rooms.ensureProjectRoom();
  const backend = rooms.createRoom("backend");
  const payments = rooms.createRoom("payments");
  writeFileSync(join(backend.path, "CLAUDE.md"), "# backend\n\n## Responsibility\n\nOwns the HTTP API and the database schema.\n");
  const projectId = projects.defaultProject().id;

  /**
   * The tool set a session in `roomId` would actually be handed. Built the same way
   * `SessionManager` builds it, so a case exercises the real closures rather than a stand-in.
   */
  const toolsFor = (roomId: string, isOrchestrator = false) =>
    busToolDefinitions({ bus, tasks, rooms, roomId, router, isOrchestrator, reportStatus: () => {} });

  const call = (defs: SdkMcpToolDefinition<any>[], name: string, args: Record<string, unknown>) => {
    const def = defs.find((d) => d.name === name);
    if (def === undefined) throw new Error(`no tool ${name}`);
    return def.handler(args as never, {});
  };

  return {
    root, db, store, exec, projects, rooms, tasks, bus, router, projectRoom, backend, payments,
    projectId,
    mgr: () => mgr,
    toolsFor,
    call,
    /** The orchestrator's own tool set, after creating it. */
    orchestrate: () => {
      const { sessionId } = ensureOrchestrator({ sessions: mgr, rooms }, projectId);
      return { sessionId, defs: toolsFor(projectRoom.id, true) };
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withFactory(fn: (ctx: ReturnType<typeof makeFactory>) => Promise<void> | void): Promise<void> {
  const ctx = makeFactory();
  return Promise.resolve(fn(ctx)).finally(() => ctx.cleanup());
}

describe("task routing", () => {
  it("with no orchestrator, sends nothing and changes nothing", async () => {
    await withFactory(({ router, tasks, bus }) => {
      const task = tasks.create({ title: "Charge cards on renewal" });
      // Nothing may fabricate an assignment: no message, no room, and the board goes on saying so.
      expect(router.requestRouting(task.id)).toBeUndefined();
      expect(router.hasOrchestrator(tasks.projectOf(task.id)!)).toBe(false);
      expect(bus.list()).toEqual([]);
      expect(tasks.get(task.id)!.roomId).toBeNull();
    });
  });

  it("asks the orchestrator once it exists, on the ordinary bus", async () => {
    await withFactory(({ router, tasks, bus, projectRoom, orchestrate }) => {
      orchestrate();
      const task = tasks.create({ title: "Charge cards on renewal", detail: "monthly plans only" });
      const sent = router.requestRouting(task.id)!;

      expect(sent.toRoomId).toBe(projectRoom.id);
      expect(sent.kind).toBe("request");
      expect(sent.taskId).toBe(task.id);
      // the orchestrator is told what the task is and what it is choosing between
      expect(sent.body).toContain(task.id);
      expect(sent.body).toContain("Charge cards on renewal");
      expect(sent.body).toContain("monthly plans only");
      expect(sent.body).toContain("backend");
      expect(sent.body).toContain("payments");
      expect(sent.body).toContain("Owns the HTTP API and the database schema.");
      expect(sent.body).toContain("factory_assign_task");
      // and the traffic is on the floor like anyone else's
      expect(bus.list().map((m) => m.id)).toEqual([sent.id]);
    });
  });

  it("delivers the routing request as a turn in the orchestrator's own session", async () => {
    await withFactory(async ({ router, tasks, store, exec, orchestrate }) => {
      const { sessionId } = orchestrate();
      const task = tasks.create({ title: "Charge cards on renewal" });
      router.requestRouting(task.id);
      await exec.settle();

      const prompts = store.listAfter(sessionId, 0)
        .map((e) => e.event)
        .filter((e): e is Extract<typeof e, { type: "user_prompt" }> => e.type === "user_prompt");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.text).toContain(task.id);
      expect(prompts[0]!.text).toContain("[factory bus]");
    });
  });

  it("refuses to route a task that already has a room", async () => {
    await withFactory(({ router, tasks, backend, orchestrate }) => {
      orchestrate();
      const task = tasks.create({ title: "Already placed", roomId: backend.id });
      expect(() => router.requestRouting(task.id)).toThrow(/already belongs to a room/);
    });
  });

  it("throws for an unknown task rather than sending a question about nothing", async () => {
    await withFactory(({ router, bus, orchestrate }) => {
      orchestrate();
      expect(() => router.requestRouting("ghost")).toThrow(/unknown task ghost/);
      expect(bus.list()).toEqual([]);
    });
  });

  it("is per factory: one floor's task never reaches another's orchestrator", async () => {
    await withFactory(({ router, tasks, rooms, projects, mgr, bus, projectId }) => {
      const otherRoot = mkdtempSync(join(tmpdir(), "superfabric-router-other-"));
      try {
        const other = projects.create({ root: otherRoot }).id;
        rooms.ensureProjectRoom(other);
        // only the *other* factory has an orchestrator
        ensureOrchestrator({ sessions: mgr(), rooms }, other);

        const mine = tasks.create({ title: "mine", projectId });
        expect(router.requestRouting(mine.id)).toBeUndefined();
        expect(bus.list(projectId)).toEqual([]);
        expect(bus.list(other)).toEqual([]);
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    });
  });
});

describe("factory_assign_task", () => {
  it("moves the card and tells the receiving room", async () => {
    await withFactory(async ({ call, tasks, bus, orchestrate, projectRoom, payments }) => {
      const { defs } = orchestrate();
      const task = tasks.create({ title: "Charge cards on renewal" });

      const res = resultOf(await call(defs, "factory_assign_task", { task_id: task.id, room: "payments" }));
      expect(res.isError).toBe(false);
      expect(res.text).toContain("payments");

      expect(tasks.get(task.id)).toMatchObject({ roomId: payments.id, agentId: null });
      const notice = bus.list().find((m) => m.toRoomId === payments.id)!;
      expect(notice).toMatchObject({ fromRoomId: projectRoom.id, kind: "info", taskId: task.id });
      expect(notice.body).toContain("Charge cards on renewal");
      // `info`, never `request`: a request naming a task blocks it, and a task blocked the instant
      // it is assigned would be the opposite of what happened.
      expect(tasks.get(task.id)!.status).toBe("open");
      expect(tasks.get(task.id)!.blockedOnMessageId).toBeNull();
    });
  });

  it("can name an agent in that room, and refuses one who does not work there", async () => {
    await withFactory(async ({ call, tasks, mgr, orchestrate, payments, backend }) => {
      const { defs } = orchestrate();
      const inPayments = mgr().createSession({ roomId: payments.id });
      const inBackend = mgr().createSession({ roomId: backend.id });
      const task = tasks.create({ title: "Charge cards" });

      const wrong = resultOf(await call(defs, "factory_assign_task", {
        task_id: task.id, room: "payments", agent_id: inBackend,
      }));
      expect(wrong.isError).toBe(true);
      expect(tasks.get(task.id)!.roomId).toBeNull();

      const right = resultOf(await call(defs, "factory_assign_task", {
        task_id: task.id, room: "payments", agent_id: inPayments,
      }));
      expect(right.isError).toBe(false);
      expect(tasks.get(task.id)).toMatchObject({ roomId: payments.id, agentId: inPayments });
    });
  });

  it("re-routes a task to another room, dropping the assignee that came with it", async () => {
    await withFactory(async ({ call, tasks, mgr, orchestrate, payments, backend }) => {
      const { defs } = orchestrate();
      const agent = mgr().createSession({ roomId: payments.id });
      const task = tasks.create({ title: "Charge cards" });
      await call(defs, "factory_assign_task", { task_id: task.id, room: "payments", agent_id: agent });

      const res = resultOf(await call(defs, "factory_assign_task", { task_id: task.id, room: "backend" }));
      expect(res.isError).toBe(false);
      expect(tasks.get(task.id)).toMatchObject({ roomId: backend.id, agentId: null });
    });
  });

  it("returns a tool error for an unknown room name, and changes nothing", async () => {
    await withFactory(async ({ call, tasks, bus, orchestrate }) => {
      const { defs } = orchestrate();
      const task = tasks.create({ title: "Charge cards" });
      const res = resultOf(await call(defs, "factory_assign_task", { task_id: task.id, room: "nowhere" }));

      expect(res.isError).toBe(true);
      // the orchestrator can fix its own mistake: the error says what the rooms are
      expect(res.text).toContain("nowhere");
      expect(res.text).toContain("payments");
      expect(tasks.get(task.id)!.roomId).toBeNull();
      expect(bus.list()).toEqual([]);
    });
  });

  it("returns a tool error for an unknown task", async () => {
    await withFactory(async ({ call, bus, orchestrate }) => {
      const { defs } = orchestrate();
      const res = resultOf(await call(defs, "factory_assign_task", { task_id: "ghost", room: "payments" }));
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/unknown task ghost/);
      expect(bus.list()).toEqual([]);
    });
  });
});

describe("the orchestrator-only gate", () => {
  it("keeps the routing tools out of an ordinary room agent's tool set", async () => {
    await withFactory(({ toolsFor, backend }) => {
      const names = toolsFor(backend.id).map((d) => d.name);
      expect(names).not.toContain("factory_assign_task");
      expect(names).not.toContain("factory_list_rooms");
      expect(names).toContain("factory_ask_orchestrator");
    });
  });

  it("gives them to the orchestrator, on top of the ordinary room tools", async () => {
    await withFactory(({ orchestrate }) => {
      const { defs } = orchestrate();
      expect(defs.map((d) => d.name)).toEqual([
        "factory_send", "factory_inbox", "factory_task_update", "factory_report_status",
        "factory_ask_orchestrator", "factory_assign_task", "factory_list_rooms",
      ]);
    });
  });

  it("refuses an ordinary agent that calls one anyway, as a tool error and not a crash", async () => {
    await withFactory(async ({ call, tasks, bus, rooms, backend, router }) => {
      const task = tasks.create({ title: "Charge cards" });
      // The definitions an ordinary agent would have if it somehow got hold of them: not being
      // offered a tool is not the same as being refused it.
      const defs = orchestratorToolDefinitions({
        bus, tasks, rooms, router, roomId: backend.id, isOrchestrator: false, reportStatus: () => {},
      });

      const assign = resultOf(await call(defs, "factory_assign_task", { task_id: task.id, room: "payments" }));
      expect(assign.isError).toBe(true);
      expect(assign.text).toMatch(/orchestrator/);
      expect(assign.text).toMatch(/factory_ask_orchestrator/);
      expect(tasks.get(task.id)!.roomId).toBeNull();
      expect(bus.list()).toEqual([]);

      const list = resultOf(await call(defs, "factory_list_rooms", {}));
      expect(list.isError).toBe(true);
    });
  });

  it("takes the role from the session's tool set, never from tool input", async () => {
    await withFactory(async ({ call, tasks, bus, rooms, backend, router }) => {
      const task = tasks.create({ title: "Charge cards" });
      const defs = orchestratorToolDefinitions({
        bus, tasks, rooms, router, roomId: backend.id, isOrchestrator: false, reportStatus: () => {},
      });
      // A model that invents extra fields must not be able to promote itself.
      const res = resultOf(await call(defs, "factory_assign_task", {
        task_id: task.id, room: "payments", is_orchestrator: true, isOrchestrator: true, role: "orchestrator",
      }));
      expect(res.isError).toBe(true);
      expect(tasks.get(task.id)!.roomId).toBeNull();
    });
  });
});

describe("factory_list_rooms", () => {
  it("reports every room with its charter, agent count and live status", async () => {
    await withFactory(async ({ call, mgr, orchestrate, backend }) => {
      const { defs } = orchestrate();
      mgr().createSession({ roomId: backend.id });

      const res = resultOf(await call(defs, "factory_list_rooms", {}));
      expect(res.isError).toBe(false);
      expect(res.text).toContain("backend");
      expect(res.text).toContain("Owns the HTTP API and the database schema.");
      expect(res.text).toMatch(/backend.*1 agent\(s\)/);
      expect(res.text).toMatch(/backend.*running/);
      // payments' charter is the untouched template, which says nothing — and says so
      expect(res.text).toMatch(/payments.*no charter yet/);
      // the central building is marked, so the orchestrator knows which one it is standing in
      expect(res.text).toMatch(/central building/);
    });
  });

  it("shows only this factory's floor", async () => {
    await withFactory(async ({ call, rooms, projects, orchestrate }) => {
      const otherRoot = mkdtempSync(join(tmpdir(), "superfabric-router-other-"));
      try {
        const other = projects.create({ root: otherRoot }).id;
        rooms.ensureProjectRoom(other);
        rooms.createRoom("vendor", { projectId: other });

        const { defs } = orchestrate();
        const res = resultOf(await call(defs, "factory_list_rooms", {}));
        expect(res.text).toContain("payments");
        expect(res.text).not.toContain("vendor");
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    });
  });
});

describe("factory_ask_orchestrator", () => {
  it("is an ordinary bus request to the project room, from the asking room", async () => {
    await withFactory(async ({ call, toolsFor, bus, backend, projectRoom, orchestrate }) => {
      orchestrate();
      const res = resultOf(await call(toolsFor(backend.id), "factory_ask_orchestrator", {
        question: "does retry policy live here or in payments?",
      }));
      expect(res.isError).toBe(false);

      const asked = bus.list().find((m) => m.body.includes("retry policy"))!;
      expect(asked).toMatchObject({
        fromRoomId: backend.id, toRoomId: projectRoom.id, kind: "request", taskId: null,
      });
      expect(res.text).toContain(asked.id);
      expect(res.text).not.toMatch(/no orchestrator/);
    });
  });

  it("reaches the orchestrator as a turn, and is answered with an ordinary factory_send", async () => {
    await withFactory(async ({ call, toolsFor, store, exec, bus, backend, orchestrate }) => {
      const { sessionId, defs } = orchestrate();
      await call(toolsFor(backend.id), "factory_ask_orchestrator", { question: "who owns retries?" });
      await exec.settle();

      const heard = store.listAfter(sessionId, 0)
        .map((e) => e.event)
        .some((e) => e.type === "user_prompt" && e.text.includes("who owns retries?"));
      expect(heard).toBe(true);

      // no privileged channel back either: the answer is a factory_send like anyone else's
      const answer = resultOf(await call(defs, "factory_send", {
        to_room: "backend", kind: "response", body: "backend owns retries",
      }));
      expect(answer.isError).toBe(false);
      expect(bus.list().some((m) => m.toRoomId === backend.id && m.body === "backend owns retries")).toBe(true);
    });
  });

  it("blocks the task it names, and releases it when the orchestrator answers", async () => {
    await withFactory(async ({ call, toolsFor, tasks, backend, orchestrate }) => {
      const { defs } = orchestrate();
      const task = tasks.create({ title: "Retry failed charges", roomId: backend.id });

      await call(toolsFor(backend.id), "factory_ask_orchestrator", {
        question: "who owns retries?", task_id: task.id,
      });
      expect(tasks.get(task.id)!.status).toBe("blocked");

      await call(defs, "factory_send", {
        to_room: "backend", kind: "response", body: "you do", task_id: task.id,
      });
      expect(tasks.get(task.id)).toMatchObject({ status: "in_progress", blockedOnMessageId: null });
    });
  });

  it("says so when the factory has no orchestrator, and still persists the question", async () => {
    await withFactory(async ({ call, toolsFor, bus, backend, projectRoom }) => {
      const res = resultOf(await call(toolsFor(backend.id), "factory_ask_orchestrator", {
        question: "who owns retries?",
      }));
      expect(res.isError).toBe(false);
      expect(res.text).toMatch(/no orchestrator/);
      // persisted first, delivered whenever: the bus does not lose a question for want of a reader
      expect(bus.undeliveredFor(projectRoom.id).map((m) => m.body)).toEqual(["who owns retries?"]);
    });
  });

  it("refuses to let the project room ask itself", async () => {
    await withFactory(async ({ call, toolsFor, bus, projectRoom, orchestrate }) => {
      orchestrate();
      const res = resultOf(await call(toolsFor(projectRoom.id, true), "factory_ask_orchestrator", {
        question: "what should I do?",
      }));
      expect(res.isError).toBe(true);
      expect(bus.list()).toEqual([]);
    });
  });

  it("returns a tool error for an unknown task rather than crashing", async () => {
    await withFactory(async ({ call, toolsFor, backend, orchestrate }) => {
      orchestrate();
      const res = resultOf(await call(toolsFor(backend.id), "factory_ask_orchestrator", {
        question: "hm?", task_id: "ghost",
      }));
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/unknown task ghost/);
    });
  });
});

describe("charterSummary", () => {
  it("takes the Responsibility section's first real line", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-charter-"));
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# api\n\n## Responsibility\n\nOwns the public API.\n\n## Interfaces\n\nnope\n");
      expect(charterSummary(dir)).toBe("Owns the public API.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips the template's own placeholders rather than reading one out as a responsibility", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-charter-"));
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# api\n\n## Responsibility\n\n_What this department owns. Replace this line._\n");
      expect(charterSummary(dir)).toBe("no charter yet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the first real line of a charter with no Responsibility heading", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-charter-"));
    try {
      writeFileSync(join(dir, "CLAUDE.md"), "# their repo\n\nThis is somebody else's project.\n");
      expect(charterSummary(dir)).toBe("This is somebody else's project.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says a room with no charter file has none, rather than throwing", () => {
    expect(charterSummary(join(tmpdir(), "superfabric-no-such-room"))).toBe("no charter yet");
  });

  it("truncates a paragraph rather than pasting a document into a prompt", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-charter-"));
    try {
      writeFileSync(join(dir, "CLAUDE.md"), `# api\n\n## Responsibility\n\n${"x".repeat(500)}\n`);
      const summary = charterSummary(dir);
      expect(summary.length).toBeLessThan(250);
      expect(summary.endsWith("…")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
