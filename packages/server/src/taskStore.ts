import { randomUUID } from "node:crypto";
import { TaskInfo, type TaskStatus } from "@superfabric/shared";
import type { Db } from "./db.js";
import type { ProjectManager } from "./projectManager.js";

/** Row shape of `tasks`. */
interface TaskRow {
  id: string;
  project_id: string | null;
  title: string;
  detail: string;
  status: string;
  room_id: string | null;
  agent_id: string | null;
  blocked_on_message_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateTaskOptions {
  title: string;
  detail?: string;
  /** Owning room. Omitted (or null) means unassigned — the orchestrator routes it (M3b). */
  roomId?: string | null;
  /**
   * The factory this card belongs to. Defaults to the default project; the hub always passes the
   * asking socket's active project, so a card can never land on another operator's board.
   */
  projectId?: string;
}

/**
 * Fields an update may change. `undefined` means "leave it alone"; `null` on a nullable field means
 * "clear it" — unassigning a task and forgetting to mention it must not be the same request.
 */
export interface TaskPatch {
  status?: TaskStatus;
  detail?: string;
  roomId?: string | null;
  agentId?: string | null;
  /** The bus sets this when a request blocks a task, and clears it when the answer arrives. */
  blockedOnMessageId?: string | null;
}

/**
 * The task board's storage. Rows in `tasks` (migration 4), nothing else: the board has to survive a
 * restart because it is the operator's record of what the factory is doing, not a view of live
 * process state.
 *
 * Knows about rooms and sessions only enough to refuse a card that would lie — an unknown room, or
 * an assignee who does not work in the task's room. Everything else about routing is M3b's problem.
 */
export class TaskStore {
  private readonly stmts;
  private listeners = new Set<() => void>();

  /**
   * `now` is a seam, not a feature: `unixepoch()` has one-second resolution, so a test cannot
   * otherwise distinguish "updatedAt moved" from "the two writes landed in the same second".
   */
  constructor(
    private db: Db,
    private projects: ProjectManager,
    private now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.stmts = {
      insert: db.prepare(`
        INSERT INTO tasks (id, project_id, title, detail, status, room_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?)
      `),
      one: db.prepare("SELECT * FROM tasks WHERE id = ?"),
      // Newest first, and `rowid` breaks the tie: at one-second resolution two tasks created in the
      // same second would otherwise come back in an order the operator cannot predict.
      list: db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC, rowid DESC"),
      update: db.prepare(`
        UPDATE tasks
        SET title = ?, detail = ?, status = ?, room_id = ?, agent_id = ?,
            blocked_on_message_id = ?, updated_at = ?
        WHERE id = ?
      `),
      // What a demolition leaves behind. A card is never deleted because the room or the agent it
      // named has gone: the work is the operator's, the department was only where it was being done.
      // Both clear `agent_id` — an assignee only means anything next to the room it works in.
      unassignRoom: db.prepare(
        "UPDATE tasks SET room_id = NULL, agent_id = NULL, updated_at = ? WHERE room_id = ?",
      ),
      unassignAgent: db.prepare(
        "UPDATE tasks SET agent_id = NULL, updated_at = ? WHERE agent_id = ?",
      ),
      // The one case where cards *are* deleted: the whole factory is going, and a board with no
      // floor under it is not something anyone would ever look at again.
      deleteForProject: db.prepare("DELETE FROM tasks WHERE project_id = ?"),
      room: db.prepare("SELECT project_id FROM rooms WHERE id = ?"),
      taskProject: db.prepare("SELECT project_id FROM tasks WHERE id = ?"),
      sessionRoom: db.prepare("SELECT room_id FROM sessions WHERE id = ?"),
    };
  }

  create(opts: CreateTaskOptions): TaskInfo {
    const projectId = opts.projectId ?? this.projects.defaultProject().id;
    const roomId = opts.roomId ?? null;
    if (roomId !== null) this.requireRoomIn(projectId, roomId);
    const ts = this.now();
    const id = randomUUID();
    // Validate through the protocol shape rather than by hand: what the store accepts and what the
    // wire accepts are the same thing, and only one of them should own the limits.
    const draft = TaskInfo.parse({
      id, title: opts.title, detail: opts.detail ?? "", status: "open",
      roomId, agentId: null, blockedOnMessageId: null, createdAt: ts, updatedAt: ts,
    });
    this.stmts.insert.run(
      draft.id, projectId, draft.title, draft.detail, draft.roomId, draft.createdAt, draft.updatedAt,
    );
    this.emitChange();
    return draft;
  }

