import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AutonomyMode, SessionEvent } from "@superfabric/shared";
import type { Executor, ExecutorEvents, ExecutorHandle, ExecutorStartOptions } from "../executor.js";

/**
 * The second provider: OpenAI's `codex` CLI, behind the same `Executor` seam Claude Code sits behind.
 *
 * **The shape of the two providers is genuinely different, and this class is where that difference
 * lives** — above it, `SessionManager` does not branch: the same event log, the same room, the same
 * task board, the same floor.
 *
 * Claude Code is one long-lived `query()` with a streaming input; `codex exec` is **one process per
 * turn**, resumed by a thread id (`codex exec resume <thread> …`). So a session here is a thread id
 * plus a queue: `send()` enqueues, and a turn spawns when the previous one has exited. That is not a
 * workaround, it is what the CLI offers — and it has one real advantage, which is that a turn cannot
 * outlive its process.
 *
 * Verified against `codex-cli 0.146.0` on 2026-08-05 by running it (see `notes/codex-cli.md`):
 * `--json` emits JSONL, `thread.started` carries the id to resume with, `item.started` /
 * `item.completed` carry the work, `turn.completed` carries token usage and **no cost** — which is
 * exactly why `turn_complete.costUsd` is optional and why nothing here invents one.
 *
 * Three deliberate absences, each stated where an operator can see it rather than discovered:
 *
 * - **No approval cards.** `codex exec` is non-interactive: there is no channel to ask an operator
 *   mid-turn. So autonomy becomes the CLI's *sandbox* setting (see `sandboxFor`), which is the same
 *   question answered by the provider instead of by us — and `attended` maps to read-only, because
 *   an agent that cannot ask must not be able to change anything.
 * - **No factory bus.** `busTools` is an in-process MCP server object; the Agent SDK takes one, a
 *   separate CLI process cannot. A Codex agent works in its room and cannot yet message another.
 * - **No container runtime.** The `agent-runner` image is built around the Agent SDK.
 */

/** How a turn is run. Options object rather than positional args — five of these are optional. */
export interface CodexExecutorOptions {
  /** The binary. Overridable so a test can point at a script instead of the operator's own CLI. */
  command?: string;
  /** Extra arguments before the subcommand, for a machine that needs `-c` overrides. */
  extraArgs?: readonly string[];
  /** Spawn seam, so no test ever runs the real CLI. */
  spawnFn?: typeof spawn;
  /** Where a line that is not JSON goes. Defaults to the console. */
  log?: (line: string) => void;
}

/**
 * Autonomy, as the sandbox the CLI runs commands in.
 *
 * The mapping is the honest translation of a mode whose usual meaning — "ask me first" — the provider
 * cannot offer. `attended` therefore becomes the strictest sandbox rather than a promise of cards
 * that will never appear: an agent that cannot ask permission must not be able to take it.
 */
export function sandboxFor(autonomy: AutonomyMode | undefined): {
  args: string[];
  detail: string;
} {
  switch (autonomy) {
    case "attended":
      return {
        args: ["--sandbox", "read-only"],
        detail: "attended → codex runs read-only: it cannot write files or reach the network. "
          + "SuperFabric's approval cards do not exist for this provider — `codex exec` has no way to "
          + "ask mid-turn — so the sandbox is what stands in for them",
      };
    case "bypass":
      return {
        args: ["--dangerously-bypass-approvals-and-sandbox"],
        detail: "bypass → codex runs with no sandbox at all: it is you, on this machine, with your "
          + "files and your credentials",
      };
    default:
      return {
        args: ["--sandbox", "workspace-write"],
        detail: "auto → codex may write inside this room's folder and run commands there; the network "
          + "stays closed",
      };
  }
}

/** One JSONL line from `codex exec --json`, as much of it as we read. */
interface CodexLine {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
  };
  error?: { message?: string } | string;
  message?: string;
}

