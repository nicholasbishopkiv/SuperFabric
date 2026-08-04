import type {
  AccountInfo,
  AccountUsage,
  ChronicleHit,
  MessageInfo,
  MessageKind,
  ProjectInfo,
  RoomInfo,
  SavedAttachment,
  ScenePosition,
  ServerMessage,
  SessionEvent,
  SessionInfo,
  TaskInfo,
  TaskStatus,
} from "@superfabric/shared";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

export interface EventRow {
  seq: number;
  event: SessionEvent;
}

/**
 * The four states the factory floor paints, for a room and for a single agent alike. This is a
 * deliberate collapse of the six `SessionStatus` values onto what an operator has to *do*:
 *
 * - `idle` — nothing to do.
 * - `working` — something is happening; leave it alone.
 * - `paused` — held by the limit scheduler; it will come back on its own, and it is *not* idle.
 * - `blocked` — an approval is waiting for **you**.
 * - `error` — something failed and will not un-fail on its own.
 *
 * `done` reads as `idle` (nothing is moving) and `starting` reads as `working` (it looks busy).
 * `paused` used to fold into `idle` too, and that was wrong once anything could pause an agent
 * without being asked: "quiet because there is nothing to do" and "stopped because the subscription
 * is spent" are the two facts an operator most needs to tell apart on a floor that has gone still.
 * The colours live in `scene/palette.ts` and are keyed by exactly this type.
 */
export type FactoryStatus = "idle" | "working" | "paused" | "blocked" | "error";

/**
 * Precedence: a room shows the most demanding state any of its agents is in.
 *
 * `paused` outranks `working` deliberately. A room where one agent is held and another is busy is a
 * room that is *half stopped*, and the half that stopped is the part nobody would otherwise notice.
 */
const STATUS_RANK: Record<FactoryStatus, number> = {
  idle: 0, working: 1, paused: 2, blocked: 3, error: 4,
};

/** A belt between two buildings. Undirected: one pair of rooms is one belt, drawn once. */
export interface Conveyor {
  from: string;
  to: string;
  /**
   * This belt's signed place in the fan of belts leaving `from`, centred on zero — so five spine
   * belts get -2, -1, 0, 1, 2. The scene turns it into a sideways offset (`BELT_FAN_STEP`), which is
   * what stops two belts of nearly the same length from tracking each other into the same mouth.
   *
   * It lives on the belt rather than being recomputed by whoever draws it, because a package has to
   * travel the belt that was actually drawn: two answers to "how far is this one fanned" would put
   * the boxes beside the conveyor instead of on it.
   */
  fan: number;
}

/** A box travelling a belt right now. `startedAt` is a wall clock, so the scene needs no tick state. */
export interface PackageInFlight {
  id: string;
  from: string;
  to: string;
  startedAt: number;
  durationMs: number;
}

/**
 * A bus message nobody has picked up yet, standing at the sending room's door.
 *
 * **A different fact from a package in flight, and drawn differently.** A message in transit is the
 * factory working; a message nobody has collected is the factory *not* working — the recipient room
 * is busy, or has no agent at all — and a pile of them at one door is exactly the thing an operator
 * needs to notice. Collapsing the two into one animation would hide the second behind the first.
 */
export interface WaitingMessage {
  /** The bus message's own id, so the marker and the package that replaces it are the same object. */
  id: string;
  /** Who sent it: the marker stands at that building. */
  from: string;
  /** Who it is for: the marker sits at the mouth of the belt leading there. */
  to: string;
  kind: MessageKind;
  createdAt: number;
}

/**
 * A building being dragged across the floor right now, and where the operator's pointer has put it.
 *
 * This is **local and uncommitted on purpose**. Rooms are rebroadcast to every attached socket on a
 * 250 ms debounce, so a drag that waited for the server would stutter, and a broadcast arriving
 * mid-drag would yank the building out from under the pointer. So the drag position wins for as long
 * as the drag lasts and exactly one `move_room` is sent when the pointer comes up.
 */
export interface RoomDrag {
  roomId: string;
  position: ScenePosition;
}

/**
 * A file that is on disk and waiting to be named in the next turn.
 *
 * Staged rather than sent, because the operator who just dropped a screenshot almost always wants
 * to say something about it. The chip is removable for the same reason — dropping the wrong file
 * must not force them to send it. Unstaging does **not** delete the file: it is the operator's file,
 * in the operator's repository, and deleting their data because they changed their mind about
 * mentioning it would be the wrong kind of tidy.
 *
 * `path` is the identity: the server never overwrites, so no two staged files share one.
 */
export interface StagedAttachment {
  /** Absolute path on disk — this is what goes into the turn text. */
  path: string;
  /** The name the file actually got, which may not be the one the browser sent. */
  name: string;
  bytes: number;
}

/**
 * What the chronicle surface is currently showing, and what it is showing it *for*.
 *
 * The query is kept beside the hits rather than only in the search box because the two have to be
 * compared: answers arrive over the socket in no guaranteed order, so the only way to know a frame
 * is still wanted is to check it against the question being asked. `asked` is what we last sent;
 * `answered` is what the hits on screen are the answer to, and `null` means nothing has come back
 * yet — which is the state the surface draws as "searching…".
 */
export interface ChronicleState {
  asked: string;
  answered: string | null;
  hits: ChronicleHit[];
}

/** The edges an overlay panel can cover. The top is deliberately free: nothing lives there. */
export type HudSide = "left" | "right" | "bottom";

/** How much of the canvas each panel covers, in CSS pixels. See `FabricState.hudInsets`. */
export type HudInsets = Record<HudSide, number>;

/** How long a package takes to cross a belt, unless the caller says otherwise. */
export const DEFAULT_PACKAGE_MS = 2_400;

/** Ids only have to be unique within a tab's lifetime; a counter is enough and is deterministic. */
let packageSeq = 0;

/** Undirected key for a pair of rooms. */
const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

