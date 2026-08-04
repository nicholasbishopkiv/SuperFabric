import { readFileSync } from "node:fs";
import path from "node:path";
import type { MessageInfo, RoomInfo, TaskInfo } from "@superfabric/shared";
import type { FactoryBus, RoomAgent } from "./factoryBus.js";
import type { RoomManager } from "./roomManager.js";
import type { TaskStore } from "./taskStore.js";

/** How much of a room's charter the orchestrator is shown per room. One line, not a document. */
const CHARTER_SUMMARY_CHARS = 200;

export interface TaskRouterDeps {
  bus: FactoryBus;
  tasks: TaskStore;
  rooms: RoomManager;
  /**
   * Which session is a project's orchestrator, or `undefined` when it has none. A callback rather
   * than the `SessionManager` itself, for the same reason the bus takes callbacks: the dependency
   * stays one-way and the router is unit-testable without a session runner.
   */
  orchestratorFor: (projectId: string) => string | undefined;
  /** Live agents in a room, with the status the floor summary reports. */
  roomAgents?: (roomId: string) => RoomAgent[];
}

/**
 * Routing: how a task with no room finds one.
 *
 * The whole mechanism is a bus round trip, and deliberately so. An unassigned task becomes a message
 * to the project room; the orchestrator reads it as an ordinary turn and answers by calling
 * `factory_assign_task`, which moves the card and tells the receiving room. Nothing here decides
 * where work belongs — that is a *model* decision, which means it is allowed to be slow, and allowed
 * to be wrong, and the operator can see and undo it either way.
 *
 * **Nothing may fabricate an assignment.** With no orchestrator there is no message and no change:
 * the task stays visibly unassigned and the board already explains that routing needs one. A
 * heuristic that guessed a room here — first room, most idle room, name similarity — would be a
 * server quietly inventing a decision it has no standing to make, and the operator would have no way
 * to tell it apart from a real one.
 */
export class TaskRouter {
  private readonly bus: FactoryBus;
  private readonly tasks: TaskStore;
  private readonly rooms: RoomManager;
  private readonly orchestrator: (projectId: string) => string | undefined;
  private readonly liveAgents: (roomId: string) => RoomAgent[];

  constructor(deps: TaskRouterDeps) {
    this.bus = deps.bus;
    this.tasks = deps.tasks;
    this.rooms = deps.rooms;
    this.orchestrator = deps.orchestratorFor;
    this.liveAgents = deps.roomAgents ?? (() => []);
  }

  /** Whether this factory has a senior agent to route with. `false` is a normal state, not a fault. */
  hasOrchestrator(projectId: string): boolean {
    return this.orchestrator(projectId) !== undefined;
  }

  /**
   * Ask the orchestrator where a task belongs.
   *
   * Returns the message that was sent, or `undefined` when nothing was sent — no orchestrator, or a
   * factory with no central building to address. `undefined` is the honest answer for "the task
   * stays unassigned", and every caller treats it as one rather than as a failure.
   *
   * The message is from the project room *to* the project room. That reads oddly for a second and is
   * right: the orchestrator stands in the central building, an unassigned task has no room of its
   * own to speak for it, and inventing a pseudo-room to be the sender would put a building on the
   * floor that is not a folder. So the factory's own room asks its own orchestrator, on the ordinary
   * bus, where everyone can see it.
   */
  requestRouting(taskId: string): MessageInfo | undefined {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error(`unknown task ${taskId}`);
    if (task.roomId !== null) {
      throw new Error(`task ${taskId} already belongs to a room; there is nothing to route`);
    }
    const projectId = this.tasks.projectOf(taskId);
    if (projectId === undefined) return undefined;
    if (!this.hasOrchestrator(projectId)) return undefined;

    const projectRoom = this.projectRoom(projectId);
    if (projectRoom === undefined) return undefined;

    return this.bus.send({
      fromRoomId: projectRoom.id,
      toRoomId: projectRoom.id,
      kind: "request",
      body: this.routingRequest(task, projectId),
      taskId: task.id,
    });
  }

  /**
   * The orchestrator's answer: move the card, and tell the room that now owns it.
   *
   * The notification is `info`, never `request` — a request naming a task blocks that task (see
   * `linkTask` in busTools), and a task blocked the instant it is assigned would be the opposite of
   * what just happened.
   */
  assign(opts: {
    taskId: string;
    /** Room *name*, which is what the orchestrator can actually know. Resolved on its own floor. */
    roomName: string;
    agentId?: string | undefined;
    /** The orchestrator's own room — the sender of the notification. Never from tool input. */
    fromRoomId: string;
  }): { task: TaskInfo; notified: MessageInfo } {
    const projectId = this.rooms.projectOf(opts.fromRoomId);
    if (projectId === undefined) throw new Error(`unknown room ${opts.fromRoomId}`);
    const room = this.roomByName(projectId, opts.roomName);

    // `agentId: null` unless one was named: moving a card to another room while its previous
    // assignee stays on it is exactly what `TaskStore.update` refuses, and rightly.
    const task = this.tasks.update(opts.taskId, {
      roomId: room.id,
      agentId: opts.agentId ?? null,
    });

    const notified = this.bus.send({
      fromRoomId: opts.fromRoomId,
      toRoomId: room.id,
      kind: "info",
      body: assignmentNotice(task),
      taskId: task.id,
    });
    return { task, notified };
  }

