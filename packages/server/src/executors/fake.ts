import { randomUUID } from "node:crypto";
import type { Executor, ExecutorEvents, ExecutorHandle, ExecutorStartOptions } from "../executor.js";

type ScriptedTool = { tool: string; input: unknown };

export class FakeExecutor implements Executor {
  readonly name = "fake";
  private pending: Promise<void> = Promise.resolve();
  constructor(private opts: { script?: ScriptedTool[] } = {}) {}

  /** Await all in-flight turns (test helper). */
  settle(): Promise<void> { return this.pending; }

  start(_opts: ExecutorStartOptions, ev: ExecutorEvents): ExecutorHandle {
    const id = _opts.resumeSessionId ?? `fake-${randomUUID()}`;
    ev.onEvent({ type: "session_status", status: "idle" });
    const send = (text: string) => {
      this.pending = this.pending.then(async () => {
        ev.onEvent({ type: "user_prompt", text });
        for (const t of this.opts.script ?? []) {
          // approval_resolved is appended by SessionManager.approve(), not here.
          await ev.requestApproval(t.tool, t.input);
        }
        ev.onEvent({ type: "agent_text", text: `echo: ${text}` });
        ev.onEvent({ type: "turn_complete" });
        ev.onEvent({ type: "session_status", status: "idle" });
      });
    };
    return {
      providerSessionId: Promise.resolve(id),
      send: (t) => { ev.onEvent({ type: "session_status", status: "working" }); send(t); },
      interrupt: async () => {},
      stop: async () => {},
    };
  }
}