export interface FabricState {
  /** Every factory this server serves, in the server's order. */
  projects: ProjectInfo[];
  /**
   * Every Claude subscription this server knows about, in the server's order.
   *
   * **Not cleared when the project changes**, unlike everything below it: an account is
   * machine-wide, so the same list is the truth on every floor (see `AccountInfo`). It is the one
   * piece of server state in this store that a factory switch leaves alone.
   */
  accounts: AccountInfo[];
  /**
   * What each account's limits look like, in the account list's own order.
   *
   * A separate list from `accounts` because it changes for a different reason and on a different
   * clock: the account list moves when the operator configures something, the meters move on the
   * server's three-minute poll. Machine-wide like the accounts, so a factory switch leaves it alone.
   */
  usage: AccountUsage[];
  /**
   * The factory this tab is looking at, or null before the server has said. Server-owned: the socket
   * holds the active project, so this is whatever the last `projects` message carried and never
   * something the UI sets on its own.
   */
  activeProjectId: string | null;
  sessions: SessionInfo[];
  /** The factory floor: the project building first, then one workshop per room. */
  rooms: RoomInfo[];
  /**
   * Just the ids, in floor order. `Buildings` maps over this and each `Building` subscribes to its
   * own row, so a status tick re-renders one building rather than the whole scene. Kept
   * referentially stable while the set of rooms does not change, because that stability *is* the
   * mechanism.
   */
  roomIds: string[];
  /** The building the operator clicked, shared by the scene and the room panel. */
  selectedRoomId: string | null;
  /**
   * How many CSS pixels of the canvas each HUD panel covers. The canvas is full-bleed *behind* the
   * overlays, so without this the camera frames the factory in the middle of the viewport and the
   * middle of the viewport is under the console drawer. The panels measure themselves and report it
   * here (they know their own collapsed/expanded size; the scene must not go reading their DOM),
   * and the camera framing subtracts it.
   *
   * Three edges now: the task board owns the bottom one, and it is a *height* where the other two
   * are widths — which is the whole reason this is a record of sides rather than a pair of numbers.
   */
  hudInsets: HudInsets;
  /**
   * Bumped by the "fit" control. The camera frames the floor automatically only until the operator
   * pans or zooms — after that the view is theirs — so there has to be one explicit way to ask for
   * the framing back, and this is it.
   */
  fitRequests: number;
  /** The building under the pointer right now, or null. See `RoomDrag`. */
  drag: RoomDrag | null;
  /**
   * roomId -> what that room's beacon shows. Derived from `sessions` (which already carry the
   * server-derived `status` and `blocked`), never from replayed events: the log is the source of
   * truth, but the server has already folded it down for us and every attached socket gets the
   * result. Every room on the floor has an entry, so an empty room is explicitly `idle`.
   */
  roomStatus: Record<string, FactoryStatus>;
  /**
   * The belts on the floor: every workshop is joined to the project building, plus any pair of rooms
   * that has exchanged a package. Derived, so the scene stays declarative and just draws the list.
   */
  conveyors: Conveyor[];
  /** Packages travelling a belt right now. Empty is the normal state. */
  packages: PackageInFlight[];
  /** The task board, newest first — the server's whole list, rebroadcast on every change. */
  tasks: TaskInfo[];
  /** The chronicle surface's current question and its answer. See `ChronicleState`. */
  chronicle: ChronicleState;
  /** Bus messages still queued at their sender, oldest first. See `WaitingMessage`. */
  waiting: WaitingMessage[];
  /**
   * Message ids whose delivery this tab has already turned into a package (or adopted as history on
   * the first snapshot). `messages` is a **snapshot** of the newest 200, rebroadcast in full on every
   * change, so without this every rebroadcast would re-animate everything it still contains.
   *
   * Pruned to what the newest snapshot still holds, so it cannot grow without bound.
   */
  animatedMessages: Record<string, true>;
  /**
   * Whether this tab has had its first `messages` snapshot since connecting. That first snapshot is
   * history — the traffic of the last hour, replied to and forgotten — and replaying it as a burst of
   * packages would be a lie about what the factory is doing *now*. So it is adopted silently, and
   * only what changes afterwards animates.
   */
  messagesLoaded: boolean;
  /**
   * Pair key -> the room pair, for every pair that has ever exchanged a package. A belt outlives the
   * package that justified it: the channel between two rooms is a fact about the factory, and having
   * it appear and vanish with every box would make the floor flicker.
   */
  packagedPairs: Record<string, Conveyor>;
  /** sessionId -> events in seq order */
  events: Record<string, EventRow[]>;
  /** sessionId -> highest seq applied (may sit above a gap) */
  lastSeq: Record<string, number>;
  /**
   * sessionId -> highest seq with no hole below it. This is what we resubscribe from: asking for
   * `lastSeq` after a gap would ask the server to replay from *past* the events we are missing.
   */
  contiguousSeq: Record<string, number>;
  /** sessionId -> a gap was seen; the ws client owes this session a resubscribe. */
  needsResync: Record<string, boolean>;
  /**
   * Files written to disk and waiting to be named in the next turn. See `StagedAttachment`; the
   * composer turns them into lines of turn text when the message is finally sent.
   */
  staged: StagedAttachment[];
  /** An upload is in flight. The composer says so rather than looking like nothing happened. */
  uploading: boolean;
  connected: boolean;
  lastError: string | null;
  /**
   * The server's last `notice`: "this worked, and here is what happened" — where a file landed,
   * what a re-pointed room now means. Separate from `lastError` because they are different facts
   * and must not be painted the same colour.
   */
  lastNotice: string | null;
  apply(msg: ServerMessage): void;
  setConnected(connected: boolean): void;
  selectRoom(roomId: string | null): void;
  /** Report how wide one of the overlay panels is right now. A no-op when it has not changed. */
  setHudInset(side: HudSide, px: number): void;
  /** Ask the camera to frame the whole factory again. */
  requestCameraFit(): void;
  /**
   * Record that a chronicle search has been sent. The *sending* is `wsClient`'s job — the store
   * never talks to the socket — but which question is outstanding is state the answer is checked
   * against, so it is held here rather than in a component that could unmount mid-flight.
   */
  askChronicle(query: string): void;
  /**
   * Forget the last server error. The overlay shows `lastError` next to whatever the operator was
   * doing when it arrived, so a rejected room name has to stop being shown once they try again —
   * otherwise the second attempt looks like it failed the same way.
   */
  clearError(): void;
  /** Report a client-side failure (a failed upload) on the same channel as a server error. */
  setError(message: string): void;
  /** Forget the last notice, so a stale "saved to …" does not sit under the next thing. */
  clearNotice(): void;
  setUploading(uploading: boolean): void;
  /**
   * Add what an upload just wrote to the composer. Idempotent by path: a double-fired drop event
   * (they happen) must not chip the same file twice, and the server never reuses a path.
   */
  stageAttachments(saved: readonly SavedAttachment[]): void;
  /** Take one chip back out. The file stays on disk — it is the operator's. */
  unstageAttachment(path: string): void;
  /** Empty the composer's attachment row, which is what sending a turn does. */
  clearStagedAttachments(): void;
  /**
   * Start dragging a building. `position` is where it stands right now, so the first frame of the
   * drag is identical to the last frame before it and the building never jumps on pointer-down.
   */
  beginRoomDrag(roomId: string, position: ScenePosition): void;
  /** Move the dragged building. Ignored when no drag is in progress — a stray pointer event. */
  dragRoomTo(position: ScenePosition): void;
  /** Let go. The caller sends the one `move_room`; the store only forgets the local position. */
  endRoomDrag(): void;
  /**
   * **Demo only.** Puts a package on the belt between two rooms with no message behind it, so the
   * conveyors can be exercised on a factory with no agents running. Real traffic arrives through
   * `applyMessages`; this is the console drawer's labelled demo button and nothing else should call
   * it. Its packages carry `demo-…` ids, which is what keeps them out of the bus's book-keeping.
   */
  sendPackage(from: string, to: string, durationMs?: number): void;
  /**
   * The bus's traffic, as the server sees it right now. A **snapshot** of the newest 200 messages,
   * newest first — not a delta — so this has to be idempotent: applying the same snapshot twice must
   * animate nothing the second time.
   *
   * What it does, per message: a delivery this tab has not seen yet becomes a package on the belt; a
   * message with no `deliveredAt` becomes a waiting marker at its sender; and the same id flipping
   * from the second to the first is one object changing state, which is why the package is keyed by
   * the message id and starts at the door the marker was standing at.
   */
  applyMessages(messages: MessageInfo[]): void;
  /**
   * The server's project list and the one this socket is on.
   *
   * When the active project **changes**, everything scoped to a project is *dropped* rather than
   * merged: rooms, agents, the board, bus traffic, packages, belts and every transcript. A stale
   * building from another factory standing on this floor is the visible symptom of merging here, and
   * it cannot be cleaned up later because nothing in the new project's snapshots mentions it. The
   * camera is asked to re-frame for the same reason: the new floor is somewhere else.
   */
  applyProjects(projects: ProjectInfo[], activeProjectId: string): void;
  /** Drop packages that have arrived. Called from the render loop and by a per-package timer. */
  reapPackages(now?: number): void;
}

