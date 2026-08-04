import { spawn as nodeSpawn } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import path from "node:path";
import { ACCOUNT_CREDENTIALS_FILE, type AccountLogin } from "@superfabric/shared";
import type { AccountManager } from "./accountManager.js";

/**
 * Logging an account in, without a terminal emulator.
 *
 * **This design is a measurement, not a preference.** The plan assumed an embedded xterm.js talking
 * to a PTY, and expected `node-pty` (a native module) to be unusable under Bun. Both assumptions
 * turned out wrong in opposite directions, and what was actually measured is:
 *
 * 1. `node-pty` *does* work under Bun (it is N-API, and Bun implements N-API) — but it ships no Linux
 *    prebuild, so depending on it would put a `node-gyp` build (python + a C++ toolchain) back into
 *    `pnpm install`, which is precisely the step adopting Bun deleted.
 * 2. `script -qec …` gives a real PTY through an ordinary spawn with no native module at all, so a
 *    PTY was available either way.
 * 3. `claude setup-token` needs a TTY — over a plain pipe it prints nothing and hangs — and the token
 *    it issues is `user:inference` scope only, which would not carry the usage endpoint M2's limit
 *    monitor is built on.
 * 4. **`claude auth login` needs no TTY at all.** Over plain pipes it prints "Opening browser to sign
 *    in…", then the OAuth URL, then `Paste code here if prompted > `, and it reads the code from
 *    stdin — an invalid one is answered with "Invalid code…" and it asks again. Its scope is the full
 *    `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers
 *    user:file_upload`.
 *
 * So the login is a two-field conversation, not a terminal: the server runs the command, hands the
 * operator the URL, and hands the CLI back the code they get from it. A terminal emulator would have
 * been an elaborate way to render a prompt and a text box — and the browser the operator needs for
 * OAuth is the one they are already looking at this UI in.
 *
 * The out-of-band case is covered too, and by the same signal: `CredentialsWatcher` notices
 * `.credentials.json` appearing whether SuperFabric ran the login or the operator did it themselves in
 * their own terminal.
 */

/** How long an unfinished login may sit before its subprocess is reaped. The OAuth code expires long before. */
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

/** How much of the CLI's output is kept for URL extraction and the last-word message. */
const OUTPUT_BUFFER_CHARS = 8000;

/** The login state of an account with nothing going on, which is most accounts most of the time. */
const IDLE: AccountLogin = { status: "idle", url: null, message: null };

/**
 * The part of a child process this needs. Node's `ChildProcess` (under Bun too) satisfies the default
 * implementation below; a test supplies a fake, so every state transition is exercised without ever
 * running the real CLI or touching a real account.
 */
