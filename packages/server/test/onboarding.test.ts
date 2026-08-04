import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { PROJECT_CHARTER_FILE } from "@superfabric/shared";
import { busToolDefinitions } from "../src/busTools.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { FakeExecutor } from "../src/executors/fake.js";
import { FactoryBus } from "../src/factoryBus.js";
import { ONBOARDING_ROLE_ID, OnboardingManager } from "../src/onboarding.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoleLibrary } from "../src/roleLibrary.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { SkillLibrary } from "../src/skills.js";
import { TaskStore } from "../src/taskStore.js";

/**
 * **First contact.**
 *
 * The four properties the design rests on, each with cases below:
 *
 * 1. **un-onboarded means no `CLAUDE.md` at the project root** — a file, not a heuristic over what is
 *    in the folder;
 * 2. the onboarder is an **ordinary session** with the onboarding role, in the project room, sent one
 *    turn to start the interview;
 * 3. `factory_suggest_rooms` **records and creates nothing** — no folder, no row in `rooms`;
 * 4. approving goes through **the ordinary `createRoom`**, so every invariant that path has still
 *    applies: a bad name is refused, an existing charter is never overwritten.
 */

/** The real shipped role library, so the tests exercise the file the product actually ships. */
const roles = new RoleLibrary();

function harness() {
  const root = mkdtempSync(join(tmpdir(), "sf-onboarding-"));
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const projects = new ProjectManager(db, root);
  const rooms = new RoomManager(db, projects);
  const tasks = new TaskStore(db, projects);
  let mgr!: SessionManager;
  const executor = new FakeExecutor();
  const bus = new FactoryBus({
    db, rooms, projects,
    deliver: (sessionId, text) => mgr.prompt(sessionId, text),
    roomAgents: (roomId) => mgr.roomAgents(roomId),
  });
  let onboarding!: OnboardingManager;
  mgr = new SessionManager(db, store, executor, rooms, projects, {
    bus, tasks, roles, skills: new SkillLibrary({ roots: [] }),
    get onboarding() { return onboarding; },
  });
  const changed: string[] = [];
  onboarding = new OnboardingManager({
    db, projects, rooms, sessions: mgr, onChange: (id) => changed.push(id),
  });
  const project = projects.defaultProject();

  return {
    root, db, store, projects, rooms, mgr, onboarding, project, changed, executor,
    /** The turns this project's onboarding agent has actually been sent. */
    promptsTo: (sessionId: string) => store.listAfter(sessionId, 0)
      .map((e) => e.event)
      .filter((e): e is Extract<typeof e, { type: "user_prompt" }> => e.type === "user_prompt")
      .map((e) => e.text),
    cleanup: () => { rmSync(root, { recursive: true, force: true }); },
  };
}

function withHarness(fn: (h: ReturnType<typeof harness>) => void | Promise<void>): Promise<void> {
  const h = harness();
  return Promise.resolve(fn(h)).finally(() => { h.cleanup(); });
}

/** The tool set an onboarding session's room would hand the SDK. */
function toolsFor(h: ReturnType<typeof harness>, opts: { isOnboarder: boolean }): SdkMcpToolDefinition<any>[] {
  const projectRoom = h.rooms.ensureProjectRoom(h.project.id);
  return busToolDefinitions({
    bus: new FactoryBus({
      db: h.db, rooms: h.rooms, projects: h.projects,
      deliver: () => {}, roomAgents: () => [],
    }),
    tasks: new TaskStore(h.db, h.projects),
    rooms: h.rooms,
    roomId: projectRoom.id,
    reportStatus: () => {},
    onboarding: h.onboarding,
    isOnboarder: opts.isOnboarder,
  });
}

describe("detecting an un-onboarded project", () => {
  it("is by the presence of CLAUDE.md at the root, and by nothing else", async () => {
    await withHarness((h) => {
      // A folder that is far from empty, and still has nobody's word for what it is.
      writeFileSync(join(h.root, "package.json"), "{}");
      mkdirSync(join(h.root, "src"), { recursive: true });
      writeFileSync(join(h.root, "src", "index.ts"), "export {};");
      writeFileSync(join(h.root, "README.md"), "# something");
      expect(h.onboarding.isOnboarded(h.project.id)).toBe(false);
      expect(h.onboarding.state(h.project.id).onboarded).toBe(false);

      // And the one file that settles it. This is what the interview writes.
      writeFileSync(join(h.root, PROJECT_CHARTER_FILE), "# a project\n");
      expect(h.onboarding.isOnboarded(h.project.id)).toBe(true);
      expect(h.onboarding.state(h.project.id).onboarded).toBe(true);
    });
  });

  it("an empty folder with a CLAUDE.md is onboarded; a full one without is not", async () => {
    await withHarness((h) => {
      writeFileSync(join(h.root, PROJECT_CHARTER_FILE), "# written by hand\n");
      // Nothing else at all — no heuristic about "looks empty" gets a say.
      expect(h.onboarding.isOnboarded(h.project.id)).toBe(true);
    });
  });
});