/**
 * Everything a project owns, back to empty. Deliberately *not* `initialFabricState`: the HUD's panel
 * widths, the socket's connected flag and the project list itself are properties of the tab, not of
 * the factory it happens to be showing.
 */
const EMPTY_PROJECT_STATE = {
  sessions: [] as SessionInfo[],
  rooms: [] as RoomInfo[],
  roomIds: [] as string[],
  selectedRoomId: null as string | null,
  drag: null as RoomDrag | null,
  roomStatus: {} as Record<string, FactoryStatus>,
  conveyors: [] as Conveyor[],
  packages: [] as PackageInFlight[],
  tasks: [] as TaskInfo[],
  // Decisions belong to a project's own repository, so the hits from the factory we have just left
  // describe files that are not on this floor at all.
  chronicle: { asked: "", answered: null, hits: [] } as ChronicleState,
  waiting: [] as WaitingMessage[],
  animatedMessages: {} as Record<string, true>,
  // The next project's first `messages` snapshot is history, not news — the same reason a reconnect
  // re-baselines. Without this every queued message on the new floor would fly down a belt at once.
  messagesLoaded: false,
  packagedPairs: {} as Record<string, Conveyor>,
  events: {} as Record<string, EventRow[]>,
  lastSeq: {} as Record<string, number>,
  contiguousSeq: {} as Record<string, number>,
  needsResync: {} as Record<string, boolean>,
  // An error about the factory we just left would sit under whatever the operator does next.
  lastError: null as string | null,
  lastNotice: null as string | null,
  // A staged path points into the folder of the factory we have just left, and the composer it was
  // staged for belongs to a session on that floor. Carrying it across would name a file at an agent
  // that cannot see it.
  staged: [] as StagedAttachment[],
} as const;

/** Everything except the actions — exported so tests can reset between cases. */
export const initialFabricState = {
  projects: [] as ProjectInfo[],
  accounts: [] as AccountInfo[],
  usage: [] as AccountUsage[],
  activeProjectId: null as string | null,
  sessions: [] as SessionInfo[],
  rooms: [] as RoomInfo[],
  roomIds: [] as string[],
  selectedRoomId: null as string | null,
  hudInsets: { left: 0, right: 0, bottom: 0 } as HudInsets,
  fitRequests: 0,
  drag: null as RoomDrag | null,
  roomStatus: {} as Record<string, FactoryStatus>,
  conveyors: [] as Conveyor[],
  packages: [] as PackageInFlight[],
  tasks: [] as TaskInfo[],
  chronicle: { asked: "", answered: null, hits: [] } as ChronicleState,
  waiting: [] as WaitingMessage[],
  animatedMessages: {} as Record<string, true>,
  messagesLoaded: false,
  packagedPairs: {} as Record<string, Conveyor>,
  events: {} as Record<string, EventRow[]>,
  lastSeq: {} as Record<string, number>,
  contiguousSeq: {} as Record<string, number>,
  needsResync: {} as Record<string, boolean>,
  staged: [] as StagedAttachment[],
  uploading: false,
  connected: false,
  lastError: null as string | null,
  lastNotice: null as string | null,
};

/** Highest seq reachable from `start` with no hole. `rows` must be sorted ascending. */
function contiguousFrom(rows: EventRow[], start: number): number {
  let c = start;
  for (const r of rows) {
    if (r.seq <= c) continue;
    if (r.seq !== c + 1) break;
    c = r.seq;
  }
  return c;
}

/** Every field a building draws from. Ids are compared separately, by position in the list. */
function sameRoom(a: RoomInfo, b: RoomInfo): boolean {
  return a.name === b.name && a.path === b.path && a.kind === b.kind
    && a.agentCount === b.agentCount && a.accountId === b.accountId
    && a.position.x === b.position.x && a.position.z === b.position.z;
}

/**
 * Whether a rebroadcast changed the pile at all. Rows keep their identity across snapshots
 * (`applyMessages` reuses them), so this is an identity comparison and the whole list keeps its own
 * identity when nothing moved — which is what stops a `messages` broadcast that changed one
 * delivery from re-rendering every waiting marker on the floor.
 */
function sameWaiting(a: readonly WaitingMessage[], b: readonly WaitingMessage[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i]);
}

/**
 * Every field a figure, a beacon or an agent row in the HUD draws from — **including
 * `isOrchestrator`**, which the floor now marks. A field left out of this list is a field whose
 * change is invisible: the row keeps its previous identity, the shallow comparison holds, and the
 * figure never repaints.
 */
function sameSession(a: SessionInfo, b: SessionInfo): boolean {
  return a.state === b.state && a.status === b.status && a.blocked === b.blocked
    && a.autonomy === b.autonomy && a.model === b.model && a.roomId === b.roomId
    && a.isOrchestrator === b.isOrchestrator && a.accountId === b.accountId
    && a.pausedUntil === b.pausedUntil
    && a.claudeSessionId === b.claudeSessionId && a.lastSeq === b.lastSeq;
}

/**
 * What one agent's figure shows. Per session, not per room: two agents in the same room routinely
 * disagree, and the whole point of a figure each is that you can see which one is stuck.
 */
