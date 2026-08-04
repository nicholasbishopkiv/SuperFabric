import type { SessionEvent } from "@superfabric/shared";
import { describe, expect, it } from "vitest";
import { agentBubble, BUBBLE_MAX } from "../src/scene/bubble";
import { toolGist } from "../src/gist";
import type { EventRow, FactoryStatus } from "../src/store";

/**
 * What a figure says it is doing. The interesting claims are about **precedence** (a pause and an
 * approval outrank whatever the log's last line was) and about **silence** (an idle agent says
 * nothing, which is what keeps twenty of them from covering the floor).
 */

let seq = 0;
const row = (event: SessionEvent): EventRow => ({ seq: ++seq, event });

const agent = (status: FactoryStatus, pausedUntil: number | null = null) => ({ status, pausedUntil });

const NOW = 1_700_000_000_000;

describe("toolGist", () => {
  // Extracted from the console drawer so the transcript and the bubble cannot describe one call two
  // ways. These pin the behaviour the drawer already had.
  it("picks the field that says what the agent is doing", () => {
    expect(toolGist({ command: "pnpm test" })).toBe("pnpm test");
    expect(toolGist({ file_path: "src/a.ts", offset: 20 })).toBe("src/a.ts");
    expect(toolGist({ pattern: "TODO", glob: "*.ts" })).toBe("TODO");
    expect(toolGist({ url: "https://example.com" })).toBe("https://example.com");
    expect(toolGist({ description: "look at the failing test" })).toBe("look at the failing test");
  });

  it("prefers the command over the path, which is the order an operator reads them in", () => {
    expect(toolGist({ file_path: "a.ts", command: "cat a.ts" })).toBe("cat a.ts");
  });

  it("falls back to the whole input rather than pretending there was nothing there", () => {
    expect(toolGist({ weird: 3 })).toBe('{"weird":3}');
    expect(toolGist(null)).toBe("");
    expect(toolGist("a string")).toBe("");
  });

  it("flattens whitespace and marks where it cut", () => {
    expect(toolGist({ command: "one\n  two\tthree" })).toBe("one two three");
    expect(toolGist({ command: "y".repeat(50) }, 10)).toBe(`${"y".repeat(10)}…`);
  });
});