export interface LoginChild {
  onOutput(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  write(text: string): void;
  kill(): void;
}

/** Start `claude auth login` against one config directory. The injection seam used by tests. */
export type SpawnLogin = (configDir: string) => LoginChild;

/**
 * The real thing: `claude auth login`, plain pipes, and this account's `CLAUDE_CONFIG_DIR`.
 *
 * `process.env` is spread first for the same reason the executor does it — an `env` handed to a spawn
 * replaces rather than merges, and a CLI without PATH or HOME cannot even find its own browser opener.
 * stderr is folded into the same stream as stdout because the operator wants one transcript of what
 * the command said, not two interleaved ones they have to reassemble.
 */
export const spawnClaudeLogin: SpawnLogin = (configDir) => {
  const child = nodeSpawn("claude", ["auth", "login"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    onOutput: (cb) => {
      child.stdout?.on("data", (d: Buffer) => cb(d.toString()));
      child.stderr?.on("data", (d: Buffer) => cb(d.toString()));
    },
    onExit: (cb) => {
      // 'close' rather than 'exit': it fires once the pipes have drained, so the last thing the CLI
      // said is in the buffer before the outcome is decided from it.
      child.on("close", (code) => cb(code));
      child.on("error", () => cb(-1));
    },
    write: (text) => { child.stdin?.write(text); },
    kill: () => { child.kill(); },
  };
};

/** One login in flight. */
interface Running {
  child: LoginChild;
  state: AccountLogin;
  /** Everything the CLI has said, trimmed to the tail. Used for the URL and the last-word message. */
  output: string;
  timer: ReturnType<typeof setTimeout>;
  /** A code has been sent and no answer has come back yet — so "Invalid code" belongs to *that* code. */
  awaitingAnswer: boolean;
  /**
   * The CLI has exited. The entry outlives it so a `failed` state stays on screen with its reason —
   * but a finished login is not a *running* one, and must never be what refuses the operator's next
   * attempt. That distinction is the whole reason this flag exists rather than the map's membership
   * being the answer.
   */
  finished: boolean;
  /**
   * The operator pressed Cancel. Kept because killing the child lands in `finish` with a non-zero
   * exit, which is indistinguishable from a real failure — and reporting "failed", with whatever the
   * CLI happened to have printed last, to someone who *chose* to stop is noise dressed as an error.
   * A cancelled login goes quietly back to idle; only a login that failed on its own says so.
   */
  cancelled: boolean;
}

export interface AccountLoginDeps {
  accounts: AccountManager;
  /** Something changed and every attached socket should see the fresh account list. */
  onChange: () => void;
  /** Test seam: defaults to the real `claude auth login`. */
  spawn?: SpawnLogin;
}

export class AccountLoginManager {
  private running = new Map<string, Running>();
  private readonly spawn: SpawnLogin;

  constructor(private deps: AccountLoginDeps) {
    this.spawn = deps.spawn ?? spawnClaudeLogin;
  }

  /** What the account list should say about this account's login. `idle` when nothing is running. */
  stateOf(accountId: string): AccountLogin {
    return this.running.get(accountId)?.state ?? IDLE;
  }

  /**
   * Start a login for one account.
   *
   * Refused while one is already running for the same account: two `claude auth login` processes
   * writing one config directory is the shared-directory corruption this whole feature exists to
   * avoid, arriving by another door.
   */
  begin(accountId: string): void {
    const account = this.deps.accounts.require(accountId);
    const existing = this.running.get(accountId);
    if (existing !== undefined && !existing.finished) {
      throw new Error(`a login is already running for ${JSON.stringify(account.label)}`);
    }

    const child = this.spawn(account.configDir);
    const entry: Running = {
      child,
      state: { status: "starting", url: null, message: null },
      output: "",
      timer: setTimeout(() => this.expire(accountId), LOGIN_TIMEOUT_MS),
      awaitingAnswer: false,
      finished: false,
      cancelled: false,
    };
    // Never the reason the process refuses to exit: an abandoned login is a stuck operator, not a
    // reason to keep the server alive.
    entry.timer.unref?.();
    this.running.set(accountId, entry);

    child.onOutput((chunk) => this.absorb(accountId, chunk));
    child.onExit((code) => this.finish(accountId, code));
    this.deps.onChange();
  }

  /**
   * Hand the CLI the code from the OAuth page.
   *
   * Accepted whenever a login is running and has got as far as printing its URL — including after an
   * "Invalid code" answer, because the CLI asks again rather than giving up, and so must we.
   */
  submitCode(accountId: string, code: string): void {
    const entry = this.running.get(accountId);
    if (entry === undefined || entry.finished) throw new Error("no login is running for this account");
    if (entry.state.url === null) {
      throw new Error("the login has not printed its sign-in URL yet");
    }
    entry.awaitingAnswer = true;
    entry.state = { status: "finishing", url: entry.state.url, message: null };
    // The CLI reads one line from stdin. The newline is the submit.
    entry.child.write(`${code.trim()}\n`);
    this.deps.onChange();
  }

  /**
   * Give up on a login. Killing the child is what ends it; `finish` does the tidying.
   *
   * Also clears a login that has already *failed* — the button reads "Dismiss" in that state, and
   * the entry is only still there to hold the reason on screen.
   */
  cancel(accountId: string): void {
    const entry = this.running.get(accountId);
    if (entry === undefined) return;
    if (entry.finished) {
      clearTimeout(entry.timer);
      this.running.delete(accountId);
      this.deps.onChange();
      return;
    }
    entry.cancelled = true;
    entry.child.kill();
  }

  /** Shutdown: no login outlives the server that started it. */
  stopAll(): void {
    for (const [, entry] of this.running) {
      clearTimeout(entry.timer);
      entry.child.kill();
    }
    this.running.clear();
  }

  /**
   * Read what the CLI just said.
   *
   * Two things are being looked for and they arrive in that order: the sign-in URL (which is what the
   * operator needs) and, after a code has been sent, whether it was rejected. Everything else is kept
   * only so the *last* line can be reported verbatim if the command fails — a paraphrase of an error
   * from a tool we do not own is a paraphrase that goes stale.
   */
  private absorb(accountId: string, chunk: string): void {
    const entry = this.running.get(accountId);
    if (entry === undefined || entry.finished) return;
    entry.output = (entry.output + stripAnsi(chunk)).slice(-OUTPUT_BUFFER_CHARS);

    const before = entry.state;
    // **Only complete lines are searched for the URL.** A pipe delivers whatever the kernel had, so a
    // chunk boundary lands mid-URL routinely — and a URL taken from a half-arrived line is a link the
    // operator clicks and gets a 404 from, which is indistinguishable to them from the login being
    // broken. Everything up to the last newline is known to be whole; the CLI prints its URL on a line
    // of its own, so nothing is lost by waiting for it.
    //
    // A freshly found URL wins over the one already on screen (a retry within the same process prints
    // a second one), and the stored URL is the fallback rather than the other way round — the buffer
    // is cleared after a rejected code, and the operator must not lose their link to that.
    const settled = entry.output.slice(0, entry.output.lastIndexOf("\n") + 1);
    const url = extractUrl(settled) ?? entry.state.url;

    if (entry.awaitingAnswer && /invalid code/i.test(entry.output)) {
      // The CLI re-prompts, so this is not the end of the login — it is a retry, and the operator
      // needs to be told why rather than watching a spinner that never resolves.
      entry.awaitingAnswer = false;
      entry.output = "";
      entry.state = { status: "awaiting_code", url, message: "That code was not accepted. Try again." };
    } else if (entry.state.status === "starting" && url !== null) {
      entry.state = { status: "awaiting_code", url, message: null };
    } else if (url !== entry.state.url) {
      entry.state = { ...entry.state, url };
    }

    if (entry.state !== before) this.deps.onChange();
  }

  /**
   * The command ended. Exit 0 is a login that worked — the account's `credentialsPresent` will say so
   * on the next listing, and on macOS (where the tokens may go to the keychain instead of
   * `.credentials.json`) the clean exit is the *only* signal, which is why it is not the file check
   * alone that decides.
   *
   * Anything else keeps the account in `failed` with the CLI's own last line attached, so the entry
   * stays on screen with a reason instead of the flow silently resetting to "not logged in".
   */
  private finish(accountId: string, code: number | null): void {
    const entry = this.running.get(accountId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.running.delete(accountId);

    if (code === 0) {
      this.deps.accounts.touch(accountId);
    } else if (entry.cancelled) {
      // Asked for. Back to idle with nothing said, rather than an "error" whose text is whatever the
      // CLI was in the middle of printing when it was killed.
    } else {
      // Re-inserted with no child: the state is the record of what happened, and it is cleared by
      // the next `begin` (which replaces the entry) rather than by a timer nobody asked for.
      this.running.set(accountId, {
        ...entry,
        finished: true,
        child: { onOutput: () => {}, onExit: () => {}, write: () => {}, kill: () => {} },
        state: {
          status: "failed",
          url: entry.state.url,
          message: lastLine(entry.output) ?? `claude auth login exited with code ${code ?? "unknown"}`,
        },
      });
    }
    this.deps.onChange();
  }

  /** An abandoned login. Killing the child lands in `finish`, which reports it as a failure. */
  private expire(accountId: string): void {
    const entry = this.running.get(accountId);
    if (entry === undefined || entry.finished) return;
    // Not `cancelled`: nobody asked for this, and an operator who wandered off has to be told why the
    // flow is no longer waiting for them.
    entry.output = "The sign-in was not completed in time. Start it again.";
    entry.child.kill();
  }
}

/**
 * Watch each account's config directory and say when `.credentials.json` appears or goes.
 *
 * This is what closes the loop for the operator, and it deliberately does not care *who* logged in:
 * the in-app flow above and an operator running `claude auth login` in their own terminal produce the
 * same file, and the account lights up either way.
 *
 * `persistent: false` so a watcher is never the reason the process stays alive, and every callback is
 * wrapped — a watcher firing after the directory has been deleted must not take a live server with it.
 */
export class CredentialsWatcher {
  /** configDir -> watcher. Keyed by directory rather than by account: one directory is one account. */
  private watchers = new Map<string, FSWatcher>();

  constructor(private onChange: () => void) {}

  /**
   * Watch exactly the given directories: new ones start, ones no longer listed stop. Called at boot
   * and whenever the account list changes, so it is idempotent by construction.
   */
  sync(configDirs: readonly string[]): void {
    const wanted = new Set(configDirs);
    for (const [dir, watcher] of this.watchers) {
      if (wanted.has(dir)) continue;
      watcher.close();
      this.watchers.delete(dir);
    }
    for (const dir of wanted) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, { persistent: false }, (_event, name) => {
          // A rename event carries the file name on Linux; when it does not, re-checking everything
          // is cheap and never wrong.
          if (name !== null && name !== undefined && path.basename(String(name)) !== ACCOUNT_CREDENTIALS_FILE) return;
          try { this.onChange(); } catch { /* a listener's problem is not the watcher's */ }
        });
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, watcher);
      } catch {
        // An unwatchable directory (removed under us, a filesystem with no inotify) is not a reason to
        // fail the server: the account list still reports `credentialsPresent` correctly every time it
        // is built, this only makes it *instant*.
      }
    }
  }

  close(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}

