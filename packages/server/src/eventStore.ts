import type { Db } from "./db.js";
import type { SessionEvent } from "@superfabric/shared";

export type AppendListener = (sessionId: string, seq: number, event: SessionEvent) => void;

export class EventStore {
  private listeners = new Set<AppendListener>();
  private insert; private maxSeq; private after;

  constructor(private db: Db) {
    this.insert = db.prepare("INSERT INTO events (session_id, seq, type, payload) VALUES (?, ?, ?, ?)");
    this.maxSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_id = ?");
    this.after = db.prepare("SELECT seq, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq");
  }

  append(sessionId: string, event: SessionEvent): number {
    const seq = (this.maxSeq.get(sessionId) as { m: number }).m + 1;
    this.insert.run(sessionId, seq, event.type, JSON.stringify(event));
    for (const l of this.listeners) l(sessionId, seq, event);
    return seq;
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
