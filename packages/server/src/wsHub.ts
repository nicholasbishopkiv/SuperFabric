import { ClientMessage, type ServerMessage } from "@superfabric/shared";
import type { EventStore } from "./eventStore.js";
import type { SessionManager } from "./sessionManager.js";

export interface SocketLike { send(data: string): void; }

export class WsHub {
  /** socket -> subscribed sessionIds with last sent seq */
  private subs = new Map<SocketLike, Map<string, number>>();

  constructor(private store: EventStore, private mgr: SessionManager) {
    store.onAppend((sessionId, seq, event) => {
      const msg: ServerMessage = { kind: "event", sessionId, seq, event };
      for (const [sock, sessions] of this.subs) {
        const last = sessions.get(sessionId);
        if (last !== undefined && seq > last) { sessions.set(sessionId, seq); this.safeSend(sock, msg); }
      }
    });
  }

  attach(sock: SocketLike): void { this.subs.set(sock, new Map()); }
  detach(sock: SocketLike): void { this.subs.delete(sock); }

  handleMessage(sock: SocketLike, raw: string): void {
    let msg: ClientMessage;
    try { msg = ClientMessage.parse(JSON.parse(raw)); }
    catch { return this.safeSend(sock, { kind: "error", message: "bad message" }); }

    switch (msg.kind) {
      case "subscribe": {
        const sessions = this.subs.get(sock) ?? new Map();
        let last = msg.afterSeq;
        for (const { seq, event } of this.store.listAfter(msg.sessionId, msg.afterSeq)) {
          this.safeSend(sock, { kind: "event", sessionId: msg.sessionId, seq, event });
          last = seq;
        }
        sessions.set(msg.sessionId, last);
        this.subs.set(sock, sessions);
        break;
      }
      case "prompt": this.mgr.prompt(msg.sessionId, msg.text); break;
      case "approval": this.mgr.approve(msg.sessionId, msg.approvalId, msg.behavior); break;
      case "interrupt": void this.mgr.interrupt(msg.sessionId); break;
      case "create_session": {
        const id = this.mgr.createSession(msg.cwd ?? process.cwd());
        this.safeSend(sock, { kind: "sessions", sessions: this.mgr.listSessions() });
        // auto-subscribe creator from seq 0
        this.handleMessage(sock, JSON.stringify({ kind: "subscribe", sessionId: id, afterSeq: 0 }));
        break;
      }
      case "list_sessions": this.safeSend(sock, { kind: "sessions", sessions: this.mgr.listSessions() }); break;
    }
  }

  private safeSend(sock: SocketLike, msg: ServerMessage): void {
    try { sock.send(JSON.stringify(msg)); } catch { /* dead socket; detach on close */ }
  }
}
