import { randomUUID } from "node:crypto";
import { TaskInfo, type TaskStatus } from "@superfabric/shared";
import type { Db } from "./db.js";

/** Row shape of `tasks`. */
interface TaskRow {
  id: string;
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

  /**
   * `now` is a seam, not a feature: `unixepoch()` has one-second resolution, so a test cannot
   * otherwise distinguish "updatedAt moved" from "the two writes landed in the same second".
   */
  constructor(private db: Db, private now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.stmts = {
      insert: db.prepare(`
        INSERT INTO tasks (id, title, detail, status, room_id, created_at, updated_at)
        VALUES (?, ?, ?, 'open', ?, ?, ?)
      `),
      one: db.prepare("SELECT * FROM tasks WHERE id = ?"),
      // Newest first, and `rowid` breaks the tie: at one-second resolution two tasks created in the
      // same second would otherwise come back in an order the operator cannot predict.
      list: db.prepare("SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC"),
      update: db.prepare(`
        UPDATE tasks
        SET title = ?, detail = ?, status = ?, room_id = ?, agent_id = ?,
            blocked_on_message_id = ?, updated_at = ?
        WHERE id = ?
      `),
      room: db.prepare("SELECT id FROM rooms WHERE id = ?"),
      sessionRoom: db.prepare("SELECT room_id FROM sessions WHERE id = ?"),
    };
  }

  create(opts: CreateTaskOptions): TaskInfo {
    const roomId = opts.roomId ?? null;
    if (roomId !== null) this.requireRoom(roomId);
    const ts = this.now();
    const id = randomUUID();
    // Validate through the protocol shape rather than by hand: what the store accepts and what the
    // wire accepts are the same thing, and only one of them should own the limits.
    const draft = TaskInfo.parse({
      id, title: opts.title, detail: opts.detail ?? "", status: "open",
      roomId, agentId: null, blockedOnMessageId: null, createdAt: ts, updatedAt: ts,
    });
    this.stmts.insert.run(draft.id, draft.title, draft.detail, draft.roomId, draft.createdAt, draft.updatedAt);
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
    if (next.roomId !== null && next.roomId !== current.roomId) this.requireRoom(next.roomId);
    if (next.agentId !== null) this.requireAgentInRoom(next.agentId, next.roomId);

    const parsed = TaskInfo.parse(next);
    this.stmts.update.run(
      parsed.title, parsed.detail, parsed.status, parsed.roomId, parsed.agentId,
      parsed.blockedOnMessageId, parsed.updatedAt, taskId,
    );
    return parsed;
  }

  /** Newest first: the board reads top-down and the newest card is the one being talked about. */
  list(): TaskInfo[] {
    return (this.stmts.list.all() as TaskRow[]).map(toTaskInfo);
  }

  /** `undefined` for an unknown id — the absent-row shape the rest of the package speaks. */
  get(taskId: string): TaskInfo | undefined {
    // `== null`, not `=== undefined`: "no such row" is `null` for the driver db.ts uses.
    const row = this.stmts.one.get(taskId) as TaskRow | null;
    return row == null ? undefined : toTaskInfo(row);
  }

  private requireRoom(roomId: string): void {
    if (this.stmts.room.get(roomId) == null) throw new Error(`unknown room ${roomId}`);
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