export function agentStatus(session: Pick<SessionInfo, "state" | "status" | "blocked">): FactoryStatus {
  if (session.status === "error") return "error";
  if (session.blocked) return "blocked";
  // The row and the log are both consulted: `state` is what the scheduler wrote and what survives a
  // reboot, `status` is the newest thing the agent's own log said. Either one saying "paused" is
  // enough — an agent that is held must never be drawn as merely quiet.
  if (session.state === "paused" || session.status === "paused") return "paused";
  if (session.status === "working" || session.status === "starting") return "working";
  return "idle";
}

/**
 * The beacon state of every room on the floor: `idle` unless one of its agents says otherwise, and
 * the most demanding of those when several do (`error` > `blocked` > `working` > `idle`). Sessions
 * with `roomId: null` belong to no room and contribute to none.
 */
export function roomStatusMap(
  rooms: readonly Pick<RoomInfo, "id">[],
  sessions: readonly SessionInfo[],
): Record<string, FactoryStatus> {
  const map: Record<string, FactoryStatus> = {};
  for (const room of rooms) map[room.id] = "idle";
  for (const session of sessions) {
    const roomId = session.roomId;
    // An unknown room id is a session in a room this client has not been told about yet; the
    // `rooms` message that introduces it recomputes the whole map, so nothing is lost by skipping.
    if (roomId === null || map[roomId] === undefined) continue;
    const next = agentStatus(session);
    if (STATUS_RANK[next] > STATUS_RANK[map[roomId]]) map[roomId] = next;
  }
  return map;
}

/** Keeps the previous map when nothing about it changed, so a beacon does not re-render for free. */
function nextRoomStatus(
  previous: Record<string, FactoryStatus>,
  rooms: readonly Pick<RoomInfo, "id">[],
  sessions: readonly SessionInfo[],
): Record<string, FactoryStatus> {
  const map = roomStatusMap(rooms, sessions);
  const keys = Object.keys(map);
  const unchanged = keys.length === Object.keys(previous).length
    && keys.every((id) => previous[id] === map[id]);
  return unchanged ? previous : map;
}

/**
 * Every belt on the floor: the project building to each workshop (the factory's spine — every room
 * answers to the project), plus each room pair that has exchanged a package. A pair is listed once,
 * whichever way round the package went.
 */
export function conveyorList(
  rooms: readonly RoomInfo[],
  packagedPairs: Record<string, Conveyor>,
): Conveyor[] {
  const known = new Set<string>();
  const belts: Conveyor[] = [];
  const project = rooms.find((r) => r.kind === "project");

  if (project !== undefined) {
    for (const r of rooms) {
      if (r.id === project.id) continue;
      known.add(pairKey(project.id, r.id));
      belts.push({ from: project.id, to: r.id, fan: 0 });
    }
    // The spine's belts all leave the same building and are all within a few percent of the same
    // length, so they are the ones that need fanning: give each a signed index centred on zero.
    const middle = (belts.length - 1) / 2;
    for (const [i, belt] of belts.entries()) belt.fan = i - middle;
  }
  const onFloor = new Set(rooms.map((r) => r.id));
  for (const [key, pair] of Object.entries(packagedPairs)) {
    // A pair whose room has since been removed has no belt to draw.
    if (known.has(key) || !onFloor.has(pair.from) || !onFloor.has(pair.to)) continue;
    known.add(key);
    // A room-to-room belt is the only belt between those two rooms, so it needs no fanning.
    belts.push({ from: pair.from, to: pair.to, fan: 0 });
  }
  return belts;
}

/** Keeps the previous belt list when it is unchanged, so panning never rebuilds a tube geometry. */
function nextConveyors(
  previous: Conveyor[],
  rooms: readonly RoomInfo[],
  packagedPairs: Record<string, Conveyor>,
): Conveyor[] {
  const belts = conveyorList(rooms, packagedPairs);
  const unchanged = belts.length === previous.length
    && belts.every((b, i) =>
      b.from === previous[i].from && b.to === previous[i].to && b.fan === previous[i].fan);
  return unchanged ? previous : belts;
}

/**
 * How far the belt between two rooms is fanned, whichever way round it is asked for. `Packages` needs
 * this: a box has a `from` and a `to`, and the belt it must ride may have been drawn the other way
 * about.
 */
export function beltFan(conveyors: readonly Conveyor[], from: string, to: string): number {
  const key = pairKey(from, to);
  for (const belt of conveyors) {
    if (pairKey(belt.from, belt.to) === key) return belt.fan;
  }
  // `conveyorCurve` bows by the *pair* rather than by argument order — swapping its arguments gives
  // the identical curve — so the fan needs no mirroring here either, and a package addressed b -> a
  // rides exactly the belt drawn a -> b.
  return 0;
}

/**
 * The server sends the whole room list on every change, so applying it naively would hand every
 * building a brand-new object and re-render the entire floor because one room moved. Unchanged rows
 * keep their previous identity; an unchanged list is not applied at all.
 */
function applyRooms(s: FabricState, incoming: RoomInfo[]): Partial<FabricState> | FabricState {
  const previous = new Map(s.rooms.map((r) => [r.id, r]));
  const rooms = incoming.map((r) => {
    const prev = previous.get(r.id);
    return prev !== undefined && sameRoom(prev, r) ? prev : r;
  });
  // Returning the state object itself is a real no-op in zustand: no listener is notified at all.
  if (rooms.length === s.rooms.length && rooms.every((r, i) => r === s.rooms[i])) return s;

  const ids = rooms.map((r) => r.id);
  const idsUnchanged = ids.length === s.roomIds.length && ids.every((id, i) => id === s.roomIds[i]);
  return {
    rooms,
    roomIds: idsUnchanged ? s.roomIds : ids,
    // A room that is gone cannot stay selected, or the panel would describe nothing.
    selectedRoomId: s.selectedRoomId !== null && !ids.includes(s.selectedRoomId) ? null : s.selectedRoomId,
    // An in-progress drag deliberately survives this: the server rebroadcasts the whole floor on a
    // 250 ms debounce, and the position it is broadcasting is the one the operator is in the middle
    // of changing. The local position wins until the pointer comes up. The one exception is a
    // building that is no longer on the floor — there is nothing left to drag.
    drag: s.drag !== null && !ids.includes(s.drag.roomId) ? null : s.drag,
    roomStatus: nextRoomStatus(s.roomStatus, rooms, s.sessions),
    conveyors: nextConveyors(s.conveyors, rooms, s.packagedPairs),
  };
}

/**
 * Same trick as `applyRooms`, for the same reason: the session list is rebroadcast whole (debounced
 * to 250 ms) and a figure must not re-render because a *sibling* agent produced a token. Unchanged
 * rows keep their identity, which is what makes `useRoomAgents`' shallow comparison bite.
 */
function applySessions(s: FabricState, incoming: SessionInfo[]): Partial<FabricState> | FabricState {
  const previous = new Map(s.sessions.map((x) => [x.id, x]));
  const sessions = incoming.map((x) => {
    const prev = previous.get(x.id);
    return prev !== undefined && sameSession(prev, x) ? prev : x;
  });
  if (sessions.length === s.sessions.length && sessions.every((x, i) => x === s.sessions[i])) return s;
  return { sessions, roomStatus: nextRoomStatus(s.roomStatus, s.rooms, sessions) };
}

