import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStatus } from "@superfabric/shared";
import { openDb } from "../src/db.js";
import { FactoryBus, type RoomAgent } from "../src/factoryBus.js";
import { RoomManager } from "../src/roomManager.js";

/**
 * A bus over an in-memory db with two real rooms, a recording `deliver` and a `roomAgents` lookup
 * the test drives. No SessionManager: the bus takes callbacks precisely so delivery is testable
 * without one (and so the dependency stays one-way).
 */
function makeBus() {
  const root = mkdtempSync(join(tmpdir(), "superfabric-bus-"));
  const db = openDb(":memory:");
  const rooms = new RoomManager(db, root);
  rooms.ensureProjectRoom();
  const chat = rooms.createRoom("chat");
  const payments = rooms.createRoom("payments");

  /** roomId -> the agents standing in it, as the test wants them seen. */
  const agents = new Map<string, RoomAgent[]>();
  const delivered: { sessionId: string; text: string }[] = [];
  let now = 1_000;
  let deliverThrows = false;

  const bus = new FactoryBus({
    db,
    rooms,
    deliver: (sessionId, text) => {
      if (deliverThrows) throw new Error("no live session");
      delivered.push({ sessionId, text });
    },
    roomAgents: (roomId) => agents.get(roomId) ?? [],
    now: () => now,
  });

  return {
    db, rooms, bus, chat, payments, delivered, agents,
    tick: () => { now += 5; },
    setAgents: (roomId: string, list: { sessionId: string; status: SessionStatus }[]) =>
      agents.set(roomId, list),
    breakDelivery: (broken: boolean) => { deliverThrows = broken; },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withBus(fn: (ctx: ReturnType<typeof makeBus>) => void): void {
  const ctx = makeBus();
  try { fn(ctx); } finally { ctx.cleanup(); }
}

describe("FactoryBus", () => {
  it("persists a message undelivered and returns it", () => {
    withBus(({ bus, chat, payments }) => {
      const msg = bus.send({
        fromRoomId: chat.id, toRoomId: payments.id, kind: "request",
        body: "Please expose a webhook for message receipts",
      });
      expect(msg).toMatchObject({
        fromRoomId: chat.id, toRoomId: payments.id, kind: "request", taskId: null, deliveredAt: null,
      });
      expect(msg.createdAt).toBe(1_000);
      // durable before anyone is told about it: it is a row, readable back immediately
      expect(bus.list()).toEqual([msg]);
      expect(bus.undeliveredFor(payments.id)).toEqual([msg]);
    });
  });

  it("delivers immediately to an idle agent and stamps deliveredAt", () => {
    withBus(({ bus, chat, payments, delivered, setAgents, tick }) => {
      setAgents(payments.id, [{ sessionId: "pay-1", status: "idle" }]);
      tick();
      const msg = bus.send({
        fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "Please expose a webhook",
      });

      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.sessionId).toBe("pay-1");
      expect(msg.deliveredAt).toBe(1_005);
      expect(bus.list()[0]!.deliveredAt).toBe(1_005);
      expect(bus.undeliveredFor(payments.id)).toEqual([]);
    });
  });

  it("delivers to a starting agent too: no turn is in flight yet", () => {
    withBus(({ bus, chat, payments, delivered, setAgents }) => {
      // A just-resumed agent reports "starting" and may never report "idle" until it runs a turn,
      // so refusing to inject here would strand every message queued across a restart.
      setAgents(payments.id, [{ sessionId: "pay-1", status: "starting" }]);
      bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "info", body: "resumed" });
      expect(delivered).toHaveLength(1);
    });
  });

  it("frames the injected turn as a message from another department", () => {
    withBus(({ bus, chat, payments, delivered, setAgents }) => {
      setAgents(payments.id, [{ sessionId: "pay-1", status: "idle" }]);
      bus.send({
        fromRoomId: chat.id, toRoomId: payments.id, kind: "request",
        body: "Please expose a webhook for message receipts",
      });

      const text = delivered[0]!.text;
      expect(text).toContain("chat");                                  // who is speaking
      expect(text).toContain("Please expose a webhook for message receipts"); // what they said
      expect(text).toContain("request");                               // what kind of message
      expect(text).toMatch(/another department/i);                     // not the operator
      expect(text).toMatch(/factory_send/);                            // how to answer
    });
  });

  it("does not inject mid-turn: a working room's message waits for flushRoom", () => {
    withBus(({ bus, chat, payments, delivered, setAgents, tick }) => {
      setAgents(payments.id, [{ sessionId: "pay-1", status: "working" }]);
      const msg = bus.send({
        fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "Please expose a webhook",
      });

      expect(delivered).toHaveLength(0);
      expect(msg.deliveredAt).toBeNull();
      expect(bus.undeliveredFor(payments.id).map(m => m.id)).toEqual([msg.id]);

      // the turn ends; SessionManager calls flushRoom at the boundary
      setAgents(payments.id, [{ sessionId: "pay-1", status: "idle" }]);
      tick();
      const flushed = bus.flushRoom(payments.id);
      expect(flushed.map(m => m.id)).toEqual([msg.id]);
      expect(delivered).toHaveLength(1);
      expect(bus.list()[0]!.deliveredAt).toBe(1_005);
    });
  });

  it("delivers two queued messages in creation order", () => {
    withBus(({ bus, chat, payments, delivered, setAgents }) => {
      setAgents(payments.id, [{ sessionId: "pay-1", status: "working" }]);
      bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "first ask" });
      bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "second ask" });
      expect(delivered).toHaveLength(0);

      setAgents(payments.id, [{ sessionId: "pay-1", status: "idle" }]);
      bus.flushRoom(payments.id);
      expect(delivered.map(d => d.text.includes("first ask"))).toEqual([true, false]);
      expect(delivered[1]!.text).toContain("second ask");
    });
  });

  it("leaves a message for a room with no agents queued, and does not throw", () => {
    withBus(({ bus, chat, payments, delivered }) => {
      const msg = bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "anyone?" });
      expect(delivered).toHaveLength(0);
      expect(msg.deliveredAt).toBeNull();
      // the operator has to be able to see the pile-up
      expect(bus.list().map(m => m.id)).toEqual([msg.id]);
      expect(bus.flushRoom(payments.id)).toEqual([]);
    });
  });

  it("does not deliver to a paused, errored or finished agent", () => {
    for (const status of ["paused", "error", "done"] as const) {
      withBus(({ bus, chat, payments, delivered, setAgents }) => {
        setAgents(payments.id, [{ sessionId: "pay-1", status }]);
        const msg = bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "info", body: "hello" });
        expect(delivered).toHaveLength(0);
        expect(msg.deliveredAt).toBeNull();
      });
    }
  });

  it("is idempotent: flushRoom twice delivers and injects once", () => {
    withBus(({ bus, chat, payments, delivered, setAgents }) => {
      setAgents(payments.id, [{ sessionId: "pay-1", status: "working" }]);
      const msg = bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "once only" });

      setAgents(payments.id, [{ sessionId: "pay-1", status: "idle" }]);
      expect(bus.flushRoom(payments.id).map(m => m.id)).toEqual([msg.id]);
      expect(bus.flushRoom(payments.id)).toEqual([]);
      expect(delivered).toHaveLength(1);
      expect(bus.list()).toHaveLength(1);
    });
  });

  it("keeps a message queued when the injection fails", () => {
    withBus(({ bus, chat, payments, delivered, setAgents, breakDelivery }) => {
      setAgents(payments.id, [{ sessionId: "pay-1", status: "idle" }]);
      breakDelivery(true);
      // A session that vanished between the status snapshot and the injection must not swallow the
      // message: it stays queued for the next boundary rather than being marked carried.
      const msg = bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "retry me" });
      expect(msg.deliveredAt).toBeNull();
      expect(bus.undeliveredFor(payments.id).map(m => m.id)).toEqual([msg.id]);

      breakDelivery(false);
      expect(bus.flushRoom(payments.id).map(m => m.id)).toEqual([msg.id]);
      expect(delivered).toHaveLength(1);
    });
  });

  it("undeliveredFor returns only that room's queue, oldest first", () => {
    withBus(({ bus, chat, payments, setAgents }) => {
      setAgents(payments.id, [{ sessionId: "pay-1", status: "working" }]);
      setAgents(chat.id, [{ sessionId: "chat-1", status: "working" }]);
      const toPay1 = bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "a" });
      const toChat = bus.send({ fromRoomId: payments.id, toRoomId: chat.id, kind: "info", body: "b" });
      const toPay2 = bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "c" });

      expect(bus.undeliveredFor(payments.id).map(m => m.id)).toEqual([toPay1.id, toPay2.id]);
      expect(bus.undeliveredFor(chat.id).map(m => m.id)).toEqual([toChat.id]);
    });
  });

  it("carries a task id when one is given", () => {
    withBus(({ bus, db, chat, payments }) => {
      db.prepare("INSERT INTO tasks (id, title) VALUES (?, ?)").run("t1", "Expose a webhook");
      const msg = bus.send({
        fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "see the task", taskId: "t1",
      });
      expect(msg.taskId).toBe("t1");
      expect(bus.list()[0]!.taskId).toBe("t1");
    });
  });

  it("refuses an unknown sender or recipient room", () => {
    withBus(({ bus, chat, payments }) => {
      expect(() => bus.send({ fromRoomId: chat.id, toRoomId: "nope", kind: "info", body: "hi" }))
        .toThrow(/unknown room nope/);
      expect(() => bus.send({ fromRoomId: "nope", toRoomId: payments.id, kind: "info", body: "hi" }))
        .toThrow(/unknown room nope/);
      expect(bus.list()).toEqual([]);
    });
  });

  it("rejects an empty or oversized body before it becomes a row", () => {
    withBus(({ bus, chat, payments }) => {
      expect(() => bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "info", body: "" })).toThrow();
      expect(() => bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "info", body: "b".repeat(8001) }))
        .toThrow();
      expect(bus.list()).toEqual([]);
    });
  });

  it("lists newest first and reports a room's recent delivered traffic", () => {
    withBus(({ bus, chat, payments, setAgents, tick }) => {
      setAgents(payments.id, [{ sessionId: "pay-1", status: "idle" }]);
      const first = bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "first" });
      tick();
      const second = bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "second" });

      expect(bus.list().map(m => m.id)).toEqual([second.id, first.id]);
      expect(bus.deliveredFor(payments.id, 10).map(m => m.id)).toEqual([second.id, first.id]);
      expect(bus.deliveredFor(chat.id, 10)).toEqual([]);
    });
  });

  it("notifies a change listener on a send and on a delivery", () => {
    withBus(({ bus, chat, payments, setAgents }) => {
      let changes = 0;
      const off = bus.onChange(() => { changes += 1; });

      setAgents(payments.id, [{ sessionId: "pay-1", status: "working" }]);
      bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "queued" });
      const afterSend = changes;
      expect(afterSend).toBeGreaterThan(0);

      setAgents(payments.id, [{ sessionId: "pay-1", status: "idle" }]);
      bus.flushRoom(payments.id);
      expect(changes).toBeGreaterThan(afterSend);

      // a flush with nothing to do is not a change
      const quiet = changes;
      bus.flushRoom(payments.id);
      expect(changes).toBe(quiet);

      off();
      bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "info", body: "unwatched" });
      expect(changes).toBe(quiet);
    });
  });

  it("survives a restart: an undelivered message is still queued for a new bus over the same db", () => {
    withBus(({ db, rooms, bus, chat, payments }) => {
      // no agents in this bus's view, so the message can only be queued
      const msg = bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "request", body: "durable" });

      const delivered: string[] = [];
      const resumed = new FactoryBus({
        db, rooms,
        deliver: (sessionId) => { delivered.push(sessionId); },
        roomAgents: () => [{ sessionId: "pay-1", status: "idle" }],
      });
      expect(resumed.undeliveredFor(payments.id).map(m => m.id)).toEqual([msg.id]);
      expect(resumed.flushRoom(payments.id).map(m => m.id)).toEqual([msg.id]);
      expect(delivered).toEqual(["pay-1"]);
    });
  });
});
