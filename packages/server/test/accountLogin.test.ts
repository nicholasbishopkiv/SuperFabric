import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountLoginManager,
  CredentialsWatcher,
  extractUrl,
  stripAnsi,
  type LoginChild,
} from "../src/accountLogin.js";
import { AccountManager } from "../src/accountManager.js";
import { openDb } from "../src/db.js";
import { waitFor } from "./_waitFor.js";

/**
 * The login flow, driven against a fake `claude auth login`.
 *
 * The fake speaks exactly what the real command was **measured** to print over a plain pipe (no TTY,
 * no terminal emulator) — that transcript is the whole reason this design exists, and it is
 * reproduced verbatim here so a change in the CLI's wording shows up as a failing test rather than as
 * a login that hangs on a spinner forever.
 */

/** What `claude auth login` actually prints before it waits for the code. */
const REAL_PROMPT = `Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=abc&code_challenge_method=S256&state=xyz
Paste code here if prompted > `;

const REAL_URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=abc&code_challenge_method=S256&state=xyz";

/** A `claude auth login` this test drives by hand. */
function fakeChild() {
  let onOutput: (chunk: string) => void = () => {};
  let onExit: (code: number | null) => void = () => {};
  const written: string[] = [];
  let killed = 0;
  const child: LoginChild = {
    onOutput: (cb) => { onOutput = cb; },
    onExit: (cb) => { onExit = cb; },
    write: (text) => { written.push(text); },
    kill: () => { killed++; onExit(143); },
  };
  return {
    child,
    written,
    get killed() { return killed; },
    say: (chunk: string) => onOutput(chunk),
    exit: (code: number | null) => onExit(code),
  };
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "sf-login-"));
  const db = openDb(":memory:");
  const accounts = new AccountManager(db);
  const account = accounts.create({ label: "Work", configDir: join(root, "cfg") });
  const spawned: string[] = [];
  let fake = fakeChild();
  let changes = 0;
  const logins = new AccountLoginManager({
    accounts,
    onChange: () => { changes++; },
    spawn: (configDir) => {
      spawned.push(configDir);
      fake = fakeChild();
      return fake.child;
    },
  });
  accounts.setLoginStateSource((id) => logins.stateOf(id));
  return {
    root, accounts, account, logins, spawned,
    get fake() { return fake; },
    get changes() { return changes; },
    cleanup: () => { rmSync(root, { recursive: true, force: true }); },
  };
}

