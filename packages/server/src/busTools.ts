import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { MessageKind, TaskStatus, type MessageInfo } from "@superfabric/shared";
import { z } from "zod";
import type { Chronicle } from "./chronicle.js";
import type { FactoryBus } from "./factoryBus.js";
import type { RoomManager } from "./roomManager.js";
import type { TaskRouter } from "./router.js";
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
  /**
   * This tool set belongs to the factory's orchestrator, so it carries the orchestrator-only tools
   * as well as the room tools. Comes from the session row (like `roomId`), never from tool input.
   */
  isOrchestrator?: boolean;
  /**
   * Task routing. Absent => the orchestrator's own tools report that this server has no router,
   * rather than being silently missing from a tool list that says it is the orchestrator's.
   */
  router?: TaskRouter;
  /**
   * The Chronicle. Absent => `factory_record_decision` and `factory_search_history` are not in this
   * session's tool set at all: a tool that cannot write the ADR file it promises is worse than no
   * tool, because an agent will believe it recorded something.
   */
  chronicle?: Chronicle;
  /**
   * The calling session, recorded as the author of a decision. Like `roomId`, it comes from the
   * session that owns this tool set and never from tool input.
   */
  sessionId?: string;
}

/** How many delivered messages `factory_inbox` shows alongside the queue. */
const INBOX_RECENT = 10;

/**
 * How much of one prose field of a decision is stored. Past this the field is **truncated, never
 * refused** — see `fitDecisionField`.
 */
const DECISION_FIELD_CHARS = 8000;

/** Longest stored title, longest stored link, and how many links one decision may carry. */
const DECISION_TITLE_CHARS = 200;
const DECISION_LINK_CHARS = 500;
const DECISION_LINKS = 20;

/**
 * What a truncated field ends with. It is written into the ADR itself, so the file says of its own
 * accord that something is missing — a reader who never sees the tool's reply still knows.
 */
const TRUNCATION_MARK =
  "\n\n[truncated by SuperFabric: the rest of this field did not fit. Edit this file to restore it.]";

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
      const to = roomByName(rooms, roomId, args.to_room);
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

  const askOrchestrator = factoryTool(
    "factory_ask_orchestrator",
    "Ask the factory's orchestrator — the senior agent in the project room — for a ruling: where "
      + "something belongs, which of two ways to go, or anything blocking you that is above your "
      + "room's remit. It answers as an ordinary bus message, so the answer arrives as a turn here. "
      + "Naming a task blocks that task until the answer comes back.",
    {
      question: z.string().min(1).max(8000)
        .describe("What you need decided. Be specific and self-contained: it cannot see your conversation."),
      task_id: z.string().optional()
        .describe("The task this is about, if any. Naming it blocks that task on the question."),
    },
    (args) => {
      const projectId = rooms.projectOf(roomId);
      if (projectId === undefined) throw new Error(`unknown room ${roomId}`);
      const projectRoom = rooms.listRooms(projectId).find((r) => r.kind === "project");
      if (projectRoom === undefined) throw new Error("this factory has no project room to ask");
      if (projectRoom.id === roomId) {
        throw new Error("you are in the project room — the orchestrator is here, not somewhere to ask");
      }

      // An ordinary bus message, sent exactly as `factory_send` would send it. There is no
      // privileged channel to the orchestrator on purpose: the traffic has to be visible on the
      // floor and in the log like everyone else's, and the orchestrator answers with `factory_send`
      // like anyone else.
      const msg = bus.send({
        fromRoomId: roomId,
        toRoomId: projectRoom.id,
        kind: "request",
        body: args.question,
        taskId: args.task_id ?? null,
      });
      if (args.task_id !== undefined) linkTask(tasks, args.task_id, msg);

      // Honest about a factory with no senior agent: the question is a durable row either way, and
      // it will be delivered the moment one exists — but nobody is going to answer it today.
      const unmanned = deps.router !== undefined && !deps.router.hasOrchestrator(projectId)
        ? " This factory has no orchestrator yet, so nothing will answer until one is created;"
          + " the question is queued in the project room until then."
        : "";
      return `Question ${msg.id} sent to the project room.${unmanned}`;
    },
  );

  const roomTools = [
    send, inbox, taskUpdate, reportStatusTool, askOrchestrator,
    ...(deps.chronicle !== undefined ? chronicleToolDefinitions(deps, deps.chronicle) : []),
  ];
  // The tool surface is per session: an ordinary agent's list simply does not contain these. The
  // handlers refuse anyway (see `orchestratorToolDefinitions`) — a tool that is only kept out of
  // reach by not being offered is not gated, it is merely unadvertised.
  return deps.isOrchestrator === true ? [...roomTools, ...orchestratorToolDefinitions(deps)] : roomTools;
}

/**
 * The Chronicle as tools: write down why, and find out why before changing something.
 *
 * Every agent gets both, not just the orchestrator. A decision made inside a room is exactly the
 * kind that gets lost — the orchestrator was never told, so it cannot record it, and the next agent
 * in that folder has no way to learn it short of asking whoever is gone.
 */
