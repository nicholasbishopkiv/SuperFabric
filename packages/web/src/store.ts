import type { ServerMessage, SessionEvent, SessionInfo } from "@superfabric/shared";
import { create } from "zustand";

export interface EventRow {
  seq: number;
  event: SessionEvent;
}

export interface FabricState {
  sessions: SessionInfo[];
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
}

/** Everything except the actions — exported so tests can reset between cases. */
export const initialFabricState = {
  sessions: [] as SessionInfo[],
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

export const useFabric = create<FabricState>((set) => ({
  ...initialFabricState,

  apply: (msg) =>
    set((s) => {
      if (msg.kind === "sessions") return { sessions: msg.sessions };
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
}));

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
