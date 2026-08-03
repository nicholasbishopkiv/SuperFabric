import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { MessageKind, TaskStatus, type MessageInfo } from "@superfabric/shared";
import { z } from "zod";
import type { FactoryBus } from "./factoryBus.js";
import type { RoomManager } from "./roomManager.js";
import type { TaskStore } from "./taskStore.js";

/**
 * MCP server name. The model sees each tool as `mcp__factory__<tool>` — the SDK namespaces
 * in-process servers exactly like external ones — so this string is part of the agent-visible tool
 * names, and changing it changes what a room's charter should tell agents to call.
 */
export const FACTORY_MCP_SERVER_NAME = "factory";

export interface BusToolsDeps {
  bus: FactoryBus;
  tasks: TaskStore;
  rooms: RoomManager;
  /**
   * The calling room. Comes from the session that owns this tool set and is **never** read from
   * tool input: an agent must not be able to send a message *as* another department.
   */
  roomId: string;
  /** Append a human-readable status line to the calling session's log. */
  reportStatus: (summary: string) => void;
}

/** How many delivered messages `factory_inbox` shows alongside the queue. */
const INBOX_RECENT = 10;

/**
 * What a tool handler hands back to the SDK: the SDK's `CallToolResult` narrowed to the one content
 * shape we produce. The index signature is part of that type (MCP results are open to extra fields),
 * and `CallToolResult` itself lives in `@modelcontextprotocol/sdk`, which is the agent SDK's
 * dependency rather than ours — so the shape is stated structurally here instead of imported from a
 * package we do not declare.
 */
interface ToolReply {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [extra: string]: unknown;
}

/**
 * One factory tool. Two things happen here that every tool needs:
 *
 * - the declared shape is **re-validated in the handler**. The MCP layer validates arguments against
 *   `inputSchema` before a call gets this far, but the handler is also called directly (by tests,
 *   and by anything in-process later), and a tool whose only validation lives in a layer above it is
 *   a tool that trusts its caller.
 * - a failure becomes tool-visible error text rather than a throw. A throwing in-process MCP handler
 *   is an error the agent can neither see nor correct; `isError` text is something it can read and
 *   retry from.
 */
function factoryTool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: Shape,
  run: (args: z.output<z.ZodObject<Shape>>) => string,
): SdkMcpToolDefinition<Shape> {
  return tool(name, description, shape, async (raw): Promise<ToolReply> => {
    try {
      // `parse` also strips fields the schema does not declare, so an invented `from_room` cannot
      // reach the body of a handler even by accident.
      return { content: [{ type: "text", text: run(z.object(shape).parse(raw)) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `factory bus error: ${String(err)}` }], isError: true };
    }
  });
}

/**
 * The bus as tools an agent can actually call. Delivery is *not* one of them: an agent receives
 * messages as injected turns, so `factory_inbox` is a look-back for context, never a poll loop —
 * the description says so, because a tool an agent misreads as "check for work" costs tokens for
 * nothing on every turn.
 *
 * `SdkMcpToolDefinition<any>` is the SDK's own element type for `createSdkMcpServer({ tools })`:
 * each tool carries its own zod shape, so the array cannot be uniformly parameterised.
 */