export function chronicleToolDefinitions(
  deps: BusToolsDeps,
  chronicle: Chronicle,
): SdkMcpToolDefinition<any>[] {
  const { rooms, roomId } = deps;
  const projectOf = (): string => {
    const projectId = rooms.projectOf(roomId);
    if (projectId === undefined) throw new Error(`unknown room ${roomId}`);
    return projectId;
  };

  const recordDecision = factoryTool(
    "factory_record_decision",
    "Write down a decision that shapes how this project is built — an interface, a technology, a "
      + "convention, a plan that supersedes another — as an ADR file in the repository's "
      + "docs/decisions/. Record the reasoning, not just the outcome: the next agent reads this to "
      + "find out WHY before changing it. Search first with factory_search_history. "
      + "KEEP IT SHORT: a decision, not an essay — a few sentences per field. A very large tool "
      + "input can fail to send at all, and then nothing is recorded; the ADR is an ordinary file "
      + "you can edit afterwards to add detail. Nothing here is ever rejected for being too long — "
      + "an over-long field is stored truncated, with a marker saying so.",
    {
      title: z.string().min(1)
        .describe("One line naming the decision, e.g. 'Retries live in the payments room'."),
      context: z.string()
        .describe(
          "What made this a question: the constraint, the disagreement, what was true at the time. "
          + "A short paragraph, not a transcript.",
        ),
      decision: z.string().min(1)
        .describe(
          "What was decided, stated so someone can act on it without reading the context. "
          + "One or two sentences.",
        ),
      alternatives: z.string().optional()
        .describe(
          "What else was considered and why it was not chosen. This is what stops it being "
          + "re-litigated. A line or two each.",
        ),
      links: z.array(z.string()).optional()
        .describe(`Files, tasks, messages or URLs this decision rests on. At most ${DECISION_LINKS}.`),
    },
    (args) => {
      // Truncate, never refuse. The upstream failure this guards against is the model's own
      // tool-input serialisation giving out on a large payload, which is not something we can fix
      // from here; what we *can* stop is our own schema throwing away a decision that did arrive
      // intact but ran long. A decision that says it was cut short is recoverable — the ADR is a
      // file, and the agent is told to go and edit it. A rejected one is simply gone.
      const cuts: string[] = [];
      const fit = (value: string, limit: number, field: string): string =>
        fitDecisionField(value, limit, field, cuts);

      const links = (args.links ?? []).slice(0, DECISION_LINKS)
        .map((l, i) => fit(l, DECISION_LINK_CHARS, `link ${i + 1}`));
      if ((args.links?.length ?? 0) > DECISION_LINKS) {
        cuts.push(`links (${args.links!.length} given, first ${DECISION_LINKS} kept)`);
      }

      const record = chronicle.record({
        projectId: projectOf(),
        // The room and the author come from the session that owns this tool set, never from `args`.
        roomId,
        agentId: deps.sessionId ?? null,
        title: fit(args.title, DECISION_TITLE_CHARS, "title"),
        context: fit(args.context, DECISION_FIELD_CHARS, "context"),
        decision: fit(args.decision, DECISION_FIELD_CHARS, "decision"),
        ...(args.alternatives !== undefined
          ? { alternatives: fit(args.alternatives, DECISION_FIELD_CHARS, "alternatives") }
          : {}),
        ...(args.links !== undefined ? { links } : {}),
      });
      const recorded = `Decision recorded as ${record.path}. It is a file in the repository, so it `
        + "is there for anyone who works on this next, with or without SuperFabric running.";
      if (cuts.length === 0) return recorded;
      return `${recorded} NOTE: this record was too long, so ${cuts.join(", ")} was truncated and `
        + "marked as such in the file. Nothing was lost that you cannot put back: edit the file "
        + "directly to restore whatever mattered, and keep the next record shorter.";
    },
  );

  const searchHistory = factoryTool(
    "factory_search_history",
    "Search this project's chronicle: recorded decisions AND what agents have actually said in "
      + "their sessions. Use it before reworking, replacing or arguing with anything that already "
      + "exists — the reason it is that way is usually written down somewhere in here.",
    {
      query: z.string().min(1).max(500)
        .describe("Words to look for. All of them must appear; punctuation and operators are ignored."),
      limit: z.number().int().min(1).max(50).optional()
        .describe("How many results, newest first. Default 10."),
    },
    (args) => {
      const hits = chronicle.search(projectOf(), args.query, args.limit ?? 10);
      if (hits.length === 0) {
        return `Nothing in this project's chronicle matches ${JSON.stringify(args.query)}. `
          + "Nobody has written this down — which may itself be worth recording once you decide.";
      }
      const lines = hits.map((h) => {
        const when = new Date(h.createdAt * 1000).toISOString().slice(0, 10);
        const where = h.roomId === null ? "no room" : rooms.getRoom(h.roomId)?.name ?? h.roomId;
        const who = h.kind === "decision" ? `decision, ${where}` : `said in ${where}, session ${h.ref}`;
        const source = h.path === null ? "" : `\n  ${h.path}`;
        return `- [${when}] ${h.title} (${who})\n  ${h.snippet}${source}`;
      });
      return [`${hits.length} result(s), newest first:`, ...lines].join("\n");
    },
  );

  return [recordDecision, searchHistory];
}

