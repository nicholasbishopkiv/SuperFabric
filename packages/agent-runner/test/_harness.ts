import { randomUUID } from "node:crypto";
import type { Options, Query, SDKAssistantMessage, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { RunnerMessage, type RunnerServerMessage } from "@superfabric/shared";
import type { ConnectFn, RunnerSocket, RunnerSocketHandlers } from "../src/socket.js";
import type { QueryFn } from "../src/runner.js";

/**
 * The two seams every test here uses: a fake socket the test can drop at an awkward moment, and a
 * fake `query()` the test drives message by message. Between them the runner's whole protocol
 * surface is reachable with no container, no server and no quota — the same technique
 * `server/test/claudeExecutor.test.ts` uses on the local executor.
 */

// ---------------------------------------------------------------------------
// scripted SDKMessage builders (the shapes verified in notes/agent-sdk-api.md)
// ---------------------------------------------------------------------------

export function initMsg(session_id: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "oauth",
    claude_code_version: "0.0.0-test",
    cwd: "/work",
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

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export function assistantMsg(content: Block[]): SDKMessage {
  return {
    type: "assistant",
    // `BetaMessage` requires ~11 fields the mapping never reads; scripting them would add noise
    // without adding coverage, so the message body is cast once (as the server's twin test does).
    message: { id: "msg_1", role: "assistant", content } as unknown as SDKAssistantMessage["message"],
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: "sess-1",
  };
}

type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content?: string | { type: string; text?: string }[];
  is_error?: boolean;
};

export function userMsg(content: string | ToolResultBlock[]): SDKMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: "sess-1",
  } as unknown as SDKMessage;
}

export function resultMsg(total_cost_usd: number): SDKMessage {
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

export interface FakeQuery {
  fn: QueryFn;
  /** User turns the runner streamed into the query. */
  received: SDKUserMessage[];
  emit(msg: SDKMessage): void;
  fail(err: unknown): void;
  end(): void;
  options(): Options | undefined;
  /** Call the `canUseTool` the runner installed, as the CLI would. */
  askPermission(toolName: string, input: Record<string, unknown>, toolUseID?: string): Promise<unknown>;
  interrupts(): number;
  closes(): number;
}

export function makeFakeQuery(): FakeQuery {
  const received: SDKUserMessage[] = [];
  const outbox: Outbox[] = [];
  let wake: (() => void) | null = null;
  let capturedOptions: Options | undefined;
  let interrupts = 0;
  let closes = 0;

  const push = (item: Outbox): void => {
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
    return stub as unknown as Query;
  };

  return {
    fn,
    received,
    emit: (msg) => push({ kind: "msg", msg }),
    fail: (err) => push({ kind: "err", err }),
    end: () => push({ kind: "end" }),
    options: () => capturedOptions,
    askPermission: (toolName, input, toolUseID = `tu_${randomUUID()}`) => {
      const canUseTool = capturedOptions?.canUseTool;
      if (canUseTool === undefined) throw new Error("the runner installed no canUseTool");
      return canUseTool(toolName, input, {
        signal: new AbortController().signal,
        toolUseID,
        requestId: randomUUID(),
      });
    },
    interrupts: () => interrupts,
    closes: () => closes,
  };
}

// ---------------------------------------------------------------------------
// fake socket
// ---------------------------------------------------------------------------

export class FakeSocket implements RunnerSocket {
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string, private readonly handlers: RunnerSocketHandlers) {}

  send(data: string): void {
    if (this.closed) return;
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose();
  }

  /** Open the connection, as a real socket does — asynchronously, after the factory returned. */
  open(): void {
    this.handlers.onOpen();
  }

  /** The server (or the network) drops the connection under a live agent. */
  drop(): void {
    this.close();
  }

  deliver(msg: RunnerServerMessage): void {
    if (this.closed) return;
    this.handlers.onMessage(JSON.stringify(msg));
  }

  /** Anything at all, to exercise the parser's tolerance. */
  deliverRaw(data: string): void {
    if (this.closed) return;
    this.handlers.onMessage(data);
  }

  messages(): RunnerMessage[] {
    return this.sent.map((s) => RunnerMessage.parse(JSON.parse(s)));
  }

  frames(): Extract<RunnerMessage, { kind: "frame" }>[] {
    return this.messages().filter((m): m is Extract<RunnerMessage, { kind: "frame" }> => m.kind === "frame");
  }

  events(): unknown[] {
    return this.frames()
      .filter((f) => f.body.type === "event")
      .map((f) => (f.body as { type: "event"; event: unknown }).event);
  }
}

export interface FakeNetwork {
  connect: ConnectFn;
  sockets: FakeSocket[];
  /** The connection currently in use. */
  latest(): FakeSocket;
}

export function makeFakeNetwork(): FakeNetwork {
  const sockets: FakeSocket[] = [];
  const connect: ConnectFn = (url, handlers) => {
    const socket = new FakeSocket(url, handlers);
    sockets.push(socket);
    // Real sockets open on a later turn of the loop; opening synchronously here would fire
    // `onOpen` before the runner has even stored the socket, which is not a situation that exists.
    queueMicrotask(() => socket.open());
    return socket;
  };
  return { connect, sockets, latest: () => sockets[sockets.length - 1]! };
}

/** A `schedule` the test drives by hand, so reconnect backoff costs no wall-clock time. */
export function makeClock(): { schedule: (fn: () => void, ms: number) => void; run(): number; pending: number } {
  let queue: { fn: () => void; ms: number }[] = [];
  return {
    schedule: (fn, ms) => {
      queue.push({ fn, ms });
    },
    run(): number {
      const due = queue;
      queue = [];
      for (const item of due) item.fn();
      return due.length;
    },
    get pending(): number {
      return queue.length;
    },
  };
}

export async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => setImmediate(r));
}

export async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 1));
  }
}
