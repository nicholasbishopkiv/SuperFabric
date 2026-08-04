import { describe, expect, it } from "bun:test";
import { RUNNER_PROTOCOL_VERSION, type SessionEvent } from "@superfabric/shared";
import { RunnerHub } from "../src/runnerHub.js";
import { FakeRunner } from "./fixtures/fakeDocker.js";
import { waitFor } from "./_waitFor.js";

/**
 * The server's end of the runner protocol.
 *
 * The interesting properties are all about a socket that comes and goes and a peer that has to prove
 * who it is — so nothing here needs Docker, a container or a real WebSocket. What it does use is the
 * real schemas from `@superfabric/shared` on both sides, so the two ends cannot drift.
 */

interface Recorded {
  events: SessionEvent[];
  providerSessions: string[];
  approvals: { toolName: string; input: unknown; resolve: (b: "allow" | "deny") => void }[];
  byes: string[];
}

function register(hub: RunnerHub, id = "att-1", token = "s3cret") {
  const rec: Recorded = { events: [], providerSessions: [], approvals: [], byes: [] };
  const attachment = hub.register({
    id,
    token,
    events: {
      onEvent: (e) => rec.events.push(e),
      onProviderSession: (p) => rec.providerSessions.push(p),
      requestApproval: (toolName, input) =>
        new Promise((resolve) => rec.approvals.push({ toolName, input, resolve })),
      onBye: (reason) => rec.byes.push(reason),
    },
  });
  return { attachment, rec };
}

describe("RunnerHub: proving who you are", () => {
  it("refuses a hello carrying the wrong token, and tells it nothing else", () => {
    const hub = new RunnerHub();
    register(hub, "att-1", "the-real-token");

    const impostor = new FakeRunner(hub, "att-1", "the-real-token");
    impostor.connect({ token: "not-the-real-token" });

    expect(impostor.attached).toBe(false);
    expect(impostor.refusal).toBe("this server is not expecting that runner");
    expect(impostor.closed).toBe(true);
  });

  it("refuses a hello for an attachment nobody registered", () => {
    const hub = new RunnerHub();
    const stranger = new FakeRunner(hub, "att-nobody", "whatever");
    stranger.connect();
    expect(stranger.attached).toBe(false);
    // Deliberately the same sentence as a wrong token: a caller must not be able to learn which of
    // the two it got wrong, because that tells it whether an attachment id exists.
    expect(stranger.refusal).toBe("this server is not expecting that runner");
  });

  it("refuses a runner speaking another protocol version, and says how to fix it", () => {
    const hub = new RunnerHub();
    register(hub);
    const old = new FakeRunner(hub, "att-1", "s3cret");
    old.connect({ protocolVersion: RUNNER_PROTOCOL_VERSION + 1 });
    expect(old.attached).toBe(false);
    expect(old.refusal).toContain(`speaks runner protocol ${RUNNER_PROTOCOL_VERSION}`);
    expect(old.refusal).toContain("agent-runner image");
  });

  it("refuses a peer that sends anything before hello", () => {
    const hub = new RunnerHub();
    const { rec } = register(hub);
    const handlers = hub.attach({ send: () => {}, close: () => {} });
    handlers.message(JSON.stringify({
      kind: "frame", seq: 1, body: { type: "event", event: { type: "agent_text", text: "hi" } },
    }));
    expect(rec.events).toEqual([]);
  });

  it("accepts the right token and admits nothing until it has", () => {
    const hub = new RunnerHub();
    const { rec } = register(hub);
    const runner = new FakeRunner(hub, "att-1", "s3cret");
    runner.connect();
    expect(runner.attached).toBe(true);
    runner.emit({ type: "agent_text", text: "hello" });
    expect(rec.events).toEqual([{ type: "agent_text", text: "hello" }]);
  });

  it("releasing an attachment stops it accepting anything, even with the right token", () => {
    const hub = new RunnerHub();
    const { attachment, rec } = register(hub);
    attachment.release();
    const runner = new FakeRunner(hub, "att-1", "s3cret");
    runner.connect();
    expect(runner.refusal).toBe("this server is not expecting that runner");
    expect(rec.events).toEqual([]);
    expect(hub.size).toBe(0);
  });
});