/**
 * The tools only the factory's orchestrator gets: moving a task to a room, and seeing the floor it
 * is choosing between.
 *
 * Exported separately from `busToolDefinitions` so the gate can be tested for what it is. They are
 * **absent** from an ordinary agent's tool set *and* **refused** by their own handlers, and the two
 * are different protections: the first is what the model sees, the second is what happens if
 * anything ever calls one anyway.
 */
export function orchestratorToolDefinitions(deps: BusToolsDeps): SdkMcpToolDefinition<any>[] {
  const { rooms, roomId } = deps;

  /** The one authority check these tools have, and it reads the session's row, never tool input. */
  const requireOrchestrator = (): TaskRouter => {
    if (deps.isOrchestrator !== true) {
      throw new Error(
        "factory_assign_task and factory_list_rooms belong to this factory's orchestrator; "
        + "this agent is not it. Use factory_ask_orchestrator to have it decide instead.",
      );
    }
    if (deps.router === undefined) throw new Error("this server has no task router");
    return deps.router;
  };

  const assignTask = factoryTool(
    "factory_assign_task",
    "Route a task to the room that should own it, and tell that room. Use this to answer a routing "
      + "request: it moves the card on the board and delivers the assignment as a turn in the "
      + "receiving room. Orchestrator only.",
    {
      task_id: z.string().describe("Id of the task, as given in the routing request or on the board."),
      room: z.string().describe("Name of the room that should own it, as shown on the factory floor."),
      agent_id: z.string().optional()
        .describe("A specific agent in that room, when it has more than one. Omitted, the room owns it."),
    },
    (args) => {
      const router = requireOrchestrator();
      const { task, notified } = router.assign({
        taskId: args.task_id,
        roomName: args.room,
        agentId: args.agent_id,
        // The sending room is this tool set's room — the session's — never anything from `args`.
        fromRoomId: roomId,
      });
      const who = task.agentId === null ? `the ${args.room} room` : `agent ${task.agentId} in ${args.room}`;
      const state = notified.deliveredAt === null
        ? "it is busy, so the notification arrives at its next turn boundary"
        : "it has been told";
      return `Task ${task.id} now belongs to ${who} (${state}).`;
    },
  );

  const listRooms = factoryTool(
    "factory_list_rooms",
    "The factory floor: every room of this project, what it is for (the first line of its charter), "
      + "how many agents it has and whether any are running. Use it before routing work you are not "
      + "sure about. Orchestrator only.",
    {},
    () => {
      const router = requireOrchestrator();
      const projectId = rooms.projectOf(roomId);
      if (projectId === undefined) throw new Error(`unknown room ${roomId}`);
      return router.describeFloor(projectId);
    },
  );

  return [assignTask, listRooms];
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
    // These are the factory's own wiring: an agent that cannot see them cannot answer another room
    // at all, so they must never be deferred behind tool search.
    alwaysLoad: true,
  });
}

/**
 * One field of a decision, cut to fit and marked where it was cut.
 *
 * The alternative — a `.max()` on the schema — turns "this decision ran long" into "this decision
 * was never recorded", which is the worst outcome available: the reasoning is lost and only the
 * agent that wrote it ever knew it existed. Truncating keeps the ADR, the index row and the
 * greppable file, and the marker plus the tool's reply tell both the agent and the next reader that
 * something is missing and where to put it back.
 *
 * Records what it cut into `cuts`, so one call can report every field it had to shorten.
 */
function fitDecisionField(value: string, limit: number, field: string, cuts: string[]): string {
  if (value.length <= limit) return value;
  cuts.push(`${field} (${value.length} characters, kept ${limit})`);
  return value.slice(0, Math.max(0, limit - TRUNCATION_MARK.length)) + TRUNCATION_MARK;
}

/** A message as one readable line for `factory_inbox`. */
function describe(rooms: RoomManager, m: MessageInfo): string {
  const from = rooms.getRoom(m.fromRoomId)?.name ?? m.fromRoomId;
  const task = m.taskId === null ? "" : ` [task ${m.taskId}]`;
  return `- ${m.id} ${m.kind} from "${from}"${task}: ${m.body}`;
}

/**
 * Resolve a room *name* — what an agent can actually know — to a room **on the caller's own floor**.
 * Names are unique per project, not per server, so the search has to be scoped or an agent in one
 * factory could address a same-named department in another. An unknown name lists what does exist:
 * an agent that guessed "backend" when the room is called "api" can fix that itself.
 */
function roomByName(rooms: RoomManager, fromRoomId: string, name: string): { id: string; name: string } {
  const projectId = rooms.projectOf(fromRoomId);
  if (projectId === undefined) throw new Error(`unknown room ${fromRoomId}`);
  const all = rooms.listRooms(projectId);
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