/** Every field a card on the board draws from. */
function sameTask(a: TaskInfo, b: TaskInfo): boolean {
  return a.title === b.title && a.detail === b.detail && a.status === b.status
    && a.roomId === b.roomId && a.agentId === b.agentId
    && a.blockedOnMessageId === b.blockedOnMessageId && a.updatedAt === b.updatedAt;
}

/**
 * Same trick as `applyRooms`/`applySessions`: the board is rebroadcast whole on every change, and an
 * agent driving `factory_task_update` changes it as fast as it can call a tool. Unchanged cards keep
 * their identity so one moving task repaints one row.
 */
function applyTasks(s: FabricState, incoming: TaskInfo[]): Partial<FabricState> | FabricState {
  const previous = new Map(s.tasks.map((t) => [t.id, t]));
  const tasks = incoming.map((t) => {
    const prev = previous.get(t.id);
    return prev !== undefined && sameTask(prev, t) ? prev : t;
  });
  if (tasks.length === s.tasks.length && tasks.every((t, i) => t === s.tasks[i])) return s;
  return { tasks };
}

/** Every field an account row draws from — including where its login has got to. */
function sameAccount(a: AccountInfo, b: AccountInfo): boolean {
  return a.label === b.label && a.configDir === b.configDir
    && a.credentialsPresent === b.credentialsPresent && a.lastUsedAt === b.lastUsedAt
    && a.login.status === b.login.status && a.login.url === b.login.url
    && a.login.message === b.login.message;
}

/**
 * Same trick as `applyRooms`/`applySessions`/`applyTasks`: the list is rebroadcast whole, and while a
 * login is running it is rebroadcast on every chunk the CLI prints. Unchanged rows keep their
 * identity so the account being logged in repaints and the others do not.
 */
function applyAccounts(s: FabricState, incoming: AccountInfo[]): Partial<FabricState> | FabricState {
  const previous = new Map(s.accounts.map((a) => [a.id, a]));
  const accounts = incoming.map((a) => {
    const prev = previous.get(a.id);
    return prev !== undefined && sameAccount(prev, a) ? prev : a;
  });
  if (accounts.length === s.accounts.length && accounts.every((a, i) => a === s.accounts[i])) return s;
  return { accounts };
}

/** Every field a meter draws from. `windows` is compared by value: it is short and rebuilt per poll. */
function sameUsage(a: AccountUsage, b: AccountUsage): boolean {
  return a.source === b.source && a.approximate === b.approximate && a.readAt === b.readAt
    && a.note === b.note && a.limited === b.limited && a.limitedUntil === b.limitedUntil
    && a.limitedBy === b.limitedBy
    && a.windows.length === b.windows.length
    && a.windows.every((w, i) => {
      const other = b.windows[i]!;
      return w.key === other.key && w.label === other.label && w.utilization === other.utilization
        && w.resetsAt === other.resetsAt && w.detail === other.detail;
    });
}

/**
 * Same identity-preserving trick as `applyAccounts`: the meters are rebroadcast whole on every poll,
 * and most polls change nothing. An unchanged row keeps its object so the popover does not repaint
 * three bars because a fourth moved.
 */
function applyUsage(s: FabricState, incoming: AccountUsage[]): Partial<FabricState> | FabricState {
  const previous = new Map(s.usage.map((u) => [u.accountId, u]));
  const usage = incoming.map((u) => {
    const prev = previous.get(u.accountId);
    return prev !== undefined && sameUsage(prev, u) ? prev : u;
  });
  if (usage.length === s.usage.length && usage.every((u, i) => u === s.usage[i])) return s;
  return { usage };
}

