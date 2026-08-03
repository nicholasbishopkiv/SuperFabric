import { ClientMessage, type ServerMessage } from "@superfabric/shared";
import type { EventStore } from "./eventStore.js";
import type { FactoryBus } from "./factoryBus.js";
import type { ProjectManager } from "./projectManager.js";
import type { RoomManager } from "./roomManager.js";
import type { SessionManager } from "./sessionManager.js";
import type { TaskStore } from "./taskStore.js";

export interface SocketLike { send(data: string): void; }

/**
 * Event types that change what a `sessions` message would say (`status`, `blocked`, and the state a
 * terminal failure moves a session to). Everything else — `agent_text` above all — arrives by the
 * token and must never trigger a list broadcast.
 */
const SESSION_SHAPE_EVENTS = new Set(["session_status", "approval_request", "approval_resolved", "session_error"]);

/** Coalescing window for the pushed state broadcasts. */
const BROADCAST_DEBOUNCE_MS = 250;

/** State the server pushes on its own, as opposed to answering a query. */
type PushedList = "sessions" | "tasks" | "messages";

export interface WsHubOptions {
  /** The task board. Absent => `create_task`/`update_task`/`list_tasks` are refused with an error. */
  tasks?: TaskStore;
  /** The factory bus. Absent => no `messages` broadcasts (there is no traffic to report). */
  bus?: FactoryBus;
  /** Overridable so tests do not have to wait out the real window. */
  sessionsDebounceMs?: number;
}

export class WsHub {
  /** socket -> subscribed sessionIds with last sent seq */
  private subs = new Map<SocketLike, Map<string, number>>();
  /**
   * socket -> the project it is looking at. **The active project is per-socket, not per-server**: a
   * second tab watching another factory must not see this one's rooms, board or belts, and that is
   * only true if every push is addressed by the socket's own scope rather than by a global "current
   * project". Set at `attach` (to the last-opened project) and changed only by `open_project`.
   */
  private active = new Map<SocketLike, string>();
  /**
   * One timer for every pushed list. A second mechanism per list would mean a burst of agent
   * activity costs one frame *per kind* per window instead of one frame, and would need its own
   * unref'd-timer discipline — so `sessions`, `tasks` and `messages` share this path.
   */
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingBroadcasts = new Set<PushedList>();
  private readonly broadcastDebounceMs: number;
  private readonly tasks: TaskStore | undefined;
  private readonly bus: FactoryBus | undefined;

  constructor(
    private store: EventStore,
    private mgr: SessionManager,
    private rooms: RoomManager,
    private projects: ProjectManager,
    opts: WsHubOptions = {},
  ) {
    this.broadcastDebounceMs = opts.sessionsDebounceMs ?? BROADCAST_DEBOUNCE_MS;
    this.tasks = opts.tasks;
    this.bus = opts.bus;
    // The bus persists and delivers on its own schedule (a send from a tool, a delivery at a turn
    // boundary), so the hub learns about traffic by subscribing rather than by being called. The
    // board is the same story and for a stronger reason: an agent moving its own task with
    // `factory_task_update`, and the bus blocking a task on a request, never pass through this hub.
    opts.bus?.onChange(() => this.scheduleBroadcast("messages"));
    opts.tasks?.onChange(() => this.scheduleBroadcast("tasks"));
    store.onAppend((sessionId, seq, event) => {
      const msg: ServerMessage = { kind: "event", sessionId, seq, event };
      for (const [sock, sessions] of this.subs) {
        const last = sessions.get(sessionId);
        if (last === undefined || seq <= last) continue;
        // The watermark advances only on a *successful* send. The client resubscribes from the
        // last seq it actually holds, so advancing past an event we failed to deliver would lose
        // it permanently. A socket we cannot write to is dead: drop it.
        if (this.safeSend(sock, msg)) sessions.set(sessionId, seq);
        else this.detach(sock);
      }
      // The 3D floor draws a status beacon per building from `SessionInfo.status`/`blocked`, and it
      // must not have to subscribe to (and replay) every session to keep them right. So a status
      // change pushes the whole session list to everyone — but only for the handful of event types
      // that can change it, and coalesced, because a working agent emits events continuously.
      if (SESSION_SHAPE_EVENTS.has(event.type)) this.scheduleBroadcast("sessions");
    });
  }

