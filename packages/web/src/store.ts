import type {
  RoomInfo,
  ScenePosition,
  ServerMessage,
  SessionEvent,
  SessionInfo,
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
 * - `blocked` — an approval is waiting for **you**.
 * - `error` — something failed and will not un-fail on its own.
 *
 * `paused` and `done` read as `idle` (nothing is moving), `starting` reads as `working` (it looks
 * busy). The colours live in `scene/palette.ts` and are keyed by exactly this type.
 */
export type FactoryStatus = "idle" | "working" | "blocked" | "error";

/** Precedence: a room shows the most demanding state any of its agents is in. */
const STATUS_RANK: Record<FactoryStatus, number> = { idle: 0, working: 1, blocked: 2, error: 3 };

/** A belt between two buildings. Undirected: one pair of rooms is one belt, drawn once. */
export interface Conveyor {
  from: string;
  to: string;
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

/** How long a package takes to cross a belt, unless the caller says otherwise. */
export const DEFAULT_PACKAGE_MS = 2_400;

/** Ids only have to be unique within a tab's lifetime; a counter is enough and is deterministic. */
let packageSeq = 0;

/** Undirected key for a pair of rooms. */
const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

export interface FabricState {
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
   * here (they know their own collapsed/expanded width; the scene must not go reading their DOM),
   * and the camera framing subtracts it.
   */
  hudInsets: { left: number; right: number };
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
  connected: boolean;
  lastError: string | null;
  apply(msg: ServerMessage): void;
  setConnected(connected: boolean): void;
  selectRoom(roomId: string | null): void;
  /** Report how wide one of the overlay panels is right now. A no-op when it has not changed. */
  setHudInset(side: "left" | "right", px: number): void;
  /** Ask the camera to frame the whole factory again. */
  requestCameraFit(): void;
  /**
   * Forget the last server error. The overlay shows `lastError` next to whatever the operator was
   * doing when it arrived, so a rejected room name has to stop being shown once they try again —
   * otherwise the second attempt looks like it failed the same way.
   */
  clearError(): void;
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
   * Put a package on the belt between two rooms. **This is the seam the M3 factory bus plugs into**:
   * when a real inter-room message exists, the bus calls this and nothing else on the client changes.
   * Until then the console drawer's manual control is the only caller.
   */
  sendPackage(from: string, to: string, durationMs?: number): void;
  /** Drop packages that have arrived. Called from the render loop and by a per-package timer. */
  reapPackages(now?: number): void;
}

/** Everything except the actions — exported so tests can reset between cases. */
export const initialFabricState = {
  sessions: [] as SessionInfo[],
  rooms: [] as RoomInfo[],
  roomIds: [] as string[],
  selectedRoomId: null as string | null,
  hudInsets: { left: 0, right: 0 } as { left: number; right: number },
  fitRequests: 0,
  drag: null as RoomDrag | null,
  roomStatus: {} as Record<string, FactoryStatus>,
  conveyors: [] as Conveyor[],
  packages: [] as PackageInFlight[],
  packagedPairs: {} as Record<string, Conveyor>,
  events: {} as Record<string, EventRow[]>,
  lastSeq: {} as Record<string, number>,
  contiguousSeq: {} as Record<string, number>,
  needsResync: {} as Record<string, boolean>,
  connected: false,
  lastError: null as string | null,
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
    && a.agentCount === b.agentCount
    && a.position.x === b.position.x && a.position.z === b.position.z;
}

/** Every field a figure or a beacon draws from. */
function sameSession(a: SessionInfo, b: SessionInfo): boolean {
  return a.state === b.state && a.status === b.status && a.blocked === b.blocked
    && a.autonomy === b.autonomy && a.roomId === b.roomId
    && a.claudeSessionId === b.claudeSessionId && a.lastSeq === b.lastSeq;
}

/**
 * What one agent's figure shows. Per session, not per room: two agents in the same room routinely
 * disagree, and the whole point of a figure each is that you can see which one is stuck.
 */
export function agentStatus(session: Pick<SessionInfo, "status" | "blocked">): FactoryStatus {
  if (session.status === "error") return "error";
  if (session.blocked) return "blocked";
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
      belts.push({ from: project.id, to: r.id });
    }
  }
  const onFloor = new Set(rooms.map((r) => r.id));
  for (const [key, pair] of Object.entries(packagedPairs)) {
    // A pair whose room has since been removed has no belt to draw.
    if (known.has(key) || !onFloor.has(pair.from) || !onFloor.has(pair.to)) continue;
    known.add(key);
    belts.push(pair);
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
    && belts.every((b, i) => b.from === previous[i].from && b.to === previous[i].to);
  return unchanged ? previous : belts;
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

export const useFabric = create<FabricState>((set, get) => ({
  ...initialFabricState,

  apply: (msg) =>
    set((s) => {
      if (msg.kind === "sessions") return applySessions(s, msg.sessions);
      if (msg.kind === "rooms") return applyRooms(s, msg.rooms);
      if (msg.kind === "error") return { lastError: msg.message };
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
    }),

  setConnected: (connected) => set({ connected }),

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

  clearError: () => set((s) => (s.lastError === null ? s : { lastError: null })),

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
        : { ...s.packagedPairs, [key]: { from, to } };
      return {
        packages: [
          ...s.packages,
          { id: `pkg-${++packageSeq}`, from, to, startedAt: Date.now(), durationMs },
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

export const useHudInsets = (): { left: number; right: number } =>
  useFabric(useShallow((s) => s.hudInsets));

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