export const useFabric = create<FabricState>((set, get) => ({
  ...initialFabricState,

  apply: (msg) => {
    // Not a reducer: turning a delivery into a package also arms the reaper's timer, and a timer is
    // a side effect that has no business inside `set`.
    if (msg.kind === "messages") return get().applyMessages(msg.messages);
    if (msg.kind === "projects") return get().applyProjects(msg.projects, msg.activeProjectId);
    set((s) => {
      if (msg.kind === "sessions") return applySessions(s, msg.sessions);
      if (msg.kind === "rooms") return applyRooms(s, msg.rooms);
      if (msg.kind === "tasks") return applyTasks(s, msg.tasks);
      if (msg.kind === "accounts") return applyAccounts(s, msg.accounts);
      if (msg.kind === "usage") return applyUsage(s, msg.usage);
      // An answer to a question nobody is asking any more is dropped: the operator has typed on,
      // and showing them the hits for a prefix of what is in the box would be worse than showing
      // them nothing. See `ChronicleState`.
      if (msg.kind === "chronicle") {
        if (msg.query !== s.chronicle.asked) return s;
        return { chronicle: { asked: s.chronicle.asked, answered: msg.query, hits: msg.hits } };
      }
      if (msg.kind === "error") return { lastError: msg.message };
      // Not an error, and deliberately not stored with them: "saved to /p/attachments/a.png" is the
      // server confirming something worked, and painting it red would be a lie.
      if (msg.kind === "notice") return { lastNotice: msg.message };
      if (msg.kind !== "event") return s;

      const { sessionId, seq } = msg;
      const rows = s.events[sessionId] ?? [];
      const last = s.lastSeq[sessionId] ?? 0;
      const contiguous = s.contiguousSeq[sessionId] ?? 0;

      // The socket is a lossy tail over an append-only log. Anything at or below the contiguous
      // watermark is certainly a replay we already hold; above it we may be filling a gap, so
      // check before inserting rather than trusting a single high-water mark.
      if (seq <= contiguous) return s;
      let next: EventRow[];
      if (seq > last) next = [...rows, { seq, event: msg.event }];
      else if (rows.some((r) => r.seq === seq)) return s;
      else next = [...rows, { seq, event: msg.event }].sort((a, b) => a.seq - b.seq);

      const nextLast = Math.max(last, seq);
      const nextContiguous = seq === contiguous + 1 && seq > last
        ? seq                               // fast path: the expected next event
        : contiguousFrom(next, contiguous); // a gap opened, or one just got filled
      return {
        events: { ...s.events, [sessionId]: next },
        lastSeq: { ...s.lastSeq, [sessionId]: nextLast },
        contiguousSeq: { ...s.contiguousSeq, [sessionId]: nextContiguous },
        needsResync: { ...s.needsResync, [sessionId]: nextContiguous < nextLast },
      };
    });
  },

  setConnected: (connected) =>
    set((s) => {
      // A reconnect re-baselines the bus: the snapshot that follows describes everything that
      // happened while this tab was not listening, and replaying an hour of it as packages would
      // animate a factory that has already moved on.
      if (s.connected === connected) return s;
      return connected ? { connected } : { connected, messagesLoaded: false };
    }),

  selectRoom: (roomId) => set({ selectedRoomId: roomId }),

  setHudInset: (side, px) =>
    set((s) => {
      // A ResizeObserver fires for sub-pixel changes and while a panel animates; rounding and
      // comparing first is what keeps a panel resize from re-framing the camera dozens of times.
      const next = Math.max(0, Math.round(px));
      if (s.hudInsets[side] === next) return s;
      return { hudInsets: { ...s.hudInsets, [side]: next } };
    }),

  requestCameraFit: () => set((s) => ({ fitRequests: s.fitRequests + 1 })),

  askChronicle: (query) =>
    set((s) => {
      // Re-asking the same question keeps the hits on screen: the operator pressing Enter again
      // should not blank the list they are reading while the identical answer comes back.
      if (s.chronicle.asked === query) return s;
      return { chronicle: { asked: query, answered: null, hits: s.chronicle.hits } };
    }),

  clearError: () => set((s) => (s.lastError === null ? s : { lastError: null })),

  setError: (message) => set((s) => (s.lastError === message ? s : { lastError: message })),

  clearNotice: () => set((s) => (s.lastNotice === null ? s : { lastNotice: null })),

  setUploading: (uploading) => set((s) => (s.uploading === uploading ? s : { uploading })),

  stageAttachments: (saved) =>
    set((s) => {
      const known = new Set(s.staged.map((a) => a.path));
      const added = saved
        .filter((a) => !known.has(a.path))
        .map((a) => ({ path: a.path, name: a.name, bytes: a.bytes }));
      return added.length === 0 ? s : { staged: [...s.staged, ...added] };
    }),

  unstageAttachment: (path) =>
    set((s) => {
      const staged = s.staged.filter((a) => a.path !== path);
      return staged.length === s.staged.length ? s : { staged };
    }),

  clearStagedAttachments: () => set((s) => (s.staged.length === 0 ? s : { staged: [] })),

  beginRoomDrag: (roomId, position) => set({ drag: { roomId, position } }),

  dragRoomTo: (position) =>
    set((s) => {
      if (s.drag === null) return s;
      const { x, z } = s.drag.position;
      // The pointer produces far more events than distinct floor cells; an unchanged position must
      // not re-render the building or rebuild the belts hanging off it.
      if (position.x === x && position.z === z) return s;
      return { drag: { roomId: s.drag.roomId, position } };
    }),

  endRoomDrag: () => set((s) => (s.drag === null ? s : { drag: null })),

  sendPackage: (from, to, durationMs = DEFAULT_PACKAGE_MS) => {
    if (from === to) return;
    set((s) => {
      const key = pairKey(from, to);
      const packagedPairs = s.packagedPairs[key] !== undefined
        ? s.packagedPairs
        : { ...s.packagedPairs, [key]: { from, to, fan: 0 } };
      return {
        packages: [
          ...s.packages,
          { id: `demo-${++packageSeq}`, from, to, startedAt: Date.now(), durationMs },
        ],
        packagedPairs,
        conveyors: packagedPairs === s.packagedPairs
          ? s.conveyors
          : nextConveyors(s.conveyors, s.rooms, packagedPairs),
      };
    });
    // The scene reaps the frame a package lands, but a backgrounded tab renders no frames at all —
    // and a package that is never reaped leaves `hasMotion` true forever. Belt and braces.
    setTimeout(() => get().reapPackages(), durationMs + 80);
  },

  applyMessages: (incoming) => {
    const s = get();
    const now = Date.now();
    const animated = { ...s.animatedMessages };
    const started: PackageInFlight[] = [];
    const waiting: WaitingMessage[] = [];
    const previousWaiting = new Map(s.waiting.map((w) => [w.id, w]));
    const pairs: Record<string, Conveyor> = { ...s.packagedPairs };
    let pairsChanged = false;

    /** A message earns the belt it uses, whether it is riding it or queued at the end of it. */
    const earnBelt = (from: string, to: string): void => {
      const key = pairKey(from, to);
      if (pairs[key] !== undefined) return;
      pairs[key] = { from, to, fan: 0 };
      pairsChanged = true;
    };

    // Oldest first: the snapshot is newest-first, and packages should leave in the order the
    // messages were actually sent.
    for (const m of [...incoming].sort((a, b) => a.createdAt - b.createdAt)) {
      if (m.fromRoomId !== m.toRoomId) earnBelt(m.fromRoomId, m.toRoomId);

      if (m.deliveredAt === null) {
        // Identity is preserved across snapshots so a rebroadcast does not re-render the pile.
        const prev = previousWaiting.get(m.id);
        waiting.push(prev ?? {
          id: m.id, from: m.fromRoomId, to: m.toRoomId, kind: m.kind, createdAt: m.createdAt,
        });
        continue;
      }
      // Delivered. Once per message id, ever: the snapshot keeps carrying it for as long as it is
      // among the newest 200, and it must not fly again on every rebroadcast.
      if (animated[m.id] === true) continue;
      animated[m.id] = true;
      // The first snapshot of a connection is history, not news — see `messagesLoaded`.
      if (!s.messagesLoaded) continue;
      // A room talking to itself has no belt to ride. The message is real and is in the log; there
      // is simply nothing to animate.
      if (m.fromRoomId === m.toRoomId) continue;
      // Keyed by the message id, so the box that leaves is the same object as the marker that was
      // standing there: the waiting marker and the package are two states of one message, and the
      // package starts at the door the marker stood at rather than appearing from nothing.
      started.push({
        id: m.id, from: m.fromRoomId, to: m.toRoomId, startedAt: now, durationMs: DEFAULT_PACKAGE_MS,
      });
    }

    const packages = started.length === 0 ? s.packages : [...s.packages, ...started];
    // Keep only what the snapshot still carries (plus anything still in the air): the record exists
    // to suppress re-animation of messages we can still be told about, and nothing else.
    const live = new Set(incoming.map((m) => m.id));
    for (const p of packages) live.add(p.id);
    const kept: Record<string, true> = {};
    for (const id of Object.keys(animated)) if (live.has(id)) kept[id] = true;

    set({
      packages,
      waiting: sameWaiting(s.waiting, waiting) ? s.waiting : waiting,
      animatedMessages: kept,
      messagesLoaded: true,
      packagedPairs: pairsChanged ? pairs : s.packagedPairs,
      conveyors: pairsChanged ? nextConveyors(s.conveyors, s.rooms, pairs) : s.conveyors,
    });

    // Same belt-and-braces reap as the demo action: a backgrounded tab renders no frames, and an
    // unreaped package would leave `hasMotion` true for ever.
    if (started.length > 0) setTimeout(() => get().reapPackages(), DEFAULT_PACKAGE_MS + 80);
  },

  applyProjects: (projects, activeProjectId) =>
    set((s) => {
      const sameList = projects.length === s.projects.length
        && projects.every((p, i) => {
          const prev = s.projects[i];
          return prev !== undefined && prev.id === p.id && prev.name === p.name
            && prev.root === p.root && prev.lastOpenedAt === p.lastOpenedAt;
        });
      // A `projects` frame arrives whenever *anyone* adds or opens a project, so the common case is
      // that nothing about this tab changed at all.
      if (sameList && activeProjectId === s.activeProjectId) return s;

      const list = sameList ? s.projects : projects;
      // First frame of a connection: there is nothing to drop, and dropping would throw away rooms
      // that legitimately arrived in the same round trip.
      if (s.activeProjectId === null || s.activeProjectId === activeProjectId) {
        return { projects: list, activeProjectId };
      }
      return {
        ...EMPTY_PROJECT_STATE,
        projects: list,
        activeProjectId,
        // The new floor is somewhere else on the ground plane; keeping the old camera would leave the
        // operator looking at empty concrete.
        fitRequests: s.fitRequests + 1,
      };
    }),

  reapPackages: (now = Date.now()) =>
    set((s) => {
      const packages = s.packages.filter((p) => now - p.startedAt < p.durationMs);
      return packages.length === s.packages.length ? s : { packages };
    }),
}));

