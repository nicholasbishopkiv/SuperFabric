import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../src/accountManager.js";
import { openDb } from "../src/db.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";

/** A scratch directory that is cleaned up by the test that made it. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sf-accounts-"));
}

function make() {
  const db = openDb(":memory:");
  return { db, accounts: new AccountManager(db) };
}

describe("AccountManager", () => {
  it("creates the config directory and records the account", () => {
    const root = scratch();
    try {
      const { accounts } = make();
      const dir = join(root, "work");
      expect(existsSync(dir)).toBe(false);

      const account = accounts.create({ label: "Work", configDir: dir });
      expect(account.label).toBe("Work");
      expect(account.configDir).toBe(dir);
      expect(existsSync(dir)).toBe(true);
      // Nothing has logged in, so nothing claims anything has.
      expect(account.credentialsPresent).toBe(false);
      expect(account.lastUsedAt).toBeNull();
      expect(account.login).toEqual({ status: "idle", url: null, message: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a relative config directory", () => {
    const { accounts } = make();
    expect(() => accounts.create({ label: "Work", configDir: "relative/path" }))
      .toThrow(/absolute path/);
  });

  it("refuses an empty label", () => {
    const root = scratch();
    try {
      const { accounts } = make();
      expect(() => accounts.create({ label: "   ", configDir: join(root, "a") })).toThrow(/label/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a config directory that is a file", () => {
    const root = scratch();
    try {
      const { accounts } = make();
      const file = join(root, "not-a-dir");
      writeFileSync(file, "");
      expect(() => accounts.create({ label: "Work", configDir: file })).toThrow(/not a directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The invariant this whole feature rests on: the CLI rewrites its refresh token in place inside a
  // config directory, so two accounts sharing one would silently log each other out — days later,
  // with nothing in any log to explain it.
  describe("one config directory is one account", () => {
    it("refuses a second account on the same directory", () => {
      const root = scratch();
      try {
        const { accounts } = make();
        const dir = join(root, "shared");
        accounts.create({ label: "Work", configDir: dir });
        expect(() => accounts.create({ label: "Personal", configDir: dir }))
          .toThrow(/already account "Work"/);
        expect(accounts.list()).toHaveLength(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("refuses it however the same directory is spelled", () => {
      const root = scratch();
      try {
        const { accounts } = make();
        const dir = join(root, "shared");
        accounts.create({ label: "Work", configDir: dir });

        // Every one of these is the *same directory*. A uniqueness check on the string the operator
        // happened to type would let three more accounts onto it.
        for (const spelling of [`${dir}/`, join(dir, "."), join(root, "x", "..", "shared"), `  ${dir}  `]) {
          expect(() => accounts.create({ label: "Personal", configDir: spelling }))
            .toThrow(/already account/);
        }
        expect(accounts.list()).toHaveLength(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("refuses a symlink pointing at a directory another account already owns", () => {
      const root = scratch();
      try {
        const { accounts } = make();
        const dir = join(root, "real");
        accounts.create({ label: "Work", configDir: dir });
        const link = join(root, "link");
        symlinkSync(dir, link);
        expect(() => accounts.create({ label: "Personal", configDir: link }))
          .toThrow(/already account/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("the schema refuses it too, so a future write path cannot lose the invariant", () => {
      const root = scratch();
      try {
        const { db, accounts } = make();
        const dir = join(root, "shared");
        accounts.create({ label: "Work", configDir: dir });
        // Straight past AccountManager, the way a later feature might.
        expect(() => db.prepare("INSERT INTO accounts (id, label, config_dir) VALUES (?, ?, ?)")
          .run("other", "Personal", dir)).toThrow(/UNIQUE/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it("lists accounts in creation order", () => {
    const root = scratch();
    try {
      const { accounts } = make();
      accounts.create({ label: "One", configDir: join(root, "one") });
      accounts.create({ label: "Two", configDir: join(root, "two") });
      accounts.create({ label: "Three", configDir: join(root, "three") });
      expect(accounts.list().map((a) => a.label)).toEqual(["One", "Two", "Three"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("credentialsPresent follows .credentials.json appearing and going", () => {
    const root = scratch();
    try {
      const { accounts } = make();
      const dir = join(root, "work");
      const account = accounts.create({ label: "Work", configDir: dir });
      expect(accounts.credentialsPresent(account.id)).toBe(false);

      writeFileSync(join(dir, ".credentials.json"), "{}");
      expect(accounts.credentialsPresent(account.id)).toBe(true);
      // And the listing agrees — this is what lights the account up in the UI.
      expect(accounts.list()[0]!.credentialsPresent).toBe(true);

      rmSync(join(dir, ".credentials.json"));
      expect(accounts.credentialsPresent(account.id)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("credentialsPresent is false for an account that does not exist", () => {
    const { accounts } = make();
    expect(accounts.credentialsPresent("nope")).toBe(false);
  });

  it("configDirOf answers undefined for null and for an unknown id", () => {
    const root = scratch();
    try {
      const { accounts } = make();
      const account = accounts.create({ label: "Work", configDir: join(root, "work") });
      expect(accounts.configDirOf(account.id)).toBe(join(root, "work"));
      // A session may name an account whose row has gone; the ambient ~/.claude is the honest answer,
      // and refusing to start the agent would be worse.
      expect(accounts.configDirOf("gone")).toBeUndefined();
      expect(accounts.configDirOf(null)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("touch stamps lastUsedAt", () => {
    const root = scratch();
    try {
      const db = openDb(":memory:");
      const accounts = new AccountManager(db, () => 1_700_000_000);
      const account = accounts.create({ label: "Work", configDir: join(root, "work") });
      expect(account.lastUsedAt).toBeNull();
      accounts.touch(account.id);
      expect(accounts.get(account.id)!.lastUsedAt).toBe(1_700_000_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("require throws for an unknown account", () => {
    const { accounts } = make();
    expect(() => accounts.require("nope")).toThrow(/unknown account/);
  });

  describe("remove", () => {
    it("refuses while a session still runs on the account", () => {
      const root = scratch();
      try {
        const { db, accounts } = make();
        const account = accounts.create({ label: "Work", configDir: join(root, "work") });
        db.prepare("INSERT INTO sessions (id, cwd, account_id) VALUES (?, ?, ?)")
          .run("s1", root, account.id);
        expect(() => accounts.remove(account.id)).toThrow(/still runs 1 session/);
        expect(accounts.list()).toHaveLength(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("clears the rooms that defaulted to it, and says how many", () => {
      const root = scratch();
      try {
        const db = openDb(":memory:");
        const accounts = new AccountManager(db);
        const projects = new ProjectManager(db, root);
        const rooms = new RoomManager(db, projects);
        const account = accounts.create({ label: "Work", configDir: join(root, "cfg") });
        mkdirSync(join(root, "a"), { recursive: true });
        const a = rooms.createRoom("a");
        const b = rooms.createRoom("b");
        rooms.setAccount(a.id, account.id);
        rooms.setAccount(b.id, account.id);

        // A room's binding is a default for agents not yet created, so it does not block removal —
        // but a room silently falling back to the operator's own ~/.claude has to be reported.
        const removed = accounts.remove(account.id);
        expect(removed).toEqual({ label: "Work", roomsUnbound: 2 });
        expect(rooms.getRoom(a.id)!.accountId).toBeNull();
        expect(rooms.getRoom(b.id)!.accountId).toBeNull();
        expect(accounts.list()).toHaveLength(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("throws for an unknown account", () => {
      const { accounts } = make();
      expect(() => accounts.remove("nope")).toThrow(/unknown account/);
    });
  });

  it("announces its own changes, so nothing has to remember to push a fresh list", () => {
    const root = scratch();
    try {
      const { accounts } = make();
      let changes = 0;
      accounts.onChange(() => { changes++; });

      const account = accounts.create({ label: "Work", configDir: join(root, "work") });
      expect(changes).toBe(1);
      accounts.touch(account.id);
      expect(changes).toBe(2);
      // An id nothing matches changes nothing, so it announces nothing.
      accounts.touch("nope");
      expect(changes).toBe(2);
      accounts.remove(account.id);
      expect(changes).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a listener that throws does not fail the write that triggered it", () => {
    const root = scratch();
    try {
      const { accounts } = make();
      accounts.onChange(() => { throw new Error("boom"); });
      expect(() => accounts.create({ label: "Work", configDir: join(root, "work") })).not.toThrow();
      expect(accounts.list()).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