/**
 * Turn one JSONL line into the events it means, or none.
 *
 * A pure function so the mapping can be tested against captured output without a process — the same
 * reason `sdkEvents.ts` exists for the other provider. `item.started` and `item.completed` for a
 * command are a `tool_use`/`tool_result` pair, which is what makes a Codex agent's transcript read
 * like every other agent's in the console and in the thought bubble over its head.
 */
export function codexEvents(line: CodexLine): SessionEvent[] {
  switch (line.type) {
    case "turn.started":
      return [{ type: "session_status", status: "working" }];
    case "turn.completed":
      // No cost: `turn.completed.usage` counts tokens, and this product has no pricing table and
      // must not grow one (see `CostRollup`). A turn with no `costUsd` is simply not counted.
      return [{ type: "turn_complete" }, { type: "session_status", status: "idle" }];
    case "turn.failed": {
      const message = typeof line.error === "string" ? line.error : line.error?.message;
      return [
        { type: "session_error", message: message ?? "the codex turn failed" },
        { type: "session_status", status: "idle" },
      ];
    }
    case "error":
      return [{
        type: "session_error",
        message: (typeof line.error === "string" ? line.error : line.error?.message)
          ?? line.message ?? "codex reported an error",
      }];
    case "item.started": {
      const item = line.item;
      if (item?.type !== "command_execution") return [];
      return [{ type: "tool_use", toolName: "shell", input: { command: item.command ?? "" } }];
    }
    case "item.completed": {
      const item = line.item;
      if (item === undefined) return [];
      if (item.type === "agent_message") {
        return item.text === undefined || item.text === "" ? [] : [{ type: "agent_text", text: item.text }];
      }
      if (item.type === "command_execution") {
        return [{
          type: "tool_result",
          toolName: "shell",
          output: item.aggregated_output ?? "",
          isError: typeof item.exit_code === "number" && item.exit_code !== 0,
        }];
      }
      // Reasoning, todo lists, file changes, web searches: real work, but not something the console
      // has a shape for yet. Deliberately dropped rather than flattened into `agent_text`, which
      // would put the model's private reasoning in the transcript as if it had been said out loud.
      return [];
    }
    default:
      return [];
  }
}

export class CodexExecutor implements Executor {
  readonly name = "codex";
  private readonly command: string;
  private readonly extraArgs: readonly string[];
  private readonly spawnFn: typeof spawn;
  private readonly log: (line: string) => void;

