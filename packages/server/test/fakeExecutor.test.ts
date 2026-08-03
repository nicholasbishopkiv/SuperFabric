import { describe, it, expect } from "bun:test";
import { FakeExecutor } from "../src/executors/fake.js";
import type { SessionEvent } from "@superfabric/shared";

describe("FakeExecutor", () => {
  it("replies to every prompt and emits turn_complete", async () => {
    const events: SessionEvent[] = [];
    const exec = new FakeExecutor();
    const h = exec.start({ cwd: "/tmp" }, {
      onEvent: e => events.push(e),
      requestApproval: async () => "allow",
    });
    h.send("hello");
    await exec.settle();
    expect(await h.providerSessionId).toMatch(/^fake-/);
    // idle (start) -> working (send) -> user_prompt -> agent_text -> turn_complete -> idle
    expect(events.map(e => e.type)).toEqual(["session_status", "session_status", "user_prompt", "agent_text", "turn_complete", "session_status"]);
  });
  it("routes gated tools through requestApproval", async () => {
    const exec = new FakeExecutor({ script: [{ tool: "Bash", input: { cmd: "rm -rf" } }] });
    const decisions: string[] = [];
    const h = exec.start({ cwd: "/tmp" }, {
      onEvent: () => {},
      requestApproval: async (tool) => { decisions.push(tool); return "deny"; },
    });
    h.send("do something dangerous");
    await exec.settle();
    expect(decisions).toEqual(["Bash"]);
  });
});