  /**
   * A new socket starts on the last-opened project, so reloading a tab returns the operator to the
   * factory they were in rather than to whichever folder the server was started from.
   */
  attach(sock: SocketLike): void {
    this.subs.set(sock, new Map());
    this.active.set(sock, this.projects.lastOpened().id);
  }

  detach(sock: SocketLike): void {
    this.subs.delete(sock);
    this.active.delete(sock);
  }

  /** Which factory a socket is looking at. Falls back to the default project for a socket we lost. */
  private activeProject(sock: SocketLike): string {
    return this.active.get(sock) ?? this.projects.defaultProject().id;
  }

  /**
   * At most one broadcast per list per window, carrying whatever the state is when the timer fires —
   * so a burst of transitions costs one frame per client and the frame is the newest truth, not the
   * first change that started the burst.
   */
  private scheduleBroadcast(kind: PushedList): void {
    this.pendingBroadcasts.add(kind);
    if (this.broadcastTimer !== null) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const kinds = [...this.pendingBroadcasts];
      this.pendingBroadcasts.clear();
      for (const k of kinds) {
        // Reading a list can throw only if the db is gone (shutdown); a throw here would be an
        // uncaught exception on a timer callback, which takes the process with it.
        try { this.broadcastList(k); } catch { /* the db is closing; nothing to tell anyone */ }
      }
    }, this.broadcastDebounceMs);
    // A pending broadcast must never be the reason the process refuses to exit.
    this.broadcastTimer.unref?.();
  }

  private broadcastList(kind: PushedList): void {
    if (kind === "sessions") this.broadcastSessions();
    else if (kind === "tasks") this.broadcastTasks();
    else this.broadcastMessages();
  }

  handleMessage(sock: SocketLike, raw: string): void {
    let msg: ClientMessage;
    try { msg = ClientMessage.parse(JSON.parse(raw)); }
    catch { this.safeSend(sock, { kind: "error", message: "bad message" }); return; }

    // A detached socket (closed, or dropped after a failed send) must never resurrect itself by
    // sending another frame — creating a subscription entry here would start feeding a dead peer.
    if (!this.subs.has(sock)) {
      this.safeSend(sock, { kind: "error", message: "socket is not attached" });
      return;
    }

    // Every branch below can throw by design (unknown session, non-existent cwd, an approval that
    // does not belong to the session). One malformed-but-valid frame must not escape the socket's
    // 'message' listener and take the process — and every live agent session — down with it.
    try {
      switch (msg.kind) {
        case "subscribe": this.subscribe(sock, msg.sessionId, msg.afterSeq); break;
        case "prompt": this.mgr.prompt(msg.sessionId, msg.text); break;
        case "approval": this.mgr.approve(msg.sessionId, msg.approvalId, msg.behavior); break;
        case "interrupt":
          // An async rejection is an unhandled rejection, which also exits the process on Node 22.
          void this.mgr.interrupt(msg.sessionId).catch((err: unknown) => {
            this.safeSend(sock, { kind: "error", message: String(err) });
          });
          break;
        case "create_session": {
          // `autonomy` omitted => SessionManager applies the product default ("auto"); `model`
          // omitted => the CLI's own default, which is not ours to guess. A `roomId` makes the
          // room's folder the cwd, and an unknown one throws into the catch below. The active
          // project is passed so a room from another factory is refused rather than adopted.
          const id = this.mgr.createSession({
            cwd: msg.cwd, roomId: msg.roomId, autonomy: msg.autonomy, model: msg.model,
            projectId: this.activeProject(sock),
          });
          this.broadcastSessions();
          // The room's agentCount just changed; refresh it in the same round trip so the building's
          // label never lags behind the agent standing in it.
          if (msg.roomId !== undefined) this.broadcastRooms();
          this.subscribe(sock, id, 0); // auto-subscribe the creator from seq 0
          break;
        }
        case "set_autonomy":
          // Restarting the executor is async, so the outcome is reported from the promise — an
          // unhandled rejection would exit the process on Node 22.
          void this.mgr.setAutonomy(msg.sessionId, msg.autonomy).then(
            () => { this.broadcastSessions(); },
            (err: unknown) => { this.safeSend(sock, { kind: "error", message: String(err) }); },
          );
          break;
        // Same shape as set_autonomy, and for the same reason: the model is fixed for the lifetime
        // of a query(), so the session's executor is restarted and resumed.
        case "set_model":
          void this.mgr.setModel(msg.sessionId, msg.model).then(
            () => { this.broadcastSessions(); },
            (err: unknown) => { this.safeSend(sock, { kind: "error", message: String(err) }); },
          );
          break;
        // A query, not a state change: the answer belongs to the socket that asked. Broadcasting it
        // would make every tab's connect handshake spam every other tab with lists it already has.
        case "list_sessions":
          this.safeSend(sock, { kind: "sessions", sessions: this.mgr.listSessions(this.activeProject(sock)) });
          break;
        // Rooms: each case answers with the whole room list rather than a delta, so a client can
        // rebuild the floor from one message and never has to merge. A failure (duplicate name,
        // unknown id) throws into the catch below and is reported as an error instead.
        case "create_room":
          // `path` given => the room's folder is exactly that, anywhere on disk; omitted => the
          // default `<project root>/<name>`, which still has to stay inside the root.
          this.rooms.createRoom(msg.name, {
            projectId: this.activeProject(sock),
            ...(msg.path !== undefined ? { path: msg.path } : {}),
          });
          this.broadcastRooms();
          break;
        case "move_room":
          this.requireRoomOnFloor(sock, msg.roomId);
          this.rooms.moveRoom(msg.roomId, msg.position);
          this.broadcastRooms();
          break;
        // Re-point a room. Agents already running there keep the cwd their SDK session was started
        // with, which the operator has to know — and that is a fact about a *successful* change, so
        // it goes out as a `notice`. It used to travel on the `error` channel (labelling a success
        // as a failure) and was then only said by the panel; now the protocol has the right channel
        // for it, the server says it itself.
        case "set_room_path": {
          this.requireRoomOnFloor(sock, msg.roomId);
          const room = this.rooms.setPath(msg.roomId, msg.path);
          this.broadcastRooms();
          this.safeSend(sock, {
            kind: "notice",
            message: `room ${room.name} now works in ${room.path} — nothing was moved, and agents `
              + "already running keep the folder they started in",
          });
          break;
        }
        case "list_rooms":
          this.safeSend(sock, { kind: "rooms", rooms: this.rooms.listRooms(this.activeProject(sock)) });
          break;
        // Projects. `list_projects` answers the asking socket; the other two change global state (a
        // new project) or per-socket state (which floor this tab is on), and both end with this socket
        // holding a complete, freshly scoped set of lists.
        case "list_projects": this.sendProjects(sock); break;
        case "create_project": {
          const project = this.projects.create({
            root: msg.root, ...(msg.name !== undefined ? { name: msg.name } : {}),
          });
          // A factory with no central building is not a factory: the floor would be empty and there
          // would be nothing for the first room's belt to join.
          this.rooms.ensureProjectRoom(project.id);
          // The operator typed a path to go there, so go there — and tell every other tab that the
          // switcher has a new entry.
          this.openProject(sock, project.id);
          break;
        }
        case "open_project": this.openProject(sock, msg.projectId); break;
        // Tasks. The board is global state like rooms are, so a change is broadcast — on the
        // coalescing path, because an agent driving `factory_task_update` can change it as fast as
        // it can call a tool. The broadcast is *not* scheduled here: the store announces its own
        // changes (see the constructor), which is the only way the board also stays right for the
        // changes that never come through this hub. An unknown task or an assignee from the wrong
        // room throws into the catch below and is reported to the socket that asked.
        case "create_task":
          this.taskStore().create({
            title: msg.title, detail: msg.detail, roomId: msg.roomId,
            projectId: this.activeProject(sock),
          });
          break;
        case "update_task":
          this.taskStore().update(msg.taskId, {
            ...(msg.status !== undefined ? { status: msg.status } : {}),
            ...(msg.roomId !== undefined ? { roomId: msg.roomId } : {}),
            ...(msg.agentId !== undefined ? { agentId: msg.agentId } : {}),
          });
          break;
        case "list_tasks":
          this.safeSend(sock, { kind: "tasks", tasks: this.taskStore().list(this.activeProject(sock)) });
          break;
        // A query like the others: the socket that asked gets the bus's newest traffic, and nobody
        // else is spammed with a list they already hold.
        case "list_messages":
          this.safeSend(sock, { kind: "messages", messages: this.busStore().list(this.activeProject(sock)) });
          break;
      }
    } catch (err) {
      this.safeSend(sock, { kind: "error", message: String(err) });
    }
  }

  /**
   * Send a message to every attached socket **looking at the given project**. Room, session, board and
   * bus state is global to a factory but not to the server, so a change made in one tab has to reach
   * the other tabs on that floor — and must not reach a tab watching another one. The list is built
   * once per project rather than once per socket, so ten tabs on one floor still cost one query.
   *
   * Errors stay per-socket: they answer one request.
   */
  private broadcastPerProject(build: (projectId: string) => ServerMessage | null): void {
    const byProject = new Map<string, SocketLike[]>();
    // Snapshot the keys: a failed send detaches, and mutating the map while iterating it is how a
    // "cannot happen" skipped socket happens.
    for (const sock of [...this.subs.keys()]) {
      const projectId = this.activeProject(sock);
      const group = byProject.get(projectId);
      if (group === undefined) byProject.set(projectId, [sock]);
      else group.push(sock);
    }
    for (const [projectId, socks] of byProject) {
      const msg = build(projectId);
      if (msg === null) continue;
      for (const sock of socks) {
        if (!this.safeSend(sock, msg)) this.detach(sock);
      }
    }
  }

  private broadcastRooms(): void {
    this.broadcastPerProject((p) => ({ kind: "rooms", rooms: this.rooms.listRooms(p) }));
  }

  private broadcastSessions(): void {
    this.broadcastPerProject((p) => ({ kind: "sessions", sessions: this.mgr.listSessions(p) }));
  }

  private broadcastTasks(): void {
    if (this.tasks === undefined) return;
    this.broadcastPerProject((p) => ({ kind: "tasks", tasks: this.tasks!.list(p) }));
  }

  private broadcastMessages(): void {
    if (this.bus === undefined) return;
    this.broadcastPerProject((p) => ({ kind: "messages", messages: this.bus!.list(p) }));
  }

  /**
   * Tell every tab on one factory floor that something worked.
   *
   * Used by the attachment endpoint, which has no socket of its own: an upload arrives over HTTP and
   * the operator has to learn *where the file landed*, in the tab they are looking at. Addressed by
   * project for the same reason every other push is — a tab watching another factory has no business
   * hearing about this one's files.
   */
  noticeProject(projectId: string, message: string): void {
    for (const sock of [...this.subs.keys()]) {
      if (this.activeProject(sock) !== projectId) continue;
      if (!this.safeSend(sock, { kind: "notice", message })) this.detach(sock);
    }
  }

  /**
   * The project list, plus which one *this* socket is on. Every socket gets the same projects and its
   * own active id, so this is a per-socket frame even when the reason for sending it was global (a
   * project someone else created).
   */
  private sendProjects(sock: SocketLike): void {
    this.safeSend(sock, {
      kind: "projects",
      projects: this.projects.list(),
      activeProjectId: this.activeProject(sock),
    });
  }

  /**
   * Point one socket at another factory. `ProjectManager.open` throws for an unknown id (reported as
   * an error, nothing changed), then this socket is re-scoped and handed a complete fresh set of
   * lists — rooms, agents, board, bus traffic — because the client throws away everything it held for
   * the previous project rather than merging. Every other socket is only told that the switcher
   * changed; their own floors are untouched.
   */
  private openProject(sock: SocketLike, projectId: string): void {
    const project = this.projects.open(projectId);
    this.active.set(sock, project.id);
    // Session subscriptions belong to the floor this socket has just left: its transcripts are not
    // this project's, and the client has dropped them too.
    this.subs.set(sock, new Map());

    this.sendProjects(sock);
    this.safeSend(sock, { kind: "rooms", rooms: this.rooms.listRooms(project.id) });
    this.safeSend(sock, { kind: "sessions", sessions: this.mgr.listSessions(project.id) });
    if (this.tasks !== undefined) {
      this.safeSend(sock, { kind: "tasks", tasks: this.tasks.list(project.id) });
    }
    if (this.bus !== undefined) {
      this.safeSend(sock, { kind: "messages", messages: this.bus.list(project.id) });
    }
    // Other tabs: the switcher gained (or re-ordered) an entry, and their `lastOpenedAt` changed.
    for (const other of [...this.subs.keys()]) {
      if (other !== sock) this.sendProjects(other);
    }
  }

  /**
   * Refuse to touch a building that is not on the floor this socket is looking at. Room ids are
   * globally unique, so without this a client holding another project's room id could move or
   * re-point it — and the change would be broadcast to a floor that never asked for it.
   */
  private requireRoomOnFloor(sock: SocketLike, roomId: string): void {
    const projectId = this.rooms.projectOf(roomId);
    if (projectId === undefined) throw new Error(`unknown room ${roomId}`);
    if (projectId !== this.activeProject(sock)) {
      throw new Error(`room ${roomId} belongs to another project`);
    }
  }

  /** A task request on a server with no task board is a routing error, not a silent no-op. */
  private taskStore(): TaskStore {
    if (this.tasks === undefined) throw new Error("this server has no task board");
    return this.tasks;
  }

  /** Likewise for the bus: "no factory bus here" is an answer, an empty list would be a lie. */
  private busStore(): FactoryBus {
    if (this.bus === undefined) throw new Error("this server has no factory bus");
    return this.bus;
  }

  /** Replay the log after `afterSeq`, then keep tailing from wherever the replay ended. */
  private subscribe(sock: SocketLike, sessionId: string, afterSeq: number): void {
    const sessions = this.subs.get(sock);
    if (sessions === undefined) return;

    const maxSeq = this.store.maxSeq(sessionId);
    // Clamp: a client claiming an afterSeq past the end of the log would otherwise park the
    // watermark above every seq the session will ever produce and mute it forever, silently.
    const from = Math.min(afterSeq, maxSeq);
    if (afterSeq > maxSeq) {
      this.safeSend(sock, {
        kind: "error",
        message: `afterSeq ${afterSeq} is beyond the log of session ${sessionId} (max seq ${maxSeq})`,
      });
    }

    let last = from;
    for (const { seq, event } of this.store.listAfter(sessionId, from)) {
      if (!this.safeSend(sock, { kind: "event", sessionId, seq, event })) { this.detach(sock); return; }
      last = seq;
    }
    sessions.set(sessionId, last);
  }

  /** Returns whether the frame was handed to the socket; false means the socket is unusable. */
  private safeSend(sock: SocketLike, msg: ServerMessage): boolean {
    try { sock.send(JSON.stringify(msg)); return true; }
    catch { return false; }
  }
}