describe("agentBubble", () => {
  it("says nothing at all over an idle agent", () => {
    expect(agentBubble(agent("idle"), [])).toBeNull();
    // …even when its log is full of history: idle is idle, and the vest already says so.
    expect(agentBubble(agent("idle"), [row({ type: "tool_use", toolName: "Bash", input: {} })])).toBeNull();
  });

  it("names the tool and the thing it is working on", () => {
    const bubble = agentBubble(
      agent("working"),
      [row({ type: "tool_use", toolName: "Edit", input: { file_path: "src/app.tsx" } })],
    );
    expect(bubble).toEqual({ status: "working", text: "Edit · src/app.tsx" });
  });

  it("reduces a tool input with the console's own summariser, never a second one", () => {
    const input = { command: "pnpm -F @superfabric/web test --run" };
    const bubble = agentBubble(agent("working"), [row({ type: "tool_use", toolName: "Bash", input })]);
    expect(bubble?.text).toBe(`Bash · ${toolGist(input, BUBBLE_MAX)}`);
  });

  it("keeps its line short enough to sit over a building", () => {
    const bubble = agentBubble(
      agent("working"),
      [row({ type: "tool_use", toolName: "Bash", input: { command: "x".repeat(400) } })],
    );
    expect(bubble!.text.length).toBeLessThanOrEqual(BUBBLE_MAX + 20);
    expect(bubble!.text.endsWith("…")).toBe(true);
  });

  it("says it is thinking when that is the newest thing it did", () => {
    const bubble = agentBubble(agent("working"), [
      row({ type: "tool_use", toolName: "Read", input: { file_path: "a.ts" } }),
      row({ type: "agent_thinking" }),
    ]);
    expect(bubble?.text).toBe("thinking…");
  });

  it("looks past a finished tool call to the call that names the work", () => {
    // `tool_result` says "that one is done"; the operator wants to know *what* is being done.
    const bubble = agentBubble(agent("working"), [
      row({ type: "tool_use", toolName: "Grep", input: { pattern: "SessionManager" } }),
      row({ type: "tool_result", toolName: "Grep", output: "12 matches" }),
      row({ type: "session_status", status: "working" }),
      row({ type: "turn_complete" }),
    ]);
    expect(bubble?.text).toBe("Grep · SessionManager");
  });

  it("says 'replying' rather than quoting the reply", () => {
    // A streaming snippet would rewrite the bubble on every chunk, and a floor plan is not where
    // anyone reads an agent's prose — the console is.
    const bubble = agentBubble(agent("working"), [
      row({ type: "tool_use", toolName: "Read", input: { file_path: "a.ts" } }),
      row({ type: "agent_text", text: "I have looked at the file and I think the problem is…" }),
    ]);
    expect(bubble?.text).toBe("replying");
  });

  it("is honest when this tab holds no log for the agent at all", () => {
    // Every figure the floor speaks for is subscribed, but the frame before that lands is real.
    expect(agentBubble(agent("working"), [])).toEqual({ status: "working", text: "working" });
  });

  it("**an approval outranks the work**, and names the tool it is asking about", () => {
    const bubble = agentBubble(agent("blocked"), [
      row({ type: "tool_use", toolName: "Read", input: { file_path: "a.ts" } }),
      row({ type: "approval_request", approvalId: "ap1", toolName: "Bash", input: { command: "rm -rf x" } }),
    ]);
    expect(bubble).toEqual({ status: "blocked", text: "waiting for you · Bash" });
  });

  it("asks about the approval nobody has answered, not the newest one", () => {
    const bubble = agentBubble(agent("blocked"), [
      row({ type: "approval_request", approvalId: "ap1", toolName: "Write", input: {} }),
      row({ type: "approval_request", approvalId: "ap2", toolName: "Bash", input: {} }),
      row({ type: "approval_resolved", approvalId: "ap2", behavior: "allow" }),
    ]);
    expect(bubble?.text).toBe("waiting for you · Write");
  });

  it("still says it is waiting when we cannot see which tool", () => {
    expect(agentBubble(agent("blocked"), [])).toEqual({ status: "blocked", text: "waiting for you" });
  });

  it("counts down a pause, and says so plainly when nothing knows the time", () => {
    expect(agentBubble(agent("paused", NOW / 1000 + 14 * 60), [], NOW)?.text)
      .toBe("paused · back in 14m");
    expect(agentBubble(agent("paused", NOW / 1000 + 95 * 60), [], NOW)?.text)
      .toBe("paused · back in 1h 35m");
    // A 429 with no reading behind it knows no reset time, and inventing one would be a promise
    // nobody made — see `SessionInfo.pausedUntil`.
    expect(agentBubble(agent("paused", null), [], NOW)?.text).toBe("paused · waiting for the limit");
    // A countdown that has run out is not a countdown.
    expect(agentBubble(agent("paused", NOW / 1000 - 60), [], NOW)?.text).toBe("paused · due back");
  });

  it("**a pause outranks whatever it was doing when it was stopped**", () => {
    const bubble = agentBubble(
      agent("paused", NOW / 1000 + 60),
      [row({ type: "tool_use", toolName: "Bash", input: { command: "pnpm test" } })],
      NOW,
    );
    expect(bubble?.status).toBe("paused");
    expect(bubble?.text.startsWith("paused")).toBe(true);
  });

  it("puts the failure's own words on a failed agent", () => {
    const bubble = agentBubble(agent("error"), [
      row({ type: "session_error", message: "spawn claude ENOENT" }),
    ]);
    expect(bubble).toEqual({ status: "error", text: "failed · spawn claude ENOENT" });
    expect(agentBubble(agent("error"), [])?.text).toBe("failed");
  });

  it("carries the figure's own status, so the bubble and the vest are one colour", () => {
    for (const status of ["working", "blocked", "paused", "error"] as const) {
      expect(agentBubble(agent(status, NOW / 1000 + 60), [], NOW)?.status).toBe(status);
    }
  });
});
