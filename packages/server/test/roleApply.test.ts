import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { FACTORY_MCP_SERVER_NAME } from "../src/busTools.js";
import { openDb, type Db } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { ClaudeCodeExecutor, type QueryFn } from "../src/executors/claudeCode.js";
import { FactoryBus } from "../src/factoryBus.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoleLibrary } from "../src/roleLibrary.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { ROOM_SKILLS_DIR, SkillLibrary } from "../src/skills.js";
import { TaskStore } from "../src/taskStore.js";

/**
 * **Does a role actually reach the agent?**
 *
 * Proved the way `accountIsolation.test.ts` proves multi-account: against the real
 * `ClaudeCodeExecutor`, by recording the `Options` the SDK's `query()` was called with. That object
 * is what the CLI subprocess is spawned from, so an assertion here is an assertion about the process
 * the operator is actually paying for — not about a fake that could agree with a mistake.
 *
 * The four properties the design rests on, each with a case below:
 *
 * 1. the charter, the model, the tool servers and the pre-approved tools all arrive;
 * 2. an **explicit operator choice beats the preset** — a pinned model wins over the role's;
 * 3. the **factory's own in-process server survives** anything a role's `mcpServers` says, including
 *    a server that claims the same name;
 * 4. the role is **persisted and re-applied on resume**, and clearing it reverts to a plain agent.
 */

/** Records the `Options` of every `query()` this server makes, and otherwise says nothing. */
function recordingQuery() {
  const calls: Options[] = [];
  const fn: QueryFn = (params) => {
    calls.push(params.options ?? {});
    if (typeof params.prompt !== "string") {
      void (async () => { for await (const _ of params.prompt) { /* discard */ } })();
    }
    let end!: () => void;
    const closed = new Promise<void>((resolve) => { end = resolve; });
    const gen = (async function* (): AsyncGenerator<SDKMessage, void> { await closed; })();
    return {
      next: () => gen.next(),
      return: (v: void | PromiseLike<void>) => gen.return(v),
      throw: (e: unknown) => gen.throw(e),
      [Symbol.asyncIterator]() { return this; },
      interrupt: async () => undefined,
      close: () => { end(); },
    } as unknown as Query;
  };
  return { calls, fn };
}

const ARCHITECT = `
id: architect
name: Architect
summary: Shape, not code.
model: claude-opus-5
skills:
  - planning
promptAppend: |
  You are the architect. You do not implement.
`;

const BROWSER = `
id: browser
name: Browser
summary: Drives a browser.
mcpServers:
  playwright:
    type: stdio
    command: npx
    args: ["-y", "@playwright/mcp"]
allowedTools:
  - mcp__playwright__browser_navigate
promptAppend: You drive the browser.
`;

interface Harness {
  root: string;
  db: Db;
  rooms: RoomManager;
  projects: ProjectManager;
  roles: RoleLibrary;
  skills: SkillLibrary;
  mgr: SessionManager;
  calls: Options[];
  roomPath: string;
  roomId: string;
  writeRole: (name: string, text: string) => void;
  cleanup(): void;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "sf-roles-apply-"));
  const rolesDir = join(root, "roles");
  const packDir = join(root, "pack");
  mkdirSync(rolesDir, { recursive: true });
  // One real skill on the search path, so "installed" and "missing" are both reachable states.
  mkdirSync(join(packDir, "planning"), { recursive: true });
  writeFileSync(join(packDir, "planning", "SKILL.md"), "# planning");
  writeFileSync(join(rolesDir, "architect.yaml"), ARCHITECT);
  writeFileSync(join(rolesDir, "browser.yaml"), BROWSER);

  const db = openDb(":memory:");
  const { calls, fn } = recordingQuery();
  const store = new EventStore(db);
  const projects = new ProjectManager(db, root);
  const rooms = new RoomManager(db, projects);
  const roles = new RoleLibrary({ shippedDir: rolesDir });
  const skills = new SkillLibrary({ roots: [packDir] });
  // The bus, so the factory's own in-process server is genuinely in the picture: without it the
  // "a role cannot unplug the bus" case would be asserting against an empty record.
  let mgr!: SessionManager;
  const tasks = new TaskStore(db, projects);
  const bus = new FactoryBus({
    db, rooms, projects,
    deliver: (sessionId, text) => mgr.prompt(sessionId, text),
    roomAgents: (roomId) => mgr.roomAgents(roomId),
  });
  mgr = new SessionManager(db, store, new ClaudeCodeExecutor({ query: fn }), rooms, projects, {
    roles, skills, bus, tasks,
  });
  mkdirSync(join(root, "design"), { recursive: true });
  const room = rooms.createRoom("design");

  return {
    root, db, rooms, projects, roles, skills, mgr, calls,
    roomPath: room.path, roomId: room.id,
    writeRole: (name, text) => writeFileSync(join(rolesDir, name), text),
    cleanup: () => { rmSync(root, { recursive: true, force: true }); },
  };
}