describe("starting the interview", () => {
  it("is an ordinary session with the onboarding role, in the project room, given one turn", async () => {
    await withHarness(async (h) => {
      const { sessionId, created } = h.onboarding.start(h.project.id);
      await h.executor.settle();
      expect(created).toBe(true);

      const session = h.mgr.listSessions(h.project.id).find((s) => s.id === sessionId)!;
      // A role, not a new kind of agent: no flag, no parallel runtime, same event log.
      expect(session.roleId).toBe(ONBOARDING_ROLE_ID);
      expect(session.isOrchestrator).toBe(false);
      expect(session.roomId).toBe(h.rooms.ensureProjectRoom(h.project.id).id);

      // And it has been told to begin — an agent nobody prompted says nothing at all.
      const prompts = h.promptsTo(sessionId);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(h.root);
      expect(prompts[0]).toMatch(/one question only/i);
    });
  });

  it("is idempotent: a second click hands back the interview already running", async () => {
    await withHarness(async (h) => {
      const first = h.onboarding.start(h.project.id);
      const second = h.onboarding.start(h.project.id);
      await h.executor.settle();
      expect(second).toEqual({ sessionId: first.sessionId, created: false });
      expect(h.mgr.listSessions(h.project.id)).toHaveLength(1);
      // And it is not prompted twice — the second click must not restart the interview.
      expect(h.promptsTo(first.sessionId)).toHaveLength(1);
    });
  });

  it("the onboarding role's charter actually reaches the agent", async () => {
    await withHarness((h) => {
      const { sessionId } = h.onboarding.start(h.project.id);
      // Proved through the role library the server really ships, so a preset edited into
      // uselessness would fail here rather than in production.
      const role = roles.get(ONBOARDING_ROLE_ID)!;
      expect(role.promptAppend).toMatch(/one question per turn/i);
      expect(h.mgr.listSessions(h.project.id).find((s) => s.id === sessionId)!.roleId)
        .toBe(ONBOARDING_ROLE_ID);
    });
  });
});