export function busToolDefinitions(deps: BusToolsDeps): SdkMcpToolDefinition<any>[] {
  const { bus, tasks, rooms, roomId, reportStatus } = deps;

  const send = factoryTool(
    "factory_send",
    "Send a message to another room (department) of the factory. The recipient receives it as a "
      + "turn in its own session — you do not need to wait for or poll anything. Use kind=request "
      + "when you need something back, response when you are answering a request, info otherwise.",
    {
      to_room: z.string().describe("Name of the recipient room, as shown on the factory floor."),
      kind: MessageKind.describe("request = needs an answer, response = answers one, info = FYI."),
      body: z.string().min(1).max(8000)
        .describe("What to say. Be specific and self-contained: the recipient cannot see your conversation."),
      task_id: z.string().optional()
        .describe("The task this message is about, if any. A request naming a task blocks that task on this message."),
    },
    (args) => {
      const to = roomByName(rooms, args.to_room);
      const msg = bus.send({
        // The sending room is this tool set's room — the session's — never anything from `args`.
        fromRoomId: roomId,
        toRoomId: to.id,
        kind: args.kind,
        body: args.body,
        taskId: args.task_id ?? null,
      });
      if (args.task_id !== undefined) linkTask(tasks, args.task_id, msg);
      const state = msg.deliveredAt === null
        ? `queued for the ${to.name} room (it is busy; it will arrive at its next turn boundary)`
        : `delivered to the ${to.name} room`;
      return `Message ${msg.id} ${state}.`;
    },
  );

  const inbox = factoryTool(
    "factory_inbox",
    "Look back at your room's bus traffic: messages still queued for you, then the most recent ones "
      + "already delivered. You do NOT need to call this to receive messages — they arrive as turns "
      + "on their own. Use it only to re-read something or to check whether a reply landed.",
    {},
    () => {
      const queued = bus.undeliveredFor(roomId);
      const recent = bus.deliveredFor(roomId, INBOX_RECENT);
      if (queued.length === 0 && recent.length === 0) return "No bus traffic for this room yet.";
      const lines: string[] = [];
      if (queued.length > 0) {
        lines.push(`Queued for you (${queued.length}):`, ...queued.map((m) => describe(rooms, m)));
      }
      if (recent.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push(`Recently delivered (${recent.length}):`, ...recent.map((m) => describe(rooms, m)));
      }
      return lines.join("\n");
    },
  );

  const taskUpdate = factoryTool(
    "factory_task_update",
    "Update a task on the factory's task board so the operator can see where the work stands.",
    {
      task_id: z.string().describe("Id of the task, as shown on the board or in a bus message."),
      status: TaskStatus.optional().describe("open, in_progress, blocked, review or done."),
      detail: z.string().max(4000).optional().describe("Replaces the task's detail text."),
    },
    (args) => {
      const patch: { status?: TaskStatus; detail?: string } = {};
      if (args.status !== undefined) patch.status = args.status;
      if (args.detail !== undefined) patch.detail = args.detail;
      const task = tasks.update(args.task_id, patch);
      return `Task ${task.id} is now ${task.status}.`;
    },
  );

  const reportStatusTool = factoryTool(
    "factory_report_status",
    "Tell the operator, in one line, what you are doing right now. Shows up on your agent in the "
      + "factory view and in the event log.",
    {
      summary: z.string().min(1).max(500)
        .describe("One short line, e.g. 'writing the webhook handler'."),
    },
    (args) => {
      reportStatus(args.summary);
      return "Status reported.";
    },
  );

  return [send, inbox, taskUpdate, reportStatusTool];
}

/**
 * The in-process MCP server handed to the SDK through `Options.mcpServers`. One server per session:
 * the calling room is baked into the closures rather than passed by whoever calls a tool.
 */
export function busTools(deps: BusToolsDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: FACTORY_MCP_SERVER_NAME,
    version: "1.0.0",
    instructions:
      "The SuperFabric factory bus. Other rooms are other agents working in other folders of this "
      + "project. Messages you send arrive as turns in their sessions, and messages they send arrive "
      + "as turns in yours — nobody polls.",
    tools: busToolDefinitions(deps),
    // These four are the factory's own wiring: an agent that cannot see them cannot answer another
    // room at all, so they must never be deferred behind tool search.
    alwaysLoad: true,
  });
}

/** A message as one readable line for `factory_inbox`. */
function describe(rooms: RoomManager, m: MessageInfo): string {
  const from = rooms.getRoom(m.fromRoomId)?.name ?? m.fromRoomId;
  const task = m.taskId === null ? "" : ` [task ${m.taskId}]`;
  return `- ${m.id} ${m.kind} from "${from}"${task}: ${m.body}`;
}

/**
 * Resolve a room *name* — what an agent can actually know — to a room. An unknown name lists what
 * does exist: an agent that guessed "backend" when the room is called "api" can fix that itself.
 */
function roomByName(rooms: RoomManager, name: string): { id: string; name: string } {
  const all = rooms.listRooms();
  const room = all.find((r) => r.name === name);
  if (room === undefined) {
    throw new Error(`unknown room ${JSON.stringify(name)}; rooms are: ${all.map((r) => r.name).join(", ")}`);
  }
  return room;
}

/**
 * Keep the board honest about what a message did to a task. A `request` naming a task is exactly
 * what `blockedOnMessageId` means, so it blocks it; a `response` releases it, but only if that task
 * was actually waiting — a reply must not resurrect work someone already marked done.
 */
function linkTask(tasks: TaskStore, taskId: string, msg: MessageInfo): void {
  if (msg.kind === "request") {
    tasks.update(taskId, { status: "blocked", blockedOnMessageId: msg.id });
    return;
  }
  if (msg.kind !== "response") return;
  const task = tasks.get(taskId);
  if (task === undefined) throw new Error(`unknown task ${taskId}`);
  if (task.blockedOnMessageId === null) return;
  tasks.update(taskId, {
    status: task.status === "blocked" ? "in_progress" : task.status,
    blockedOnMessageId: null,
  });
}
