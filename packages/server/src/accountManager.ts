import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { ACCOUNT_CREDENTIALS_FILE, AccountInfo, type AccountLogin } from "@superfabric/shared";
import type { Db } from "./db.js";

/** Row shape of `accounts`. */
interface AccountRow {
  id: string;
  label: string;
  config_dir: string;
  created_at: number;
  last_used_at: number | null;
}

export interface CreateAccountOptions {
  label: string;
  /** Absolute path of this account's `CLAUDE_CONFIG_DIR`. Created if absent. */
  configDir: string;
}

/** The login state of an account that has none: nothing is running, nothing has been said. */
const NO_LOGIN: AccountLogin = { status: "idle", url: null, message: null };

/** `server_state` key: this server has already looked at the operator's own `~/.claude` once. */
const AMBIENT_ADOPTED = "ambient_account_adopted";

/**
 * What the adopted `~/.claude` is called. Plain and true rather than clever: it is the operator's own
 * login, the one every unbound agent already runs on, and a label like "default" would read as a
 * setting rather than as a subscription.
 */
const AMBIENT_LABEL = "personal";

/**
 * Accounts: one Claude subscription per `CLAUDE_CONFIG_DIR`, and the row that names it.
 *
 * **Machine-wide, not per project** — see `AccountInfo` in the protocol for why. This class has no
 * `projectId` anywhere in it, and that absence is the design rather than an omission.
 *
 * **One config directory is one account, always.** The CLI keeps an account's OAuth tokens in that
 * directory and rewrites the refresh token in place; two accounts sharing one would silently
 * invalidate each other. `create` refuses a duplicate, the schema refuses it too (migration 9), and
 * the path is resolved through `realpath` first so `/a/b`, `/a/b/`, `/a/./b` and a symlink to the same
 * directory are all recognised as the one directory they are — a uniqueness check on the string the
 * operator happened to type would let the invariant through the back door.
 *
 * It deliberately knows nothing about sessions beyond counting the ones that reference an account,
 * and nothing at all about logging in: `AccountLoginManager` owns that, and hands its state in here
 * so one `AccountInfo` describes the whole account.
 */
export class AccountManager {
  private readonly now: () => number;
  private readonly stmts;
  /**
   * Where the transient login state comes from. Injected as a callback rather than as the login
   * manager itself, so the two do not have to know about each other: the login manager already needs
   * `configDirOf` from here, and a mutual import would be a cycle. An account with nothing going on
   * reports `NO_LOGIN`, which is the state of every account most of the time.
   */
  private loginState: (accountId: string) => AccountLogin = () => NO_LOGIN;
  /**
   * Announce-your-own-changes, the same shape `TaskStore` and `FactoryBus` use. The hub subscribes to
   * push a fresh list, and boot subscribes to point the credentials watcher at the new set of
   * directories — neither of which can be done from the call sites, because `touch()` is called deep
   * inside starting a session and nothing there holds a socket.
   */
  private listeners: (() => void)[] = [];

  constructor(private db: Db, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.now = now;
    this.stmts = {
      insert: db.prepare("INSERT INTO accounts (id, label, config_dir) VALUES (?, ?, ?)"),
      one: db.prepare("SELECT id, label, config_dir, created_at, last_used_at FROM accounts WHERE id = ?"),
      byDir: db.prepare("SELECT id, label, config_dir, created_at, last_used_at FROM accounts WHERE config_dir = ?"),
      // Creation order, like the project switcher's, and for the same reason: a list that reshuffles
      // as you use it is a list you have to re-read every time.
      list: db.prepare("SELECT id, label, config_dir, created_at, last_used_at FROM accounts ORDER BY created_at, rowid"),
      remove: db.prepare("DELETE FROM accounts WHERE id = ?"),
      touch: db.prepare("UPDATE accounts SET last_used_at = ? WHERE id = ?"),
      sessionsOn: db.prepare("SELECT COUNT(*) c FROM sessions WHERE account_id = ?"),
      // A room's binding is a *default* for agents not yet created, so removal clears it rather than
      // being blocked by it — but never silently: `remove` reports how many it cleared.
      roomsOn: db.prepare("SELECT COUNT(*) c FROM rooms WHERE account_id = ?"),
      unbindRooms: db.prepare("UPDATE rooms SET account_id = NULL WHERE account_id = ?"),
      // Things this server has done once and must not repeat — see `adoptAmbient`.
      stateOf: db.prepare("SELECT value FROM server_state WHERE key = ?"),
      setState: db.prepare(
        "INSERT INTO server_state (key, value, set_at) VALUES (?, ?, ?)"
        + " ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at",
      ),
    };
  }