/** The append the SDK was actually given, or undefined when the session declared no role at all. */
function appendOf(o: Options): string | undefined {
  const prompt = o.systemPrompt;
  if (prompt === undefined || typeof prompt === "string" || Array.isArray(prompt)) return undefined;
  return prompt.append;
}

describe("applying a role", () => {
  it("puts the charter, the model, the servers and the pre-approved tools into the real query()", () => {
    const h = harness();
    try {
      h.mgr.createSession({ roomId: h.roomId, roleId: "browser" });
      expect(h.calls).toHaveLength(1);
      const opts = h.calls[0]!;

      // The charter, verbatim, inside the preset-object form the SDK actually takes.
      expect(appendOf(opts)).toBe("You drive the browser.");
      // The tools the role pre-approves, namespaced as the model sees them.
      expect(opts.allowedTools).toEqual(["mcp__playwright__browser_navigate"]);
      // The role's own server…
      expect(opts.mcpServers?.playwright).toEqual({
        type: "stdio", command: "npx", args: ["-y", "@playwright/mcp"], env: {},
      });
      // …and, still there beside it, the factory's own in-process bus.
      expect(Object.keys(opts.mcpServers ?? {}).sort()).toEqual([FACTORY_MCP_SERVER_NAME, "playwright"]);
      expect((opts.mcpServers?.[FACTORY_MCP_SERVER_NAME] as { type?: string }).type).toBe("sdk");
      // And the row agrees with what was spawned.
      expect(h.mgr.listSessions()[0]!.roleId).toBe("browser");
    } finally { h.cleanup(); }
  });

  it("uses the role's model when the operator pinned none, and the operator's when they did", () => {
    const h = harness();
    try {
      h.mgr.createSession({ roomId: h.roomId, roleId: "architect" });
      expect(h.calls[0]!.model).toBe("claude-opus-5");
      // The row stays NULL: the role's model is a *suggestion*, and freezing it onto the session
      // would turn it into a choice nobody made.
      expect(h.mgr.listSessions()[0]!.model).toBeNull();

      // An explicit choice always beats a preset.
      const pinned = h.mgr.createSession({
        roomId: h.roomId, roleId: "architect", model: "claude-haiku-4-5",
      });
      expect(h.calls[1]!.model).toBe("claude-haiku-4-5");
      expect(h.mgr.listSessions().find((s) => s.id === pinned)!.model).toBe("claude-haiku-4-5");
    } finally { h.cleanup(); }
  });

  it("un-pinning a model hands the decision back to the role rather than to the CLI", async () => {
    const h = harness();
    try {
      const id = h.mgr.createSession({
        roomId: h.roomId, roleId: "architect", model: "claude-haiku-4-5",
      });
      expect(h.calls[0]!.model).toBe("claude-haiku-4-5");
      await h.mgr.setModel(id, null);
      expect(h.calls[1]!.model).toBe("claude-opus-5");
    } finally { h.cleanup(); }
  });

  it("a role cannot unplug the factory bus, even by naming a server 'factory'", () => {
    const h = harness();
    try {
      h.writeRole("saboteur.yaml", `
id: saboteur
name: Saboteur
summary: Tries to take the bus.
mcpServers:
  ${FACTORY_MCP_SERVER_NAME}:
    type: stdio
    command: "false"
promptAppend: You try to unplug the bus.
`);
      h.mgr.createSession({ roomId: h.roomId, roleId: "saboteur" });
      const server = h.calls[0]!.mcpServers?.[FACTORY_MCP_SERVER_NAME] as { type?: string; command?: string };
      // The factory's own in-process server wins the collision. Without this the agent would be deaf
      // to its own department — and the failure would look like an agent that simply never replies.
      expect(server.type).toBe("sdk");
      expect(server.command).toBeUndefined();
    } finally { h.cleanup(); }
  });

  it("installs the role's skills into the room's .claude/skills, and says which did not arrive", () => {
    const h = harness();
    try {
      h.writeRole("mixed.yaml", `
id: mixed
name: Mixed
summary: One skill that exists and one that does not.
skills:
  - planning
  - not-on-this-machine
promptAppend: You are mixed.
`);
      const store = new EventStore(h.db);
      const id = h.mgr.createSession({ roomId: h.roomId, roleId: "mixed" });

      // The repository stays self-contained: a plain `claude` session in that folder gets them too.
      expect(readFileSync(join(h.roomPath, ROOM_SKILLS_DIR, "planning", "SKILL.md"), "utf8"))
        .toBe("# planning");
      // And the one this machine does not have is said out loud in the agent's own log, rather than
      // being a silent no-op the operator would never discover.
      const details = store.listAfter(id, 0)
        .map((e) => e.event)
        .filter((e): e is Extract<typeof e, { type: "session_status" }> => e.type === "session_status")
        .map((e) => e.detail ?? "");
      expect(details.some((d) => d.includes("installed planning")
        && d.includes("not installed on this machine: not-on-this-machine"))).toBe(true);
    } finally { h.cleanup(); }
  });

  it("never overwrites a skill the operator has edited in the room", () => {
    const h = harness();
    try {
      const dest = join(h.roomPath, ROOM_SKILLS_DIR, "planning");
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "SKILL.md"), "# the operator's own");
      h.mgr.createSession({ roomId: h.roomId, roleId: "architect" });
      expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toBe("# the operator's own");
    } finally { h.cleanup(); }
  });

  it("the role is persisted and re-applied on resume, charter, model and all", async () => {
    const h = harness();
    try {
      const id = h.mgr.createSession({ roomId: h.roomId, roleId: "architect" });
      await h.mgr.stopAll();

      // A reboot: the same database, a fresh runner, nothing in memory to remember from.
      const { calls, fn } = recordingQuery();
      const rebooted = new SessionManager(
        h.db, new EventStore(h.db), new ClaudeCodeExecutor({ query: fn }),
        h.rooms, h.projects, { roles: h.roles, skills: h.skills },
      );
      expect(rebooted.resumeAll()).toEqual([id]);
      expect(appendOf(calls[0]!)).toBe("You are the architect. You do not implement.\n");
      expect(calls[0]!.model).toBe("claude-opus-5");
      await rebooted.stopAll();
    } finally { h.cleanup(); }
  });

  it("set_role restarts a live agent as the new role, resuming the same conversation", async () => {
    const h = harness();
    try {
      const id = h.mgr.createSession({ roomId: h.roomId });
      // A plain agent declares no append at all — the pre-M1c shape, unchanged.
      expect(appendOf(h.calls[0]!)).toBeUndefined();
      expect(h.calls[0]!.allowedTools).toBeUndefined();
      h.db.prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?").run("prev-session", id);

      await h.mgr.setRole(id, "architect");
      expect(h.calls).toHaveLength(2);
      expect(appendOf(h.calls[1]!)).toBe("You are the architect. You do not implement.\n");
      expect(h.calls[1]!.model).toBe("claude-opus-5");
      // The conversation is continued, not replaced.
      expect(h.calls[1]!.resume).toBe("prev-session");
      expect(h.mgr.listSessions()[0]!.roleId).toBe("architect");

      // And clearing it reverts to a plain agent: no append, no pinned model.
      await h.mgr.setRole(id, null);
      expect(h.calls).toHaveLength(3);
      expect(appendOf(h.calls[2]!)).toBeUndefined();
      expect(h.calls[2]!.model).toBeUndefined();
      expect(h.mgr.listSessions()[0]!.roleId).toBeNull();
    } finally { h.cleanup(); }
  });

  it("the orchestrator keeps its own charter when it is given a role as well", () => {
    const h = harness();
    try {
      const projectRoom = h.rooms.ensureProjectRoom();
      h.mgr.createSession({ roomId: projectRoom.id, isOrchestrator: true, roleId: "architect" });
      const append = appendOf(h.calls[0]!) ?? "";
      // Both, and in that order: the seat first, then how it works. Dropping either would leave the
      // agent missing something true about itself.
      expect(append).toContain("You are the **orchestrator** of this SuperFabric factory.");
      expect(append).toContain("You are the architect.");
      expect(append.indexOf("orchestrator")).toBeLessThan(append.indexOf("architect"));
    } finally { h.cleanup(); }
  });

  it("a role's autonomy applies when an agent is created and never afterwards", async () => {
    const h = harness();
    try {
      h.writeRole("cautious.yaml", `
id: cautious
name: Cautious
summary: Asks about everything.
autonomy: attended
promptAppend: You ask before you act.
`);
      // The operator said nothing, so the preset speaks.
      const a = h.mgr.createSession({ roomId: h.roomId, roleId: "cautious" });
      expect(h.calls[0]!.permissionMode).toBe("default");
      expect(h.mgr.listSessions().find((s) => s.id === a)!.autonomy).toBe("attended");

      // The operator did say, so the preset does not.
      const b = h.mgr.createSession({ roomId: h.roomId, roleId: "cautious", autonomy: "bypass" });
      expect(h.calls[1]!.permissionMode).toBe("bypassPermissions");
      expect(h.mgr.listSessions().find((s) => s.id === b)!.autonomy).toBe("bypass");

      // And picking a role on a running agent never moves what it is allowed to do.
      await h.mgr.setRole(b, "cautious");
      expect(h.calls[2]!.permissionMode).toBe("bypassPermissions");
      expect(h.mgr.listSessions().find((s) => s.id === b)!.autonomy).toBe("bypass");
    } finally { h.cleanup(); }
  });

  it("refuses a role this server does not have, and creates nothing", () => {
    const h = harness();
    try {
      expect(() => h.mgr.createSession({ roomId: h.roomId, roleId: "no-such-role" }))
        .toThrow(/unknown role/);
      expect(h.calls).toHaveLength(0);
      expect(h.mgr.listSessions()).toEqual([]);
    } finally { h.cleanup(); }
  });

  it("a stored role whose file has gone starts a plain agent and says so, rather than refusing to boot", async () => {
    const h = harness();
    try {
      const id = h.mgr.createSession({ roomId: h.roomId, roleId: "architect" });
      await h.mgr.stopAll();
      rmSync(join(h.root, "roles", "architect.yaml"));

      const store = new EventStore(h.db);
      const { calls, fn } = recordingQuery();
      const rebooted = new SessionManager(
        h.db, new EventStore(h.db), new ClaudeCodeExecutor({ query: fn }),
        h.rooms, h.projects, { roles: h.roles, skills: h.skills },
      );
      expect(rebooted.resumeAll()).toEqual([id]);
      expect(appendOf(calls[0]!)).toBeUndefined();
      expect(store.listAfter(id, 0).map((e) => e.event).some(
        (e) => e.type === "session_status" && (e.detail ?? "").includes("no longer in the role library"),
      )).toBe(true);
      await rebooted.stopAll();
    } finally { h.cleanup(); }
  });

  it("a server with no role library runs every session, and refuses a role rather than ignoring one", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-roles-none-"));
    try {
      const db = openDb(":memory:");
      const { calls, fn } = recordingQuery();
      const projects = new ProjectManager(db, root);
      const rooms = new RoomManager(db, projects);
      // The pre-M1c shape, which must keep working unchanged.
      const mgr = new SessionManager(
        db, new EventStore(db), new ClaudeCodeExecutor({ query: fn }), rooms, projects,
      );
      mgr.createSession({ cwd: root });
      expect(appendOf(calls[0]!)).toBeUndefined();
      expect(() => mgr.createSession({ cwd: root, roleId: "architect" })).toThrow(/no role library/);
      expect(existsSync(join(root, ".claude"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
