import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AccountManager } from "../src/accountManager.js";
import { openDb, type Db } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { ClaudeCodeExecutor, type QueryFn } from "../src/executors/claudeCode.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { waitFor } from "./_waitFor.js";

/**
 * The multi-account acceptance property, proved end to end through the real `ClaudeCodeExecutor`
 * rather than against a fake that could agree with a mistake.
 *
 * The question these answer is the one M2 exists for: **do two agents of one server genuinely run on
 * two different subscriptions?** The evidence is the `Options` the SDK's `query()` was actually
 * called with — the same object the CLI subprocess is spawned from — so an assertion here is an
 * assertion about the environment the provider process really got.
 *
 * The second half of every case matters as much as the first: `Options.env` **replaces** the
 * subprocess environment rather than merging into it, so a `CLAUDE_CONFIG_DIR` set without spreading
 * `process.env` first would isolate the accounts perfectly and leave the CLI unable to find its own
 * binary. PATH and HOME are checked every time for that reason.
 */

/**
 * Records the `Options` of every `query()` this server makes, and otherwise says nothing.
 *
 * The stream never yields — these cases are about how a session is *started*, not about what it then
 * says — but it does end on `close()`, which is what the real SDK does and what `stop()` waits for. A
 * stub that ignored `close()` would make every restart in here time out rather than fail, which is a
 * much worse way to learn about a bug.
 */
function recordingQuery() {
  const calls: Options[] = [];
  const fn: QueryFn = (params) => {
    calls.push(params.options ?? {});
    // Drain the prompt so the executor's queue is not left with a dangling consumer.
    if (typeof params.prompt !== "string") {
      void (async () => { for await (const _ of params.prompt) { /* discard */ } })();
    }
    let end!: () => void;
    const closed = new Promise<void>((resolve) => { end = resolve; });
    const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
      await closed;
    })();
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

interface Harness {
  root: string;
  db: Db;
  accounts: AccountManager;
  rooms: RoomManager;
  projects: ProjectManager;
  mgr: SessionManager;
  calls: Options[];
  cleanup(): void;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "sf-isolation-"));
  const db = openDb(":memory:");
  const { calls, fn } = recordingQuery();
  const store = new EventStore(db);
  const projects = new ProjectManager(db, root);
  const rooms = new RoomManager(db, projects);
  const accounts = new AccountManager(db);
  const mgr = new SessionManager(
    db, store, new ClaudeCodeExecutor({ query: fn }), rooms, projects, { accounts },
  );
  return {
    root, db, accounts, rooms, projects, mgr, calls,
    cleanup: () => { rmSync(root, { recursive: true, force: true }); },
  };
}

/** The `CLAUDE_CONFIG_DIR` the Nth `query()` of this server was actually given. */
const configDirOfCall = (o: Options): string | undefined => o.env?.CLAUDE_CONFIG_DIR;