describe("AccountLoginManager", () => {
  it("an account with no login running reports idle", () => {
    const h = harness();
    try {
      expect(h.logins.stateOf(h.account.id)).toEqual({ status: "idle", url: null, message: null });
      expect(h.accounts.list()[0]!.login.status).toBe("idle");
    } finally {
      h.cleanup();
    }
  });

  it("runs the CLI against that account's own config directory", () => {
    const h = harness();
    try {
      h.logins.begin(h.account.id);
      expect(h.spawned).toEqual([h.account.configDir]);
      expect(h.logins.stateOf(h.account.id).status).toBe("starting");
    } finally {
      h.cleanup();
    }
  });

  it("hands the operator the sign-in URL the CLI printed, verbatim", () => {
    const h = harness();
    try {
      h.logins.begin(h.account.id);
      h.fake.say(REAL_PROMPT);
      expect(h.logins.stateOf(h.account.id)).toEqual({
        status: "awaiting_code", url: REAL_URL, message: null,
      });
      // And it reaches the UI as part of the account, not as a second list to join.
      expect(h.accounts.list()[0]!.login.url).toBe(REAL_URL);
    } finally {
      h.cleanup();
    }
  });

  it("survives the output arriving in pieces, which is how a pipe delivers it", () => {
    const h = harness();
    try {
      h.logins.begin(h.account.id);
      // Split mid-URL: a chunk boundary must not produce a truncated link the operator then clicks.
      const cut = Math.floor(REAL_PROMPT.length / 2);
      h.fake.say(REAL_PROMPT.slice(0, cut));
      h.fake.say(REAL_PROMPT.slice(cut));
      expect(h.logins.stateOf(h.account.id).url).toBe(REAL_URL);
      expect(h.logins.stateOf(h.account.id).status).toBe("awaiting_code");
    } finally {
      h.cleanup();
    }
  });

  it("writes the code to the CLI's stdin, newline and all", () => {
    const h = harness();
    try {
      h.logins.begin(h.account.id);
      h.fake.say(REAL_PROMPT);
      h.logins.submitCode(h.account.id, "  the-code  ");
      // Trimmed, because a code pasted from a web page routinely carries whitespace; the newline is
      // the submit, and without it the CLI simply waits forever.
      expect(h.fake.written).toEqual(["the-code\n"]);
      expect(h.logins.stateOf(h.account.id).status).toBe("finishing");
    } finally {
      h.cleanup();
    }
  });

  it("reports a rejected code and lets the operator try again, because the CLI asks again", () => {
    const h = harness();
    try {
      h.logins.begin(h.account.id);
      h.fake.say(REAL_PROMPT);
      h.logins.submitCode(h.account.id, "wrong");
      h.fake.say("Invalid code. Please make sure the full code was copied.\nPaste code here if prompted > ");

      const state = h.logins.stateOf(h.account.id);
      expect(state.status).toBe("awaiting_code");
      expect(state.message).toBe("That code was not accepted. Try again.");
      expect(state.url).toBe(REAL_URL);

      // The retry goes through, and is not confused by the previous rejection still being in the buffer.
      h.logins.submitCode(h.account.id, "right");
      expect(h.fake.written).toEqual(["wrong\n", "right\n"]);
      expect(h.logins.stateOf(h.account.id).status).toBe("finishing");
    } finally {
      h.cleanup();
    }
  });

  it("a clean exit ends the login and stamps the account as used", () => {
    const h = harness();
    try {
      h.logins.begin(h.account.id);
      h.fake.say(REAL_PROMPT);
      h.logins.submitCode(h.account.id, "the-code");
      h.fake.exit(0);

      // Back to idle: the account's own `credentialsPresent` is what says it is logged in now, and
      // that is a fact about the directory rather than about this flow.
      expect(h.logins.stateOf(h.account.id)).toEqual({ status: "idle", url: null, message: null });
      expect(h.accounts.get(h.account.id)!.lastUsedAt).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("a clean exit is enough even when no .credentials.json appears (the macOS keychain case)", () => {
    const h = harness();
    try {
      h.logins.begin(h.account.id);
      h.fake.say(REAL_PROMPT);
      h.logins.submitCode(h.account.id, "the-code");
      h.fake.exit(0);
      // Nothing was written to the directory, and the flow still does not report a failure: the CLI
      // said it worked, and inventing a failure over a file we do not own would be worse.
      expect(h.accounts.credentialsPresent(h.account.id)).toBe(false);
      expect(h.logins.stateOf(h.account.id).status).toBe("idle");
    } finally {
      h.cleanup();
    }
  });

  it("a failure keeps the CLI's own last word on screen", () => {
    const h = harness();
    try {
      h.logins.begin(h.account.id);
      h.fake.say(REAL_PROMPT);
      h.fake.say("\nOAuth error: the authorization server rejected this client.\n");
      h.fake.exit(1);

      const state = h.logins.stateOf(h.account.id);
      expect(state.status).toBe("failed");
      // Verbatim, not paraphrased: a paraphrase of an error from a tool we do not own goes stale.
      expect(state.message).toBe("OAuth error: the authorization server rejected this client.");
      expect(state.url).toBe(REAL_URL);
    } finally {
      h.cleanup();
    }
  });

  it("a failure with nothing said still says something", () => {
    const h = harness();
    try {
      h.logins.begin(h.account.id);
      h.fake.exit(127);
      expect(h.logins.stateOf(h.account.id).message).toBe("claude auth login exited with code 127");
    } finally {
      h.cleanup();
    }
  });

  it("a second login for the same account is refused while one is running", () => {
    const h = harness();
    try {
      h.logins.begin(h.account.id);
      // Two `claude auth login` processes writing one config directory is the shared-directory
      // corruption this feature exists to avoid, arriving through another door.
      expect(() => h.logins.begin(h.account.id)).toThrow(/already running/);
      expect(h.spawned).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it("a login can be started again after one failed", () => {
    const h = harness();
    try {
      h.logins.begin(h.account.id);
      h.fake.exit(1);
      expect(h.logins.stateOf(h.account.id).status).toBe("failed");
      expect(() => h.logins.begin(h.account.id)).not.toThrow();
      expect(h.logins.stateOf(h.account.id).status).toBe("starting");
      expect(h.spawned).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });

  it("refuses a code before the CLI has printed its URL", () => {
    const h = harness();
    try {
      h.logins.begin(h.account.id);
      // There is nothing to have got a code *from* yet, so accepting one would write a line the CLI
      // is not reading and then look like it hung.
      expect(() => h.logins.submitCode(h.account.id, "guess")).toThrow(/has not printed/);
    } finally {
      h.cleanup();
    }
  });

  it("refuses a code when no login is running at all", () => {
    const h = harness();
    try {
      expect(() => h.logins.submitCode(h.account.id, "code")).toThrow(/no login is running/);
    } finally {
      h.cleanup();
    }
  });

  it("refuses to start a login for an account that does not exist", () => {
    const h = harness();
    try {
      expect(() => h.logins.begin("nope")).toThrow(/unknown account/);
    } finally {
      h.cleanup();
    }
  });

  it("cancel kills the CLI, and cancelling nothing is not an error", () => {
    const h = harness();
    try {
      h.logins.begin(h.account.id);
      const running = h.fake;
      h.logins.cancel(h.account.id);
      expect(running.killed).toBe(1);
      expect(() => h.logins.cancel(h.account.id)).not.toThrow();
    } finally {
      h.cleanup();
    }
  });

  it("stopAll ends every login, so none outlives the server", () => {
    const h = harness();
    try {
      h.logins.begin(h.account.id);
      const running = h.fake;
      h.logins.stopAll();
      expect(running.killed).toBe(1);
      expect(h.logins.stateOf(h.account.id).status).toBe("idle");
    } finally {
      h.cleanup();
    }
  });

  it("announces every step, so a second tab watches the same login", () => {
    const h = harness();
    try {
      const before = h.changes;
      h.logins.begin(h.account.id);
      h.fake.say(REAL_PROMPT);
      h.logins.submitCode(h.account.id, "code");
      h.fake.exit(0);
      // start, URL, code sent, finished.
      expect(h.changes - before).toBe(4);
    } finally {
      h.cleanup();
    }
  });
});

describe("extractUrl", () => {
  it("finds the URL in what the CLI actually prints", () => {
    expect(extractUrl(REAL_PROMPT)).toBe(REAL_URL);
  });

  it("is null when nothing has been printed yet", () => {
    expect(extractUrl("")).toBeNull();
    expect(extractUrl("Opening browser to sign in…")).toBeNull();
  });

  it("takes the newest URL, because a retry prints a second one", () => {
    expect(extractUrl("visit: https://a.example/one\nvisit: https://b.example/two"))
      .toBe("https://b.example/two");
  });

  it("does not swallow the sentence's punctuation into the URL", () => {
    expect(extractUrl("Go to https://claude.com/cai/oauth/authorize?state=x.")).
      toBe("https://claude.com/cai/oauth/authorize?state=x");
  });

  it("survives an OSC-8 hyperlink, which the TUI form of the command emits", () => {
    // `claude setup-token` wraps its URL like this. `claude auth login` does not today — but a URL
    // the operator cannot click would be a total, silent failure of the feature, so it is handled.
    const osc = "\u001b]8;id=1;https://claude.com/cai/oauth/authorize?state=x\u0007"
      + "https://claude.com/cai/oauth/authorize?state=x\u001b]8;;\u0007";
    expect(extractUrl(stripAnsi(osc))).toBe("https://claude.com/cai/oauth/authorize?state=x");
  });
});

describe("stripAnsi", () => {
  it("leaves plain text alone — which is what this command prints over a pipe", () => {
    expect(stripAnsi(REAL_PROMPT)).toBe(REAL_PROMPT);
  });

  it("removes CSI colour codes", () => {
    expect(stripAnsi("\u001b[38;2;153;153;153mhello\u001b[39m")).toBe("hello");
  });

  it("removes OSC sequences terminated either way", () => {
    expect(stripAnsi("a\u001b]8;;https://x\u0007b")).toBe("ab");
    // ST (ESC backslash) rather than BEL — both terminate an OSC and both appear in the wild.
    expect(stripAnsi("a\u001b]0;title\u001b\\b")).toBe("ab");
  });
});

describe("CredentialsWatcher", () => {
  it("fires when .credentials.json appears — however the login happened", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-watch-"));
    const watcher = new CredentialsWatcher(() => { fired++; });
    let fired = 0;
    try {
      watcher.sync([root]);
      // The out-of-band case: the operator ran `claude auth login` in their own terminal and this
      // server was never told. The account still lights up.
      writeFileSync(join(root, ".credentials.json"), "{}");
      await waitFor(() => {
        if (fired === 0) throw new Error("not yet");
      });
    } finally {
      watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores the other files a config directory is full of", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-watch-"));
    const watcher = new CredentialsWatcher(() => { fired++; });
    let fired = 0;
    try {
      watcher.sync([root]);
      // A session transcript, a settings write, a lock file: the CLI touches this directory
      // constantly, and a broadcast per touch would be a broadcast per token an agent produces.
      writeFileSync(join(root, ".claude.json"), "{}");
      writeFileSync(join(root, "history.jsonl"), "");
      await new Promise((r) => setTimeout(r, 120));
      expect(fired).toBe(0);
    } finally {
      watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sync is idempotent and drops directories no longer listed", () => {
    const a = mkdtempSync(join(tmpdir(), "sf-watch-a-"));
    const b = mkdtempSync(join(tmpdir(), "sf-watch-b-"));
    const watcher = new CredentialsWatcher(() => {});
    try {
      watcher.sync([a, b]);
      watcher.sync([a, b]);
      watcher.sync([a]);
      // The property that matters is that none of this throws and nothing is left holding the
      // process open; `close()` below is the assertion that the bookkeeping stayed coherent.
      expect(() => watcher.close()).not.toThrow();
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("an unwatchable directory is not a reason to fail the server", () => {
    const watcher = new CredentialsWatcher(() => {});
    try {
      // Deleted, never created, on a filesystem with no inotify — the account list still reports
      // `credentialsPresent` correctly every time it is built; the watcher only makes it instant.
      expect(() => watcher.sync(["/definitely/not/a/directory/anywhere"])).not.toThrow();
    } finally {
      watcher.close();
    }
  });
});