// ---- per-object selectors ----
//
// Scene state flows through these, never through prop drilling: a building subscribes to its own
// room and its own agent count, so one room's change re-renders one building.

export const useRoomIds = (): string[] => useFabric((s) => s.roomIds);

// ---- projects ----

export const useProjects = (): ProjectInfo[] => useFabric((s) => s.projects);

export const useActiveProjectId = (): string | null => useFabric((s) => s.activeProjectId);

// ---- accounts ----
//
// Machine-wide, so none of these takes a project: the same list is the answer on every floor. What
// *is* per-project is the binding, and that rides on `RoomInfo.accountId` / `SessionInfo.accountId`
// like any other field of a room or an agent.

export const useAccounts = (): AccountInfo[] => useFabric(useShallow((s) => s.accounts));

/** One account, or `undefined` for `null` and for an id this tab has not been told about. */
export const useAccount = (accountId: string | null): AccountInfo | undefined =>
  useFabric((s) => (accountId === null ? undefined : s.accounts.find((a) => a.id === accountId)));

/**
 * What to call an account in one line. An id we hold no row for is shown as the id rather than as
 * "none": "this agent is on an account I cannot describe" and "this agent is on no account" are
 * different facts, and the second is a claim about which subscription is being spent.
 */
export function accountLabel(accounts: readonly AccountInfo[], accountId: string | null): string {
  if (accountId === null) return ACCOUNT_NONE_LABEL;
  return accounts.find((a) => a.id === accountId)?.label ?? accountId;
}

/** Every account's meters. Machine-wide like `useAccounts`, so it takes no project. */
export const useUsage = (): AccountUsage[] => useFabric(useShallow((s) => s.usage));

/** One account's meters, or `undefined` before the server has said anything about it. */
export const useAccountUsage = (accountId: string): AccountUsage | undefined =>
  useFabric((s) => s.usage.find((u) => u.accountId === accountId));

/** What "no account" is called wherever it is offered or shown. One string, not four. */
export const ACCOUNT_NONE_LABEL = "default";

/** The factory this tab is showing, or undefined before the server has said which. */
export const useActiveProject = (): ProjectInfo | undefined =>
  useFabric((s) => s.projects.find((p) => p.id === s.activeProjectId));

export const useRoom = (roomId: string): RoomInfo | undefined =>
  useFabric((s) => s.rooms.find((r) => r.id === roomId));

/**
 * Where a building should be drawn: the position the operator's pointer is holding it at while they
 * drag it, and the server's committed position at every other moment. **This is the single place the
 * "local position wins during a drag" rule is expressed** — the building and the belts hanging off it
 * both read it, so they can never disagree about where the building is.
 */
export function roomPosition(
  state: Pick<FabricState, "rooms" | "drag">,
  roomId: string,
): ScenePosition | undefined {
  if (state.drag !== null && state.drag.roomId === roomId) return state.drag.position;
  return state.rooms.find((r) => r.id === roomId)?.position;
}

export const useRoomPosition = (roomId: string): ScenePosition | undefined =>
  useFabric(useShallow((s) => roomPosition(s, roomId)));

/**
 * Whether a room is the project block or a workshop. A primitive, so a subscriber does not re-render
 * because the room gained an agent — which matters for the belts, whose geometry depends on the kind
 * (how wide the building is) and on nothing else about the room.
 */
export const useRoomKind = (roomId: string): RoomInfo["kind"] | undefined =>
  useFabric((s) => s.rooms.find((r) => r.id === roomId)?.kind);

/**
 * Which way the belts leave this room, as a flat `[dx0, dz0, dx1, dz1, …]` — one pair per belt this
 * room is an end of. The building draws a loading bay on the wall each of them crosses, so a package
 * arrives at a door instead of at a blank slab.
 *
 * Flat numbers rather than objects on purpose: this goes through `useShallow`, which compares
 * element by element with `Object.is`. An array of freshly built `{x, z}` objects would never compare
 * equal, and the building would re-render on every store notification for ever.
 *
 * Positions come from `roomPosition`, so a bay follows the belt while either building is dragged.
 */
export function beltDirections(
  state: Pick<FabricState, "rooms" | "drag" | "conveyors">,
  roomId: string,
): number[] {
  const self = roomPosition(state, roomId);
  if (self === undefined) return [];
  const out: number[] = [];
  for (const belt of state.conveyors) {
    const otherId = belt.from === roomId ? belt.to : belt.to === roomId ? belt.from : null;
    if (otherId === null) continue;
    const other = roomPosition(state, otherId);
    if (other === undefined) continue;
    out.push(other.x - self.x, other.z - self.z);
  }
  return out;
}

export const useBeltDirections = (roomId: string): number[] =>
  useFabric(useShallow((s) => beltDirections(s, roomId)));

export const useSelectedRoomId = (): string | null => useFabric((s) => s.selectedRoomId);

/** The composer's attachment row. See `StagedAttachment`. */
export const useStagedAttachments = (): StagedAttachment[] => useFabric((s) => s.staged);

export const useHudInsets = (): HudInsets => useFabric(useShallow((s) => s.hudInsets));

/** Whether *any* building is being dragged. Subscribing to the boolean, not to the moving position. */
export const useIsDragging = (): boolean => useFabric((s) => s.drag !== null);

export const useIsSelected = (roomId: string): boolean =>
  useFabric((s) => s.selectedRoomId === roomId);

/**
 * How many agents actually stand in a room. `RoomInfo.agentCount` is a plain `COUNT(*)` over
 * `sessions.room_id`, so it keeps counting sessions that finished or failed — history, not agents.
 */
