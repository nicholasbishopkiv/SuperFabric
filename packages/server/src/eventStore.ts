import type { Db } from "./db.js";
import type { SessionEvent } from "@superfabric/shared";

export type AppendListener = (sessionId: string, seq: number, event: SessionEvent) => void;

export class EventStore {
  private listeners = new Set<AppendListener>();
  private insert; private maxSeqStmt; private after;

  constructor(db: Db) {
    this.insert = db.prepare("INSERT INTO events (session_id, seq, type, payload) VALUES (?, ?, ?, ?)");
    this.maxSeqStmt = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_id = ?");
    this.after = db.prepare("SELECT seq, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq");
  }

  append(sessionId: string, event: SessionEvent): number {
    const seq = this.maxSeq(sessionId) + 1;
    this.insert.run(sessionId, seq, event.type, JSON.stringify(event));
    for (const l of this.listeners) l(sessionId, seq, event);
    return seq;
  }

  /** Highest seq recorded for a session, 0 when it has no events. */
  maxSeq(sessionId: string): number {
    return (this.maxSeqStmt.get(sessionId) as { m: number }).m;
  }

  listAfter(sessionId: string, afterSeq: number): { seq: number; event: SessionEvent }[] {
    return (this.after.all(sessionId, afterSeq) as { seq: number; payload: string }[])
      .map(r => ({ seq: r.seq, event: JSON.parse(r.payload) as SessionEvent }));
  }

  onAppend(l: AppendListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