describe("RunnerHub: the stream", () => {
  it("applies frames once, acknowledges every one, and drops what it already has", () => {
    const hub = new RunnerHub();
    const { rec } = register(hub);
    const runner = new FakeRunner(hub, "att-1", "s3cret");
    runner.connect();

    runner.emit({ type: "agent_text", text: "one" });
    runner.emit({ type: "agent_text", text: "two" });
    // The same two, as a reconnect would re-send them.
    runner.reframe(1, { type: "event", event: { type: "agent_text", text: "one" } });
    runner.reframe(2, { type: "event", event: { type: "agent_text", text: "two" } });

    expect(rec.events.map((e) => (e.type === "agent_text" ? e.text : e.type))).toEqual(["one", "two"]);
    const acks = runner.received.flatMap((m) => (m.kind === "ack" ? [m.seq] : []));
    expect(acks).toEqual([1, 2, 2, 2]);
  });

  it("re-attaching says how far the server got, so the runner replays only the tail", () => {
    const hub = new RunnerHub();
    const { rec } = register(hub);
    const runner = new FakeRunner(hub, "att-1", "s3cret");
    runner.connect();
    runner.emit({ type: "agent_text", text: "before" });
    runner.disconnect();

    runner.connect();
    const attached = runner.received.filter((m) => m.kind === "attached");
    expect(attached.at(-1)).toEqual({ kind: "attached", ackedSeq: 1 });

    runner.emit({ type: "agent_text", text: "after" });
    expect(rec.events).toHaveLength(2);
  });

  it("keeps the provider session id, which is what makes the session resumable", () => {
    const hub = new RunnerHub();
    const { rec } = register(hub);
    const runner = new FakeRunner(hub, "att-1", "s3cret");
    runner.connect();
    runner.providerSession("claude-abc");
    expect(rec.providerSessions).toEqual(["claude-abc"]);
  });

  it("survives a frame it cannot parse from an authenticated runner", () => {
    const hub = new RunnerHub();
    const { rec } = register(hub);
    const runner = new FakeRunner(hub, "att-1", "s3cret");
    runner.connect();
    runner.raw("{not json");
    runner.raw(JSON.stringify({ kind: "nonsense" }));
    runner.emit({ type: "agent_text", text: "still here" });
    expect(rec.events).toEqual([{ type: "agent_text", text: "still here" }]);
  });
});

describe("RunnerHub: talking back", () => {
  it("holds a prompt sent before the container attached, then delivers it in order", () => {
    const hub = new RunnerHub();
    const { attachment } = register(hub);
    attachment.prompt("first");
    attachment.prompt("second");
    expect(attachment.attached).toBe(false);

    const runner = new FakeRunner(hub, "att-1", "s3cret");
    runner.connect();
    expect(runner.prompts()).toEqual(["first", "second"]);
  });

  it("waitForAttach resolves when a runner arrives and rejects when none does", async () => {
    const hub = new RunnerHub();
    const { attachment } = register(hub);
    const waiting = attachment.waitForAttach(1000);
    new FakeRunner(hub, "att-1", "s3cret").connect();
    await waiting;

    const { attachment: lonely } = register(hub, "att-2", "t");
    await expect(lonely.waitForAttach(20)).rejects.toThrow(/no runner attached within 20 ms/);
  });

  it("asks the operator once however many times the runner re-asks, and repeats the answer", async () => {
    const hub = new RunnerHub();
    const { rec } = register(hub);
    const runner = new FakeRunner(hub, "att-1", "s3cret");
    runner.connect();

    runner.askApproval("req-1", "Bash", { command: "rm -rf /" });
    runner.askApproval("req-1", "Bash", { command: "rm -rf /" });
    expect(rec.approvals).toHaveLength(1);

    rec.approvals[0]!.resolve("deny");
    await waitFor(() => {
      expect(runner.approvalAnswers()).toEqual([{ requestId: "req-1", behavior: "deny" }]);
    });

    // A runner whose socket died before the answer arrived asks again; the answer is repeated
    // rather than the operator being shown the card a second time.
    runner.askApproval("req-1", "Bash", { command: "rm -rf /" });
    expect(rec.approvals).toHaveLength(1);
    expect(runner.approvalAnswers()).toHaveLength(2);
  });

  it("denies when the operator's side fails, so the agent's turn is never left hanging", async () => {
    const hub = new RunnerHub();
    hub.register({
      id: "att-1",
      token: "s3cret",
      events: {
        onEvent: () => {},
        onProviderSession: () => {},
        requestApproval: () => Promise.reject(new Error("the session is gone")),
      },
    });
    const runner = new FakeRunner(hub, "att-1", "s3cret");
    runner.connect();
    runner.askApproval("req-1", "Write", {});
    await waitFor(() => {
      expect(runner.approvalAnswers()).toEqual([{ requestId: "req-1", behavior: "deny" }]);
    });
  });

  it("reports a goodbye without treating it as a failure", () => {
    const hub = new RunnerHub();
    const { rec } = register(hub);
    const runner = new FakeRunner(hub, "att-1", "s3cret");
    runner.connect();
    runner.bye("stopped by the server");
    expect(rec.byes).toEqual(["stopped by the server"]);
    expect(rec.events).toEqual([]);
  });

  it("a second connection for one attachment replaces the first", () => {
    const hub = new RunnerHub();
    register(hub);
    const first = new FakeRunner(hub, "att-1", "s3cret");
    first.connect();
    const second = new FakeRunner(hub, "att-1", "s3cret");
    second.connect();
    expect(first.closed).toBe(true);
    expect(second.attached).toBe(true);
  });
});
