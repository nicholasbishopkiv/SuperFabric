import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_CHARTER_FILE, type ServerMessage } from "@superfabric/shared";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { FakeExecutor } from "../src/executors/fake.js";
import { OnboardingManager } from "../src/onboarding.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoleLibrary } from "../src/roleLibrary.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { SkillLibrary } from "../src/skills.js";
import { WsHub, type SocketLike } from "../src/wsHub.js";
import { waitFor } from "./_waitFor.js";

/** Onboarding over the wire: the state, the button, the accept/edit list, and a server without one. */

function fakeSocket() {
  const sent: ServerMessage[] = [];
  const sock: SocketLike = { send: (d: string) => sent.push(JSON.parse(d) as ServerMessage) };
  return { sock, sent };
}

function makeHub(opts: { withOnboarding?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sf-hub-onboarding-"));
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const projects = new ProjectManager(db, root);
  const rooms = new RoomManager(db, projects);
  const roles = new RoleLibrary();
  const withOnboarding = opts.withOnboarding !== false;
  let onboarding!: OnboardingManager;
  const mgr = new SessionManager(db, store, new FakeExecutor(), rooms, projects, {
    roles, skills: new SkillLibrary({ roots: [] }),
    get onboarding() { return onboarding; },
  });
  let hub!: WsHub;
  onboarding = new OnboardingManager({
    db, projects, rooms, sessions: mgr, onChange: () => hub.announceOnboarding(),
  });
  hub = new WsHub(store, mgr, rooms, projects, {
    sessionsDebounceMs: 5, ...(withOnboarding ? { onboarding } : {}),
  });
  const { sock, sent } = fakeSocket();
  hub.attach(sock);
  const project = projects.defaultProject();

  return {
    root, db, projects, rooms, mgr, hub, onboarding, project, sock, sent,
    send: (msg: unknown) => hub.handleMessage(sock, JSON.stringify(msg)),
    cleanup: () => { rmSync(root, { recursive: true, force: true }); },
  };
}

const errors = (sent: ServerMessage[]): string[] =>
  sent.filter((m): m is Extract<ServerMessage, { kind: "error" }> => m.kind === "error").map((m) => m.message);

/** The newest `onboarding` frame this socket received. */
function latest(sent: ServerMessage[]) {
  for (let i = sent.length - 1; i >= 0; i--) {
    const msg = sent[i]!;
    if (msg.kind === "onboarding") return msg.onboarding;
  }
  return undefined;
}

describe("onboarding over the wire", () => {
  it("list_onboarding says the project is un-onboarded, and says so by the file", () => {
    const h = makeHub();
    try {
      h.send({ kind: "list_onboarding" });
      expect(latest(h.sent)).toEqual({
        projectId: h.project.id, onboarded: false, sessionId: null, suggestions: [],
      });

      writeFileSync(join(h.root, PROJECT_CHARTER_FILE), "# written\n");
      h.send({ kind: "list_onboarding" });
      expect(latest(h.sent)!.onboarded).toBe(true);
      expect(errors(h.sent)).toEqual([]);
    } finally { h.cleanup(); }
  });

  it("start_onboarding puts an agent in the project room and subscribes the asking socket to it", async () => {
    const h = makeHub();
    try {
      h.send({ kind: "start_onboarding" });
      await waitFor(() => {
        if (latest(h.sent)?.sessionId == null) throw new Error("no onboarder yet");
      });
      const state = latest(h.sent)!;
      const session = h.mgr.listSessions(h.project.id).find((s) => s.id === state.sessionId)!;
      expect(session.roleId).toBe("onboarding");
      expect(session.roomId).toBe(h.rooms.ensureProjectRoom(h.project.id).id);
      // The operator is told where the interview is happening, and their socket is following it.
      expect(h.sent.some((m) => m.kind === "notice" && /one question at a time/.test(m.message)))
        .toBe(true);
      expect(h.sent.some((m) => m.kind === "event" && m.sessionId === state.sessionId)).toBe(true);
      expect(errors(h.sent)).toEqual([]);
    } finally { h.cleanup(); }
  });

  it("a second start_onboarding hands back the interview already running", async () => {
    const h = makeHub();
    try {
      h.send({ kind: "start_onboarding" });
      await waitFor(() => {
        if (latest(h.sent)?.sessionId == null) throw new Error("no onboarder yet");
      });
      const first = latest(h.sent)!.sessionId;
      h.send({ kind: "start_onboarding" });
      expect(latest(h.sent)!.sessionId).toBe(first);
      expect(h.mgr.listSessions(h.project.id)).toHaveLength(1);
    } finally { h.cleanup(); }
  });

  it("accepting the proposal creates the rooms, and the floor is rebroadcast", async () => {
    const h = makeHub();
    try {
      const [api, docs] = h.onboarding.suggest(h.project.id, null, [
        { name: "api", charter: "The service." },
        { name: "docs", charter: "The manual." },
      ]);
      // Only one of them, and renamed: a proposal is something to correct, and the other is dropped.
      h.send({ kind: "accept_room_suggestions", rooms: [{ id: api!.id, name: "service" }] });
      h.send({ kind: "dismiss_room_suggestion", suggestionId: docs!.id });

      expect(h.rooms.listRooms(h.project.id).map((r) => r.name)).toContain("service");
      expect(existsSync(join(h.root, "docs"))).toBe(false);
      expect(h.sent.some((m) => m.kind === "rooms" && m.rooms.some((r) => r.name === "service")))
        .toBe(true);
      expect(h.sent.some((m) => m.kind === "notice" && /created 1 room/.test(m.message))).toBe(true);

      await waitFor(() => {
        const state = latest(h.sent);
        if (state === undefined) throw new Error("no onboarding frame");
        if (state.suggestions.length !== 2) throw new Error("not both suggestions");
        if (state.suggestions.find((s) => s.id === api!.id)!.status !== "accepted") {
          throw new Error("not accepted yet");
        }
        if (state.suggestions.find((s) => s.id === docs!.id)!.status !== "dismissed") {
          throw new Error("not dismissed yet");
        }
      });
      expect(errors(h.sent)).toEqual([]);
    } finally { h.cleanup(); }
  });

  it("a name createRoom refuses is reported, and the rooms beside it are still created", () => {
    const h = makeHub();
    try {
      h.rooms.createRoom("api");
      const [dup, fresh] = h.onboarding.suggest(h.project.id, null, [
        { name: "api", charter: "Already there." },
        { name: "docs", charter: "The manual." },
      ]);
      h.send({ kind: "accept_room_suggestions", rooms: [{ id: dup!.id }, { id: fresh!.id }] });
      expect(h.rooms.listRooms(h.project.id).map((r) => r.name)).toContain("docs");
      expect(errors(h.sent).join()).toMatch(/created docs; not created — api \(.*already exists/);
    } finally { h.cleanup(); }
  });

  it("refuses a suggestion from a factory this socket is not looking at", () => {
    const h = makeHub();
    try {
      const otherRoot = mkdtempSync(join(tmpdir(), "sf-hub-onboarding-other-"));
      try {
        const other = h.projects.create({ root: otherRoot });
        const [theirs] = h.onboarding.suggest(other.id, null, [{ name: "api", charter: "x" }]);
        h.send({ kind: "accept_room_suggestions", rooms: [{ id: theirs!.id }] });
        expect(errors(h.sent).join()).toMatch(/another project/);
        expect(existsSync(join(h.root, "api"))).toBe(false);
      } finally { rmSync(otherRoot, { recursive: true, force: true }); }
    } finally { h.cleanup(); }
  });

  it("a server that does not onboard says so rather than answering 'already onboarded'", () => {
    const h = makeHub({ withOnboarding: false });
    try {
      h.send({ kind: "list_onboarding" });
      expect(h.sent.some((m) => m.kind === "onboarding")).toBe(false);
      expect(errors(h.sent).join()).toMatch(/does not do onboarding/);
    } finally { h.cleanup(); }
  });
});
