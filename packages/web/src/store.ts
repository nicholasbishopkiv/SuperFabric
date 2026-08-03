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
  /** sessionId -> highest seq applied; what we resubscribe from after a reconnect */
  lastSeq: Record<string, number>;
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
  connected: false,
  lastError: null as string | null,
};

export const useFabric = create<FabricState>((set) => ({
  ...initialFabricState,

  apply: (msg) =>
    set((s) => {
      if (msg.kind === "sessions") return { sessions: msg.sessions };
      if (msg.kind === "error") return { lastError: msg.message };
      if (msg.kind !== "event") return s;
      // The socket is a lossy tail over an append-only log: a resubscribe can replay events we
      // already hold, so anything at or below the highest seq we've seen is dropped.
      if ((s.lastSeq[msg.sessionId] ?? 0) >= msg.seq) return s;
      const rows = s.events[msg.sessionId] ?? [];
      return {
        events: { ...s.events, [msg.sessionId]: [...rows, { seq: msg.seq, event: msg.event }] },
        lastSeq: { ...s.lastSeq, [msg.sessionId]: msg.seq },
      };
    }),

  setConnected: (connected) => set({ connected }),
}));