describe("the suggest-rooms tool", () => {
  it("belongs to the onboarding session and to nobody else", async () => {
    await withHarness((h) => {
      const plain = toolsFor(h, { isOnboarder: false }).map((d) => d.name);
      expect(plain).not.toContain("factory_suggest_rooms");
      const onboarder = toolsFor(h, { isOnboarder: true }).map((d) => d.name);
      expect(onboarder).toContain("factory_suggest_rooms");
    });
  });

  it("records suggestions and creates no folders and no rooms", async () => {
    await withHarness(async (h) => {
      const def = toolsFor(h, { isOnboarder: true }).find((d) => d.name === "factory_suggest_rooms")!;
      const res = await def.handler({
        rooms: [
          { name: "api", charter: "The HTTP surface and its request handling." },
          { name: "web", charter: "The browser app." },
        ],
      } as never, {} as never);
      expect(res.isError).not.toBe(true);
      const text = (res.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
      // The reply says out loud that nothing happened, because an agent that believes it has
      // reorganised the repository will act as though those folders exist.
      expect(text).toMatch(/nothing has been created/i);

      // The floor is untouched: the project room and nothing else.
      expect(h.rooms.listRooms(h.project.id).map((r) => r.kind)).toEqual(["project"]);
      expect(existsSync(join(h.root, "api"))).toBe(false);
      expect(existsSync(join(h.root, "web"))).toBe(false);

      // And the proposal is on the record, waiting for a person.
      const state = h.onboarding.state(h.project.id);
      expect(state.suggestions.map((s) => s.name)).toEqual(["api", "web"]);
      expect(state.suggestions.every((s) => s.status === "proposed")).toBe(true);
    });
  });

  it("a second call revises an outstanding proposal rather than duplicating it", async () => {
    await withHarness((h) => {
      h.onboarding.suggest(h.project.id, null, [{ name: "api", charter: "first thought" }]);
      h.onboarding.suggest(h.project.id, null, [
        { name: "api", charter: "second thought" },
        { name: "docs", charter: "The manual." },
      ]);
      const suggestions = h.onboarding.state(h.project.id).suggestions;
      expect(suggestions.map((s) => s.name)).toEqual(["api", "docs"]);
      expect(suggestions[0]!.charter).toBe("second thought");
    });
  });
});

describe("accepting a proposal", () => {
  it("creates the rooms through the ordinary createRoom, one-line charter and all", async () => {
    await withHarness((h) => {
      const [api, web] = h.onboarding.suggest(h.project.id, null, [
        { name: "api", charter: "The HTTP surface and its request handling." },
        { name: "web", charter: "The browser app." },
      ]);
      const result = h.onboarding.accept(h.project.id, [{ id: api!.id }, { id: web!.id }]);
      expect(result.failed).toEqual([]);
      expect(result.created.map((r) => r.name)).toEqual(["api", "web"]);

      // Rooms are folders. Both invariants of that path are visible here: the folder is under the
      // project root, and its charter is the template with the proposed line in it.
      const charter = readFileSync(join(h.root, "api", PROJECT_CHARTER_FILE), "utf8");
      expect(charter).toContain("# api");
      expect(charter).toContain("The HTTP surface and its request handling.");
      // The factory-bus section a room's charter always carries is still there.
      expect(charter).toContain("mcp__factory__factory_send");

      expect(h.rooms.listRooms(h.project.id).filter((r) => r.kind === "room").map((r) => r.name))
        .toEqual(["api", "web"]);
      expect(h.onboarding.state(h.project.id).suggestions.every((s) => s.status === "accepted"))
        .toBe(true);
    });
  });

  it("uses the operator's edits, because a proposal is something to correct", async () => {
    await withHarness((h) => {
      const [only] = h.onboarding.suggest(h.project.id, null, [
        { name: "backend-service", charter: "Everything not the UI." },
      ]);
      h.onboarding.accept(h.project.id, [
        { id: only!.id, name: "api", charter: "The service the app talks to." },
      ]);
      expect(h.rooms.listRooms(h.project.id).map((r) => r.name)).toContain("api");
      expect(existsSync(join(h.root, "backend-service"))).toBe(false);
      expect(readFileSync(join(h.root, "api", PROJECT_CHARTER_FILE), "utf8"))
        .toContain("The service the app talks to.");
    });
  });

  it("never overwrites a charter that is already there", async () => {
    await withHarness((h) => {
      mkdirSync(join(h.root, "api"), { recursive: true });
      writeFileSync(join(h.root, "api", PROJECT_CHARTER_FILE), "# the operator's own\n");
      const [only] = h.onboarding.suggest(h.project.id, null, [
        { name: "api", charter: "An agent's idea of what this is." },
      ]);
      h.onboarding.accept(h.project.id, [{ id: only!.id }]);
      expect(readFileSync(join(h.root, "api", PROJECT_CHARTER_FILE), "utf8"))
        .toBe("# the operator's own\n");
    });
  });

  it("one refused name does not sink the rest, and says why against that suggestion", async () => {
    await withHarness((h) => {
      h.rooms.createRoom("api");
      const [dup, fresh] = h.onboarding.suggest(h.project.id, null, [
        { name: "api", charter: "A room that already exists." },
        { name: "docs", charter: "The manual." },
      ]);
      const result = h.onboarding.accept(h.project.id, [{ id: dup!.id }, { id: fresh!.id }]);
      expect(result.created.map((r) => r.name)).toEqual(["docs"]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.message).toMatch(/already exists/);

      // The one that failed is still *offered*, with the reason attached, so the operator can rename
      // it and try again rather than watching a room silently not appear.
      const suggestions = h.onboarding.state(h.project.id).suggestions;
      expect(suggestions.find((s) => s.id === dup!.id)!.status).toBe("proposed");
      expect(suggestions.find((s) => s.id === dup!.id)!.note).toMatch(/already exists/);
      expect(suggestions.find((s) => s.id === fresh!.id)!.status).toBe("accepted");
    });
  });

  it("refuses a name that would escape the project root — createRoom's own rule, unchanged", async () => {
    await withHarness((h) => {
      // The tool's schema is a `RoomName`, so this can only arrive from a hand-edited row or a
      // client's "edit" — which is exactly why the second layer exists.
      const [only] = h.onboarding.suggest(h.project.id, null, [{ name: "api", charter: "x" }]);
      const result = h.onboarding.accept(h.project.id, [{ id: only!.id, name: "../escape" }]);
      expect(result.created).toEqual([]);
      expect(result.failed[0]!.message).toMatch(/outside the project root|invalid room name/);
      expect(existsSync(join(h.root, "..", "escape"))).toBe(false);
    });
  });

  it("dismissing takes it off the list and creates nothing", async () => {
    await withHarness((h) => {
      const [only] = h.onboarding.suggest(h.project.id, null, [{ name: "docs", charter: "x" }]);
      h.onboarding.dismiss(h.project.id, only!.id);
      expect(h.onboarding.state(h.project.id).suggestions[0]!.status).toBe("dismissed");
      expect(existsSync(join(h.root, "docs"))).toBe(false);
      // A dismissed proposal is settled: accepting it afterwards does nothing.
      expect(h.onboarding.accept(h.project.id, [{ id: only!.id }]))
        .toEqual({ created: [], failed: [] });
    });
  });

  it("refuses a suggestion belonging to another factory", async () => {
    await withHarness((h) => {
      const otherRoot = mkdtempSync(join(tmpdir(), "sf-onboarding-other-"));
      try {
        const other = h.projects.create({ root: otherRoot });
        const [theirs] = h.onboarding.suggest(other.id, null, [{ name: "api", charter: "x" }]);
        expect(() => h.onboarding.accept(h.project.id, [{ id: theirs!.id }]))
          .toThrow(/another project/);
        expect(() => h.onboarding.dismiss(h.project.id, theirs!.id)).toThrow(/another project/);
        expect(existsSync(join(h.root, "api"))).toBe(false);
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    });
  });
});