/**
 * The sign-in URL out of whatever the CLI printed.
 *
 * The last one wins: the command prints one URL, but a retry within the same process prints a second
 * and the operator must be sent to the one that is actually current.
 */
export function extractUrl(output: string): string | null {
  const matches = output.match(/https?:\/\/[^\s"'<>]+/g);
  if (matches === null) return null;
  const url = matches[matches.length - 1]!;
  // Trailing punctuation from a sentence the URL was embedded in is not part of the URL.
  return url.replace(/[.,;:)\]]+$/, "");
}

/**
 * ANSI/OSC escape sequences, so the regexes above look at text rather than at colour codes.
 *
 * `claude auth login` over a pipe prints plain text — it does not believe it is on a terminal — so in
 * practice this changes nothing today. It exists because the *next* version of the CLI may decide
 * otherwise, and a sign-in URL the operator cannot click because it arrived wrapped in an OSC-8
 * hyperlink would be a silent, total failure of the feature. (`claude setup-token`, which does use a
 * TUI, prints exactly that — see the probe notes at the top of this file.)
 *
 * OSC first, because its payload may contain anything at all including something shaped like a CSI
 * sequence; then CSI; then the two-character escapes. Written with `\u001b` rather than a literal
 * control byte so the source stays greppable and survives a copy-paste.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\u001b[78>=c]/g, "");
}

/** The last thing the CLI actually said, for reporting a failure in its own words. */
function lastLine(output: string): string | null {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  const line = lines[lines.length - 1];
  return line === undefined ? null : line.slice(0, 400);
}
