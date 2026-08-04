import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNNER_IMAGE_TAG, type SessionEvent, type SessionInfo,
} from "@superfabric/shared";
import { AccountManager } from "../src/accountManager.js";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { ContainerExecutor } from "../src/executors/container.js";
import type { Executor, ExecutorEvents, ExecutorHandle, ExecutorStartOptions } from "../src/executor.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";
import { RunnerHub } from "../src/runnerHub.js";
import { SessionManager } from "../src/sessionManager.js";
import { FakeDocker, FakeRunner, runnerCredentials } from "./fixtures/fakeDocker.js";
import { waitFor } from "./_waitFor.js";

/**
 * **The point of the whole seam, as a test.**
 *
 * `SessionManager` must not be able to tell a contained session from a host one. Everything the
 * operator interacts with — the event log, approvals, the bus's turn boundary, the account binding,
 * pausing, resuming — is written once, against the `Executor` interface, and it either works for
 * both implementations or the sandbox is a second product wearing the first one's UI.
 *
 * So this drives one scripted turn through *both* executors and compares the two logs directly. A
 * host executor that scripts the same events is the control; `ContainerExecutor` over a fake daemon
 * and a real `RunnerHub` is the subject. Anything that differs is either a deliberate difference
 * (the two `starting` lines a container emits about itself) or a bug.
 */

/** This server instance's identity: its data directory. See `LABEL_INSTANCE`. */
const INSTANCE = "/data/.fabrica";

/** A local executor that emits exactly what the runner will, so the two logs are comparable. */
class ScriptedHostExecutor implements Executor {
  readonly name = "scripted-host";
  readonly starts: ExecutorStartOptions[] = [];
  private ev: ExecutorEvents | null = null;

  start(opts: ExecutorStartOptions, ev: ExecutorEvents): ExecutorHandle {
    this.starts.push(opts);
    this.ev = ev;
    ev.onEvent({ type: "session_status", status: "starting" });
    return {
      providerSessionId: Promise.resolve("claude-host-1"),
      send: (text) => {
        ev.onEvent({ type: "session_status", status: "working" });
        ev.onEvent({ type: "user_prompt", text });
      },
      interrupt: async () => {},
      stop: async () => {},
    };
  }

  /** Drive the same turn the fake runner will drive on the other side. */
  async turn(): Promise<void> {
    const ev = this.ev!;
    const behavior = await ev.requestApproval("Write", { file_path: "hello.txt" });
    ev.onEvent({ type: "tool_use", toolName: "Write", input: { file_path: "hello.txt" } });
    ev.onEvent({ type: "tool_result", toolName: "Write", isError: behavior === "deny" });
    ev.onEvent({ type: "agent_text", text: "done" });
    ev.onEvent({ type: "turn_complete" });
    ev.onEvent({ type: "session_status", status: "idle" });
  }
}

interface Built {
  db: ReturnType<typeof openDb>;
  store: EventStore;
  mgr: SessionManager;
  rooms: RoomManager;
  roomId: string;
  accountId: string;
  dir: string;
}

function build(opts: {
  runtime: "host" | "container";
  host: Executor;
  container?: Executor;
}): Built {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-equiv-"));
  const db = openDb(":memory:");
  const store = new EventStore(db);
  const projects = new ProjectManager(db, dir);
  const rooms = new RoomManager(db, projects);
  const accounts = new AccountManager(db);
  const account = accounts.create({ label: "Work", configDir: join(dir, "config") });
  const room = rooms.createRoom("payments", { projectId: projects.defaultProject().id });
  rooms.setAccount(room.id, account.id);
  rooms.setRuntime(room.id, opts.runtime);
  const mgr = new SessionManager(db, store, opts.host, rooms, projects, {
    accounts,
    ...(opts.container !== undefined ? { containerExecutor: opts.container } : {}),
  });
  return { db, store, mgr, rooms, roomId: room.id, accountId: account.id, dir };
}

/**
 * Everything the operator's transcript is made of, minus the two things that are never equal.
 *
 * - **ids**: an `approvalId` is a fresh uuid on each side.
 * - **`session_status` lines carrying a `detail`**: that is the factory narrating what it is doing
 *   to an agent ("starting a container", "contained in c1a2b3", "role X skills — …"), as opposed to
 *   reporting the agent's own state. A contained session has two more of them than a host one and
 *   should: they are the honest difference between the runtimes, and hiding them would be worse
 *   than showing them. The *statuses* themselves are compared, because those are what the floor
 *   draws and what the operator reads as "what is this agent doing".
 */
