import type { RoomInfo, ServerMessage, SessionEvent, SessionInfo } from "@superfabric/shared";
import { create } from "zustand";

export interface EventRow {
  seq: number;
  event: SessionEvent;
}

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
  /** The building the operator clicked, shared by the scene and (from Task 9) the room panel. */
  selectedRoomId: string | null;
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
}

/** Everything except the actions — exported so tests can reset between cases. */
export const initialFabricState = {
  sessions: [] as SessionInfo[],
  rooms: [] as RoomInfo[],
  roomIds: [] as string[],
  selectedRoomId: null as string | null,
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
  };
}

export const useFabric = create<FabricState>((set) => ({
  ...initialFabricState,

  apply: (msg) =>
    set((s) => {
      if (msg.kind === "sessions") return { sessions: msg.sessions };
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
}));

// ---- per-object selectors ----
//
// Scene state flows through these, never through prop drilling: a building subscribes to its own
// room and its own agent count, so one room's change re-renders one building.

export const useRoomIds = (): string[] => useFabric((s) => s.roomIds);

export const useRoom = (roomId: string): RoomInfo | undefined =>
  useFabric((s) => s.rooms.find((r) => r.id === roomId));

export const useSelectedRoomId = (): string | null => useFabric((s) => s.selectedRoomId);

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
 * Whether anything in the scene needs animating. The canvas runs `frameloop="demand"` and only
 * switches to `"always"` while this is true, so an idle factory does not spin the GPU. Tasks 6 and 7
 * must keep this accurate: a beacon or a package that looks frozen is this returning false when it
 * should not.
 */
export function hasMotion(state: Pick<FabricState, "sessions">): boolean {
  return state.sessions.some((s) => s.status === "working" || s.status === "starting");
}

export const useHasMotion = (): boolean => useFabric(hasMotion);
