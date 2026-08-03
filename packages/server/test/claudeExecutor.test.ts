import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Options, Query, SDKAssistantMessage, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionEvent } from "@superfabric/shared";
import type { ExecutorStartOptions } from "../src/executor.js";
import {
  ClaudeCodeExecutor,
  inProcessToolPrefixes,
  sdkPermissionMode,
  type ClaudeCodeExecutorOptions,
  type QueryFn,
} from "../src/executors/claudeCode.js";

// ---------------------------------------------------------------------------
// scripted SDKMessage builders
// ---------------------------------------------------------------------------

function initMsg(session_id: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "oauth",
    claude_code_version: "0.0.0-test",
    cwd: "/tmp",
    tools: [],
    mcp_servers: [],
    model: "claude-fable-5",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: randomUUID(),
    session_id,
  };
}

type Block = { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "tool_use"; id: string; name: string; input: unknown };

function assistantMsg(content: Block[]): SDKMessage {
  return {
    type: "assistant",
    // `BetaMessage` (peer @anthropic-ai/sdk) requires ~11 fields the executor never reads
    // (container, diagnostics, context_management, usage, stop_reason, ...). Scripting them
    // would add noise without adding coverage, so the message body is cast once.
    message: { id: "msg_1", role: "assistant", content } as unknown as SDKAssistantMessage["message"],
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: "sess-1",
  };
}

/**
 * The CLI reports tool outcomes as `type: "user"` messages carrying tool_result content blocks
 * (per notes/agent-sdk-api.md — `SDKUserMessage` is in the emitted union).
 */
type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content?: string | { type: string; text?: string }[];
  is_error?: boolean;
};

function userMsg(content: string | ToolResultBlock[], extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: "sess-1",
    ...extra,
  } as unknown as SDKMessage;
}

function resultMsg(total_cost_usd: number): SDKMessage {
  // `usage: NonNullableUsage` requires every field of the peer SDK's BetaUsage; the executor
  // only reads `total_cost_usd`, so the message is cast once instead of fabricating a full usage.
  return {
    type: "result",
    subtype: "success",
    duration_ms: 12,
    duration_api_ms: 10,
    is_error: false,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd,
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: "sess-1",
  } as unknown as SDKMessage;
}

// ---------------------------------------------------------------------------
// fake query(): a push-driven stand-in for the SDK's Query
// ---------------------------------------------------------------------------

type Outbox = { kind: "msg"; msg: SDKMessage } | { kind: "err"; err: unknown } | { kind: "end" };

function makeFakeQuery() {
  const received: SDKUserMessage[] = [];
  const outbox: Outbox[] = [];
  let wake: (() => void) | null = null;
  let capturedOptions: Options | undefined;
  let interrupts = 0;
  let closes = 0;

  const push = (item: Outbox) => {
    outbox.push(item);
    const w = wake;
    wake = null;
    w?.();
  };

  const fn: QueryFn = (params) => {
    capturedOptions = params.options;
    if (typeof params.prompt !== "string") {
      const input = params.prompt;
      void (async () => {
        for await (const m of input) received.push(m);
      })();
    }
    const gen = (async function* (): AsyncGenerator<SDKMessage, void> {
      for (;;) {
        while (outbox.length > 0) {
          const item = outbox.shift()!;
          if (item.kind === "end") return;
          if (item.kind === "err") throw item.err;
          yield item.msg;
        }
        await new Promise<void>((res) => {
          wake = res;
        });
      }
    })();
    const stub = {
      next: () => gen.next(),
      return: (v: void | PromiseLike<void>) => gen.return(v),
      throw: (e: unknown) => gen.throw(e),
      [Symbol.asyncIterator]() {
        return this;
      },
      interrupt: async () => {
        interrupts++;
        return undefined;
      },
      close: () => {
        closes++;
        push({ kind: "end" });
      },
    };
    // The SDK's `Query` interface carries ~25 control methods; the executor only uses the
    // async-iteration protocol plus interrupt()/close(). One cast beats stubbing the rest.
    return stub as unknown as Query;
  };

  return {
    fn,
    received,
    emit: (msg: SDKMessage) => push({ kind: "msg", msg }),
    fail: (err: unknown) => push({ kind: "err", err }),
    end: () => push({ kind: "end" }),
    options: () => capturedOptions,
    interrupts: () => interrupts,
    closes: () => closes,
  };
}

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 1));
  }
}