function shape(events: SessionEvent[]): unknown[] {
  return events
    .filter((e) => !(e.type === "session_status" && e.detail !== undefined))
    .map((e) => {
      if (e.type === "approval_request") return { type: e.type, toolName: e.toolName };
      if (e.type === "approval_resolved") return { type: e.type, behavior: e.behavior };
      return e;
    });
}

describe("a contained session and a host session are the same session", () => {
  it("produce the same event log for the same turn, including the approval round trip", async () => {
    // ---- the control: a host room -----------------------------------------
    const host = new ScriptedHostExecutor();
    const a = build({ runtime: "host", host });
    const hostSession = a.mgr.createSession({ roomId: a.roomId });
    a.mgr.prompt(hostSession, "write hello.txt");
    const hostTurn = host.turn();
    await waitFor(() => {
      const req = a.store.listAfter(hostSession, 0).find((r) => r.event.type === "approval_request");
      expect(req).toBeDefined();
      a.mgr.approve(
        hostSession,
        (req!.event as Extract<SessionEvent, { type: "approval_request" }>).approvalId,
        "allow",
      );
    });
    await hostTurn;

    // ---- the subject: a container room ------------------------------------
    const docker = new FakeDocker({ images: [RUNNER_IMAGE_TAG] });
    const hub = new RunnerHub();
    const contained = new ContainerExecutor({
      docker, hub, instanceId: INSTANCE, socketDir: "/data/run", attachTimeoutMs: 3000, stopGraceSeconds: 1,
    });
    const b = build({ runtime: "container", host: new ScriptedHostExecutor(), container: contained });
    const containedSession = b.mgr.createSession({ roomId: b.roomId });

    await waitFor(() => expect(docker.containers.size).toBe(1));
    const { id, token } = runnerCredentials(docker.nth(0));
    const runner = new FakeRunner(hub, id, token);
    runner.connect();
    // The runner emits `starting` itself, exactly as the local executor does.
    runner.emit({ type: "session_status", status: "starting" });
    runner.providerSession("claude-contained-1");

    b.mgr.prompt(containedSession, "write hello.txt");
    await waitFor(() => expect(runner.prompts()).toEqual(["write hello.txt"]));
    // ...and the working/user_prompt pair, in order with what follows — which is why
    // `ContainerExecutor.send` must not emit them too.
    runner.emit({ type: "session_status", status: "working" });
    runner.emit({ type: "user_prompt", text: "write hello.txt" });

    runner.askApproval("req-1", "Write", { file_path: "hello.txt" });
    await waitFor(() => {
      const req = b.store.listAfter(containedSession, 0).find((r) => r.event.type === "approval_request");
      expect(req).toBeDefined();
      b.mgr.approve(
        containedSession,
        (req!.event as Extract<SessionEvent, { type: "approval_request" }>).approvalId,
        "allow",
      );
    });
    await waitFor(() => expect(runner.approvalAnswers()).toHaveLength(1));
    runner.emit({ type: "tool_use", toolName: "Write", input: { file_path: "hello.txt" } });
    runner.emit({ type: "tool_result", toolName: "Write", isError: false });
    runner.emit({ type: "agent_text", text: "done" });
    runner.emit({ type: "turn_complete" });
    runner.emit({ type: "session_status", status: "idle" });

    await waitFor(() => {
      expect(shape(b.store.listAfter(containedSession, 0).map((r) => r.event)))
        .toEqual(shape(a.store.listAfter(hostSession, 0).map((r) => r.event)));
    });

    // The provider session id — what makes a resume a continuation — is recorded either way.
    await waitFor(() => {
      const row = b.mgr.listSessions().find((s: SessionInfo) => s.id === containedSession);
      expect(row!.claudeSessionId).toBe("claude-contained-1");
    });

    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }, 20_000);

  it("passes the room's account to the container, and the session id it needs to be found again", async () => {
    const docker = new FakeDocker({ images: [RUNNER_IMAGE_TAG] });
    const contained = new ContainerExecutor({
      docker, hub: new RunnerHub(), instanceId: INSTANCE, socketDir: "/data/run", attachTimeoutMs: 200,
    });
    const b = build({ runtime: "container", host: new ScriptedHostExecutor(), container: contained });
    const id = b.mgr.createSession({ roomId: b.roomId });
    await waitFor(() => expect(docker.containers.size).toBe(1));
    const binds = (docker.nth(0).create.HostConfig as { Binds: string[] }).Binds;
    // The room's folder, and *that account's* directory — not the operator's `~/.claude`.
    expect(binds[0]).toContain(b.rooms.getRoom(b.roomId)!.path);
    expect(binds[1]).toContain(join(b.dir, "config"));
    expect((docker.nth(0).create.Labels as Record<string, string>)["superfabric.session"]).toBe(id);
    rmSync(b.dir, { recursive: true, force: true });
  });
});

