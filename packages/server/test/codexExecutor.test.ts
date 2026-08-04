import { describe, it, expect } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@superfabric/shared";
import { CodexExecutor, codexEvents, sandboxFor } from "../src/executors/codex.js";
import { waitFor } from "./_waitFor.js";

/**
 * The second provider, driven by a **fake `codex`** — a shell script that prints captured JSONL and
 * records the arguments and environment it was given.
 *
 * No test here runs the real CLI or spends anyone's OpenAI quota. What they hold down is the part
 * that would otherwise be discovered in production: that a session is a *thread id plus a queue* of
 * one-process-per-turn runs, that the second turn resumes the first, that autonomy becomes a sandbox
 * flag, and that an account is `CODEX_HOME`.
 *
 * The JSONL below is copied verbatim from `codex-cli 0.146.0` (see `notes/codex-cli.md`), so a
 * change in the CLI's output shape fails here rather than in an operator's console.
 */

/** What `codex exec --json` actually printed for "run echo and say done", 2026-08-05. */
const CAPTURED = [
  '{"type":"thread.started","thread_id":"019fce97-eca9-7be3-8535-fded2d83c455"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I will run it."}}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution",'
    + '"command":"/usr/bin/bash -c \'echo hello\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution",'
    + '"command":"/usr/bin/bash -c \'echo hello\'","aggregated_output":"hello\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"done"}}',
  '{"type":"turn.completed","usage":{"input_tokens":23644,"output_tokens":92}}',
];

interface Fake {
  dir: string;
  /** The fake binary's path. */
  command: string;
  /** One file per invocation: argv, then the environment lines we care about, then stdin. */
  runs(): { argv: string[]; codexHome: string | null; stdin: string }[];
  cleanup(): void;
}

/**
 * A `codex` that is a shell script: it records how it was called and prints the captured stream.
 *
 * A script rather than a `spawnFn` stub on purpose — this is the one test that proves the executor
 * can actually drive a process: pipes, line buffering, exit codes and all. The stub seam is used by
 * the failure cases below, where the point is the mapping rather than the plumbing.
 */