  /**
   * The floor as the orchestrator needs to see it: every room, what it is for, how many agents it
   * has and whether any of them are actually running. This is what makes routing a decision rather
   * than a guess — a name alone says nothing about what a department owns.
   */
  describeFloor(projectId: string): string {
    const rooms = this.rooms.listRooms(projectId);
    if (rooms.length === 0) return "This factory has no rooms yet.";
    return rooms.map((room) => this.roomLine(room)).join("\n");
  }

  private roomLine(room: RoomInfo): string {
    const live = this.liveAgents(room.id);
    const running = live.length === 0
      ? "none running"
      : `${live.length} running (${live.map((a) => a.status).join(", ")})`;
    const central = room.kind === "project" ? " [the central building — the orchestrator works here]" : "";
    return `- ${room.name}${central} — ${room.agentCount} agent(s), ${running} — ${charterSummary(room.path)}`;
  }

  /** The turn the orchestrator actually reads when a task needs a home. */
  private routingRequest(task: TaskInfo, projectId: string): string {
    const lines = [
      `A new task has no room yet. Decide where it belongs.`,
      "",
      `Task ${task.id}: ${task.title}`,
    ];
    if (task.detail !== "") lines.push("", task.detail);
    lines.push(
      "",
      "Rooms on this floor:",
      this.describeFloor(projectId),
      "",
      `Answer by calling factory_assign_task(task_id: ${JSON.stringify(task.id)}, room: "<name>"),`,
      "which moves the card and tells that room. If no room fits, say so with factory_send instead of",
      "forcing it somewhere wrong — the task stays unassigned until you decide, which is fine.",
    );
    return lines.join("\n");
  }

  /** The single central building of a factory, or `undefined` for one that has none yet. */
  private projectRoom(projectId: string): RoomInfo | undefined {
    return this.rooms.listRooms(projectId).find((r) => r.kind === "project");
  }

  /**
   * Resolve a room *name* on one floor. Names are unique per project, not per server, so the search
   * is scoped — the same reason `busTools` scopes its own lookup. An unknown name lists what does
   * exist, so a model that guessed "backend" when the room is called "api" can fix that itself.
   */
  private roomByName(projectId: string, name: string): RoomInfo {
    const all = this.rooms.listRooms(projectId);
    const room = all.find((r) => r.name === name);
    if (room === undefined) {
      throw new Error(`unknown room ${JSON.stringify(name)}; rooms are: ${all.map((r) => r.name).join(", ")}`);
    }
    return room;
  }
}

/** What the receiving room is told. Plain, and it says what to do next. */
function assignmentNotice(task: TaskInfo): string {
  const lines = [`Task ${task.id} has been assigned to your room: ${task.title}`];
  if (task.detail !== "") lines.push("", task.detail);
  lines.push(
    "",
    "Move it on the board with factory_task_update(task_id, status) as you work. If it does not",
    "belong here, say so with factory_ask_orchestrator rather than dropping it.",
  );
  return lines.join("\n");
}

/**
 * One line of what a room is for, read from its charter (`CLAUDE.md`) — the room's own folder, which
 * is the truth about what a room is whether or not SuperFabric is running.
 *
 * Template placeholders are skipped: `RoomManager`'s charter ships `_What this department owns.
 * Replace this line._`, and showing the orchestrator a placeholder as if it were a responsibility
 * would be worse than admitting the room has not been described yet.
 */
export function charterSummary(roomPath: string): string {
  let text: string;
  try { text = readFileSync(path.join(roomPath, "CLAUDE.md"), "utf8"); }
  catch { return "no charter yet"; }

  const lines = text.split("\n").map((l) => l.trim());
  const meaningful = (l: string): boolean =>
    l !== "" && !l.startsWith("#") && !/^_.*_$/.test(l) && !l.startsWith("<!--");

  // A charter with a "## Responsibility" heading is answering exactly this question, so that section
  // is the answer and there is no fallback: an untouched template says "no charter yet" rather than
  // reading out the bus paragraph further down the file as if it were what the room owns. A file
  // with no such heading is somebody's own CLAUDE.md, where the first real line is the best there is.
  const heading = lines.findIndex((l) => /^#+\s*responsibilit/i.test(l));
  const found = heading === -1
    ? lines.find(meaningful)
    : lines.slice(heading + 1, nextHeading(lines, heading + 1)).find(meaningful);
  if (found === undefined) return "no charter yet";
  return found.length > CHARTER_SUMMARY_CHARS ? `${found.slice(0, CHARTER_SUMMARY_CHARS)}…` : found;
}

function nextHeading(lines: string[], from: number): number {
  const at = lines.slice(from).findIndex((l) => l.startsWith("#"));
  return at === -1 ? lines.length : from + at;
}
