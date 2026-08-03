import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { SessionEvent } from "@superfabric/shared";
import { ClaudeCodeExecutor } from "../src/executors/claudeCode.js";

// Consumes real quota and spawns the real claude CLI. Run explicitly:
//   SUPERFABRIC_LIVE_TEST=1 pnpm -F @superfabric/server test
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe.skipIf(process.env.SUPERFABRIC_LIVE_TEST !== "1")("ClaudeCodeExecutor (live)", () => {
  it("runs a real turn and streams agent_text", async () => {
    const events: SessionEvent[] = [];
    const exec = new ClaudeCodeExecutor();
    const handle = exec.start(
      { cwd: repoRoot },
      {
        onEvent: (e) => events.push(e),
        requestApproval: async () => "deny",
      },
    );

    handle.send("Reply with exactly the word: pong");

    const providerSessionId = await handle.providerSessionId;
    expect(providerSessionId.length).toBeGreaterThan(8);

    const deadline = Date.now() + 110_000;
    while (!events.some((e) => e.type === "turn_complete") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const text = events
      .filter((e): e is Extract<SessionEvent, { type: "agent_text" }> => e.type === "agent_text")
      .map((e) => e.text)
      .join("");
    expect(events.some((e) => e.type === "turn_complete")).toBe(true);
    expect(text.toLowerCase()).toContain("pong");

    await handle.stop();
  }, 120_000);
});
