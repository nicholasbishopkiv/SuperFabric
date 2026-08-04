import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../src/accountManager.js";
import { Chronicle } from "../src/chronicle.js";
import { openDb } from "../src/db.js";
import { DemoExecutor, startDemo } from "../src/demo.js";
import { EventStore } from "../src/eventStore.js";
import { FactoryBus } from "../src/factoryBus.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoleLibrary } from "../src/roleLibrary.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { TaskStore } from "../src/taskStore.js";
import { waitFor } from "./_waitFor.js";

/**
 * The demo factory.
 *
 * One property matters more than everything else here and it is negative: **a demo agent cannot
 * reach a real CLI**. The rest is about the demo being a picture of this product rather than a
 * picture of a product — it is built by the same managers an operator's clicks would use, so a
 * screenshot of it cannot show a factory this code could not actually produce.
 */

function harness() {
  const root = mkdtempSync(join(tmpdir(), "sf-demo-"));
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const projects = new ProjectManager(db, root);
  const rooms = new RoomManager(db, projects);
  const tasks = new TaskStore(db, projects);
  const chronicle = new Chronicle(db, projects);
  const accounts = new AccountManager(db);
  const roles = new RoleLibrary();
  const executor = new DemoExecutor();
  let sessions!: SessionManager;
  const bus = new FactoryBus({
    db, rooms, projects,
    deliver: (id, text) => sessions.prompt(id, text),
    roomAgents: (roomId) => sessions.roomAgents(roomId),
  });
  sessions = new SessionManager(db, store, executor, rooms, projects, {
    bus, tasks, chronicle, roles, providers: { codex: executor },
  });
  return {
    root, db, store, projects, rooms, tasks, chronicle, accounts, sessions, bus,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("the demo factory", () => {
  it("builds a floor with rooms, agents, a board and traffic", () => {
    const h = harness();
    try {
      const demo = startDemo({ ...h, root: h.root });
      try {
        const project = h.projects.list()[0]!;
        // Enough of a factory to look like one: the project room plus eight departments.
        expect(h.rooms.listRooms(project.id).length).toBeGreaterThanOrEqual(8);
        expect(h.sessions.listSessions(project.id).length).toBeGreaterThanOrEqual(10);
        expect(h.tasks.list(project.id).length).toBeGreaterThanOrEqual(8);
        expect(h.bus.list(project.id).length).toBeGreaterThan(0);

        // Every column of the board is represented, which is what makes it a board rather than a list.
        const statuses = new Set(h.tasks.list(project.id).map((t) => t.status));
        for (const status of ["open", "in_progress", "review", "done"]) {
          expect([...statuses]).toContain(status);
        }
        // Exactly one orchestrator, in the project room, as `ensure_orchestrator` would leave it.
        expect(h.sessions.listSessions(project.id).filter((s) => s.isOrchestrator)).toHaveLength(1);
      } finally {
        demo.stop();
      }
    } finally {
      h.cleanup();
    }
  });

  it("writes only inside the temp root it was given", () => {
    const h = harness();
    try {
      const demo = startDemo({ ...h, root: h.root });
      try {
        const project = h.projects.list()[0]!;
        // Room = folder, so the demo makes folders — all of them under its own root, never in a
        // repository of the operator's.
        for (const room of h.rooms.listRooms(project.id)) {
          expect(room.path.startsWith(h.root)).toBe(true);
          expect(existsSync(room.path)).toBe(true);
        }
        // And the ADRs it recorded are real files in that same throwaway project.
        const decisions = join(h.root, "docs", "decisions");
        expect(readdirSync(decisions).length).toBeGreaterThan(0);
        expect(readFileSync(join(h.root, "CLAUDE.md"), "utf8")).toMatch(/simulated/i);
      } finally {
        demo.stop();
      }
    } finally {
      h.cleanup();
    }
  });

  it("shows a floor that is already moving, and keeps moving", async () => {
    const h = harness();
    try {
      const demo = startDemo({ ...h, root: h.root });
      try {
        // The director stirs once immediately — a demo whose first five seconds are an idle factory
        // is a demo of nothing.
        await waitFor(() => {
          const working = h.sessions.listSessions().filter((s) => s.status === "working");
          if (working.length === 0) throw new Error("nobody is working yet");
        });
      } finally {
        demo.stop();
      }
    } finally {
      h.cleanup();
    }
  });

  it("holds one agent at a limit, so the paused state is on screen", async () => {
    const h = harness();
    try {
      const demo = startDemo({ ...h, root: h.root });
      try {
        await waitFor(() => {
          if (!h.sessions.listSessions().some((s) => s.state === "paused")) throw new Error("not yet");
        });
      } finally {
        demo.stop();
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("the demo executor", () => {
  it("says it is simulated before it does anything", () => {
    const events: { type: string; detail?: string }[] = [];
    new DemoExecutor().start(
      { cwd: tmpdir() },
      { onEvent: (e) => events.push(e as never), requestApproval: async () => "allow" },
    );
    // The first thing in every demo agent's own log. A screenshot of this must not be mistakable
    // for a claim about a real run — including by whoever took it.
    expect(events[0]).toMatchObject({ type: "session_status", status: "starting" });
    expect((events[0] as { detail: string }).detail).toMatch(/simulated/);
  });

  it("produces the same event shapes a real agent does, and a turn boundary", async () => {
    const events: { type: string }[] = [];
    const handle = new DemoExecutor().start(
      { cwd: tmpdir() },
      { onEvent: (e) => events.push(e as never), requestApproval: async () => "allow" },
    );
    handle.send("carry on with the card you are holding");

    await waitFor(() => {
      if (!events.some((e) => e.type === "turn_complete")) throw new Error("not yet");
    }, 8000);
    // Everything downstream — the console, the beacons, the bus flush, the chronicle — keys off
    // these, so a demo that produced a different shape would be a demo of a different product.
    const types = events.map((e) => e.type);
    expect(types).toContain("user_prompt");
    expect(types).toContain("tool_use");
    expect(types).toContain("tool_result");
    expect(types).toContain("agent_text");
    expect(types.at(-1)).toBe("session_status");
    await handle.stop();
  });

  it("waits on the operator when a turn asks for something gated", async () => {
    let asked: { toolName: string } | null = null;
    let release: (b: "allow" | "deny") => void = () => {};
    const events: { type: string }[] = [];
    const handle = new DemoExecutor().start(
      { cwd: tmpdir() },
      {
        onEvent: (e) => events.push(e as never),
        requestApproval: async (toolName) => {
          asked = { toolName };
          return await new Promise((resolve) => { release = resolve; });
        },
      },
    );
    handle.send("run the pending migration on payments");

    await waitFor(() => { if (asked === null) throw new Error("not yet"); });
    // The card is a real approval, not a picture of one: the turn does not finish until it is
    // answered, which is exactly what an attended agent does.
    expect(events.some((e) => e.type === "turn_complete")).toBe(false);
    release("allow");
    await waitFor(() => {
      if (!events.some((e) => e.type === "turn_complete")) throw new Error("not yet");
    });
    await handle.stop();
  });
});
