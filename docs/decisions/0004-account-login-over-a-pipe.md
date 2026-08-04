# 0004 — logging an account in over a pipe, not through a terminal emulator

Date: 2026-08-04 · Status: accepted

## Context

M2 gives SuperFabric several Claude subscriptions: an account is a `CLAUDE_CONFIG_DIR`, and a
fresh one has no credentials until someone logs into it. The operator has to be able to do that
from the app — telling them "go and run a command somewhere else" for the central setup step of
the headline feature is a poor answer for a product whose whole premise is that it manages the
accounts for you.

The M2 plan's intended design was an **embedded terminal**: xterm.js in the browser talking to a
PTY on the server running interactive `claude`. It also predicted the obstacle: `node-pty` is a
native module, and native modules were the reason `better-sqlite3` was dropped when the server
moved to Bun (see [0001](0001-bun-runtime-keep-vite.md)). The plan therefore asked for a probe
before any UI was built on the assumption.

The probe found something better than either the intended design or its fallback.

## What was measured

Against throwaway `CLAUDE_CONFIG_DIR`s, with `claude` 2.1.220 on Bun 1.3.14. No account was
logged in: every probe was stopped at the point a human would enter a credential.

1. **`node-pty` works under Bun.** It is N-API and Bun implements N-API; a PTY spawned through it
   behaved identically under `node` and `bun` (`tty` reported `/dev/pts/N`, `tput cols` honoured
   the requested width). *But* the npm package ships prebuilds only for darwin and win32 — on
   Linux `npm install` runs `node-gyp`, so adopting it would put a python + C++ toolchain back
   into `pnpm install`. That is exactly the step the Bun adoption deleted.
2. **A PTY needs no native module anyway.** `script -qec "<cmd>" /dev/null` under an ordinary
   `Bun.spawn` gives a real controlling terminal. It has no window-size control and is
   util-linux-shaped, but it works.
3. **`claude setup-token` needs a TTY, and issues the wrong token.** Over a plain pipe it prints
   *nothing at all* and hangs until killed. Under a PTY it works — but it is an Ink TUI, so its
   output is a stream of cursor addressing and OSC-8 hyperlinks that has to be parsed as a screen
   rather than as text. And the CLI's own strings say the token it issues is `user:inference`
   scope only: not enough for the usage endpoint the M2 limit monitor is built on.
4. **`claude auth login` needs no TTY.** Over plain pipes it prints, in plain text:

   ```
   Opening browser to sign in…
   If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…
   Paste code here if prompted >
   ```

   …and it reads the code from stdin. Writing an obviously-invalid string to stdin was answered
   with `Invalid code. Please make sure the full code was copied.` and a re-prompt, which is how
   we know the pipe is genuinely being read. Its requested scope is the full
   `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers
   user:file_upload`.

Plain interactive `claude` was also tried against a fresh directory: it opens with a theme
picker and a multi-step first-run wizard, so driving *it* would genuinely have needed a terminal
emulator. `claude auth login` is the single-purpose door.

## Decision

**No terminal emulator, no PTY, no native module. The server runs `claude auth login` against the
account's config directory over plain pipes and turns it into a two-field conversation in the
HUD:** the URL to open, and a box for the code that page gives back.

`AccountLoginManager` (`packages/server/src/accountLogin.ts`) owns the state machine —
`starting → awaiting_code → finishing`, with `failed` carrying the CLI's own last line verbatim.
`CredentialsWatcher` watches each account's directory and lights the account up the moment
`.credentials.json` appears.

## Why this one

- **It is what actually works.** Everything else on the list was either a build-step regression, a
  screen-scrape of a TUI, or the wrong token.
- **A terminal was the wrong shape for the job.** The whole interaction is "here is a link" and
  "here is the code" — and the browser needed for the OAuth page is the one the operator is
  already reading this UI in. An xterm.js would have been an elaborate way to render one prompt
  and one text box.
- **The dependency count does not move.** No `node-pty`, no xterm.js, no `script` shelling, no
  `node-gyp`. `pnpm install` stays a download.
- **The out-of-band path is covered by the same mechanism.** `CredentialsWatcher` does not care
  who logged in: an operator who prefers their own terminal runs
  `CLAUDE_CONFIG_DIR=<dir> claude auth login` and the account lights up in the HUD anyway. The UI
  shows that command, filled in and copyable, next to the in-app button.

## Consequences and risks

- **This rests on the output of a tool we do not own.** If `claude auth login` changes its wording
  or starts requiring a TTY, the flow breaks. Three mitigations: the URL is found by regex over
  *complete lines* rather than by matching the sentence around it; ANSI/OSC stripping is already
  in place so a future TUI form does not produce an unclickable link; and the measured transcript
  is reproduced verbatim in `test/accountLogin.test.ts`, so a change shows up as a failing test
  rather than as a login that hangs. The out-of-band command remains as the floor.
- **`credentialsPresent` is a hint, not a proof.** On macOS the CLI may put tokens in the keychain
  rather than in `.credentials.json`. So a clean exit from `claude auth login` is *also* treated
  as success, and the file check is what additionally catches the out-of-band case.
- **A PTY is still available if something later needs one** — via `script`, with no new
  dependency. Nothing here forecloses it.
- **`claude setup-token` was not adopted**, so SuperFabric does not produce long-lived
  `CLAUDE_CODE_OAUTH_TOKEN`s. That is deliberate: its scope would not carry the limit monitor, and
  an account logged in two different ways is an account whose behaviour depends on which.