  /**
   * Where the live login state is read from. Called by whoever wires the server together; without it
   * every account simply reports `idle`, which is what a server with no login manager truly is.
   */
  setLoginStateSource(source: (accountId: string) => AccountLogin): void {
    this.loginState = source;
  }

  /** Be told when the set of accounts, or what is known about one, changed. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** A listener's failure is that listener's problem; it must never fail the write that triggered it. */
  private announce(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* ignore */ }
    }
  }

  /**
   * Add an account. The directory is created if it is not there yet — unlike a project root, this is
   * *our* folder rather than the operator's repository, and an account with nowhere to put its
   * credentials is not an account.
   */
  create(opts: CreateAccountOptions): AccountInfo {
    const label = opts.label.trim();
    if (label === "") throw new Error("an account needs a label");

    const given = opts.configDir.trim();
    if (!path.isAbsolute(given)) {
      throw new Error(`a config directory must be an absolute path: ${JSON.stringify(opts.configDir)}`);
    }
    const dir = this.prepareDir(path.resolve(given));

    // `== null`, not `=== undefined`: "no such row" is `null` for the driver db.ts uses.
    const clash = this.stmts.byDir.get(dir) as AccountRow | null;
    if (clash != null) {
      throw new Error(
        `${dir} is already account ${JSON.stringify(clash.label)} — one config directory is one `
        + "account: the CLI rewrites its refresh token in place there, so two accounts sharing it "
        + "would log each other out",
      );
    }

    const id = randomUUID();
    this.stmts.insert.run(id, label, dir);
    this.announce();
    return this.get(id)!;
  }

  /**
   * Adopt the operator's own `~/.claude` as an account — **once, and only if it is already logged in**.
   *
   * A machine where Claude Code is set up already *has* a subscription, and SuperFabric already runs
   * every unbound agent on it (a NULL `account_id` is exactly this directory). Showing "No accounts
   * yet" there is false: the account is right in front of us, on disk, at the path the CLI documents.
   * Adopting it makes it visible, gives it a meter (an account with no row cannot be polled, so the
   * limit monitor was blind to the one subscription most operators use), and lets a room be bound to
   * it explicitly.
   *
   * Three refusals, each of which matters:
   *
   * - **Only with credentials present.** An empty `~/.claude`, or one holding only settings, is not
   *   an account; the login lives in `.credentials.json` (and on macOS may be in the keychain
   *   instead, which is why this is best-effort discovery and not the only way in).
   * - **Only once.** `server_state` remembers the adoption, so an operator who removes the row is not
   *   handed it back on the next boot. A delete that undoes itself is the bug the boot project had.
   * - **Never a duplicate.** If some account already points at that directory — the operator added it
   *   by hand — nothing happens, because one directory is one account.
   *
   * Returns the account it adopted, or `undefined` when it did nothing. Never throws: a machine with
   * no home directory readable is a machine that starts with no accounts, not one that fails to boot.
   */
  adoptAmbient(configDir: string): AccountInfo | undefined {
    try {
      if (this.stmts.stateOf.get(AMBIENT_ADOPTED) != null) return undefined;
      const dir = path.resolve(configDir);
      if (!existsSync(path.join(dir, ACCOUNT_CREDENTIALS_FILE))) return undefined;
      const canonical = realpathSync(dir);
      // Recorded before the insert, and recorded even when the insert is skipped: "we have looked at
      // this once" is the fact worth remembering either way.
      this.stmts.setState.run(AMBIENT_ADOPTED, canonical, this.now());
      if (this.stmts.byDir.get(canonical) != null) return undefined;

      const id = randomUUID();
      this.stmts.insert.run(id, AMBIENT_LABEL, canonical);
      this.announce();
      return this.get(id)!;
    } catch {
      return undefined;
    }
  }

  /**
   * Make sure the config directory exists and hand back its canonical path.
   *
   * `realpath` after the `mkdir` rather than before: it is the only way to resolve symlinks, and it
   * needs the directory to exist to do it. This is what makes the uniqueness check about the
   * *directory* rather than about the string typed into the box.
   */
  private prepareDir(dir: string): string {
    if (existsSync(dir) && !statSync(dir).isDirectory()) {
      throw new Error(`config directory is not a directory: ${dir}`);
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return realpathSync(dir);
  }

  /** Every account on this server, in creation order. */
  list(): AccountInfo[] {
    return (this.stmts.list.all() as AccountRow[]).map((r) => this.toInfo(r));
  }

  /** `undefined` for an unknown id — the absent-row shape the rest of the package speaks. */
  get(id: string): AccountInfo | undefined {
    const row = this.stmts.one.get(id) as AccountRow | null;
    return row == null ? undefined : this.toInfo(row);
  }

  /** The same, as an assertion: callers that must have an account say so once, here. */
  require(id: string): AccountInfo {
    const account = this.get(id);
    if (account === undefined) throw new Error(`unknown account ${id}`);
    return account;
  }

  /**
   * This account's `CLAUDE_CONFIG_DIR`, or `undefined` when there is no such account.
   *
   * The one thing `SessionManager` asks for. `undefined` rather than a throw because a session row
   * can outlive the account it names (nothing deletes history), and an agent whose account row has
   * gone must still start — on the ambient `~/.claude`, which is the honest fallback.
   */
  configDirOf(id: string | null): string | undefined {
    if (id === null) return undefined;
    const row = this.stmts.one.get(id) as AccountRow | null;
    return row == null ? undefined : row.config_dir;
  }

  /**
   * Has this account been logged in? True exactly when `<configDir>/.credentials.json` is there.
   *
   * That file appearing is how the server learns a login finished, whether it was driven from the UI
   * or by the operator in their own terminal. It is a *hint*, not a proof of a working session: the
   * file could hold an expired token, and on macOS the CLI may use the keychain instead — which is
   * why the login flow also treats the CLI's own clean exit as success rather than relying on this
   * alone.
   */
  credentialsPresent(id: string): boolean {
    const dir = this.configDirOf(id);
    if (dir === undefined) return false;
    return existsSync(path.join(dir, ACCOUNT_CREDENTIALS_FILE));
  }

  /**
   * Forget an account. Refused while any session references it: an agent's `CLAUDE_CONFIG_DIR` would
   * silently become the operator's own `~/.claude` on its next restart, which is the wrong
   * subscription doing the work and no way to notice.
   *
   * A *room's* binding is only a default for agents not yet created, so it is cleared here instead of
   * blocking the removal — and the count comes back so the caller can say so out loud rather than
   * leaving the operator to discover it.
   */
  remove(id: string): { label: string; roomsUnbound: number } {
    const account = this.require(id);
    const sessions = (this.stmts.sessionsOn.get(id) as { c: number }).c;
    if (sessions > 0) {
      throw new Error(
        `account ${JSON.stringify(account.label)} still runs ${sessions} `
        + `session${sessions === 1 ? "" : "s"} — move or stop them first`,
      );
    }
    const roomsUnbound = (this.stmts.roomsOn.get(id) as { c: number }).c;
    this.db.transaction(() => {
      this.stmts.unbindRooms.run(id);
      this.stmts.remove.run(id);
    })();
    this.announce();
    return { label: account.label, roomsUnbound };
  }

  /** Stamp "an agent started on this one just now". Unknown ids are a no-op, not an error. */
  touch(id: string): void {
    if (this.stmts.touch.run(this.now(), id).changes === 0) return;
    this.announce();
  }

  private toInfo(row: AccountRow): AccountInfo {
    return AccountInfo.parse({
      id: row.id,
      label: row.label,
      configDir: row.config_dir,
      credentialsPresent: existsSync(path.join(row.config_dir, ACCOUNT_CREDENTIALS_FILE)),
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      login: this.loginState(row.id),
    });
  }
}