export function liveAgentCount(sessions: readonly SessionInfo[], roomId: string): number {
  return sessions.filter((s) => s.roomId === roomId && s.state !== "done" && s.state !== "error").length;
}

export const useRoomAgentCount = (roomId: string): number =>
  useFabric((s) => liveAgentCount(s.sessions, roomId));

/**
 * What this room's beacon shows. Returns a string, so a subscriber only re-renders when *this*
 * room's status actually changed — the map's identity churning is invisible here.
 */
export const useRoomStatus = (roomId: string): FactoryStatus =>
  useFabric((s) => s.roomStatus[roomId] ?? "idle");

/**
 * The agents standing in one room: exactly the sessions `liveAgentCount` counts, so the figures on
 * the floor and the number on the building's label can never disagree. A `done` or `error` session is
 * history rather than an agent — an error still reaches the operator, through the room's beacon.
 */
export function roomAgents(sessions: readonly SessionInfo[], roomId: string): SessionInfo[] {
  return sessions.filter((s) => s.roomId === roomId && s.state !== "done" && s.state !== "error");
}

/**
 * One room's agents. `useShallow` is load-bearing twice over: without an equality function a selector
 * that builds an array would make React re-render forever, and with it a rebroadcast session list that
 * changed nothing about *this* room does not touch these figures at all (which is why `applySessions`
 * preserves row identity).
 */
export const useRoomAgents = (roomId: string): SessionInfo[] =>
  useFabric(useShallow((s) => roomAgents(s.sessions, roomId)));

/**
 * The sessions that belong to no room at all. Every M0 session is one of these (`room_id` did not
 * exist yet), and so is anything created through the console drawer's plain "New session" button —
 * they run, they cost quota, and **nothing on the factory floor draws them**, because a figure with
 * no building to stand at has nowhere to be. The room panel lists them for exactly that reason: the
 * floor is allowed to be incomplete, the operator's view of what is running is not.
 *
 * Unlike `roomAgents` this keeps finished and failed sessions too. A room's figures are what is
 * standing there now; this is a list of what the floor is *not* showing, and a `done` roomless
 * session is still not shown anywhere else.
 */
export function roomlessSessions(sessions: readonly SessionInfo[]): SessionInfo[] {
  return sessions.filter((s) => s.roomId === null);
}

export const useRoomlessSessions = (): SessionInfo[] =>
  useFabric(useShallow((s) => roomlessSessions(s.sessions)));

// ---- the orchestrator ----
//
// It is an ordinary session with a flag, so there is nothing here but selectors: no separate list,
// no separate widget, no second source of truth about which agent is senior. At most one per
// project — the server enforces that — so "the first flagged session" is "the orchestrator".

/** This factory's senior agent, or `undefined` for a factory that has not been given one. */
export function orchestratorSession(sessions: readonly SessionInfo[]): SessionInfo | undefined {
  return sessions.find((s) => s.isOrchestrator);
}

export const useOrchestrator = (): SessionInfo | undefined =>
  useFabric((s) => orchestratorSession(s.sessions));

/**
 * Whether this factory has one. A boolean, so the board's "route it" affordance does not re-render
 * every time the orchestrator's status ticks — it only cares that it exists.
 */
export const useHasOrchestrator = (): boolean =>
  useFabric((s) => orchestratorSession(s.sessions) !== undefined);

/**
 * Whether the orchestrator stands in this room. The building's label reads it, and it is a boolean
 * for the same reason: the central building's label must not repaint on every token.
 */
export const useRoomHasOrchestrator = (roomId: string): boolean =>
  useFabric((s) => orchestratorSession(s.sessions)?.roomId === roomId);

// ---- the chronicle ----

export const useChronicle = (): ChronicleState => useFabric((s) => s.chronicle);

// ---- the task board ----

/**
 * The order the board reads in: what has not started, what is moving, what is stuck, what is up for
 * review, what is finished. `blocked` sits in the middle rather than at the end because it is the
 * group the operator is being asked to do something about.
 */
export const TASK_STATUS_ORDER: readonly TaskStatus[] = [
  "open", "in_progress", "blocked", "review", "done",
];

export const useTasks = (): TaskInfo[] => useFabric((s) => s.tasks);

/** The board grouped for display. Empty groups are kept: an empty column is information. */
export function tasksByStatus(tasks: readonly TaskInfo[]): { status: TaskStatus; tasks: TaskInfo[] }[] {
  return TASK_STATUS_ORDER.map((status) => ({ status, tasks: tasks.filter((t) => t.status === status) }));
}

/**
 * The cards nobody owns yet. `done` is excluded: a finished card that was never routed is history,
 * not work waiting on a decision, and counting it would make the board nag about nothing.
 */
export function unassignedTasks(tasks: readonly TaskInfo[]): TaskInfo[] {
  return tasks.filter((t) => t.roomId === null && t.status !== "done");
}

/**
 * How many tasks a room still owes. `done` is excluded on purpose: the badge is a workload, and a
 * room whose every card is finished should read as clear rather than as busy.
 */
export function openTaskCount(tasks: readonly TaskInfo[], roomId: string): number {
  return tasks.filter((t) => t.roomId === roomId && t.status !== "done").length;
}

export const useRoomTaskCount = (roomId: string): number =>
  useFabric((s) => openTaskCount(s.tasks, roomId));

/**
 * The bus messages nobody has picked up yet. Deliberately *not* part of `hasMotion`: the marker is
 * static, because a pile-up that pinned the frameloop to `"always"` would spin the GPU for as long as
 * a room was busy — and a queue is a state to read, not an animation to watch.
 */
export const useWaitingMessages = (): WaitingMessage[] => useFabric((s) => s.waiting);

/**
 * Whether anything in the scene needs animating. The canvas runs `frameloop="demand"` and only
 * switches to `"always"` while this is true, so an idle factory does not spin the GPU. Tasks 6 and 7
 * must keep this accurate: a beacon or a package that looks frozen is this returning false when it
 * should not.
 *
 * `starting` deliberately does **not** count, even though Task 6's beacon colours it like `working`.
 * A Claude Code session reports `starting` when its executor spawns and only leaves that status when
 * its first turn completes — so a freshly created agent nobody has prompted yet stays `starting`
 * indefinitely, and counting it would pin the frameloop to `"always"` for the rest of the session.
 *
 * A drag counts because a drag *is* motion: without it the demand loop renders the frame the pointer
 * went down and then nothing, and the building sits frozen while the operator hauls on it.
 */
export function hasMotion(state: Pick<FabricState, "sessions" | "packages" | "drag">): boolean {
  return state.drag !== null
    || state.packages.length > 0
    || state.sessions.some((s) => s.status === "working");
}

export const useHasMotion = (): boolean => useFabric(hasMotion);
