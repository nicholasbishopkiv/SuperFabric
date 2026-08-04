import { randomUUID } from "node:crypto";
import { MessageInfo, type MessageKind, type SessionStatus } from "@superfabric/shared";
import type { Db } from "./db.js";
import type { ProjectManager } from "./projectManager.js";
import type { RoomManager } from "./roomManager.js";

/** Row shape of `messages`. */
interface MessageRow {
  id: string;
  project_id: string | null;
  from_room_id: string;
  to_room_id: string;
  kind: string;
  body: string;
  task_id: string | null;
  delivered_at: number | null;
  created_at: number;
}

/** One agent standing in a room, as far as the bus needs to know. */
export interface RoomAgent {
  sessionId: string;
  status: SessionStatus;
}

export interface SendOptions {
  fromRoomId: string;
  toRoomId: string;
  kind: MessageKind;
  body: string;
  /** The task this message is about, when there is one. */
  taskId?: string | null;
}

export interface FactoryBusDeps {
  db: Db;
  rooms: RoomManager;
  /** Only used to answer "which factory's traffic?" when a caller does not say. */
  projects: ProjectManager;
  /**
   * Inject a turn into a live agent's input stream (`SessionManager.prompt`, wired in `index.ts`).
   * A callback rather than the manager itself: the dependency stays one-way and the bus is
   * unit-testable without a session runner. Throwing is allowed and means "not delivered".
   */
  deliver: (sessionId: string, text: string) => void;
  /** Live agents in a room, with the status that decides whether a turn may be injected now. */
  roomAgents: (roomId: string) => RoomAgent[];
  /** Seam: `unixepoch()`-resolution timestamps are untestable against a real clock. */
  now?: () => number;
}

/**
 * A status that means "no turn is in flight, so a turn may be injected". `working` is the one that
 * must wait: injecting mid-turn is the thing this design exists to avoid. `starting` counts as
 * available because a just-resumed agent reports it and may never report `idle` until it runs a
 * turn — refusing there would strand every message queued across a restart. `paused`, `error` and
 * `done` agents are not going to answer, so their room's queue keeps waiting for someone who will.
 */
function isAvailable(status: SessionStatus): boolean {
  return status === "idle" || status === "starting";
}

/**
 * The bus between departments. Two rules make it what it is:
 *
 * 1. **Persist first, then deliver.** A message is a row before anyone is told about it, so it
 *    survives a restart and a crash mid-delivery. `deliveredAt` is the record of it actually having
 *    been carried, not of it having been sent.
 * 2. **Delivery is push, at a turn boundary.** A message for an available agent is injected
 *    immediately; a message for a busy one waits until `flushRoom` is called at the next
 *    `turn_complete`. Agents never poll — an inbox loop would burn tokens to learn nothing.
 *
 * Deliberately knows nothing about `SessionManager` (see `FactoryBusDeps`) or about `TaskStore`:
 * blocking a task on a message belongs to the tool layer that has both.
 */
export class FactoryBus {
  private readonly db: Db;
  private readonly rooms: RoomManager;
  private readonly projects: ProjectManager;
  private readonly deliverTo: (sessionId: string, text: string) => void;
  private readonly roomAgents: (roomId: string) => RoomAgent[];
  private readonly now: () => number;
  private readonly stmts;
  private listeners = new Set<() => void>();
  /** Rooms with a flush in progress, so a re-entrant flush cannot deliver the same row twice. */
  private flushing = new Set<string>();

