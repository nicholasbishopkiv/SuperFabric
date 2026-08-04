import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "@superfabric/shared";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { FakeExecutor } from "../src/executors/fake.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoleLibrary } from "../src/roleLibrary.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { SkillLibrary } from "../src/skills.js";
import { WsHub, type SocketLike } from "../src/wsHub.js";
import { waitFor } from "./_waitFor.js";

/** Roles over the wire: the listing, the picker's two write paths, and what a server without one says. */

function fakeSocket() {
  const sent: ServerMessage[] = [];
  const sock: SocketLike = { send: (d: string) => sent.push(JSON.parse(d) as ServerMessage) };
  return { sock, sent };
}

const ARCHITECT = `
id: architect
name: Architect
summary: Shape, not code.
model: claude-opus-5
promptAppend: You are the architect.
`;

function makeHub(opts: { withRoles?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sf-hub-roles-"));
  const rolesDir = join(root, "roles");
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(join(rolesDir, "architect.yaml"), ARCHITECT);
  // A file that does not parse, so the listing's `problems` half is exercised rather than assumed.
  writeFileSync(join(rolesDir, "broken.yaml"), "id: broken\nname: [unclosed\n");

  const db = openDb(":memory:");
  const store = new EventStore(db);
  const projects = new ProjectManager(db, root);
  const rooms = new RoomManager(db, projects);
  const roles = new RoleLibrary({ shippedDir: rolesDir });
  const skills = new SkillLibrary({ roots: [] });
  const withRoles = opts.withRoles !== false;
  const mgr = new SessionManager(db, store, new FakeExecutor(), rooms, projects, {
    ...(withRoles ? { roles, skills } : {}),
  });
  const hub = new WsHub(store, mgr, rooms, projects, {
    sessionsDebounceMs: 5,
    ...(withRoles ? { roles } : {}),
  });
  const { sock, sent } = fakeSocket();
  hub.attach(sock);
  mkdirSync(join(root, "design"), { recursive: true });
  const room = rooms.createRoom("design");
  return {
    root, db, rolesDir, roles, rooms, projects, mgr, hub, sock, sent, room,
    send: (msg: unknown) => hub.handleMessage(sock, JSON.stringify(msg)),
    cleanup: () => { rmSync(root, { recursive: true, force: true }); },
  };
}

const errors = (sent: ServerMessage[]): string[] =>
  sent.filter((m): m is Extract<ServerMessage, { kind: "error" }> => m.kind === "error").map((m) => m.message);

/** The newest `sessions` frame this socket received. */
function latestSessions(sent: ServerMessage[]) {
  for (let i = sent.length - 1; i >= 0; i--) {
    const msg = sent[i]!;
    if (msg.kind === "sessions") return msg.sessions;
  }
  return undefined;
}

describe("roles over the wire", () => {
  it("list_roles answers the asking socket with the library and its failures", () => {
    const h = makeHub();
    try {
      h.send({ kind: "list_roles" });
      const msg = h.sent.find((m) => m.kind === "roles");
      expect(msg).toBeDefined();
      if (msg?.kind !== "roles") throw new Error("unreachable");
      expect(msg.roles.map((r) => r.id)).toEqual(["architect"]);
      expect(msg.roles[0]!.summary).toBe("Shape, not code.");
      // The broken file travels with the list rather than being dropped from it.
      expect(msg.problems).toHaveLength(1);
      expect(msg.problems[0]!.file).toBe(join(h.rolesDir, "broken.yaml"));
      expect(errors(h.sent)).toEqual([]);
    } finally { h.cleanup(); }
  });

  it("picks up an edited role file without a restart", () => {
    const h = makeHub();
    try {
      h.send({ kind: "list_roles" });
      writeFileSync(join(h.rolesDir, "architect.yaml"), ARCHITECT.replace("Architect", "Architect II"));
      h.send({ kind: "list_roles" });
      const frames = h.sent.filter((m): m is Extract<ServerMessage, { kind: "roles" }> => m.kind === "roles");
      expect(frames).toHaveLength(2);
      expect(frames[1]!.roles[0]!.name).toBe("Architect II");
    } finally { h.cleanup(); }
  });

  it("create_session carries a role onto the new agent's row", async () => {
    const h = makeHub();
    try {
      h.send({ kind: "create_session", roomId: h.room.id, roleId: "architect" });
      await waitFor(() => {
        const sessions = latestSessions(h.sent);
        if (sessions === undefined || sessions.length === 0) throw new Error("no sessions yet");
        if (sessions[0]!.roleId !== "architect") throw new Error("role not on the row");
      });
      expect(errors(h.sent)).toEqual([]);
    } finally { h.cleanup(); }
  });

  it("create_session with an unknown role is refused, and no agent appears", () => {
    const h = makeHub();
    try {
      h.send({ kind: "create_session", roomId: h.room.id, roleId: "nope" });
      expect(errors(h.sent).join()).toMatch(/unknown role/);
      expect(h.mgr.listSessions()).toEqual([]);
    } finally { h.cleanup(); }
  });

  it("set_role changes a live agent, and null clears it", async () => {
    const h = makeHub();
    try {
      const id = h.mgr.createSession({ roomId: h.room.id });
      h.send({ kind: "set_role", sessionId: id, roleId: "architect" });
      await waitFor(() => {
        if (h.mgr.listSessions()[0]!.roleId !== "architect") throw new Error("not yet");
      });
      h.send({ kind: "set_role", sessionId: id, roleId: null });
      await waitFor(() => {
        if (h.mgr.listSessions()[0]!.roleId !== null) throw new Error("not yet");
      });
      expect(errors(h.sent)).toEqual([]);
    } finally { h.cleanup(); }
  });

  it("set_role on an unknown session is reported to the socket that asked, not thrown at the process", async () => {
    const h = makeHub();
    try {
      h.send({ kind: "set_role", sessionId: "nope", roleId: "architect" });
      await waitFor(() => {
        if (errors(h.sent).length === 0) throw new Error("no error yet");
      });
      expect(errors(h.sent).join()).toMatch(/unknown session/);
    } finally { h.cleanup(); }
  });

  it("a server with no role library says so rather than answering with an empty picker", () => {
    const h = makeHub({ withRoles: false });
    try {
      h.send({ kind: "list_roles" });
      expect(h.sent.some((m) => m.kind === "roles")).toBe(false);
      expect(errors(h.sent).join()).toMatch(/no role library/);
    } finally { h.cleanup(); }
  });
});
