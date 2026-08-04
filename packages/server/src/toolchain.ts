import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ACCOUNT_CREDENTIALS_FILE, type AgentCliInfo } from "@superfabric/shared";

/**
 * Which agent CLIs are on this machine, and which of them SuperFabric can actually drive.
 *
 * It exists because of a fair complaint: an operator with `claude`, `codex` and `agy` all installed
 * and logged in opened SuperFabric and saw none of it. A tool that runs other people's CLIs should
 * be able to say what it found on the machine it is running on.
 *
 * Three rules keep it honest, and they are the whole design:
 *
 * - **Nothing is executed.** Detection is a `PATH` walk and a `stat`, never a subprocess. Running an
 *   unknown binary to ask its version is slow, is a surprise on someone's machine, and would make
 *   opening a popover spawn processes.
 * - **"Signed in" is `null` when we cannot tell.** Each entry names the file it looked at. Where a
 *   CLI keeps its credentials somewhere we cannot read from disk (a keyring, a state blob), the
 *   answer is "cannot tell from here" rather than a guess in either direction — a red cross next to
 *   a CLI the operator is logged into is worse than no answer.
 * - **`runsAgents` is the truth about *us*, not about them.** SuperFabric drives Claude Code and
 *   nothing else today: `Executor` has one real implementation, and multi-provider is an After-v1
 *   item in the roadmap. Listing `codex` next to `claude` without saying so would imply a capability
 *   that does not exist, which is the one thing this surface must not do.
 */

/** What we know about one CLI before we go looking for it. */
interface KnownCli {
  id: string;
  name: string;
  command: string;
  /** Files whose presence means "this one is signed in", relative to the home directory. */
  loginMarkers: string[];
  /** The directory to name when nothing is found — where the operator would look themselves. */
  configHint: string;
  /** Can SuperFabric start an agent on it? Exactly one entry is `true`. */
  runsAgents: boolean;
  /** One line about what it is and what we can do with it. */
  detail: string;
}

/**
 * The CLIs worth looking for.
 *
 * Deliberately a short, hand-written list rather than a scan for anything agent-shaped: each entry
 * makes a claim about where that tool keeps its login, and a claim we have not checked is worse than
 * an absence. Adding one is a line here plus its marker file.
 */
const KNOWN: KnownCli[] = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    loginMarkers: [path.join(".claude", ACCOUNT_CREDENTIALS_FILE)],
    configHint: ".claude",
    runsAgents: true,
    detail: "the engine every SuperFabric agent runs on — a logged-in ~/.claude is adopted as an account",
  },
  {
    id: "codex",
    name: "OpenAI Codex CLI",
    command: "codex",
    loginMarkers: [path.join(".codex", "auth.json")],
    configHint: ".codex",
    runsAgents: false,
    detail: "found on this machine; SuperFabric cannot staff a room with it yet (one provider behind the Executor seam)",
  },
  {
    id: "antigravity",
    name: "Antigravity (agy)",
    command: "agy",
    // Its credentials are not a file we can read; `~/.gemini/antigravity*` is where it lives.
    loginMarkers: [],
    configHint: ".gemini",
    runsAgents: false,
    detail: "found on this machine; its sign-in is not readable from disk, and SuperFabric cannot staff a room with it yet",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    command: "gemini",
    loginMarkers: [path.join(".gemini", "oauth_creds.json")],
    configHint: ".gemini",
    runsAgents: false,
    detail: "found on this machine; SuperFabric cannot staff a room with it yet",
  },
];

export interface ToolchainOptions {
  /** Overridable so a test can point at a fake machine instead of the developer's own. */
  home?: string;
  /** `PATH`, already split. Defaults to this process's. */
  searchPath?: string[];
}

/**
 * Look for one command on `PATH` **without running it**. Returns its path, or `undefined`.
 *
 * `access(X_OK)` rather than `existsSync`: a non-executable file with the right name is not an
 * installed CLI, and reporting one would send the operator looking for a problem that is not there.
 */
function whichSync(command: string, searchPath: readonly string[]): string | undefined {
  for (const dir of searchPath) {
    if (dir === "") continue;
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* not here, or not ours to execute */ }
  }
  return undefined;
}

/**
 * Every known CLI, installed or not, in a stable order — the one SuperFabric drives first.
 *
 * Uninstalled ones are included rather than filtered out: "we looked for codex and it is not here"
 * is a different, more useful answer than silence, and it is what makes the list a report about the
 * machine rather than a list of things that happened to be found.
 */
export function detectAgentClis(opts: ToolchainOptions = {}): AgentCliInfo[] {
  const home = opts.home ?? homedir();
  const searchPath = opts.searchPath ?? (process.env.PATH ?? "").split(path.delimiter);

  return KNOWN.map((cli): AgentCliInfo => {
    const found = whichSync(cli.command, searchPath);
    const marker = cli.loginMarkers
      .map((m) => path.join(home, m))
      .find((m) => existsSync(m));
    return {
      id: cli.id,
      name: cli.name,
      command: cli.command,
      path: found ?? null,
      // `null` is "we cannot tell", and it is the honest answer for a CLI whose credentials do not
      // live in a file — never `false`, which would read as "you are logged out".
      signedIn: found === undefined ? null : cli.loginMarkers.length === 0 ? null : marker !== undefined,
      configPath: marker ?? path.join(home, cli.configHint),
      runsAgents: cli.runsAgents,
      detail: cli.detail,
    };
  });
}
