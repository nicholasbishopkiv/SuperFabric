import { describe, it, expect } from "bun:test";
import { APPROVAL_DENIED_MESSAGE, RUNNER_PROTOCOL_VERSION, type RunnerOptions } from "@superfabric/shared";
import { SessionRunner } from "../src/runner.js";
import {
  assistantMsg,
  initMsg,
  makeClock,
  makeFakeNetwork,
  makeFakeQuery,
  resultMsg,
  tick,
  until,
  userMsg,
  type FakeNetwork,
  type FakeQuery,
} from "./_harness.js";

const BASE_OPTIONS: RunnerOptions = {
  cwd: "/work",
  resumeSessionId: null,
  model: null,
  allowedTools: [],
  ungatedToolPrefixes: [],
};

interface Harness {
  runner: SessionRunner;
  fq: FakeQuery;
  net: FakeNetwork;
  clock: ReturnType<typeof makeClock>;
}

function harness(options: Partial<RunnerOptions> = {}, extra: { outboxLimit?: number } = {}): Harness {
  const fq = makeFakeQuery();
  const net = makeFakeNetwork();
  const clock = makeClock();
  const runner = new SessionRunner({
    sessionId: "sess-super",
    serverUrl: "ws://host.docker.internal:4620/runner",
    token: "tok-abc",
    options: { ...BASE_OPTIONS, ...options },
    query: fq.fn,
    connect: net.connect,
    schedule: clock.schedule,
    backoffMs: () => 0,
    ...extra,
  });
  runner.start();
  return { runner, fq, net, clock };
}

/** Connect and complete the handshake, as a server that has nothing yet would. */
async function attach(h: Harness, ackedSeq = 0): Promise<void> {
  await tick();
  h.net.latest().deliver({ kind: "attached", ackedSeq });
  await tick();
}

describe("SessionRunner: the handshake", () => {
  it("says hello with the session id, the token and the protocol version", async () => {
    const h = harness();
    await tick();
    expect(h.net.latest().messages()[0]).toEqual({
      kind: "hello",
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      sessionId: "sess-super",
      token: "tok-abc",
    });
  });

  it("sends nothing but hello until the server has answered", async () => {
    const h = harness();
    await tick();
    h.fq.emit(assistantMsg([{ type: "text", text: "early" }]));
    await tick();
    // The agent kept working; the frames are held rather than fired at a server that has not
    // said what it already has.
    expect(h.net.latest().messages().map((m) => m.kind)).toEqual(["hello"]);
    expect(h.runner.pendingFrames).toBeGreaterThan(0);

    await attach(h);
    expect(h.net.latest().events()).toEqual([
      { type: "session_status", status: "starting" },
      { type: "agent_text", text: "early" },
    ]);
  });

  it("starts the query before the socket, so an unreachable server costs nothing", async () => {
    const h = harness({ model: "claude-fable-5", autonomy: "bypass", appendSystemPrompt: "be brief" });
    // No attach at all: the query is already running with the options the session asked for.
    expect(h.fq.options()?.cwd).toBe("/work");
    expect(h.fq.options()?.model).toBe("claude-fable-5");
    expect(h.fq.options()?.permissionMode).toBe("bypassPermissions");
    expect(h.fq.options()?.allowDangerouslySkipPermissions).toBe(true);
    expect(h.fq.options()?.strictMcpConfig).toBe(true);
    expect(h.fq.options()?.settingSources).toEqual(["project", "local"]);
    expect(h.fq.options()?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "be brief",
    });
    // `env` is deliberately never set — it would replace the container's environment wholesale.
    expect(h.fq.options()?.env).toBeUndefined();
  });

  it("resumes the provider session when told to", () => {
    const h = harness({ resumeSessionId: "prov-1" });
    expect(h.fq.options()?.resume).toBe("prov-1");
  });
});

