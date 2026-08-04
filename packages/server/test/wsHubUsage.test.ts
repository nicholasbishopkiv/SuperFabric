import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountUsage, ServerMessage } from "@superfabric/shared";
import { AccountManager } from "../src/accountManager.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { FakeExecutor } from "../src/executors/fake.js";
import { LimitMonitor } from "../src/limitMonitor.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import type { UsageAdapter } from "../src/usageAdapters.js";
import { WsHub, type SocketLike } from "../src/wsHub.js";
import { waitFor } from "./_waitFor.js";

/** The limit meters over the wire: who may ask, who is told, and what a server without them says. */

function fakeSocket() {
  const sent: ServerMessage[] = [];
  const sock: SocketLike = { send: (d: string) => sent.push(JSON.parse(d) as ServerMessage) };
  return { sock, sent };
}

const stub = (utilization: number): UsageAdapter => ({
  name: "stub",
  read: async () => ({
    source: "endpoint",
    approximate: false,
    note: null,
    windows: [{
      key: "five_hour", label: "5-hour", utilization,
      resetsAt: "2026-08-04T18:00:00Z", detail: null,
    }],
  }),
});

function makeHub(opts: { withLimits?: boolean; utilization?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sf-hub-usage-"));
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const projects = new ProjectManager(db, root);
  const rooms = new RoomManager(db, projects);
  const accounts = new AccountManager(db);
  const mgr = new SessionManager(db, store, new FakeExecutor(), rooms, projects, { accounts });
  const withLimits = opts.withLimits !== false;
  const limits = new LimitMonitor(db, accounts, {
    primary: stub(opts.utilization ?? 42),
    onChange: () => hub.announceUsage(),
  });
  const hub: WsHub = new WsHub(store, mgr, rooms, projects, {
    sessionsDebounceMs: 5, accounts, ...(withLimits ? { limits } : {}),
  });
  const { sock, sent } = fakeSocket();
  hub.attach(sock);
  return {
    root, db, accounts, limits, hub, sock, sent,
    /** An account with credentials in place, so the monitor is willing to read it. */
    loggedIn: (label: string) => {
      const account = accounts.create({ label, configDir: join(root, `cfg-${label}`) });
      writeFileSync(join(account.configDir, ".credentials.json"), JSON.stringify({
        claudeAiOauth: { accessToken: "t" },
      }));
      return account;
    },
    send: (msg: unknown) => hub.handleMessage(sock, JSON.stringify(msg)),
    cleanup: () => { rmSync(root, { recursive: true, force: true }); },
  };
}

function latestUsage(sent: ServerMessage[]): AccountUsage[] | undefined {
  for (let i = sent.length - 1; i >= 0; i--) {
    const msg = sent[i]!;
    if (msg.kind === "usage") return msg.usage;
  }
  return undefined;
}

const errors = (sent: ServerMessage[]): string[] =>
  sent.filter((m): m is Extract<ServerMessage, { kind: "error" }> => m.kind === "error").map((m) => m.message);

describe("WsHub: usage", () => {
  it("answers list_usage to the socket that asked", async () => {
    const h = makeHub();
    try {
      const account = h.loggedIn("work");
      await h.limits.pollAll();
      h.send({ kind: "list_usage" });

      const usage = latestUsage(h.sent)!;
      expect(usage).toHaveLength(1);
      expect(usage[0]!.accountId).toBe(account.id);
      expect(usage[0]!.windows[0]!.utilization).toBe(42);
    } finally {
      h.cleanup();
    }
  });

  it("never triggers a read of its own — a client connecting is not a reason to spend a request", () => {
    const h = makeHub();
    try {
      h.loggedIn("work");
      // Ten tabs opening at once must not become ten requests against an undocumented endpoint.
      for (let i = 0; i < 10; i++) h.send({ kind: "list_usage" });
      const usage = latestUsage(h.sent)!;
      expect(usage[0]!.readAt).toBeNull();
      expect(usage[0]!.windows).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it("pushes fresh meters to every attached socket when a reading changes", async () => {
    const h = makeHub();
    try {
      const second = fakeSocket();
      h.hub.attach(second.sock);
      h.loggedIn("work");

      await h.limits.pollAll();
      // Machine-wide, like the account list: both tabs are told, whatever floor they are on.
      await waitFor(() => {
        if (latestUsage(h.sent) === undefined) throw new Error("first socket has no usage yet");
        if (latestUsage(second.sent) === undefined) throw new Error("second socket has no usage yet");
      });
      expect(latestUsage(second.sent)![0]!.windows[0]!.utilization).toBe(42);
    } finally {
      h.cleanup();
    }
  });

  it("pushes the mark from a 429 too, without waiting for the next poll", async () => {
    const h = makeHub();
    try {
      const account = h.loggedIn("work");
      h.limits.markLimited(account.id, "a session was refused with a rate-limit error");
      await waitFor(() => {
        const usage = latestUsage(h.sent);
        if (usage === undefined || !usage[0]!.limited) throw new Error("not marked on the wire yet");
      });
    } finally {
      h.cleanup();
    }
  });

  it("refuses list_usage on a server that monitors no limits, rather than answering with nothing", () => {
    const h = makeHub({ withLimits: false });
    try {
      h.loggedIn("work");
      h.send({ kind: "list_usage" });
      // "This server reads no limits" and "your accounts have used nothing" are different facts, and
      // only one of them is safe to plan around.
      expect(latestUsage(h.sent)).toBeUndefined();
      expect(errors(h.sent).join(" ")).toContain("does not monitor limits");
    } finally {
      h.cleanup();
    }
  });
});