describe("account isolation", () => {
  it("two agents on two accounts get two different CLAUDE_CONFIG_DIRs, with PATH and HOME intact", () => {
    const h = harness();
    try {
      const alpha = h.accounts.create({ label: "Alpha", configDir: join(h.root, "cfg-alpha") });
      const beta = h.accounts.create({ label: "Beta", configDir: join(h.root, "cfg-beta") });

      mkdirSync(join(h.root, "backend"), { recursive: true });
      mkdirSync(join(h.root, "frontend"), { recursive: true });
      const backend = h.rooms.createRoom("backend");
      const frontend = h.rooms.createRoom("frontend");
      // One room defaults to each account — the shape the product actually ships.
      h.rooms.setAccount(backend.id, alpha.id);
      h.rooms.setAccount(frontend.id, beta.id);

      const a = h.mgr.createSession({ roomId: backend.id });
      const b = h.mgr.createSession({ roomId: frontend.id });

      expect(h.calls).toHaveLength(2);
      const [optsA, optsB] = h.calls as [Options, Options];

      // Each got its own directory…
      expect(configDirOfCall(optsA)).toBe(alpha.configDir);
      expect(configDirOfCall(optsB)).toBe(beta.configDir);
      // …and they are genuinely two directories, not one name written twice.
      expect(configDirOfCall(optsA)).not.toBe(configDirOfCall(optsB));

      // The environment is otherwise the server's own: `Options.env` replaces rather than merges, so
      // a CLI missing PATH could not even be spawned and one missing HOME would look elsewhere for
      // everything it is not being told about.
      for (const o of [optsA, optsB]) {
        expect(o.env?.PATH).toBe(process.env.PATH);
        expect(o.env?.HOME).toBe(process.env.HOME);
      }

      // And the rows agree with what was actually spawned.
      const sessions = h.mgr.listSessions();
      expect(sessions.find((s) => s.id === a)!.accountId).toBe(alpha.id);
      expect(sessions.find((s) => s.id === b)!.accountId).toBe(beta.id);
    } finally {
      h.cleanup();
    }
  });

  it("a session with no account touches env at all — the ambient ~/.claude, unchanged", () => {
    const h = harness();
    try {
      h.mgr.createSession({ cwd: h.root });
      expect(h.calls).toHaveLength(1);
      // Not "env with no CLAUDE_CONFIG_DIR": no env override whatsoever, so the subprocess inherits
      // the server's environment exactly as it did before M2 existed.
      expect(h.calls[0]!.env).toBeUndefined();
      expect(h.mgr.listSessions()[0]!.accountId).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("an agent's own account beats its room's default", () => {
    const h = harness();
    try {
      const alpha = h.accounts.create({ label: "Alpha", configDir: join(h.root, "cfg-alpha") });
      const beta = h.accounts.create({ label: "Beta", configDir: join(h.root, "cfg-beta") });
      mkdirSync(join(h.root, "backend"), { recursive: true });
      const backend = h.rooms.createRoom("backend");
      h.rooms.setAccount(backend.id, alpha.id);

      h.mgr.createSession({ roomId: backend.id, accountId: beta.id });
      expect(configDirOfCall(h.calls[0]!)).toBe(beta.configDir);
    } finally {
      h.cleanup();
    }
  });

  it("refuses an account this server does not have, instead of silently using the operator's own", () => {
    const h = harness();
    try {
      // The worst available failure here would be a quiet fallback: the agent would run, and it would
      // run on the wrong subscription with nothing on screen to say so.
      expect(() => h.mgr.createSession({ cwd: h.root, accountId: "no-such-account" }))
        .toThrow(/unknown account/);
      expect(h.calls).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it("the account is persisted and re-applied on resume", async () => {
    const h = harness();
    try {
      const alpha = h.accounts.create({ label: "Alpha", configDir: join(h.root, "cfg-alpha") });
      mkdirSync(join(h.root, "backend"), { recursive: true });
      const backend = h.rooms.createRoom("backend");
      h.rooms.setAccount(backend.id, alpha.id);
      const id = h.mgr.createSession({ roomId: backend.id });
      await h.mgr.stopAll();

      // A reboot: the same database, a fresh runner, and nothing in memory to remember from.
      const { calls, fn } = recordingQuery();
      const rebooted = new SessionManager(
        h.db, new EventStore(h.db), new ClaudeCodeExecutor({ query: fn }),
        h.rooms, h.projects, { accounts: h.accounts },
      );
      expect(rebooted.resumeAll()).toEqual([id]);
      expect(calls).toHaveLength(1);
      expect(configDirOfCall(calls[0]!)).toBe(alpha.configDir);
      expect(calls[0]!.env?.PATH).toBe(process.env.PATH);

      // And the room's default changing later must not retroactively move an agent that is running.
      const beta = h.accounts.create({ label: "Beta", configDir: join(h.root, "cfg-beta") });
      h.rooms.setAccount(backend.id, beta.id);
      await rebooted.stopAll();
      const second = recordingQuery();
      const again = new SessionManager(
        h.db, new EventStore(h.db), new ClaudeCodeExecutor({ query: second.fn }),
        h.rooms, h.projects, { accounts: h.accounts },
      );
      again.resumeAll();
      expect(configDirOfCall(second.calls[0]!)).toBe(alpha.configDir);
    } finally {
      h.cleanup();
    }
  });

  it("setAccount restarts a live agent onto the other account, resuming the same conversation", async () => {
    const h = harness();
    try {
      const alpha = h.accounts.create({ label: "Alpha", configDir: join(h.root, "cfg-alpha") });
      const beta = h.accounts.create({ label: "Beta", configDir: join(h.root, "cfg-beta") });
      const id = h.mgr.createSession({ cwd: h.root, accountId: alpha.id });
      expect(configDirOfCall(h.calls[0]!)).toBe(alpha.configDir);

      // A provider session id, so the restart has something to resume from.
      h.db.prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?").run("prev-session", id);

      await h.mgr.setAccount(id, beta.id);
      expect(h.calls).toHaveLength(2);
      expect(configDirOfCall(h.calls[1]!)).toBe(beta.configDir);
      expect(h.calls[1]!.resume).toBe("prev-session");
      expect(h.mgr.listSessions()[0]!.accountId).toBe(beta.id);

      // Back to none: the ambient ~/.claude, and no env override at all.
      await h.mgr.setAccount(id, null);
      expect(h.calls).toHaveLength(3);
      expect(h.calls[2]!.env).toBeUndefined();
      expect(h.mgr.listSessions()[0]!.accountId).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("setAccount on a session with no live executor persists for the next start and says so", async () => {
    const h = harness();
    try {
      const alpha = h.accounts.create({ label: "Alpha", configDir: join(h.root, "cfg-alpha") });
      const store = new EventStore(h.db);
      const id = h.mgr.createSession({ cwd: h.root });
      await h.mgr.stopAll();

      await h.mgr.setAccount(id, alpha.id);
      const details = store.listAfter(id, 0)
        .map((e) => e.event)
        .filter((e): e is Extract<typeof e, { type: "session_status" }> => e.type === "session_status")
        .map((e) => e.detail);
      expect(details).toContain("account: Alpha (applies when the session next starts)");
      expect(h.mgr.listSessions()[0]!.accountId).toBe(alpha.id);
    } finally {
      h.cleanup();
    }
  });

  it("setAccount refuses an unknown account and changes nothing", async () => {
    const h = harness();
    try {
      const alpha = h.accounts.create({ label: "Alpha", configDir: join(h.root, "cfg-alpha") });
      const id = h.mgr.createSession({ cwd: h.root, accountId: alpha.id });
      await expect(h.mgr.setAccount(id, "nope")).rejects.toThrow(/unknown account/);
      expect(h.mgr.listSessions()[0]!.accountId).toBe(alpha.id);
      expect(h.calls).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it("starting an agent stamps the account as used", async () => {
    const h = harness();
    try {
      const alpha = h.accounts.create({ label: "Alpha", configDir: join(h.root, "cfg-alpha") });
      expect(h.accounts.get(alpha.id)!.lastUsedAt).toBeNull();
      h.mgr.createSession({ cwd: h.root, accountId: alpha.id });
      await waitFor(() => {
        if (h.accounts.get(alpha.id)!.lastUsedAt === null) throw new Error("not stamped yet");
      });
    } finally {
      h.cleanup();
    }
  });

  it("an account row deleted under a running session falls back to the ambient ~/.claude rather than refusing to boot", async () => {
    const h = harness();
    try {
      const alpha = h.accounts.create({ label: "Alpha", configDir: join(h.root, "cfg-alpha") });
      const id = h.mgr.createSession({ cwd: h.root, accountId: alpha.id });
      await h.mgr.stopAll();
      // Past AccountManager.remove, which would have refused: a hand-edited database, or a future
      // write path. The session's history must still come back.
      h.db.prepare("DELETE FROM accounts WHERE id = ?").run(alpha.id);

      const { calls, fn } = recordingQuery();
      const rebooted = new SessionManager(
        h.db, new EventStore(h.db), new ClaudeCodeExecutor({ query: fn }),
        h.rooms, h.projects, { accounts: h.accounts },
      );
      expect(rebooted.resumeAll()).toEqual([id]);
      expect(calls[0]!.env).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  it("a server with no AccountManager at all still runs every session, on the ambient ~/.claude", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-isolation-"));
    try {
      const db = openDb(":memory:");
      const { calls, fn } = recordingQuery();
      const projects = new ProjectManager(db, root);
      const rooms = new RoomManager(db, projects);
      // The pre-M2 shape, which must keep working unchanged.
      const mgr = new SessionManager(
        db, new EventStore(db), new ClaudeCodeExecutor({ query: fn }), rooms, projects,
      );
      mgr.createSession({ cwd: root });
      expect(calls[0]!.env).toBeUndefined();
      // And an account cannot be named on a server that has none — refused, not ignored.
      expect(() => mgr.createSession({ cwd: root, accountId: randomUUID() }))
        .toThrow(/no accounts/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