describe("SessionRunner: events", () => {
  it("forwards the session's events in order, numbered from one", async () => {
    const h = harness();
    await attach(h);
    h.fq.emit(initMsg("prov-77"));
    h.fq.emit(
      assistantMsg([
        { type: "text", text: "hello" },
        { type: "thinking", thinking: "hmm" },
        { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
      ]),
    );
    h.fq.emit(userMsg([{ type: "tool_result", tool_use_id: "tu_1", content: "a.txt" }]));
    h.fq.emit(resultMsg(0.25));
    await until(() => h.net.latest().events().some((e) => (e as { type: string }).type === "turn_complete"));

    const frames = h.net.latest().frames();
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(frames[1]!.body).toEqual({ type: "provider_session", providerSessionId: "prov-77" });
    expect(h.net.latest().events()).toEqual([
      { type: "session_status", status: "starting" },
      { type: "agent_text", text: "hello" },
      { type: "agent_thinking" },
      { type: "tool_use", toolName: "Bash", input: { command: "ls" } },
      { type: "tool_result", toolName: "Bash", isError: false, output: "a.txt" },
      { type: "turn_complete", costUsd: 0.25 },
      { type: "session_status", status: "idle" },
    ]);
  });

  it("turns a prompt from the server into a turn, and says so in the log first", async () => {
    const h = harness();
    await attach(h);
    h.net.latest().deliver({ kind: "prompt", text: "write the thing" });
    await tick();
    expect(h.net.latest().events().slice(1)).toEqual([
      { type: "session_status", status: "working" },
      { type: "user_prompt", text: "write the thing" },
    ]);
    await until(() => h.fq.received.length === 1);
    expect(h.fq.received[0]!.message.content).toBe("write the thing");
  });

  it("reports a failed stream the way the local executor does, so a 429 is still detected", async () => {
    const h = harness();
    await attach(h);
    h.fq.fail(new Error("429 rate_limit_error"));
    await until(() => h.net.latest().events().some((e) => (e as { type: string }).type === "session_error"));
    expect(h.net.latest().events().slice(1)).toEqual([
      { type: "session_error", message: "rate_limited: Error: 429 rate_limit_error" },
      { type: "session_status", status: "error" },
    ]);
  });

  it("forgets frames the server has acknowledged", async () => {
    const h = harness();
    await attach(h);
    h.fq.emit(assistantMsg([{ type: "text", text: "one" }]));
    await tick();
    expect(h.runner.pendingFrames).toBe(2);
    h.net.latest().deliver({ kind: "ack", seq: 2 });
    await tick();
    expect(h.runner.pendingFrames).toBe(0);
  });

  it("ignores a server frame it cannot parse rather than abandoning the agent", async () => {
    const h = harness();
    await attach(h);
    h.net.latest().deliverRaw("{not json");
    h.net.latest().deliverRaw(JSON.stringify({ kind: "nonsense" }));
    h.fq.emit(assistantMsg([{ type: "text", text: "still here" }]));
    await tick();
    expect(h.net.latest().events()).toContainEqual({ type: "agent_text", text: "still here" });
  });
});

describe("SessionRunner: approvals", () => {
  it("asks the server and waits for the answer", async () => {
    const h = harness();
    await attach(h);
    const decision = h.fq.askPermission("Bash", { command: "rm -rf /" });
    await tick();

    const asked = h.net.latest().messages().filter((m) => m.kind === "approval_request");
    expect(asked).toHaveLength(1);
    const request = asked[0] as Extract<(typeof asked)[number], { kind: "approval_request" }>;
    expect(request.toolName).toBe("Bash");
    expect(request.input).toEqual({ command: "rm -rf /" });

    h.net.latest().deliver({ kind: "approval_response", requestId: request.requestId, behavior: "allow" });
    expect(await decision).toEqual({ behavior: "allow", updatedInput: { command: "rm -rf /" } });
  });

  it("denies with the message the SDK requires, and the same words a host session uses", async () => {
    const h = harness();
    await attach(h);
    const decision = h.fq.askPermission("Write", { file_path: "/etc/passwd" });
    await tick();
    const request = h.net
      .latest()
      .messages()
      .find((m) => m.kind === "approval_request") as { requestId: string };
    h.net.latest().deliver({ kind: "approval_response", requestId: request.requestId, behavior: "deny" });
    expect(await decision).toEqual({ behavior: "deny", message: APPROVAL_DENIED_MESSAGE });
  });

  it("never gates the factory's own tools, and still records the call", async () => {
    const h = harness({ ungatedToolPrefixes: ["mcp__factory__"] });
    await attach(h);
    const decision = await h.fq.askPermission("mcp__factory__factory_send", { to_room: "payments" }, "tu_bus");
    expect(decision).toEqual({ behavior: "allow", updatedInput: { to_room: "payments" } });
    await tick();
    expect(h.net.latest().messages().some((m) => m.kind === "approval_request")).toBe(false);
    expect(h.net.latest().events()).toContainEqual({
      type: "tool_use",
      toolName: "mcp__factory__factory_send",
      input: { to_room: "payments" },
    });
  });

  it("asks the same question again after a reconnect, and answers it once", async () => {
    const h = harness();
    await attach(h);
    const decision = h.fq.askPermission("Bash", { command: "ls" });
    await tick();
    const first = h.net.latest().messages().find((m) => m.kind === "approval_request") as { requestId: string };

    h.net.latest().drop();
    h.clock.run();
    await attach(h, 1);

    const reasked = h.net.latest().messages().filter((m) => m.kind === "approval_request") as {
      requestId: string;
    }[];
    expect(reasked).toHaveLength(1);
    // Same id: it is the same question coming back, not a second card for the same call.
    expect(reasked[0]!.requestId).toBe(first.requestId);

    h.net.latest().deliver({ kind: "approval_response", requestId: first.requestId, behavior: "allow" });
    expect(await decision).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    // A duplicate answer (both connections' servers replying) resolves nothing a second time.
    h.net.latest().deliver({ kind: "approval_response", requestId: first.requestId, behavior: "deny" });
    await tick();
  });
});

describe("SessionRunner: the server going away", () => {
  it("keeps the query alive and loses nothing across a drop mid-turn", async () => {
    const h = harness();
    await attach(h);
    h.fq.emit(initMsg("prov-9"));
    h.fq.emit(assistantMsg([{ type: "text", text: "before" }]));
    await tick();
    // The server acknowledged everything up to and including the "before" line.
    const beforeFrames = h.net.latest().frames();
    const acked = beforeFrames[beforeFrames.length - 1]!.seq;
    h.net.latest().deliver({ kind: "ack", seq: acked });
    await tick();

    // ...and then falls over mid-turn.
    h.net.latest().drop();
    h.fq.emit(assistantMsg([{ type: "text", text: "during" }]));
    h.fq.emit(resultMsg(0.5));
    await until(() => h.runner.pendingFrames === 3);
    expect(h.fq.closes()).toBe(0); // the agent was never stopped

    // The runner reconnects on its own schedule and the server says where it got to.
    expect(h.clock.pending).toBe(1);
    h.clock.run();
    await attach(h, acked);

    const second = h.net.latest();
    expect(second.events()).toEqual([
      { type: "agent_text", text: "during" },
      { type: "turn_complete", costUsd: 0.5 },
      { type: "session_status", status: "idle" },
    ]);
    // Nothing duplicated: not one frame the first connection had already delivered.
    expect(second.frames().every((f) => f.seq > acked)).toBe(true);
    // Nothing lost: the sequence carries on where the first connection stopped, unbroken.
    expect(second.frames().map((f) => f.seq)).toEqual([acked + 1, acked + 2, acked + 3]);
  });

  it("replays everything when the server comes back knowing nothing", async () => {
    const h = harness();
    await attach(h);
    h.fq.emit(assistantMsg([{ type: "text", text: "one" }]));
    await tick();
    h.net.latest().drop();
    h.clock.run();
    await attach(h, 0);
    expect(h.net.latest().events()).toEqual([
      { type: "session_status", status: "starting" },
      { type: "agent_text", text: "one" },
    ]);
  });

  it("keeps trying, and stops trying when the server says the runner is not welcome", async () => {
    const h = harness();
    await tick();
    for (let i = 0; i < 3; i++) {
      h.net.latest().drop();
      expect(h.clock.run()).toBe(1);
      await tick();
    }
    expect(h.net.sockets).toHaveLength(4);

    h.net.latest().deliver({ kind: "fatal", message: "unknown runner token" });
    await tick();
    // Whatever timers were outstanding, running them opens no new connection.
    h.clock.run();
    await tick();
    expect(h.net.sockets).toHaveLength(4);
    await h.runner.done;
    expect(h.runner.isFinished).toBe(true);
  });
});

describe("SessionRunner: the buffer's bound", () => {
  it("drops the oldest events, keeps the newest, and says how many went", async () => {
    const h = harness({}, { outboxLimit: 4 });
    // Never attached: everything piles up.
    await tick();
    for (let i = 1; i <= 10; i++) h.fq.emit(assistantMsg([{ type: "text", text: `line ${i}` }]));
    await until(() => h.runner.droppedEvents >= 8);

    await attach(h);
    const events = h.net.latest().events() as { type: string; text?: string; message?: string }[];
    expect(events).toHaveLength(4);
    // The gap is marked where it happened — first — and the newest three lines survive.
    expect(events[0]!.type).toBe("session_error");
    expect(events[0]!.message).toContain("8 events from this agent were dropped");
    expect(events.slice(1).map((e) => e.text)).toEqual(["line 8", "line 9", "line 10"]);
    expect(h.runner.droppedEvents).toBe(8);
  });

  it("never drops the frame that makes the session resumable", async () => {
    const h = harness({}, { outboxLimit: 3 });
    await tick();
    h.fq.emit(initMsg("prov-keep"));
    for (let i = 1; i <= 20; i++) h.fq.emit(assistantMsg([{ type: "text", text: `line ${i}` }]));
    await until(() => h.runner.droppedEvents >= 18);

    await attach(h);
    const bodies = h.net.latest().frames().map((f) => f.body);
    expect(bodies).toContainEqual({ type: "provider_session", providerSessionId: "prov-keep" });
  });
});

describe("SessionRunner: shutdown", () => {
  it("stops the query, flushes, and says goodbye", async () => {
    const h = harness();
    await attach(h);
    h.fq.emit(assistantMsg([{ type: "text", text: "last word" }]));
    await tick();

    await h.runner.shutdown("SIGTERM");

    expect(h.fq.closes()).toBe(1); // the provider session is closed, not deleted — still resumable
    const messages = h.net.latest().messages();
    expect(messages[messages.length - 1]).toEqual({ kind: "bye", reason: "SIGTERM" });
    expect(h.net.latest().events()).toContainEqual({ type: "agent_text", text: "last word" });
    expect(h.net.latest().closed).toBe(true);
    expect(h.runner.isFinished).toBe(true);
  });

  it("does not reconnect after it has gone down", async () => {
    const h = harness();
    await attach(h);
    await h.runner.shutdown("SIGTERM");
    h.clock.run();
    await tick();
    expect(h.net.sockets).toHaveLength(1);
  });

  it("releases an approval nobody will ever answer, rather than hanging", async () => {
    const h = harness();
    await attach(h);
    const decision = h.fq.askPermission("Bash", { command: "sleep 999" });
    await tick();
    h.net.latest().drop(); // the operator's server is gone for good

    await h.runner.shutdown("SIGTERM");
    expect(await decision).toEqual({ behavior: "deny", message: APPROVAL_DENIED_MESSAGE });
  });

  it("flushes unacknowledged frames one last time when the socket is still up", async () => {
    const h = harness();
    await attach(h);
    h.fq.emit(assistantMsg([{ type: "text", text: "unacked" }]));
    await tick();
    const before = h.net.latest().frames().length;
    await h.runner.shutdown("SIGTERM");
    expect(h.net.latest().frames().length).toBeGreaterThan(before);
  });

  it("is idempotent", async () => {
    const h = harness();
    await attach(h);
    await Promise.all([h.runner.shutdown("SIGTERM"), h.runner.shutdown("SIGTERM")]);
    expect(h.fq.closes()).toBe(1);
  });
});