  constructor(deps: FactoryBusDeps) {
    this.db = deps.db;
    this.rooms = deps.rooms;
    this.projects = deps.projects;
    this.deliverTo = deps.deliver;
    this.roomAgents = deps.roomAgents;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO messages (id, project_id, from_room_id, to_room_id, kind, body, task_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      one: this.db.prepare("SELECT * FROM messages WHERE id = ?"),
      // Oldest first: a queue is answered in the order the questions were asked. Scoped by project as
      // well as by room even though a room id already implies a project — the index still drives the
      // lookup, and a mis-stamped row can then never be carried onto the wrong floor.
      undelivered: this.db.prepare(`
        SELECT * FROM messages WHERE project_id = ? AND to_room_id = ? AND delivered_at IS NULL
        ORDER BY created_at, rowid
      `),
      deliveredFor: this.db.prepare(`
        SELECT * FROM messages WHERE project_id = ? AND to_room_id = ? AND delivered_at IS NOT NULL
        ORDER BY delivered_at DESC, rowid DESC LIMIT ?
      `),
      list: this.db.prepare(
        "SELECT * FROM messages WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      ),
      // `AND delivered_at IS NULL` is what makes delivery idempotent at the storage level: a
      // second flush of the same row changes nothing and reports 0 changes.
      // Only ever run while the factory itself is being removed. A *room* going does not delete its
      // traffic — `messages` has never had a foreign key, precisely so the record of what a factory
      // asked for outlives the department that asked (both ends already tolerate a room id that no
      // longer resolves; see `injectedTurn`). A whole floor going leaves nothing to read it.
      deleteForProject: this.db.prepare("DELETE FROM messages WHERE project_id = ?"),
      markDelivered: this.db.prepare("UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL"),
      unmarkDelivered: this.db.prepare("UPDATE messages SET delivered_at = NULL WHERE id = ?"),
    };
  }

  /**
   * Persist a message, then try to deliver it. An unknown room on either end is refused — a message
   * whose sender or recipient does not exist is not something the operator could ever act on.
   */
  send(opts: SendOptions): MessageInfo {
    const projectId = this.requireRoom(opts.fromRoomId);
    // Both ends on the same floor. Rooms of two different factories are not departments of one
    // company: a belt between them would be drawn on neither floor, and the message would show up in
    // one operator's traffic and not the other's.
    if (this.requireRoom(opts.toRoomId) !== projectId) {
      throw new Error(`rooms ${opts.fromRoomId} and ${opts.toRoomId} belong to different projects`);
    }

    // Validate through the protocol's own shape: what the bus accepts and what the wire accepts are
    // the same thing, and only one of them should own the limits.
    const msg = MessageInfo.parse({
      id: randomUUID(),
      fromRoomId: opts.fromRoomId,
      toRoomId: opts.toRoomId,
      kind: opts.kind,
      body: opts.body,
      taskId: opts.taskId ?? null,
      deliveredAt: null,
      createdAt: this.now(),
    });
    this.stmts.insert.run(
      msg.id, projectId, msg.fromRoomId, msg.toRoomId, msg.kind, msg.body, msg.taskId, msg.createdAt,
    );
    this.emitChange();

    // Then delivery, which is allowed to do nothing: the row is already durable, and flushRoom at
    // the recipient's next turn boundary will pick it up.
    this.flushRoom(msg.toRoomId);
    return this.get(msg.id)!;
  }

  /**
   * Deliver everything queued for a room, in creation order, to an available agent. Called at every
   * turn boundary (`turn_complete`) and after every `send`. Returns the messages actually carried,
   * which is empty whenever the room has nobody free — that is the normal, non-exceptional case.
   */
  flushRoom(roomId: string): MessageInfo[] {
    // An unknown room has no queue. This is the normal shape of a stale call (a room removed while a
    // turn was in flight), not an error worth throwing at an executor's event handler.
    const projectId = this.rooms.projectOf(roomId);
    if (projectId === undefined) return [];
    // A re-entrant call (an executor that reaches a turn boundary synchronously inside deliver())
    // would otherwise walk the same queue again before the first pass finished marking it.
    if (this.flushing.has(roomId)) return [];
    this.flushing.add(roomId);
    try {
      const carried: MessageInfo[] = [];
      for (const row of this.stmts.undelivered.all(projectId, roomId) as MessageRow[]) {
        const agent = this.roomAgents(roomId).find((a) => isAvailable(a.status));
        if (agent === undefined) break; // nobody free; the rest of the queue waits with it
        const msg = toMessageInfo(row);
        const at = this.now();
        // Mark first: a second flush (or a re-entrant one) can then never inject the same message
        // twice. If the injection fails the mark is rolled back, so the message stays queued
        // instead of being recorded as carried by a session that never got it.
        if (this.stmts.markDelivered.run(at, msg.id).changes === 0) continue;
        try {
          this.deliverTo(agent.sessionId, this.injectedTurn(msg));
        } catch {
          this.stmts.unmarkDelivered.run(msg.id);
          break; // this room's agent is not usable right now; try again at the next boundary
        }
        carried.push({ ...msg, deliveredAt: at });
      }
      if (carried.length > 0) this.emitChange();
      return carried;
    } finally {
      this.flushing.delete(roomId);
    }
  }

  /** That room's queue, oldest first — what nobody has picked up yet. */
  undeliveredFor(roomId: string): MessageInfo[] {
    const projectId = this.rooms.projectOf(roomId);
    if (projectId === undefined) return [];
    return (this.stmts.undelivered.all(projectId, roomId) as MessageRow[]).map(toMessageInfo);
  }

  /** That room's recent carried traffic, newest first. */
  deliveredFor(roomId: string, limit = 20): MessageInfo[] {
    const projectId = this.rooms.projectOf(roomId);
    if (projectId === undefined) return [];
    return (this.stmts.deliveredFor.all(projectId, roomId, limit) as MessageRow[]).map(toMessageInfo);
  }

  /**
   * One factory's traffic, newest first. Includes undelivered messages: the operator must see a
   * pile-up. Another project's traffic is never in here — a second tab watching another floor draws
   * its own belts, and one factory's boxes appearing on another's is exactly the bug this scoping
   * exists to make impossible.
   */
  list(projectId: string = this.projects.defaultProject().id, limit = 200): MessageInfo[] {
    return (this.stmts.list.all(projectId, limit) as MessageRow[]).map(toMessageInfo);
  }

  /** Drop a whole factory's traffic. Only ever called while the factory itself is being removed. */
  deleteForProject(projectId: string): number {
    const changed = this.stmts.deleteForProject.run(projectId).changes;
    if (changed > 0) this.emitChange();
    return changed;
  }

  /** `undefined` for an unknown id — the absent-row shape the rest of the package speaks. */
  get(messageId: string): MessageInfo | undefined {
    // `== null`, not `=== undefined`: "no such row" is `null` for the driver db.ts uses.
    const row = this.stmts.one.get(messageId) as MessageRow | null;
    return row == null ? undefined : toMessageInfo(row);
  }

  /** Fires whenever the message table changed (a send, or a delivery). Returns an unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The turn an agent actually sees. It has to read as another department talking, not as the
   * operator: an agent that mistakes a peer's request for an instruction from its human will treat
   * it as top priority and answer to the wrong audience. So the frame names the sending room, says
   * what kind of message it is, and says how to answer.
   */
  private injectedTurn(msg: MessageInfo): string {
    const from = this.rooms.getRoom(msg.fromRoomId)?.name ?? msg.fromRoomId;
    const to = this.rooms.getRoom(msg.toRoomId)?.name ?? msg.toRoomId;
    const lines = [
      `[factory bus] ${msg.kind} from the "${from}" room to the "${to}" room.`,
      "",
      msg.body,
      "",
    ];
    if (msg.taskId !== null) lines.push(`Task: ${msg.taskId}`, "");
    lines.push(
      `This is an inter-room message from another department — another agent wrote it, not the`,
      `operator. Answer with the factory_send tool (to_room: "${from}", kind: "response") when you`,
      `have something to send back, and use factory_task_update if it changes a task's state.`,
    );
    return lines.join("\n");
  }

  /** The room's project, or a throw. Returning it is how `send` learns which floor to stamp. */
  private requireRoom(roomId: string): string {
    const projectId = this.rooms.projectOf(roomId);
    if (projectId === undefined) throw new Error(`unknown room ${roomId}`);
    return projectId;
  }

  private emitChange(): void {
    for (const l of this.listeners) l();
  }
}

function toMessageInfo(row: MessageRow): MessageInfo {
  return MessageInfo.parse({
    id: row.id,
    fromRoomId: row.from_room_id,
    toRoomId: row.to_room_id,
    kind: row.kind,
    body: row.body,
    taskId: row.task_id,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
  });
}