  /**
   * Apply a patch. Throws for an unknown task, an unknown room, and any assignment that would make
   * the board claim an agent owns work in a room it does not stand in — including moving a task to
   * another room while its current assignee stays on the card. Clearing the assignee in the same
   * patch is the way to do that move.
   */
  update(taskId: string, patch: TaskPatch): TaskInfo {
    const current = this.get(taskId);
    if (current === undefined) throw new Error(`unknown task ${taskId}`);

    const next: TaskInfo = {
      ...current,
      status: patch.status ?? current.status,
      detail: patch.detail ?? current.detail,
      roomId: patch.roomId !== undefined ? patch.roomId : current.roomId,
      agentId: patch.agentId !== undefined ? patch.agentId : current.agentId,
      blockedOnMessageId: patch.blockedOnMessageId !== undefined
        ? patch.blockedOnMessageId
        : current.blockedOnMessageId,
      updatedAt: this.now(),
    };
    if (next.roomId !== null && next.roomId !== current.roomId) {
      // A card may only move between rooms of its own factory: assigning it to a room on another
      // floor would put work in front of an operator who cannot see the task that asked for it.
      const row = this.stmts.taskProject.get(taskId) as { project_id: string | null } | null;
      this.requireRoomIn(row?.project_id ?? null, next.roomId);
    }
    if (next.agentId !== null) this.requireAgentInRoom(next.agentId, next.roomId);

    const parsed = TaskInfo.parse(next);
    this.stmts.update.run(
      parsed.title, parsed.detail, parsed.status, parsed.roomId, parsed.agentId,
      parsed.blockedOnMessageId, parsed.updatedAt, taskId,
    );
    this.emitChange();
    return parsed;
  }

  /**
   * Hand every card owned by a room back to the board, unassigned. Returns how many moved.
   *
   * The alternative — deleting them with the room — would throw away the operator's own record of
   * what the factory owes, because a department was reorganised. An unassigned card is a state the
   * board already draws and the orchestrator can already route.
   */
  unassignRoom(roomId: string): number {
    const changed = this.stmts.unassignRoom.run(this.now(), roomId).changes;
    if (changed > 0) this.emitChange();
    return changed;
  }

  /** The same for one agent: the card stays where it is, with nobody on it. */
  unassignAgent(agentId: string): number {
    const changed = this.stmts.unassignAgent.run(this.now(), agentId).changes;
    if (changed > 0) this.emitChange();
    return changed;
  }

  /** Drop a whole factory's board. Only ever called while the factory itself is being removed. */
  deleteForProject(projectId: string): number {
    const changed = this.stmts.deleteForProject.run(projectId).changes;
    if (changed > 0) this.emitChange();
    return changed;
  }

  /**
   * Fires whenever the board changed. The hub subscribes to this rather than broadcasting from its
   * own handlers, because most changes do not come through the hub at all: an agent calling
   * `factory_task_update`, and the bus blocking a task on a request, both reach this store directly.
   * Without it the board is only right for whoever asked, and only until an agent touches it.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitChange(): void {
    for (const l of this.listeners) l();
  }

  /** One factory's board, newest first: it reads top-down and the newest card is the live one. */
  list(projectId: string = this.projects.defaultProject().id): TaskInfo[] {
    return (this.stmts.list.all(projectId) as TaskRow[]).map(toTaskInfo);
  }

  /**
   * Which factory a card belongs to, or `undefined` for an unknown task. The twin of
   * `RoomManager.projectOf`, and for the same reason: routing has a task id and needs the floor it
   * stands on, without carrying a project through its own call chain.
   */
  projectOf(taskId: string): string | undefined {
    // `== null`, not `=== undefined`: "no such row" is `null` for the driver db.ts uses.
    const row = this.stmts.taskProject.get(taskId) as { project_id: string | null } | null;
    return row == null || row.project_id === null ? undefined : row.project_id;
  }

  /** `undefined` for an unknown id — the absent-row shape the rest of the package speaks. */
  get(taskId: string): TaskInfo | undefined {
    // `== null`, not `=== undefined`: "no such row" is `null` for the driver db.ts uses.
    const row = this.stmts.one.get(taskId) as TaskRow | null;
    return row == null ? undefined : toTaskInfo(row);
  }

  /**
   * The room must exist *and* stand on the given factory. A room id is globally unique, so without
   * this check a client that knew another project's room id could hang a card off it — and the card
   * would then be listed on one board while naming a building on another.
   */
  private requireRoomIn(projectId: string | null, roomId: string): void {
    const row = this.stmts.room.get(roomId) as { project_id: string } | null;
    if (row == null) throw new Error(`unknown room ${roomId}`);
    if (row.project_id !== projectId) {
      throw new Error(`room ${roomId} belongs to another project`);
    }
  }

  private requireAgentInRoom(agentId: string, roomId: string | null): void {
    const row = this.stmts.sessionRoom.get(agentId) as { room_id: string | null } | null;
    if (row == null) throw new Error(`unknown session ${agentId}`);
    if (roomId === null) {
      throw new Error(`cannot assign session ${agentId}: task has no room to own it`);
    }
    if (row.room_id !== roomId) {
      throw new Error(`session ${agentId} does not work in room ${roomId}`);
    }
  }
}

function toTaskInfo(row: TaskRow): TaskInfo {
  return TaskInfo.parse({
    id: row.id,
    title: row.title,
    detail: row.detail,
    status: row.status,
    roomId: row.room_id,
    agentId: row.agent_id,
    blockedOnMessageId: row.blocked_on_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