function harness(defaults: ClaudeCodeExecutorOptions = {}, start: Partial<ExecutorStartOptions> = {}) {
  const fq = makeFakeQuery();
  const events: SessionEvent[] = [];
  const approvals: { toolName: string; input: unknown }[] = [];
  let decision: "allow" | "deny" = "allow";
  const exec = new ClaudeCodeExecutor({ ...defaults, query: fq.fn });
  const handle = exec.start(
    { cwd: "/tmp/work", resumeSessionId: null, ...start },
    {
      onEvent: (e) => events.push(e),
      requestApproval: async (toolName, input) => {
        approvals.push({ toolName, input });
        return decision;
      },
    },
  );
  return { fq, events, approvals, handle, exec, setDecision: (d: "allow" | "deny") => { decision = d; } };
}

// ---------------------------------------------------------------------------

describe("ClaudeCodeExecutor", () => {
  it("emits session_status starting on start()", () => {
    const { events } = harness();
    expect(events).toEqual([{ type: "session_status", status: "starting" }]);
  });

  it("resolves providerSessionId from the system/init message", async () => {
    const { fq, handle } = harness();
    fq.emit(initMsg("11111111-2222-3333-4444-555555555555"));
    expect(await handle.providerSessionId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("maps assistant content blocks to agent_text / agent_thinking / tool_use in order", async () => {
    const { fq, events } = harness();
    fq.emit(initMsg("sess-a"));
    fq.emit(
      assistantMsg([
        { type: "text", text: "hello" },
        { type: "thinking", thinking: "hmm" },
        { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
        { type: "text", text: "bye" },
      ]),
    );
    await until(() => events.filter((e) => e.type === "agent_text").length === 2);
    expect(events.slice(1)).toEqual([
      { type: "agent_text", text: "hello" },
      { type: "agent_thinking" },
      { type: "tool_use", toolName: "Bash", input: { command: "ls" } },
      { type: "agent_text", text: "bye" },
    ]);
  });

  describe("tool_result blocks on user messages", () => {
    it("correlates the tool name from the earlier tool_use and normalizes string content", async () => {
      const { fq, events } = harness();
      fq.emit(initMsg("sess-tr"));
      fq.emit(assistantMsg([{ type: "tool_use", id: "tu_7", name: "Bash", input: { command: "ls" } }]));
      fq.emit(userMsg([{ type: "tool_result", tool_use_id: "tu_7", content: "a.txt\nb.txt" }]));
      await until(() => events.some((e) => e.type === "tool_result"));
      expect(events.slice(1)).toEqual([
        { type: "tool_use", toolName: "Bash", input: { command: "ls" } },
        { type: "tool_result", toolName: "Bash", isError: false, output: "a.txt\nb.txt" },
      ]);
    });

    it("maps is_error: true to isError: true", async () => {
      const { fq, events } = harness();
      fq.emit(initMsg("sess-tr2"));
      fq.emit(assistantMsg([{ type: "tool_use", id: "tu_8", name: "Write", input: { file_path: "/etc/x" } }]));
      fq.emit(userMsg([{ type: "tool_result", tool_use_id: "tu_8", content: "permission denied", is_error: true }]));
      await until(() => events.some((e) => e.type === "tool_result"));
      expect(events.at(-1)).toEqual({
        type: "tool_result", toolName: "Write", isError: true, output: "permission denied",
      });
    });

    it("falls back to the tool_use_id when the name was never seen, and flattens block content", async () => {
      const { fq, events } = harness();
      fq.emit(initMsg("sess-tr3"));
      fq.emit(userMsg([{
        type: "tool_result",
        tool_use_id: "tu_orphan",
        content: [{ type: "text", text: "line one" }, { type: "image" }, { type: "text", text: "line two" }],
      }]));
      await until(() => events.some((e) => e.type === "tool_result"));
      expect(events.at(-1)).toEqual({
        type: "tool_result", toolName: "tu_orphan", isError: false, output: "line one\n[image]\nline two",
      });
    });

    it("emits one event per tool_result block and omits output when there is none", async () => {
      const { fq, events } = harness();
      fq.emit(initMsg("sess-tr4"));
      fq.emit(assistantMsg([
        { type: "tool_use", id: "tu_a", name: "Read", input: {} },
        { type: "tool_use", id: "tu_b", name: "Grep", input: {} },
      ]));
      fq.emit(userMsg([
        { type: "tool_result", tool_use_id: "tu_a" },
        { type: "tool_result", tool_use_id: "tu_b", content: "hit" },
      ]));
      await until(() => events.filter((e) => e.type === "tool_result").length === 2);
      expect(events.filter((e) => e.type === "tool_result")).toEqual([
        { type: "tool_result", toolName: "Read", isError: false },
        { type: "tool_result", toolName: "Grep", isError: false, output: "hit" },
      ]);
    });

    it("ignores plain-text user turns and replayed history", async () => {
      const { fq, events } = harness();
      fq.emit(initMsg("sess-tr5"));
      fq.emit(assistantMsg([{ type: "tool_use", id: "tu_r", name: "Bash", input: {} }]));
      fq.emit(userMsg("just a prompt echoed back"));
      // isReplay marks history the CLI re-emits on resume; our log already holds those rows.
      fq.emit(userMsg([{ type: "tool_result", tool_use_id: "tu_r", content: "old" }], { isReplay: true }));
      fq.emit(resultMsg(0.1));
      await until(() => events.some((e) => e.type === "turn_complete"));
      expect(events.some((e) => e.type === "tool_result")).toBe(false);
    });
  });

  it("emits turn_complete with costUsd then session_status idle on result", async () => {
    const { fq, events } = harness();
    fq.emit(initMsg("sess-b"));
    fq.emit(resultMsg(0.0421));
    await until(() => events.some((e) => e.type === "session_status" && e.status === "idle"));
    expect(events.slice(1)).toEqual([
      { type: "turn_complete", costUsd: 0.0421 },
      { type: "session_status", status: "idle" },
    ]);
  });

  it("send() emits working + user_prompt and pushes the turn into the prompt iterable", async () => {
    const { fq, events, handle } = harness();
    fq.emit(initMsg("sess-c"));
    handle.send("do the thing");
    expect(events.slice(1)).toEqual([
      { type: "session_status", status: "working" },
      { type: "user_prompt", text: "do the thing" },
    ]);
    await until(() => fq.received.length === 1);
    expect(fq.received[0]).toEqual({
      type: "user",
      message: { role: "user", content: "do the thing" },
      parent_tool_use_id: null,
    });
  });

  it("classifies a thrown stream error into session_error + session_status error", async () => {
    const { fq, events } = harness();
    fq.emit(initMsg("sess-d"));
    fq.fail(new Error("429 rate_limit_error: slow down"));
    await until(() => events.some((e) => e.type === "session_status" && e.status === "error"));
    const err = events.find((e) => e.type === "session_error");
    expect(err).toBeDefined();
    expect(err && err.type === "session_error" && err.message).toContain("rate_limited:");
    expect(err && err.type === "session_error" && err.message).toContain("429 rate_limit_error");
    expect(events.at(-1)).toEqual({ type: "session_status", status: "error" });
  });

  it("routes canUseTool through requestApproval and maps allow", async () => {
    const { fq, approvals } = harness();
    const canUseTool = fq.options()?.canUseTool;
    expect(typeof canUseTool).toBe("function");
    const res = await canUseTool!("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      toolUseID: "tu_1",
      requestId: "req_1",
    });
    expect(approvals).toEqual([{ toolName: "Bash", input: { command: "ls" } }]);
    expect(res).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
  });

  it("maps a denied approval to a deny result with a non-empty message", async () => {
    const { fq, setDecision } = harness();
    setDecision("deny");
    const res = await fq.options()!.canUseTool!("Write", { file_path: "/etc/passwd" }, {
      signal: new AbortController().signal,
      toolUseID: "tu_2",
      requestId: "req_2",
    });
    expect(res?.behavior).toBe("deny");
    expect(res && res.behavior === "deny" ? res.message.length : 0).toBeGreaterThan(0);
  });

  it("interrupt() delegates to Query.interrupt() and stop() closes the query", async () => {
    const { fq, handle } = harness();
    await handle.interrupt();
    expect(fq.interrupts()).toBe(1);
    await handle.stop();
    expect(fq.closes()).toBe(1);
  });

  it("ignores send() after stop() without emitting events", async () => {
    const { fq, events, handle } = harness();
    fq.emit(initMsg("sess-e"));
    await handle.stop();
    const before = events.length;
    handle.send("too late");
    expect(events.length).toBe(before);
    await new Promise((r) => setTimeout(r, 5));
    expect(fq.received.length).toBe(0);
  });

  it("does not emit session_error for a stream that ends after stop()", async () => {
    const { fq, events, handle } = harness();
    fq.emit(initMsg("sess-f"));
    await handle.stop();
    fq.fail(new Error("aborted"));
    await new Promise((r) => setTimeout(r, 10));
    expect(events.some((e) => e.type === "session_error")).toBe(false);
  });

  it("threads constructor defaults and resume into Options", () => {
    const fq = makeFakeQuery();
    const exec = new ClaudeCodeExecutor({
      model: "claude-fable-5",
      configDir: "/tmp/cfg",
      appendSystemPrompt: "be terse",
      query: fq.fn,
    });
    exec.start({ cwd: "/repo", resumeSessionId: "prev-session" }, { onEvent: () => {}, requestApproval: async () => "deny" });
    const o = fq.options()!;
    expect(o.cwd).toBe("/repo");
    expect(o.resume).toBe("prev-session");
    expect(o.model).toBe("claude-fable-5");
    expect(o.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "be terse" });
    expect(o.env?.CLAUDE_CONFIG_DIR).toBe("/tmp/cfg");
    // Options.env REPLACES the subprocess env, so process.env must be spread in.
    expect(o.env?.PATH).toBe(process.env.PATH);
    expect(o.abortController).toBeInstanceOf(AbortController);
  });

  it("owns its own configuration instead of inheriting the operator's global setup", () => {
    const fq = makeFakeQuery();
    const exec = new ClaudeCodeExecutor({ query: fq.fn });
    exec.start({ cwd: "/repo" }, { onEvent: () => {}, requestApproval: async () => "deny" });
    const o = fq.options()!;
    // Explicit mode, always: a user-level defaultMode must never decide what an agent may do.
    // With no autonomy and no constructor default, that is the product default, "auto".
    expect(o.permissionMode).toBe("auto");
    // "user" excluded so the operator's personal hooks/model/permission rules stay out of
    // factory agents; project/local stay because a room's own config lives in its folder.
    expect(o.settingSources).toEqual(["project", "local"]);
  });

  it("allows a room to opt into an autonomous permission mode", () => {
    const fq = makeFakeQuery();
    const exec = new ClaudeCodeExecutor({ permissionMode: "bypassPermissions", query: fq.fn });
    exec.start({ cwd: "/repo" }, { onEvent: () => {}, requestApproval: async () => "deny" });
    expect(fq.options()!.permissionMode).toBe("bypassPermissions");
  });

  // ---- per-session autonomy (ExecutorStartOptions.autonomy) ----

  describe("autonomy", () => {
    it("maps every mode to its SDK permission mode", () => {
      expect(sdkPermissionMode("attended")).toBe("default");
      expect(sdkPermissionMode("auto")).toBe("auto");
      expect(sdkPermissionMode("bypass")).toBe("bypassPermissions");
    });

    for (const [autonomy, permissionMode] of [
      ["attended", "default"],
      ["auto", "auto"],
      ["bypass", "bypassPermissions"],
    ] as const) {
      it(`passes autonomy "${autonomy}" to the SDK as "${permissionMode}"`, () => {
        const fq = makeFakeQuery();
        const exec = new ClaudeCodeExecutor({ query: fq.fn });
        exec.start({ cwd: "/repo", autonomy }, { onEvent: () => {}, requestApproval: async () => "deny" });
        expect(fq.options()!.permissionMode).toBe(permissionMode);
        // canUseTool stays wired in every mode: the attended mode needs it, and in the other two
        // a classifier-escalated call must still be able to reach the operator.
        expect(typeof fq.options()!.canUseTool).toBe("function");
      });
    }

    it("per-session autonomy wins over the constructor default", () => {
      const fq = makeFakeQuery();
      const exec = new ClaudeCodeExecutor({ permissionMode: "bypassPermissions", query: fq.fn });
      exec.start({ cwd: "/repo", autonomy: "attended" }, { onEvent: () => {}, requestApproval: async () => "deny" });
      expect(fq.options()!.permissionMode).toBe("default");
    });

    it("sets allowDangerouslySkipPermissions only for bypass", () => {
      const gated = makeFakeQuery();
      new ClaudeCodeExecutor({ query: gated.fn })
        .start({ cwd: "/repo", autonomy: "auto" }, { onEvent: () => {}, requestApproval: async () => "deny" });
      expect(gated.options()!.allowDangerouslySkipPermissions).toBeUndefined();

      const bypass = makeFakeQuery();
      new ClaudeCodeExecutor({ query: bypass.fn })
        .start({ cwd: "/repo", autonomy: "bypass" }, { onEvent: () => {}, requestApproval: async () => "deny" });
      // The SDK requires this flag alongside "bypassPermissions".
      expect(bypass.options()!.allowDangerouslySkipPermissions).toBe(true);
    });
  });

  it("omits optional Options when no defaults are given", () => {
    const fq = makeFakeQuery();
    const exec = new ClaudeCodeExecutor({ query: fq.fn });
    exec.start({ cwd: "/repo" }, { onEvent: () => {}, requestApproval: async () => "deny" });
    const o = fq.options()!;
    expect(o.resume).toBeUndefined();
    expect(o.model).toBeUndefined();
    expect(o.systemPrompt).toBeUndefined();
    expect(o.env).toBeUndefined();
    expect(o.mcpServers).toBeUndefined();
  });

  // ---- M3a: in-process MCP tool servers (the factory bus) ----

  describe("mcpServers", () => {
    it("threads a per-session in-process server into Options under the SDK's own field name", () => {
      const fq = makeFakeQuery();
      const server = createSdkMcpServer({
        name: "factory",
        tools: [tool("factory_ping", "test tool", {}, async () => ({ content: [{ type: "text", text: "pong" }] }))],
      });
      new ClaudeCodeExecutor({ query: fq.fn })
        .start({ cwd: "/repo", mcpServers: { factory: server } }, { onEvent: () => {}, requestApproval: async () => "deny" });

      const o = fq.options()!;
      expect(o.mcpServers).toEqual({ factory: server });
      // an in-process server carries a live instance, so it must be passed by reference
      expect(o.mcpServers!.factory).toBe(server);
      expect((o.mcpServers!.factory as { type?: string }).type).toBe("sdk");
    });

    it("omits mcpServers entirely for a session with no tool servers", () => {
      const fq = makeFakeQuery();
      new ClaudeCodeExecutor({ query: fq.fn })
        .start({ cwd: "/repo", mcpServers: {} }, { onEvent: () => {}, requestApproval: async () => "deny" });
      // an empty record would tell the CLI "this session has MCP servers"; a roomless session has none
      expect(fq.options()!.mcpServers).toBeUndefined();
    });
  });

  // ---- M3a: the factory's own bus tools are never gated (ADR 0002) ----

  describe("the factory's own tools are not gated", () => {
    const factoryServer = () =>
      createSdkMcpServer({
        name: "factory",
        tools: [tool("factory_send", "test tool", {}, async () => ({ content: [{ type: "text", text: "sent" }] }))],
      });
    /** What the CLI hands `canUseTool` besides the tool name and its input. */
    const ctx = (toolUseID: string) => ({
      signal: new AbortController().signal,
      toolUseID,
      requestId: `req_${toolUseID}`,
    });

    it("derives the ungated prefixes from the session's own in-process servers", () => {
      expect(inProcessToolPrefixes(undefined)).toEqual([]);
      expect(inProcessToolPrefixes({ factory: factoryServer() })).toEqual(["mcp__factory__"]);
      // A stdio/http server is a third party reaching outside this process; it stays gated.
      expect(inProcessToolPrefixes({
        factory: factoryServer(),
        github: { type: "stdio", command: "gh-mcp" },
      })).toEqual(["mcp__factory__"]);
    });

    it("allows an attended agent's factory_send without ever asking the operator", async () => {
      const { fq, approvals } = harness({}, { autonomy: "attended", mcpServers: { factory: factoryServer() } });
      const res = await fq.options()!.canUseTool!(
        "mcp__factory__factory_send",
        { to_room: "payments", kind: "request", body: "need a webhook" },
        ctx("tu_bus"),
      );
      expect(res).toEqual({
        behavior: "allow",
        updatedInput: { to_room: "payments", kind: "request", body: "need a webhook" },
      });
      // The whole point: no approval card, in the mode where every gated call raises one.
      expect(approvals).toEqual([]);
    });

    it("still records the ungated call in the log, exactly once", async () => {
      const { fq, events } = harness({}, { autonomy: "attended", mcpServers: { factory: factoryServer() } });
      fq.emit(initMsg("sess-bus"));
      await fq.options()!.canUseTool!("mcp__factory__factory_send", { body: "hi" }, ctx("tu_1"));
      // The assistant message reporting the same call must not double it up in the transcript.
      fq.emit(assistantMsg([{ type: "tool_use", id: "tu_1", name: "mcp__factory__factory_send", input: { body: "hi" } }]));
      fq.emit(userMsg([{ type: "tool_result", tool_use_id: "tu_1", content: "Message m1 delivered." }]));
      await until(() => events.some((e) => e.type === "tool_result"));
      expect(events.filter((e) => e.type === "tool_use")).toEqual([
        { type: "tool_use", toolName: "mcp__factory__factory_send", input: { body: "hi" } },
      ]);
      // …and the result still correlates to the name the operator saw.
      expect(events.at(-1)).toEqual({
        type: "tool_result", toolName: "mcp__factory__factory_send", isError: false,
        output: "Message m1 delivered.",
      });
    });

    it("keeps gating everything else in the same session", async () => {
      const { fq, approvals } = harness({}, { autonomy: "attended", mcpServers: { factory: factoryServer() } });
      const res = await fq.options()!.canUseTool!("Bash", { command: "rm -rf /" }, ctx("tu_2"));
      expect(approvals).toEqual([{ toolName: "Bash", input: { command: "rm -rf /" } }]);
      expect(res?.behavior).toBe("allow"); // the harness's operator said yes; the point is it was asked
    });

    it("gates a factory-looking tool name in a session that was given no bus", async () => {
      const { fq, approvals } = harness({}, { autonomy: "attended" });
      await fq.options()!.canUseTool!("mcp__factory__factory_send", { body: "hi" }, ctx("tu_3"));
      // A roomless session has no factory server, so nothing about it is ours to auto-allow.
      expect(approvals).toEqual([{ toolName: "mcp__factory__factory_send", input: { body: "hi" } }]);
    });
  });
});
