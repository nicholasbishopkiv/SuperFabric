import { ClientMessage, type ServerMessage } from "@superfabric/shared";
import type { EventStore } from "./eventStore.js";
import type { RoomManager } from "./roomManager.js";
import type { SessionManager } from "./sessionManager.js";

export interface SocketLike { send(data: string): void; }

export class WsHub {
  /** socket -> subscribed sessionIds with last sent seq */
  private subs = new Map<SocketLike, Map<string, number>>();

  constructor(private store: EventStore, private mgr: SessionManager, private rooms: RoomManager) {
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
    });
  }

  attach(sock: SocketLike): void { this.subs.set(sock, new Map()); }
  detach(sock: SocketLike): void { this.subs.delete(sock); }

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
          // `autonomy` omitted => SessionManager applies the product default ("auto"); a `roomId`
          // makes the room's folder the cwd, and an unknown one throws into the catch below.
          const id = this.mgr.createSession({ cwd: msg.cwd, roomId: msg.roomId, autonomy: msg.autonomy });
          this.safeSend(sock, { kind: "sessions", sessions: this.mgr.listSessions() });
          // The room's agentCount just changed; refresh it in the same round trip so the building's
          // label never lags behind the agent standing in it.
          if (msg.roomId !== undefined) this.sendRooms(sock);
          this.subscribe(sock, id, 0); // auto-subscribe the creator from seq 0
          break;
        }
        case "set_autonomy":
          // Restarting the executor is async, so the outcome is reported from the promise — an
          // unhandled rejection would exit the process on Node 22.
          void this.mgr.setAutonomy(msg.sessionId, msg.autonomy).then(
            () => { this.safeSend(sock, { kind: "sessions", sessions: this.mgr.listSessions() }); },
            (err: unknown) => { this.safeSend(sock, { kind: "error", message: String(err) }); },
          );
          break;
        case "list_sessions": this.safeSend(sock, { kind: "sessions", sessions: this.mgr.listSessions() }); break;
        // Rooms: each case answers with the whole room list rather than a delta, so a client can
        // rebuild the floor from one message and never has to merge. A failure (duplicate name,
        // unknown id) throws into the catch below and is reported as an error instead.
        case "create_room":
          this.rooms.createRoom(msg.name);
          this.sendRooms(sock);
          break;
        case "move_room":
          this.rooms.moveRoom(msg.roomId, msg.position);
          this.sendRooms(sock);
          break;
        case "list_rooms": this.sendRooms(sock); break;
      }
    } catch (err) {
      this.safeSend(sock, { kind: "error", message: String(err) });
    }
  }

  private sendRooms(sock: SocketLike): void {
    this.safeSend(sock, { kind: "rooms", rooms: this.rooms.listRooms() });
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
