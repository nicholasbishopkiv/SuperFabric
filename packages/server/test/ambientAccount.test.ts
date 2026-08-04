import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_CREDENTIALS_FILE } from "@superfabric/shared";
import { AccountManager } from "../src/accountManager.js";
import { openDb } from "../src/db.js";

/**
 * Finding the account that is already on the machine.
 *
 * An operator who has used Claude Code has a logged-in `~/.claude`, and SuperFabric has always run
 * every unbound agent on exactly that directory — so "No accounts yet" was a false statement made to
 * the people most likely to be reading it. What this must *not* become is a row that keeps coming
 * back after they remove it, which is the property most of these cases are about.
 */

/** A directory that looks like a logged-in `~/.claude`. */
function loggedIn(): string {
  const dir = mkdtempSync(join(tmpdir(), "superfabric-ambient-"));
  writeFileSync(join(dir, ACCOUNT_CREDENTIALS_FILE), JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
  return dir;
}

describe("adopting the ambient ~/.claude", () => {
  it("shows the account that was already there, with its real directory", () => {
    const dir = loggedIn();
    try {
      const accounts = new AccountManager(openDb(":memory:"));
      const adopted = accounts.adoptAmbient(dir);

      expect(adopted).toBeDefined();
      expect(adopted!.configDir).toBe(dir);
      expect(accounts.list()).toHaveLength(1);
      // It is an ordinary account row from here on: bindable, pollable, removable.
      expect(accounts.list()[0]!.credentialsPresent).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does nothing for a directory that is not logged in", () => {
    const dir = mkdtempSync(join(tmpdir(), "superfabric-ambient-empty-"));
    try {
      const accounts = new AccountManager(openDb(":memory:"));
      // A `~/.claude` holding only settings is not an account, and inventing one would produce a row
      // whose meter could never be read and whose agents could never run.
      mkdirSync(join(dir, "projects"), { recursive: true });
      expect(accounts.adoptAmbient(dir)).toBeUndefined();
      expect(accounts.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not hand it back after the operator removes it", () => {
    const dir = loggedIn();
    try {
      const db = openDb(":memory:");
      const accounts = new AccountManager(db);
      const adopted = accounts.adoptAmbient(dir)!;
      accounts.remove(adopted.id);

      // The next boot — a second manager over the same database, exactly as a restart is.
      const afterRestart = new AccountManager(db);
      expect(afterRestart.adoptAmbient(dir)).toBeUndefined();
      expect(afterRestart.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when the operator had already added that directory by hand", () => {
    const dir = loggedIn();
    try {
      const accounts = new AccountManager(openDb(":memory:"));
      accounts.create({ label: "work", configDir: dir });

      expect(accounts.adoptAmbient(dir)).toBeUndefined();
      // One directory is one account: adopting would have been a second row on the same tokens.
      expect(accounts.list().map((a) => a.label)).toEqual(["work"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives a home directory that is not there at all", () => {
    const accounts = new AccountManager(openDb(":memory:"));
    // A machine with no `~/.claude` is a machine that starts with no accounts, not one that fails.
    expect(accounts.adoptAmbient(join(tmpdir(), "superfabric-nowhere-at-all"))).toBeUndefined();
    expect(accounts.list()).toEqual([]);
  });
});
