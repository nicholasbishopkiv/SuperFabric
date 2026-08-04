import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountInfo, ServerMessage } from "@superfabric/shared";
import { AccountLoginManager, type LoginChild } from "../src/accountLogin.js";
import { AccountManager } from "../src/accountManager.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { FakeExecutor } from "../src/executors/fake.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { WsHub, type SocketLike } from "../src/wsHub.js";
import { waitFor } from "./_waitFor.js";

/** Accounts over the wire: the five messages, the bindings, and who hears about a change. */

function fakeSocket() {
  const sent: ServerMessage[] = [];
  const sock: SocketLike = { send: (d: string) => sent.push(JSON.parse(d) as ServerMessage) };
  return { sock, sent };
}

/** A fake `claude auth login` the test drives by hand, shared by every login the harness spawns. */
function fakeLoginSpawner() {
  let onOutput: (chunk: string) => void = () => {};
  const child: LoginChild = {
    onOutput: (cb) => { onOutput = cb; },
    onExit: () => {},
    write: () => {},
    kill: () => {},
  };
  return { spawn: () => child, say: (chunk: string) => onOutput(chunk) };
}

function makeHub(opts: { withAccounts?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sf-hub-accounts-"));
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const projects = new ProjectManager(db, root);
  const rooms = new RoomManager(db, projects);
  const accounts = new AccountManager(db);
  const login = fakeLoginSpawner();
  const logins = new AccountLoginManager({
    accounts, onChange: () => hub.announceAccounts(), spawn: login.spawn,
  });
  accounts.setLoginStateSource((id) => logins.stateOf(id));
  const withAccounts = opts.withAccounts !== false;
  const mgr = new SessionManager(db, store, new FakeExecutor(), rooms, projects, {
    ...(withAccounts ? { accounts } : {}),
  });
  const hub: WsHub = new WsHub(store, mgr, rooms, projects, {
    // Short enough that a test does not wait out the real 250 ms window.
    sessionsDebounceMs: 5,
    ...(withAccounts ? { accounts, logins } : {}),
  });
  const { sock, sent } = fakeSocket();
  hub.attach(sock);
  return {
    root, db, accounts, logins, login, rooms, projects, mgr, hub, sock, sent,
    send: (msg: unknown) => hub.handleMessage(sock, JSON.stringify(msg)),
    cleanup: () => { rmSync(root, { recursive: true, force: true }); },
  };
}

/** The newest `accounts` frame this socket received. */
function latestAccounts(sent: ServerMessage[]): AccountInfo[] | undefined {
  for (let i = sent.length - 1; i >= 0; i--) {
    const msg = sent[i]!;
    if (msg.kind === "accounts") return msg.accounts;
  }
  return undefined;
}

const errors = (sent: ServerMessage[]): string[] =>
  sent.filter((m): m is Extract<ServerMessage, { kind: "error" }> => m.kind === "error").map((m) => m.message);

const notices = (sent: ServerMessage[]): string[] =>
  sent.filter((m): m is Extract<ServerMessage, { kind: "notice" }> => m.kind === "notice").map((m) => m.message);

describe("WsHub: accounts", () => {
  it("lists accounts to the socket that asked", () => {
    const h = makeHub();
    try {
      h.accounts.create({ label: "Work", configDir: join(h.root, "work") });
      h.send({ kind: "list_accounts" });
      expect(latestAccounts(h.sent)!.map((a) => a.label)).toEqual(["Work"]);
    } finally {
      h.cleanup();
    }
  });

  it("creates an account and tells every tab, whatever factory it is on", async () => {
    const h = makeHub();
    try {
      // A subscription is the operator's, not a repository's — so an account created on one floor is
      // news on every floor. This is the one broadcast here that is deliberately not project-scoped.
      const other = fakeSocket();
      h.hub.attach(other.sock);

      h.send({ kind: "create_account", label: "Work", configDir: join(h.root, "work") });
      await waitFor(() => {
        if (latestAccounts(other.sent) === undefined) throw new Error("not yet");
      });
      expect(latestAccounts(other.sent)!.map((a) => a.label)).toEqual(["Work"]);
      expect(notices(h.sent)[0]).toContain("log it in");
    } finally {
      h.cleanup();
    }
  });

  it("refuses a duplicate config directory over the wire, with the reason", () => {
    const h = makeHub();
    try {
      const dir = join(h.root, "shared");
      h.send({ kind: "create_account", label: "Work", configDir: dir });
      h.send({ kind: "create_account", label: "Personal", configDir: dir });
      expect(errors(h.sent).join()).toMatch(/already account "Work"/);
      expect(h.accounts.list()).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it("removes an account and says what that did to the rooms that defaulted to it", async () => {
    const h = makeHub();
    try {
      const account = h.accounts.create({ label: "Work", configDir: join(h.root, "work") });
      mkdirSync(join(h.root, "backend"), { recursive: true });
      const room = h.rooms.createRoom("backend");
      h.rooms.setAccount(room.id, account.id);

      h.send({ kind: "remove_account", accountId: account.id });
      expect(notices(h.sent).join()).toContain("1 room now default to the ambient ~/.claude");
      expect(h.rooms.getRoom(room.id)!.accountId).toBeNull();
      await waitFor(() => {
        if (latestAccounts(h.sent)?.length !== 0) throw new Error("not yet");
      });
    } finally {
      h.cleanup();
    }
  });

  it("binds a room, and says out loud that nobody already working there moves", () => {
    const h = makeHub();
    try {
      const account = h.accounts.create({ label: "Work", configDir: join(h.root, "work") });
      mkdirSync(join(h.root, "backend"), { recursive: true });
      const room = h.rooms.createRoom("backend");

      h.send({ kind: "set_room_account", roomId: room.id, accountId: account.id });
      expect(h.rooms.getRoom(room.id)!.accountId).toBe(account.id);
      const notice = notices(h.sent).join();
      expect(notice).toContain("new agents in backend will run on Work");
      expect(notice).toContain("keep the account they started on");

      // And the fresh floor carries the binding, so the panel does not have to re-ask.
      const roomsMsg = h.sent.filter((m) => m.kind === "rooms").at(-1)!;
      expect(roomsMsg.kind === "rooms" && roomsMsg.rooms.find((r) => r.id === room.id)!.accountId)
        .toBe(account.id);
    } finally {
      h.cleanup();
    }
  });

  it("unbinds a room back to the ambient ~/.claude", () => {
    const h = makeHub();
    try {
      const account = h.accounts.create({ label: "Work", configDir: join(h.root, "work") });
      mkdirSync(join(h.root, "backend"), { recursive: true });
      const room = h.rooms.createRoom("backend");
      h.rooms.setAccount(room.id, account.id);

      h.send({ kind: "set_room_account", roomId: room.id, accountId: null });
      expect(h.rooms.getRoom(room.id)!.accountId).toBeNull();
      expect(notices(h.sent).join()).toContain("the ambient ~/.claude");
    } finally {
      h.cleanup();
    }
  });

  it("refuses to bind a room on another factory's floor", () => {
    const h = makeHub();
    try {
      const account = h.accounts.create({ label: "Work", configDir: join(h.root, "work") });
      const elsewhere = mkdtempSync(join(tmpdir(), "sf-other-"));
      try {
        // Room ids are globally unique, so without the scope check a client holding another
        // project's id could re-bind it — and the change would be broadcast to a floor that never
        // asked. This is the cross-project protection, applied to the new message.
        const other = h.projects.create({ root: elsewhere });
        mkdirSync(join(elsewhere, "far"), { recursive: true });
        const room = h.rooms.createRoom("far", { projectId: other.id });
        h.send({ kind: "set_room_account", roomId: room.id, accountId: account.id });
        expect(errors(h.sent).join()).toMatch(/belongs to another project/);
        expect(h.rooms.getRoom(room.id)!.accountId).toBeNull();
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    } finally {
      h.cleanup();
    }
  });

  it("refuses to bind a room to an account that does not exist", () => {
    const h = makeHub();
    try {
      mkdirSync(join(h.root, "backend"), { recursive: true });
      const room = h.rooms.createRoom("backend");
      h.send({ kind: "set_room_account", roomId: room.id, accountId: "nope" });
      expect(errors(h.sent).join()).toMatch(/unknown account/);
      expect(h.rooms.getRoom(room.id)!.accountId).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("a new agent inherits its room's account, and the session list says which", async () => {
    const h = makeHub();
    try {
      const account = h.accounts.create({ label: "Work", configDir: join(h.root, "work") });
      mkdirSync(join(h.root, "backend"), { recursive: true });
      const room = h.rooms.createRoom("backend");
      h.rooms.setAccount(room.id, account.id);

      h.send({ kind: "create_session", roomId: room.id });
      await waitFor(() => {
        const msg = h.sent.filter((m) => m.kind === "sessions").at(-1);
        if (msg === undefined || msg.kind !== "sessions" || msg.sessions.length === 0) {
          throw new Error("not yet");
        }
        expect(msg.sessions[0]!.accountId).toBe(account.id);
      });
    } finally {
      h.cleanup();
    }
  });

  it("an agent can be moved onto another account, and the list follows", async () => {
    const h = makeHub();
    try {
      const work = h.accounts.create({ label: "Work", configDir: join(h.root, "work") });
      const personal = h.accounts.create({ label: "Personal", configDir: join(h.root, "personal") });
      const id = h.mgr.createSession({ cwd: h.root, accountId: work.id });

      h.send({ kind: "set_session_account", sessionId: id, accountId: personal.id });
      await waitFor(() => {
        expect(h.mgr.listSessions()[0]!.accountId).toBe(personal.id);
      });
      expect(errors(h.sent)).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it("moving an agent onto an unknown account is an error the UI can show", async () => {
    const h = makeHub();
    try {
      const id = h.mgr.createSession({ cwd: h.root });
      h.send({ kind: "set_session_account", sessionId: id, accountId: "nope" });
      await waitFor(() => {
        expect(errors(h.sent).join()).toMatch(/unknown account/);
      });
      expect(h.mgr.listSessions()[0]!.accountId).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  describe("login", () => {
    it("starts one and pushes the URL to every tab", async () => {
      const h = makeHub();
      try {
        const account = h.accounts.create({ label: "Work", configDir: join(h.root, "work") });
        h.send({ kind: "begin_account_login", accountId: account.id });
        h.login.say("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=x\n");

        await waitFor(() => {
          const listed = latestAccounts(h.sent)?.[0];
          if (listed === undefined) throw new Error("not yet");
          expect(listed.login.status).toBe("awaiting_code");
          expect(listed.login.url).toBe("https://claude.com/cai/oauth/authorize?state=x");
        });
      } finally {
        h.cleanup();
      }
    });

    it("a code sent before the URL is an error rather than a silent no-op", () => {
      const h = makeHub();
      try {
        const account = h.accounts.create({ label: "Work", configDir: join(h.root, "work") });
        h.send({ kind: "begin_account_login", accountId: account.id });
        h.send({ kind: "submit_account_login_code", accountId: account.id, code: "guess" });
        expect(errors(h.sent).join()).toMatch(/has not printed/);
      } finally {
        h.cleanup();
      }
    });

    it("cancelling one is harmless when there is nothing to cancel", () => {
      const h = makeHub();
      try {
        const account = h.accounts.create({ label: "Work", configDir: join(h.root, "work") });
        h.send({ kind: "cancel_account_login", accountId: account.id });
        expect(errors(h.sent)).toEqual([]);
      } finally {
        h.cleanup();
      }
    });
  });

  it("the credentials file appearing lights the account up", async () => {
    const h = makeHub();
    try {
      const account = h.accounts.create({ label: "Work", configDir: join(h.root, "work") });
      h.send({ kind: "list_accounts" });
      expect(latestAccounts(h.sent)![0]!.credentialsPresent).toBe(false);

      // However it got there — this flow, or the operator in their own terminal.
      writeFileSync(join(account.configDir, ".credentials.json"), "{}");
      h.hub.announceAccounts();
      await waitFor(() => {
        expect(latestAccounts(h.sent)![0]!.credentialsPresent).toBe(true);
      });
    } finally {
      h.cleanup();
    }
  });

  it("a server with no accounts refuses the account messages rather than answering with an empty list", () => {
    const h = makeHub({ withAccounts: false });
    try {
      // "This server has no accounts configured" and "you have no accounts" are different facts, and
      // a surface that showed the second for the first would be lying.
      h.send({ kind: "list_accounts" });
      h.send({ kind: "create_account", label: "Work", configDir: join(h.root, "work") });
      h.send({ kind: "begin_account_login", accountId: "x" });
      expect(errors(h.sent)).toEqual([
        "Error: this server has no accounts",
        "Error: this server has no accounts",
        "Error: this server cannot log accounts in",
      ]);
    } finally {
      h.cleanup();
    }
  });
});