  constructor(opts: CodexExecutorOptions = {}) {
    this.command = opts.command ?? "codex";
    this.extraArgs = opts.extraArgs ?? [];
    this.spawnFn = opts.spawnFn ?? spawn;
    this.log = opts.log ?? ((line) => console.log(`codex: ${line}`));
  }

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorHandle {
    const sandbox = sandboxFor(opts.autonomy);
    let threadId: string | null = opts.resumeSessionId ?? null;
    let resolveThread: (id: string) => void;
    const providerSessionId = new Promise<string>((resolve) => { resolveThread = resolve; });
    // A resumed session already has its id; nothing has to wait for a turn to learn it.
    if (threadId !== null) resolveThread!(threadId);

    /** Turns waiting for the current process to finish. One process at a time, always. */
    const queue: string[] = [];
    let child: ChildProcessWithoutNullStreams | null = null;
    let stopped = false;

    // Said once, at the start, in the agent's own log: this provider's rules are not the other's,
    // and an operator who picked "attended" has to know what it bought them here.
    events.onEvent({
      type: "session_status",
      status: "starting",
      detail: `provider: codex — ${sandbox.detail}. The factory bus is not available to this `
        + "provider yet, so this agent cannot message other rooms.",
    });
    events.onEvent({ type: "session_status", status: "idle" });

    const runNext = (): void => {
      if (stopped || child !== null) return;
      const text = queue.shift();
      if (text === undefined) return;

      // **Every flag goes before the subcommand.** `codex exec resume` accepts a narrower option set
      // than `codex exec` does — `--sandbox` and `-C` among the ones it refuses outright — so
      // `exec resume <id> --sandbox …` fails with "unexpected argument". Measured, not assumed: the
      // first version of this put them after and every second turn of every session died with it.
      const args = [...this.extraArgs, "exec", "--skip-git-repo-check", ...sandbox.args, "-C", opts.cwd];
      if (opts.model !== undefined && opts.model !== null) args.push("-m", opts.model);
      if (threadId !== null) args.push("resume", threadId);
      // The prompt goes in on stdin (`-`), never as an argument: a turn can carry a whole file's
      // worth of text, and argument length is an operating-system limit rather than ours.
      args.push("--json", "-");

      const env: NodeJS.ProcessEnv = { ...process.env };
      // The account, in this provider's own vocabulary. `CODEX_HOME` is to codex what
      // `CLAUDE_CONFIG_DIR` is to Claude Code, which is why the seam names a *directory*.
      if (opts.configDir !== undefined) env.CODEX_HOME = opts.configDir;

      const proc = this.spawnFn(this.command, args, { cwd: opts.cwd, env }) as ChildProcessWithoutNullStreams;
      child = proc;
      events.onEvent({ type: "user_prompt", text });
      events.onEvent({ type: "session_status", status: "working" });

      // The turn itself, and then EOF. Both halves matter: `-` means the CLI reads the prompt from
      // stdin, so a stream left open is a process that waits for the rest of a sentence forever.
      // An `error` on the pipe is reported by the `error`/`close` handlers below rather than thrown.
      proc.stdin.on("error", () => { /* the close handler reports it */ });
      proc.stdin.end(text);

      let buffer = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let cut = buffer.indexOf("\n");
        while (cut !== -1) {
          const line = buffer.slice(0, cut).trim();
          buffer = buffer.slice(cut + 1);
          cut = buffer.indexOf("\n");
          if (line === "") continue;
          let parsed: CodexLine;
          // Not every line is JSON — the CLI prints human notes to stdout too. A line we cannot read
          // is logged, never turned into a `session_error`: a chatty CLI must not look like a failure.
          try { parsed = JSON.parse(line) as CodexLine; }
          catch { this.log(line); continue; }
          if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
            threadId = parsed.thread_id;
            resolveThread(parsed.thread_id);
          }
          for (const event of codexEvents(parsed)) events.onEvent(event);
        }
      });

      let stderr = "";
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => { stderr += chunk.slice(0, 4000); });

      const finish = (detail: string | null): void => {
        if (child !== proc) return;
        child = null;
        if (detail !== null) events.onEvent({ type: "session_error", message: detail });
        // The turn boundary the whole product hangs off — the bus flush, an armed pause, an armed
        // stop. A process that died still ended a turn, so it is emitted either way.
        events.onEvent({ type: "session_status", status: "idle" });
        runNext();
      };

      proc.on("error", (err: Error) => {
        finish(`codex could not be started (${this.command}): ${err.message}`);
      });
      proc.on("close", (code: number | null) => {
        // A non-zero exit with nothing on stderr is an interrupt we asked for; the log already says so.
        const failed = code !== null && code !== 0 && stderr.trim() !== "";
        finish(failed ? `codex exited with ${code}: ${stderr.trim().slice(0, 500)}` : null);
      });
    };

    return {
      providerSessionId,
      send: (text: string) => {
        if (stopped) return;
        queue.push(text);
        runNext();
      },
      interrupt: async () => {
        // The turn is a process, so interrupting it is exactly that. Queued turns are dropped with
        // it: an operator interrupting an agent means "stop what you are doing", not "start the next
        // thing I typed".
        queue.length = 0;
        child?.kill("SIGINT");
      },
      stop: async () => {
        stopped = true;
        queue.length = 0;
        const running = child;
        if (running === null) return;
        running.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { running.kill("SIGKILL"); resolve(); }, 3000);
          timer.unref?.();
          running.once("close", () => { clearTimeout(timer); resolve(); });
        });
      },
    };
  }
}
