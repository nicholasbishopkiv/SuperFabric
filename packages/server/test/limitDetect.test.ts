import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../src/accountManager.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import type { Executor, ExecutorEvents, ExecutorHandle } from "../src/executor.js";
import { classifyExecutorError } from "../src/executors/claudeCode.js";
import { LimitMonitor } from "../src/limitMonitor.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";

describe("classifyExecutorError", () => {
  it("classifies HTTP 429 / rate_limit_error as rate_limited", () => {
    expect(classifyExecutorError("429 rate_limit_error: exceeded")).toBe("rate_limited");
  });
  it("classifies the claude.ai usage-limit message as rate_limited", () => {
    expect(classifyExecutorError("Claude usage limit reached|1754269200")).toBe("rate_limited");
  });
  it("classifies anything else as unknown", () => {
    expect(classifyExecutorError("boom")).toBe("unknown");
  });
  it("works on Error instances, not just strings", () => {
    expect(classifyExecutorError(new Error("Rate Limit hit"))).toBe("rate_limited");
    expect(classifyExecutorError(new Error("nope"))).toBe("unknown");
  });
});

/**
 * An executor that fails on demand, so the path from "the provider said 429" to "that account is
 * marked" can be exercised without a provider.
 */
class FailingExecutor implements Executor {
  readonly name = "failing";
  private fail: ((message: string) => void) | null = null;

  start(_opts: unknown, ev: ExecutorEvents): ExecutorHandle {
    ev.onEvent({ type: "session_status", status: "idle" });
    this.fail = (message) => {
      ev.onEvent({ type: "session_error", message });
      ev.onEvent({ type: "session_status", status: "error" });
    };
    return {
      providerSessionId: Promise.resolve("fake"),
      send: () => {},
      interrupt: async () => {},
      stop: async () => {},
    };
  }

  /** Make the most recently started session fail, exactly as the real pump would. */
  break(message: string): void {
    if (this.fail === null) throw new Error("nothing started yet");
    this.fail(message);
  }
}

describe("a limit error from a live session marks its account", () => {
  function harness() {
    const root = mkdtempSync(join(tmpdir(), "sf-limit-detect-"));
    const db = openDb(":memory:");
    const accounts = new AccountManager(db);
    const projects = new ProjectManager(db, root);
    const rooms = new RoomManager(db, projects);
    const monitor = new LimitMonitor(db, accounts);
    const executor = new FailingExecutor();
    const mgr = new SessionManager(db, new EventStore(db), executor, rooms, projects, {
      accounts,
      onRateLimited: (sessionId, accountId) => {
        if (accountId === null) return;
        monitor.markLimited(accountId, `a session was refused with a rate-limit error (${sessionId})`);
      },
    });
    const account = accounts.create({ label: "work", configDir: join(root, "cfg") });
    writeFileSync(join(account.configDir, ".credentials.json"), "{}");
    return {
      root, accounts, monitor, executor, mgr, account,
      cleanup: () => { rmSync(root, { recursive: true, force: true }); },
    };
  }

  it("marks the account limited the moment the executor reports a rate limit", () => {
    const h = harness();
    try {
      h.mgr.createSession({ cwd: h.root, accountId: h.account.id });
      expect(h.monitor.usageOf(h.account.id)).toBeUndefined();

      // Exactly what `ClaudeCodeExecutor` appends when the SDK stream throws a limit error.
      h.executor.break("rate_limited: Error: Claude usage limit reached|1754269200");

      const usage = h.monitor.usageOf(h.account.id)!;
      expect(usage.limited).toBe(true);
      expect(usage.note).toContain("rate-limit error");
    } finally {
      h.cleanup();
    }
  });

  it("leaves the account alone when the failure is not a limit", () => {
    const h = harness();
    try {
      h.mgr.createSession({ cwd: h.root, accountId: h.account.id });
      h.executor.break("unknown: Error: the disk is full");
      expect(h.monitor.usageOf(h.account.id)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  it("says nothing at all for a session on the ambient ~/.claude, which has no row to mark", () => {
    const h = harness();
    try {
      // No account: there is no subscription row whose meters could be marked, and inventing one
      // would put the operator's own quota under a label that is not theirs.
      h.mgr.createSession({ cwd: h.root });
      h.executor.break("rate_limited: 429");
      expect(h.monitor.list().every((u) => !u.limited)).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});
