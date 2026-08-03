import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { FACTORY_MCP_SERVER_NAME, busToolDefinitions, busTools } from "../src/busTools.js";
import { z } from "zod";
import { openDb } from "../src/db.js";
import { FactoryBus, type RoomAgent } from "../src/factoryBus.js";
import { RoomManager } from "../src/roomManager.js";
import { TaskStore } from "../src/taskStore.js";

/**
 * A tool set for the "chat" room over a real bus and task store (an in-memory db and two rooms), so
 * a handler's effect is asserted on the actual rows rather than on a mock's call log. The session
 * runner is stubbed: `deliver` records, `roomAgents` is driven by the test.
 */
function makeTools() {
  const root = mkdtempSync(join(tmpdir(), "superfabric-bustools-"));
  const db = openDb(":memory:");
  const rooms = new RoomManager(db, root);
  rooms.ensureProjectRoom();
  const chat = rooms.createRoom("chat");
  const payments = rooms.createRoom("payments");

  const agents = new Map<string, RoomAgent[]>();
  const delivered: { sessionId: string; text: string }[] = [];
  const reported: string[] = [];
  const bus = new FactoryBus({
    db, rooms,
    deliver: (sessionId, text) => { delivered.push({ sessionId, text }); },
    roomAgents: (roomId) => agents.get(roomId) ?? [],
  });
  const tasks = new TaskStore(db);
  // the calling room is "chat": this tool set belongs to a session standing in it
  const deps = { bus, tasks, rooms, roomId: chat.id, reportStatus: (s: string) => { reported.push(s); } };
  const defs = busToolDefinitions(deps);

  const call = (name: string, args: Record<string, unknown>) => {
    const def = defs.find((d) => d.name === name);
    if (def === undefined) throw new Error(`no tool ${name}`);
    return def.handler(args as never, {});
  };

  return {
    db, rooms, bus, tasks, chat, payments, defs, deps, call, delivered, reported, agents,
    setAgents: (roomId: string, list: RoomAgent[]) => agents.set(roomId, list),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withTools(fn: (ctx: ReturnType<typeof makeTools>) => Promise<void> | void): Promise<void> {
  const ctx = makeTools();
  return Promise.resolve(fn(ctx)).finally(() => ctx.cleanup());
}

/** The text a tool handler produced, and whether it reported failure. */
function resultOf(res: Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>): { text: string; isError: boolean } {
  const text = (res.content ?? [])
    .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
    .join("\n");
  return { text, isError: res.isError === true };
}

describe("busTools", () => {
  it("exposes exactly the four factory tools", async () => {
    await withTools(({ defs }) => {
      expect(defs.map((d) => d.name))
        .toEqual(["factory_send", "factory_inbox", "factory_task_update", "factory_report_status"]);
      for (const d of defs) expect(d.description.length).toBeGreaterThan(20);
    });
  });

  it("declares the input schema each tool documents", async () => {
    await withTools(({ defs }) => {
      const schema = (name: string) => Object.keys(defs.find((d) => d.name === name)!.inputSchema);
      expect(schema("factory_send")).toEqual(["to_room", "kind", "body", "task_id"]);
      expect(schema("factory_inbox")).toEqual([]);
      expect(schema("factory_task_update")).toEqual(["task_id", "status", "detail"]);
      expect(schema("factory_report_status")).toEqual(["summary"]);
    });
  });

  it("takes no room from tool input: no tool can name the sender", async () => {
    await withTools(({ defs }) => {
      // The calling room comes from the session that owns the tool set. If any schema grew a
      // from_room/room field, an agent could speak as another department.
      for (const d of defs) {
        for (const field of Object.keys(d.inputSchema)) {
          expect(field).not.toBe("from_room");
          expect(field).not.toBe("from");
          expect(field).not.toBe("room");
          expect(field).not.toBe("room_id");
        }
      }
    });
  });

  it("declares schemas the MCP layer can turn into JSON Schema for the model", async () => {
    await withTools(({ defs }) => {
      // This is the conversion `@modelcontextprotocol/sdk` performs for a zod-4 shape when it lists
      // tools to the CLI (`zod-json-schema-compat` → `zod/v4-mini`'s toJSONSchema). A shape that
      // cannot convert would leave an agent with no bus tools at all, and only at runtime.
      for (const d of defs) {
        const json = z.toJSONSchema(z.object(d.inputSchema), { io: "input" }) as {
          properties?: Record<string, { description?: string }>;
          required?: string[];
        };
        expect(Object.keys(json.properties ?? {})).toEqual(Object.keys(d.inputSchema));
        // every declared field is documented for the model
        for (const field of Object.values(json.properties ?? {})) {
          expect(field.description ?? "").not.toBe("");
        }
      }
      const sendJson = z.toJSONSchema(z.object(defs[0]!.inputSchema), { io: "input" }) as { required?: string[] };
      expect(sendJson.required).toEqual(["to_room", "kind", "body"]); // task_id is optional
    });
  });

  it("builds an in-process MCP server the SDK can take", async () => {
    await withTools(({ deps, defs }) => {
      const server = busTools(deps);
      expect(server.type).toBe("sdk");
      expect(server.name).toBe(FACTORY_MCP_SERVER_NAME);
      expect(server.instance).toBeDefined();
      // the model sees these namespaced by the server name
      expect(defs.map((d) => `mcp__${FACTORY_MCP_SERVER_NAME}__${d.name}`))
        .toContain("mcp__factory__factory_send");
    });
  });

  it("factory_send persists the message from the calling room and delivers it", async () => {
    await withTools(async ({ call, bus, chat, payments, delivered, setAgents }) => {
      setAgents(payments.id, [{ sessionId: "pay-1", status: "idle" }]);
      const res = resultOf(await call("factory_send", {
        to_room: "payments", kind: "request", body: "Please expose a webhook",
      }));

      expect(res.isError).toBe(false);
      const msg = bus.list()[0]!;
      expect(msg).toMatchObject({
        fromRoomId: chat.id, toRoomId: payments.id, kind: "request",
        body: "Please expose a webhook", taskId: null,
      });
      expect(msg.deliveredAt).not.toBeNull();
      expect(res.text).toContain(msg.id);
      expect(delivered).toHaveLength(1);
    });
  });

  it("factory_send reports a queued message as queued rather than delivered", async () => {
    await withTools(async ({ call, payments, setAgents, delivered }) => {
      setAgents(payments.id, [{ sessionId: "pay-1", status: "working" }]);
      const res = resultOf(await call("factory_send", { to_room: "payments", kind: "info", body: "fyi" }));
      expect(res.isError).toBe(false);
      expect(res.text).toMatch(/queued/);
      expect(delivered).toHaveLength(0);
    });
  });

  it("cannot send as another department, whatever the arguments say", async () => {
    await withTools(async ({ call, bus, chat, payments }) => {
      // A model that invents extra fields must not be able to forge a sender.
      await call("factory_send", {
        to_room: "payments", kind: "request", body: "spoofed",
        from_room: "payments", room_id: payments.id, fromRoomId: payments.id,
      });
      expect(bus.list()[0]!.fromRoomId).toBe(chat.id);
    });
  });

  it("returns a tool error, not a throw, for an unknown room name", async () => {
    await withTools(async ({ call, bus }) => {
      const res = resultOf(await call("factory_send", { to_room: "nowhere", kind: "info", body: "hi" }));
      expect(res.isError).toBe(true);
      // the agent can fix its own mistake: the error says what the rooms are
      expect(res.text).toContain("nowhere");
      expect(res.text).toContain("payments");
      expect(bus.list()).toEqual([]);
    });
  });

  it("returns a tool error for a body the protocol rejects", async () => {
    await withTools(async ({ call, bus }) => {
      const res = resultOf(await call("factory_send", { to_room: "payments", kind: "info", body: "" }));
      expect(res.isError).toBe(true);
      expect(bus.list()).toEqual([]);
    });
  });

  it("blocks a task on a request that names it, and releases it on the response", async () => {
    await withTools(async ({ call, tasks, bus, payments, setAgents }) => {
      setAgents(payments.id, [{ sessionId: "pay-1", status: "idle" }]);
      const task = tasks.create({ title: "Send receipts to chat" });

      await call("factory_send", {
        to_room: "payments", kind: "request", body: "webhook please", task_id: task.id,
      });
      const request = bus.list()[0]!;
      expect(tasks.get(task.id)).toMatchObject({ status: "blocked", blockedOnMessageId: request.id });

      await call("factory_send", {
        to_room: "payments", kind: "response", body: "here it is", task_id: task.id,
      });
      expect(tasks.get(task.id)).toMatchObject({ status: "in_progress", blockedOnMessageId: null });
    });
  });

  it("does not resurrect a finished task when a late response names it", async () => {
    await withTools(async ({ call, tasks, payments, setAgents }) => {
      setAgents(payments.id, [{ sessionId: "pay-1", status: "idle" }]);
      const task = tasks.create({ title: "Send receipts to chat" });
      await call("factory_send", { to_room: "payments", kind: "request", body: "ask", task_id: task.id });
      tasks.update(task.id, { status: "done" });

      await call("factory_send", { to_room: "payments", kind: "response", body: "late", task_id: task.id });
      expect(tasks.get(task.id)!.status).toBe("done");
      expect(tasks.get(task.id)!.blockedOnMessageId).toBeNull();
    });
  });

  it("reports a tool error for a send naming an unknown task, and sends nothing", async () => {
    await withTools(async ({ call, payments, setAgents }) => {
      setAgents(payments.id, [{ sessionId: "pay-1", status: "idle" }]);
      const res = resultOf(await call("factory_send", {
        to_room: "payments", kind: "request", body: "about what?", task_id: "ghost",
      }));
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/unknown task ghost/);
    });
  });

  it("factory_inbox lists this room's queue first, then recent delivered traffic", async () => {
    await withTools(async ({ call, bus, chat, payments, setAgents }) => {
      setAgents(chat.id, [{ sessionId: "chat-1", status: "idle" }]);
      const answered = bus.send({ fromRoomId: payments.id, toRoomId: chat.id, kind: "response", body: "already read" });
      setAgents(chat.id, [{ sessionId: "chat-1", status: "working" }]);
      const waiting = bus.send({ fromRoomId: payments.id, toRoomId: chat.id, kind: "request", body: "still waiting" });
      // traffic for the other room must not show up in ours
      bus.send({ fromRoomId: chat.id, toRoomId: payments.id, kind: "info", body: "not mine" });

      const res = resultOf(await call("factory_inbox", {}));
      expect(res.isError).toBe(false);
      expect(res.text).toContain(waiting.id);
      expect(res.text).toContain(answered.id);
      expect(res.text.indexOf(waiting.id)).toBeLessThan(res.text.indexOf(answered.id));
      expect(res.text).toMatch(/Queued for you/);
      expect(res.text).not.toContain("not mine");
      // and it names the sending room, not just an id
      expect(res.text).toContain("payments");
    });
  });

  it("factory_inbox says so when there is no traffic", async () => {
    await withTools(async ({ call }) => {
      expect(resultOf(await call("factory_inbox", {}))).toMatchObject({ isError: false });
      expect(resultOf(await call("factory_inbox", {})).text).toMatch(/No bus traffic/);
    });
  });

  it("factory_inbox's description tells the agent not to poll it", async () => {
    await withTools(({ defs }) => {
      // Delivery is push; an agent that reads this as "check for work" burns tokens every turn.
      const description = defs.find((d) => d.name === "factory_inbox")!.description;
      expect(description).toMatch(/do NOT need to call this/i);
    });
  });

  it("factory_task_update reaches the task store", async () => {
    await withTools(async ({ call, tasks }) => {
      const task = tasks.create({ title: "Expose a webhook" });
      const res = resultOf(await call("factory_task_update", {
        task_id: task.id, status: "review", detail: "waiting on a look",
      }));
      expect(res.isError).toBe(false);
      expect(res.text).toContain("review");
      expect(tasks.get(task.id)).toMatchObject({ status: "review", detail: "waiting on a look" });
    });
  });

  it("factory_task_update returns a tool error for an unknown task or a bad status", async () => {
    await withTools(async ({ call, tasks }) => {
      expect(resultOf(await call("factory_task_update", { task_id: "ghost", status: "done" })).isError).toBe(true);
      const task = tasks.create({ title: "Expose a webhook" });
      expect(resultOf(await call("factory_task_update", { task_id: task.id, status: "shipped" })).isError).toBe(true);
      expect(tasks.get(task.id)!.status).toBe("open");
    });
  });

  it("factory_report_status reaches the session's log", async () => {
    await withTools(async ({ call, reported }) => {
      const res = resultOf(await call("factory_report_status", { summary: "writing the webhook handler" }));
      expect(res.isError).toBe(false);
      expect(reported).toEqual(["writing the webhook handler"]);
    });
  });

  it("factory_report_status returns a tool error for an empty summary", async () => {
    await withTools(async ({ call, reported }) => {
      expect(resultOf(await call("factory_report_status", { summary: "" })).isError).toBe(true);
      expect(reported).toEqual([]);
    });
  });
});