describe("choosing a runtime", () => {
  it("a host room gets the host executor and a container room gets the container one", async () => {
    const host = new ScriptedHostExecutor();
    const docker = new FakeDocker({ images: [RUNNER_IMAGE_TAG] });
    const contained = new ContainerExecutor({
      docker, hub: new RunnerHub(), instanceId: INSTANCE, socketDir: "/data/run", attachTimeoutMs: 200,
    });
    const b = build({ runtime: "host", host, container: contained });
    const onHost = b.mgr.createSession({ roomId: b.roomId });
    expect(host.starts).toHaveLength(1);
    expect(docker.containers.size).toBe(0);
    expect(b.mgr.listSessions().find((s) => s.id === onHost)!.runtime).toBe("host");

    b.rooms.setRuntime(b.roomId, "container");
    const inContainer = b.mgr.createSession({ roomId: b.roomId });
    await waitFor(() => expect(docker.containers.size).toBe(1));
    // The agent that was already running did not move — a live `query()` cannot be put in a box —
    // and the listing says so per agent rather than per room.
    expect(b.mgr.listSessions().find((s) => s.id === onHost)!.runtime).toBe("host");
    expect(b.mgr.listSessions().find((s) => s.id === inContainer)!.runtime).toBe("container");
    rmSync(b.dir, { recursive: true, force: true });
  });

  it("a roomless session is always on the host: there is no workspace to mount", () => {
    const host = new ScriptedHostExecutor();
    const docker = new FakeDocker({ images: [RUNNER_IMAGE_TAG] });
    const contained = new ContainerExecutor({
      docker, hub: new RunnerHub(), instanceId: INSTANCE, socketDir: "/data/run", attachTimeoutMs: 200,
    });
    const b = build({ runtime: "container", host, container: contained });
    b.mgr.createSession({ cwd: b.dir });
    expect(host.starts).toHaveLength(1);
    expect(docker.containers.size).toBe(0);
    rmSync(b.dir, { recursive: true, force: true });
  });

  it("a container room on a server with no container runtime runs on the host and says so", () => {
    const host = new ScriptedHostExecutor();
    const b = build({ runtime: "container", host });
    const id = b.mgr.createSession({ roomId: b.roomId });
    expect(host.starts).toHaveLength(1);
    const details = b.store.listAfter(id, 0)
      .flatMap((r) => (r.event.type === "session_status" && r.event.detail !== undefined ? [r.event.detail] : []));
    expect(details.join(" ")).toContain("no container runtime configured");
    expect(b.mgr.listSessions().find((s) => s.id === id)!.runtime).toBe("host");
    rmSync(b.dir, { recursive: true, force: true });
  });

  it("an agent that is not running has no runtime at all", async () => {
    const host = new ScriptedHostExecutor();
    const b = build({ runtime: "host", host });
    const id = b.mgr.createSession({ roomId: b.roomId });
    expect(b.mgr.listSessions().find((s) => s.id === id)!.runtime).toBe("host");
    await b.mgr.stopAll();
    // Not "host": it is not running anywhere, and a floor that kept showing a runtime for a stopped
    // agent would be describing a process that does not exist.
    expect(b.mgr.listSessions().find((s) => s.id === id)!.runtime).toBeNull();
    rmSync(b.dir, { recursive: true, force: true });
  });
});