function fakeCodex(lines: readonly string[] = CAPTURED, exitCode = 0): Fake {
  const dir = mkdtempSync(join(tmpdir(), "sf-codex-"));
  const command = join(dir, "codex");
  // The stream lives in a file the script `cat`s, rather than inside the script: JSONL is full of
  // quotes and backslashes, and embedding it would be a test that passes or fails on shell quoting.
  writeFileSync(join(dir, "stream.jsonl"), lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  writeFileSync(command, [
    "#!/usr/bin/env bash",
    // A counter file rather than counting directory entries: each run writes three files, so `ls`
    // would number the second run 3 and leave a hole the reader stops at.
    `n=$(cat "${dir}/count" 2>/dev/null || echo 0)`,
    `echo $((n + 1)) > "${dir}/count"`,
    `run="${dir}/run-$n"`,
    'printf "%s\\n" "$*" > "$run.argv"',
    'printf "%s" "${CODEX_HOME:-}" > "$run.home"',
    'cat > "$run.stdin"',
    `cat "${dir}/stream.jsonl"`,
    `exit ${exitCode}`,
  ].join("\n") + "\n");
  chmodSync(command, 0o755);

  return {
    dir,
    command,
    runs: () => {
      const out: { argv: string[]; codexHome: string | null; stdin: string }[] = [];
      for (let i = 0; ; i++) {
        try {
          const argv = readFileSync(join(dir, `run-${i}.argv`), "utf8").trim().split(/\s+/);
          const home = readFileSync(join(dir, `run-${i}.home`), "utf8");
          const stdin = readFileSync(join(dir, `run-${i}.stdin`), "utf8");
          out.push({ argv, codexHome: home === "" ? null : home, stdin });
        } catch { return out; }
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Collects everything the executor emits, in order. */
function collector() {
  const events: SessionEvent[] = [];
  return {
    events,
    handlers: {
      onEvent: (e: SessionEvent) => { events.push(e); },
      requestApproval: async () => "allow" as const,
    },
    types: () => events.map((e) => e.type),
    texts: () => events.flatMap((e) => (e.type === "agent_text" ? [e.text] : [])),
  };
}

describe("codexEvents — one JSONL line at a time", () => {
  it("turns a captured turn into the same event shapes every other agent produces", () => {
    const events = CAPTURED.map((l) => codexEvents(JSON.parse(l) as never)).flat();
    expect(events.map((e) => e.type)).toEqual([
      "session_status",   // turn.started -> working
      "agent_text",
      "tool_use",
      "tool_result",
      "agent_text",
      "turn_complete",
      "session_status",   // idle
    ]);
    // The console and the thought bubble read a Codex agent exactly as they read a Claude one.
    expect(events.find((e) => e.type === "tool_use")).toMatchObject({ toolName: "shell" });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: false });
  });

  it("carries no cost, because the CLI reports none and this product has no pricing table", () => {
    const done = codexEvents(JSON.parse('{"type":"turn.completed","usage":{"output_tokens":92}}'));
    expect(done[0]).toEqual({ type: "turn_complete" });
    expect(done[0]).not.toHaveProperty("costUsd");
  });

  it("keeps the model's private reasoning out of the transcript", () => {
    // Dropped rather than flattened into `agent_text`: putting reasoning in the log as if it had
    // been said out loud would misrepresent what the agent told the operator.
    expect(codexEvents(JSON.parse('{"type":"item.completed","item":{"id":"i","type":"reasoning","text":"hmm"}}')))
      .toEqual([]);
  });

  it("reports a failed turn as an error and still ends the turn", () => {
    const events = codexEvents(JSON.parse('{"type":"turn.failed","error":{"message":"model overloaded"}}'));
    expect(events.map((e) => e.type)).toEqual(["session_error", "session_status"]);
    // The `idle` matters as much as the error: it is the turn boundary the bus, a pause and a stop
    // are all waiting for, and a failure that never produced one would strand them.
    expect(events[1]).toMatchObject({ status: "idle" });
  });
});

describe("sandboxFor — autonomy, in the vocabulary this provider actually has", () => {
  it("makes an attended agent read-only, because it cannot ask", () => {
    // The honest translation: `codex exec` is non-interactive, so there is no approval card to
    // raise. An agent that cannot ask permission must not be able to take it.
    expect(sandboxFor("attended").args).toEqual(["--sandbox", "read-only"]);
    expect(sandboxFor("attended").detail).toMatch(/approval cards do not exist/);
  });

  it("lets an auto agent write inside its room", () => {
    expect(sandboxFor("auto").args).toEqual(["--sandbox", "workspace-write"]);
    expect(sandboxFor(undefined).args).toEqual(["--sandbox", "workspace-write"]);
  });

  it("takes the sandbox off entirely for bypass, and says what that means", () => {
    expect(sandboxFor("bypass").args).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    expect(sandboxFor("bypass").detail).toMatch(/no sandbox at all/);
  });
});

describe("CodexExecutor — driving the CLI", () => {
  it("runs a turn, maps its output, and hands back the thread id to resume with", async () => {
    const fake = fakeCodex();
    try {
      const c = collector();
      const exec = new CodexExecutor({ command: fake.command });
      const handle = exec.start({ cwd: fake.dir, autonomy: "auto" }, c.handlers);
      handle.send("run echo");

      expect(await handle.providerSessionId).toBe("019fce97-eca9-7be3-8535-fded2d83c455");
      await waitFor(() => {
        if (!c.types().includes("turn_complete")) throw new Error("not yet");
      });
      expect(c.texts()).toEqual(["I will run it.", "done"]);
      // The prompt goes in on stdin, never as an argument: a turn can be a whole file's worth of
      // text and argv length is the operating system's limit, not ours.
      const [run] = fake.runs();
      expect(run!.stdin).toBe("run echo");
      expect(run!.argv).toContain("--json");
      expect(run!.argv).toContain("workspace-write");
      await handle.stop();
    } finally {
      fake.cleanup();
    }
  });

  it("resumes the same thread on the second turn rather than starting a new conversation", async () => {
    const fake = fakeCodex();
    try {
      const c = collector();
      const handle = new CodexExecutor({ command: fake.command })
        .start({ cwd: fake.dir, autonomy: "auto" }, c.handlers);
      handle.send("first");
      await handle.providerSessionId;
      await waitFor(() => {
        if (c.types().filter((t) => t === "turn_complete").length < 1) throw new Error("not yet");
      });
      handle.send("second");
      await waitFor(() => {
        if (fake.runs().length < 2) throw new Error("not yet");
      });

      const [first, second] = fake.runs();
      expect(first!.argv).not.toContain("resume");
      // The whole reason a thread id is worth keeping: turn two is the same conversation.
      expect(second!.argv).toContain("resume");
      expect(second!.argv[second!.argv.indexOf("resume") + 1]).toBe("019fce97-eca9-7be3-8535-fded2d83c455");
      expect(second!.stdin).toBe("second");
      // And every flag comes *before* the subcommand: `codex exec resume` refuses `--sandbox` and
      // `-C` outright, so the other order kills the second turn of every session. This was measured
      // against the real CLI, not assumed — see `notes/codex-cli.md`.
      const resumeAt = second!.argv.indexOf("resume");
      for (const flag of ["--skip-git-repo-check", "--sandbox", "-C"]) {
        expect(second!.argv.indexOf(flag)).toBeLessThan(resumeAt);
      }
      await handle.stop();
    } finally {
      fake.cleanup();
    }
  });

  it("runs one process at a time, so two quick turns do not overlap", async () => {
    const fake = fakeCodex();
    try {
      const c = collector();
      const handle = new CodexExecutor({ command: fake.command })
        .start({ cwd: fake.dir, autonomy: "auto" }, c.handlers);
      handle.send("one");
      handle.send("two");

      await waitFor(() => {
        if (fake.runs().length < 2) throw new Error("not yet");
      });
      // Both landed, in order, and the second only started after the first had exited — which is
      // what makes `turn_complete` mean what it means for the bus, a pause and a stop.
      expect(fake.runs().map((r) => r.stdin)).toEqual(["one", "two"]);
      expect(c.types().filter((t) => t === "turn_complete").length).toBe(2);
      await handle.stop();
    } finally {
      fake.cleanup();
    }
  });

  it("gives the account to the CLI in its own vocabulary: CODEX_HOME", async () => {
    const fake = fakeCodex();
    try {
      const c = collector();
      const handle = new CodexExecutor({ command: fake.command })
        .start({ cwd: fake.dir, configDir: "/tmp/some-codex-home", autonomy: "auto" }, c.handlers);
      handle.send("hello");
      await waitFor(() => {
        if (fake.runs().length < 1) throw new Error("not yet");
      });
      // `CLAUDE_CONFIG_DIR` is to Claude Code what this is to codex, which is exactly why the seam
      // names a *directory* rather than an account id.
      expect(fake.runs()[0]!.codexHome).toBe("/tmp/some-codex-home");
      await handle.stop();
    } finally {
      fake.cleanup();
    }
  });

  it("says what this provider does not have, in the agent's own log, before anything runs", async () => {
    const fake = fakeCodex();
    try {
      const c = collector();
      const handle = new CodexExecutor({ command: fake.command })
        .start({ cwd: fake.dir, autonomy: "attended" }, c.handlers);
      const first = c.events[0];
      expect(first).toMatchObject({ type: "session_status", status: "starting" });
      // Both absences, at the moment they start applying rather than when an operator trips over them.
      expect((first as { detail: string }).detail).toMatch(/read-only/);
      expect((first as { detail: string }).detail).toMatch(/factory bus is not available/);
      await handle.stop();
    } finally {
      fake.cleanup();
    }
  });

  it("reports a CLI that is not installed as an error on the session, not a crash", async () => {
    const c = collector();
    const handle = new CodexExecutor({ command: "/nonexistent/codex" })
      .start({ cwd: tmpdir(), autonomy: "auto" }, c.handlers);
    handle.send("hello");

    await waitFor(() => {
      if (!c.types().includes("session_error")) throw new Error("not yet");
    });
    const error = c.events.find((e) => e.type === "session_error") as { message: string };
    expect(error.message).toMatch(/could not be started/);
    // And the turn still ends: whatever is waiting on a boundary is not stranded by a missing binary.
    expect(c.types().at(-1)).toBe("session_status");
    await handle.stop();
  });

  it("does not turn a chatty non-JSON line into a failure", async () => {
    const noisy = fakeCodex(["Reading additional input from stdin...", ...CAPTURED]);
    try {
      const c = collector();
      const logged: string[] = [];
      const handle = new CodexExecutor({ command: noisy.command, log: (l) => logged.push(l) })
        .start({ cwd: noisy.dir, autonomy: "auto" }, c.handlers);
      handle.send("hello");
      await waitFor(() => {
        if (!c.types().includes("turn_complete")) throw new Error("not yet");
      });
      expect(c.types()).not.toContain("session_error");
      expect(logged).toContain("Reading additional input from stdin...");
      await handle.stop();
    } finally {
      noisy.cleanup();
    }
  });
});
