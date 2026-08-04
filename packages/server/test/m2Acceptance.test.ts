import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionEvent } from "@superfabric/shared";
import { AccountManager } from "../src/accountManager.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { ClaudeCodeExecutor, type QueryFn } from "../src/executors/claudeCode.js";
import { LimitMonitor } from "../src/limitMonitor.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { LimitScheduler } from "../src/scheduler.js";
import { SessionManager } from "../src/sessionManager.js";
import type { UsageAdapter, UsageReading } from "../src/usageAdapters.js";

/**
 * M2's acceptance, end to end: two subscriptions running agents in two rooms, and the whole
 * warn → pause → resume arc driven through the **real** `ClaudeCodeExecutor`, the real monitor and
 * the real scheduler.
 *
 * Only two things are stubbed, and each for a stated reason:
 *
 * - `query()`, so the evidence is the `Options` the SDK would actually have been called with — the
 *   same object the CLI subprocess is spawned from. A fake executor could agree with a mistake about
 *   `Options.env`, which is the one thing the multi-account feature *is*.
 * - the usage adapter, because the alternative is **deliberately exhausting a real subscription** to
 *   watch a threshold fire. Forcing the numbers is the only honest way to exercise 80 % and 95 %, and
 *   it is what the plan asks for.
 *
 * Everything between those two — the config-dir isolation, the poll, the thresholds, the turn
 * boundary, the persisted pause, the resume through `options.resume` — is the shipping code.
 */

/** Records every `query()` and lets a test end a turn by hand. */
function recordingQuery() {
  const calls: Options[] = [];
  const streams: { emit: (msg: SDKMessage) => void; prompts: string[] }[] = [];
  const fn: QueryFn = (params) => {
    calls.push(params.options ?? {});
    const prompts: string[] = [];
    if (typeof params.prompt !== "string") {
      void (async () => {
        for await (const msg of params.prompt) {
          const content = msg.message.content;
          prompts.push(typeof content === "string" ? content : JSON.stringify(content));
        }
      })();
    }
    const queue: SDKMessage[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    })();
    streams.push({
      emit: (msg) => { queue.push(msg); const w = wake; wake = null; w?.(); },
      prompts,
    });
    return {
      next: () => gen.next(),
      return: (v: void | PromiseLike<void>) => gen.return(v),
      throw: (e: unknown) => gen.throw(e),
      [Symbol.asyncIterator]() { return this; },
      interrupt: async () => undefined,
      close: () => { closed = true; const w = wake; wake = null; w?.(); },
    } as unknown as Query;
  };
  return { calls, streams, fn };
}

/** The stub whose numbers the test moves. Per config dir, so one account can be spent and one not. */
function forcedAdapter() {
  const perDir = new Map<string, UsageReading>();
  let fallback: UsageReading = reading(5);
  return {
    adapter: {
      name: "forced",
      read: async (account: { configDir: string }) => perDir.get(account.configDir) ?? fallback,
    } satisfies UsageAdapter,
    set: (r: UsageReading) => { fallback = r; },
    setFor: (configDir: string, r: UsageReading) => { perDir.set(configDir, r); },
  };
}

const RESETS_AT = "2026-08-04T18:00:00Z";

function reading(utilization: number, resetsAt = RESETS_AT): UsageReading {
  return {
    source: "endpoint",
    approximate: false,
    note: null,
    windows: [{ key: "five_hour", label: "5-hour", utilization, resetsAt, detail: null }],
  };
}

const configDirOf = (o: Options): string | undefined => o.env?.CLAUDE_CONFIG_DIR;

describe("M2 acceptance", () => {
  it("two accounts, two rooms, two genuinely different CLAUDE_CONFIG_DIRs", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-m2-"));
    try {
      const db = openDb(":memory:");
      const { calls, fn } = recordingQuery();
      const projects = new ProjectManager(db, root);
      const rooms = new RoomManager(db, projects);
      const accounts = new AccountManager(db);
      const mgr = new SessionManager(
        db, new EventStore(db), new ClaudeCodeExecutor({ query: fn }), rooms, projects, { accounts },
      );

      const alpha = accounts.create({ label: "Alpha", configDir: join(root, "cfg-alpha") });
      const beta = accounts.create({ label: "Beta", configDir: join(root, "cfg-beta") });
      mkdirSync(join(root, "backend"), { recursive: true });
      mkdirSync(join(root, "frontend"), { recursive: true });
      const backend = rooms.createRoom("backend");
      const frontend = rooms.createRoom("frontend");
      rooms.setAccount(backend.id, alpha.id);
      rooms.setAccount(frontend.id, beta.id);

      mgr.createSession({ roomId: backend.id });
      mgr.createSession({ roomId: frontend.id });

      // The evidence is the options the SDK was called with — the environment the CLI subprocess
      // would really have been spawned into.
      expect(calls).toHaveLength(2);
      expect(configDirOf(calls[0]!)).toBe(alpha.configDir);
      expect(configDirOf(calls[1]!)).toBe(beta.configDir);
      expect(configDirOf(calls[0]!)).not.toBe(configDirOf(calls[1]!));
      // …and `Options.env` replaces rather than merges, so a CLI without these could not be spawned.
      for (const o of calls) {
        expect(o.env?.PATH).toBe(process.env.PATH);
        expect(o.env?.HOME).toBe(process.env.HOME);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("warn, pause at a turn boundary, and auto-resume — observed end to end", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-m2-"));
    try {
      const db = openDb(":memory:");
      const store = new EventStore(db);
      const { calls, streams, fn } = recordingQuery();
      const projects = new ProjectManager(db, root);
      const rooms = new RoomManager(db, projects);
      const accounts = new AccountManager(db);
      const clock = { ms: Date.parse("2026-08-04T12:00:00Z") };
      const forced = forcedAdapter();

      const monitor = new LimitMonitor(db, accounts, {
        primary: forced.adapter, now: () => clock.ms, minIntervalMs: 1000,
      });
      const mgr = new SessionManager(
        db, store, new ClaudeCodeExecutor({ query: fn }), rooms, projects, { accounts },
      );
      const scheduler = new LimitScheduler({ monitor, sessions: mgr, accounts, now: () => clock.ms });

      const alpha = accounts.create({ label: "Alpha", configDir: join(root, "cfg-alpha") });
      const beta = accounts.create({ label: "Beta", configDir: join(root, "cfg-beta") });
      for (const account of [alpha, beta]) {
        writeFileSync(join(account.configDir, ".credentials.json"), JSON.stringify({
          claudeAiOauth: { accessToken: "forced" },
        }));
      }
      mkdirSync(join(root, "backend"), { recursive: true });
      mkdirSync(join(root, "frontend"), { recursive: true });
      const backend = rooms.createRoom("backend");
      const frontend = rooms.createRoom("frontend");
      rooms.setAccount(backend.id, alpha.id);
      rooms.setAccount(frontend.id, beta.id);
      // Beta stays comfortable throughout — no rotation, and no collateral damage either.
      forced.setFor(beta.configDir, reading(9));

      const onAlpha = mgr.createSession({ roomId: backend.id });
      const onBeta = mgr.createSession({ roomId: frontend.id });
      // A provider session id, so the eventual resume has a conversation to come back to.
      streams[0]!.emit({ type: "system", subtype: "init", session_id: "alpha-conversation" } as SDKMessage);
      await Promise.resolve();
      await Promise.resolve();

      // ---- 84 %: the warning -----------------------------------------------------------------
      forced.setFor(alpha.configDir, reading(84));
      clock.ms += 1000;
      await monitor.pollAll();
      await scheduler.tick();

      const warning = streams[0]!.prompts.at(-1) ?? "";
      expect(warning).toContain("84% of its 5-hour limit");
      expect(warning).toContain("safe stopping point");
      // Beta's agent was told nothing: it is a different subscription with its own quota.
      expect(streams[1]!.prompts).toHaveLength(0);
      expect(mgr.listSessions().find((s) => s.id === onAlpha)!.state).toBe("active");

      // ---- 97 %, mid-turn: armed, and the turn is allowed to finish --------------------------
      streams[0]!.emit({
        type: "assistant",
        message: { content: [{ type: "text", text: "still working" }] },
      } as SDKMessage);
      await Promise.resolve();
      mgr.prompt(onAlpha, "keep going");   // puts the session into `working`

      forced.setFor(alpha.configDir, reading(97));
      clock.ms += 1000;
      await monitor.pollAll();
      await scheduler.tick();

      expect(mgr.listSessions().find((s) => s.id === onAlpha)!.state).toBe("active");
      expect(details(store, onAlpha)).toContain("pausing at the end of this turn");

      // ---- the turn boundary: the pause lands -------------------------------------------------
      streams[0]!.emit({ type: "result", total_cost_usd: 0.01 } as SDKMessage);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const paused = mgr.listSessions().find((s) => s.id === onAlpha)!;
      expect(paused.state).toBe("paused");
      expect(paused.status).toBe("paused");
      expect(paused.pausedUntil).toBe(Math.floor(Date.parse(RESETS_AT) / 1000));
      expect(details(store, onAlpha)).toContain('the account "Alpha" is at its limit');
      // Beta is untouched. An exhausted subscription's agents wait for its window; they are never
      // moved to a subscription that has room. (CLAUDE.md; docs/RESEARCH.md §5.)
      expect(mgr.listSessions().find((s) => s.id === onBeta)!.state).toBe("active");
      const startsBeforeResume = calls.length;

      // ---- the window rolls: resumed, unattended ----------------------------------------------
      clock.ms = Date.parse(RESETS_AT) + 1000;
      forced.setFor(alpha.configDir, reading(3, "2026-08-04T23:00:00Z"));
      await monitor.pollAll();
      await scheduler.tick();

      const back = mgr.listSessions().find((s) => s.id === onAlpha)!;
      expect(back.state).toBe("active");
      expect(back.pausedUntil).toBeNull();
      expect(calls).toHaveLength(startsBeforeResume + 1);
      // The same conversation, on the same subscription.
      expect(calls.at(-1)!.resume).toBe("alpha-conversation");
      expect(configDirOf(calls.at(-1)!)).toBe(alpha.configDir);
      // And it is told why it stopped, rather than silently restarted.
      expect(streams.at(-1)!.prompts.at(-1) ?? "").toContain("You were paused");

      await mgr.stopAll();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Every `session_status` detail this session's log holds, as one string. */
function details(store: EventStore, sessionId: string): string {
  return store.listAfter(sessionId, 0)
    .map((r) => r.event)
    .filter((e): e is Extract<SessionEvent, { type: "session_status" }> => e.type === "session_status")
    .map((e) => `${e.status}${e.detail === undefined ? "" : `: ${e.detail}`}`)
    .join(" | ");
}
