import { describe, expect, it } from "bun:test";
import {
  RUNNER_CONFIG_DIR,
  RUNNER_ENV,
  RUNNER_IMAGE_TAG,
  RUNNER_SOCKET_DIR,
  RUNNER_WORKSPACE_DIR,
  RunnerOptions,
  runnerUnixUrl,
  type SessionEvent,
} from "@superfabric/shared";
import type { ExecutorEvents, ExecutorHandle, ExecutorStartOptions } from "../src/executor.js";
import {
  CONTAINER_DEFAULTS,
  ContainerExecutor,
  LABEL_ATTACHMENT,
  LABEL_RUNNER,
  LABEL_SESSION,
  LABEL_SPEC,
} from "../src/executors/container.js";
import { RunnerHub } from "../src/runnerHub.js";
import {
  FakeDocker, FakeRunner, envValue, hostConfig, labelsOf, runnerCredentials,
} from "./fixtures/fakeDocker.js";
import { waitFor } from "./_waitFor.js";

/**
 * `ContainerExecutor` against a fake daemon.
 *
 * Three groups, in the order they matter: what it *asks Docker for* (the mounts and the caps are the
 * isolation, and a test is the only thing that stops one quietly going missing), what it does when
 * that fails, and the fact that a container which outlived the server is re-attached rather than
 * killed.
 */

const SOCKET_DIR = "/data/.fabrica/run";
/** This server instance's identity: its data directory. See `LABEL_INSTANCE`. */
const INSTANCE = "/data/.fabrica";
const WORKSPACE = "/code/shop/payments";
const CONFIG = "/home/me/.claude-work";

interface Harness {
  docker: FakeDocker;
  hub: RunnerHub;
  executor: ContainerExecutor;
  events: SessionEvent[];
  approvals: { toolName: string; input: unknown; resolve: (b: "allow" | "deny") => void }[];
  ev: ExecutorEvents;
}

function harness(opts: { images?: string[]; attachTimeoutMs?: number } = {}): Harness {
  const docker = new FakeDocker({ images: opts.images ?? [RUNNER_IMAGE_TAG] });
  const hub = new RunnerHub();
  const events: SessionEvent[] = [];
  const approvals: Harness["approvals"] = [];
  const executor = new ContainerExecutor({
    docker, hub, instanceId: INSTANCE, socketDir: SOCKET_DIR,
    attachTimeoutMs: opts.attachTimeoutMs ?? 250,
    stopGraceSeconds: 1,
  });
  return {
    docker, hub, executor, events, approvals,
    ev: {
      onEvent: (e) => events.push(e),
      requestApproval: (toolName, input) =>
        new Promise((resolve) => approvals.push({ toolName, input, resolve })),
    },
  };
}

function startOptions(over: Partial<ExecutorStartOptions> = {}): ExecutorStartOptions {
  return { cwd: WORKSPACE, configDir: CONFIG, sessionKey: "sess-1", ...over };
}

/** Start, then bring the container's runner up as the real one would. */
async function startAndAttach(h: Harness, over: Partial<ExecutorStartOptions> = {}) {
  const before = h.docker.containers.size;
  const handle = h.executor.start(startOptions(over), h.ev);
  await waitFor(() => expect(h.docker.containers.size).toBe(before + 1));
  const container = h.docker.nth(before);
  const { id, token } = runnerCredentials(container);
  const runner = new FakeRunner(h.hub, id, token);
  runner.connect();
  return { handle, container, runner };
}

describe("ContainerExecutor: what it asks Docker for", () => {
  it("creates, starts, then waits for the runner — in that order", async () => {
    const h = harness();
    const { handle } = await startAndAttach(h);
    const kinds = h.docker.calls.map((c) => c.call);
    expect(kinds).toEqual(["getImage", "listContainers", "createContainer", "start"]);
    await handle.stop();
  });

  it("mounts the workspace, the account's config dir and the socket — and nothing else", async () => {
    const h = harness();
    const { handle, container } = await startAndAttach(h);
    expect(hostConfig(container).Binds).toEqual([
      `${WORKSPACE}:${RUNNER_WORKSPACE_DIR}:rw`,
      `${CONFIG}:${RUNNER_CONFIG_DIR}:rw`,
      // Read-only: connecting to a unix socket needs write permission on the socket, never on the
      // directory holding it, so a contained agent cannot unlink or shadow the factory's socket.
      `${SOCKET_DIR}:${RUNNER_SOCKET_DIR}:ro`,
    ]);
    // The three things that must never be there, stated as a test rather than as a comment.
    const binds = (hostConfig(container).Binds as string[]).join(" ");
    expect(binds).not.toContain("/var/run/docker.sock");
    expect(binds).not.toMatch(/:\/root|\.claude:/);
    expect(binds.split(" ")).toHaveLength(3);
    await handle.stop();
  });

  it("caps memory, cpu and processes, and gives the container a read-only rootfs", async () => {
    const h = harness();
    const { handle, container } = await startAndAttach(h);
    const hc = hostConfig(container);
    expect(hc.Memory).toBe(CONTAINER_DEFAULTS.memoryMb * 1024 * 1024);
    expect(hc.NanoCpus).toBe(CONTAINER_DEFAULTS.cpus * 1e9);
    expect(hc.PidsLimit).toBe(CONTAINER_DEFAULTS.pids);
    expect(hc.ReadonlyRootfs).toBe(true);
    // The two writable spots a read-only rootfs still needs: /tmp, and $HOME for the CLI's, git's
    // and bun's caches. Both tmpfs, so nothing survives the container.
    expect(Object.keys(hc.Tmpfs as Record<string, string>).sort()).toEqual(["/home/bun", "/tmp"]);
    // The firewall is the one thing inside that needs root, and it cannot install an allow-list
    // without these two.
    expect(hc.CapAdd).toEqual(["NET_ADMIN", "NET_RAW"]);
    await handle.stop();
  });

  it("honours the operator's own limits", async () => {
    const docker = new FakeDocker({ images: [RUNNER_IMAGE_TAG] });
    const hub = new RunnerHub();
    const executor = new ContainerExecutor({
      docker, hub, instanceId: INSTANCE, socketDir: SOCKET_DIR, memoryMb: 512, cpus: 0.5, pids: 64, attachTimeoutMs: 50,
    });
    executor.start(startOptions(), { onEvent: () => {}, requestApproval: async () => "deny" });
    await waitFor(() => expect(docker.containers.size).toBe(1));
    const hc = hostConfig(docker.nth(0));
    expect(hc.Memory).toBe(512 * 1024 * 1024);
    expect(hc.NanoCpus).toBe(5e8);
    expect(hc.PidsLimit).toBe(64);
  });

  it("hands the runner a unix URL and no route to the host at all", async () => {
    const h = harness();
    const { handle, container } = await startAndAttach(h);
    expect(envValue(container, RUNNER_ENV.serverUrl)).toBe(runnerUnixUrl());
    // No `host.docker.internal`, because with a socket there is nothing to reach over the bridge —
    // which is also what lets the container's egress allow-list stay strict.
    expect(hostConfig(container).ExtraHosts).toBeUndefined();
    await handle.stop();
  });

  it("uses the TCP fallback when an operator asked for one, and only then adds the host alias", async () => {
    const docker = new FakeDocker({ images: [RUNNER_IMAGE_TAG] });
    const executor = new ContainerExecutor({
      docker, hub: new RunnerHub(), instanceId: INSTANCE, socketDir: SOCKET_DIR, attachTimeoutMs: 50,
      serverUrl: "ws://host.docker.internal:4620/runner",
    });
    executor.start(startOptions(), { onEvent: () => {}, requestApproval: async () => "deny" });
    await waitFor(() => expect(docker.containers.size).toBe(1));
    const container = docker.nth(0);
    expect(envValue(container, RUNNER_ENV.serverUrl)).toBe("ws://host.docker.internal:4620/runner");
    expect(hostConfig(container).ExtraHosts).toEqual(["host.docker.internal:host-gateway"]);
  });

  it("passes the session's options through, with the agent's cwd rewritten to the mount", async () => {
    const h = harness();
    const { handle, container } = await startAndAttach(h, {
      autonomy: "bypass",
      model: "claude-opus-5",
      resumeSessionId: "claude-abc",
      appendSystemPrompt: "You are an architect.",
      allowedTools: ["mcp__docs__search"],
      mcpServers: {
        factory: { type: "sdk", name: "factory", instance: {} as never },
        docs: { type: "stdio", command: "docs-server" },
      },
    });
    const options = RunnerOptions.parse(JSON.parse(envValue(container, RUNNER_ENV.options)!));
    expect(options).toEqual({
      cwd: RUNNER_WORKSPACE_DIR,
      resumeSessionId: "claude-abc",
      autonomy: "bypass",
      model: "claude-opus-5",
      appendSystemPrompt: "You are an architect.",
      allowedTools: ["mcp__docs__search"],
      // Only the in-process server is ours and therefore ungated (ADR 0002). The stdio one a role
      // brought is a third party reaching outside and stays gated, exactly as on the host path.
      ungatedToolPrefixes: ["mcp__factory__"],
    });
    // The account, as the CLI understands it: one mount, one variable.
    expect(envValue(container, "CLAUDE_CONFIG_DIR")).toBe(RUNNER_CONFIG_DIR);
    await handle.stop();
  });

  it("labels the container so a later boot can find it", async () => {
    const h = harness();
    const { handle, container } = await startAndAttach(h);
    const labels = labelsOf(container);
    expect(labels[LABEL_RUNNER]).toBe("1");
    expect(labels[LABEL_SESSION]).toBe("sess-1");
    expect(labels[LABEL_ATTACHMENT]).toBe(runnerCredentials(container).id);
    expect(labels[LABEL_SPEC]).toMatch(/^[0-9a-f]{32}$/);
    await handle.stop();
  });

  it("gives every attachment its own token", async () => {
    const h = harness();
    const a = await startAndAttach(h);
    const b = await startAndAttach(h, { sessionKey: "sess-2" });
    const ta = runnerCredentials(a.container);
    const tb = runnerCredentials(b.container);
    expect(ta.token).not.toBe(tb.token);
    expect(ta.id).not.toBe(tb.id);
    expect(ta.token).toHaveLength(64);
    // And one container's token is no good for the other's attachment.
    const impostor = new FakeRunner(h.hub, tb.id, ta.token);
    impostor.connect();
    expect(impostor.attached).toBe(false);
    await a.handle.stop();
    await b.handle.stop();
  });
});

describe("ContainerExecutor: when it cannot start", () => {
  it("reports a missing image as a session_error saying how to build it", async () => {
    const h = harness({ images: [] });
    h.executor.start(startOptions(), h.ev);
    await waitFor(() => {
      const err = h.events.find((e) => e.type === "session_error");
      expect(err).toBeDefined();
      expect(err!.type === "session_error" && err!.message).toContain(RUNNER_IMAGE_TAG);
      expect(err!.type === "session_error" && err!.message).toContain("pnpm -F @superfabric/agent-runner image");
    });
    expect(h.events.at(-1)).toEqual({ type: "session_status", status: "error" });
    // Nothing was created, so there is nothing to clean up.
    expect(h.docker.containers.size).toBe(0);
  });

  it("reports an unreachable daemon as something the operator can act on", async () => {
    const h = harness();
    h.docker.daemonError = "connect ENOENT /var/run/docker.sock";
    h.executor.start(startOptions(), h.ev);
    await waitFor(() => {
      const err = h.events.find((e) => e.type === "session_error");
      expect(err!.type === "session_error" && err!.message).toContain("`docker` group");
    });
  });

  it("refuses a contained session with no account rather than mounting the operator's home", async () => {
    const h = harness();
    h.executor.start({ cwd: WORKSPACE, sessionKey: "sess-1" }, h.ev);
    await waitFor(() => {
      const err = h.events.find((e) => e.type === "session_error");
      expect(err!.type === "session_error" && err!.message).toContain("a container room needs an account");
    });
    expect(h.docker.containers.size).toBe(0);
  });

  it("a container that never attaches is an error carrying its own last output, and is removed", async () => {
    const h = harness();
    h.executor.start(startOptions(), h.ev);
    await waitFor(() => expect(h.docker.containers.size).toBe(1));
    const container = h.docker.nth(0);
    container.logs = "[init-firewall] verification failed: api.anthropic.com is not reachable\n";
    container.running = false;
    container.exitCode = 1;

    await waitFor(() => {
      const err = h.events.find((e) => e.type === "session_error");
      expect(err).toBeDefined();
      const message = err!.type === "session_error" ? err!.message : "";
      expect(message).toContain("never attached");
      expect(message).toContain("exited with code 1");
      expect(message).toContain("init-firewall");
    }, 4000);
    // Nothing half-started is left behind.
    await waitFor(() => expect(h.docker.nth(0).removed).toBe(true));
  });

  it("mentions the ufw rule only when the TCP transport is the one in use", async () => {
    const docker = new FakeDocker({ images: [RUNNER_IMAGE_TAG] });
    const events: SessionEvent[] = [];
    new ContainerExecutor({
      docker, hub: new RunnerHub(), instanceId: INSTANCE, socketDir: SOCKET_DIR, attachTimeoutMs: 60,
      serverUrl: "ws://host.docker.internal:4620/runner",
    }).start(startOptions(), { onEvent: (e) => events.push(e), requestApproval: async () => "deny" });
    await waitFor(() => {
      const err = events.find((e) => e.type === "session_error");
      expect(err!.type === "session_error" && err!.message).toContain("ufw allow in on docker0");
    }, 4000);
  });

  it("a failed start is never a throw — the handle is returned and is inert", async () => {
    const h = harness({ images: [] });
    let handle: ExecutorHandle | null = null;
    expect(() => { handle = h.executor.start(startOptions(), h.ev); }).not.toThrow();
    await waitFor(() => expect(h.events.some((e) => e.type === "session_error")).toBe(true));
    expect(() => handle!.send("anyone there?")).not.toThrow();
    await expect(handle!.stop()).resolves.toBeUndefined();
  });
});

describe("ContainerExecutor: a container that outlived the server", () => {
  it("re-attaches to it rather than starting a second one", async () => {
    const h = harness({ attachTimeoutMs: 2000 });
    // A first run, whose container the operator's restart left running.
    const first = await startAndAttach(h);
    first.runner.providerSession("claude-abc");
    await first.handle.detach!();
    expect(first.container.removed).toBe(false);
    expect(first.container.running).toBe(true);

    // The next boot, resuming the same session.
    const events: SessionEvent[] = [];
    const handle = h.executor.start(
      startOptions({ resumeSessionId: "claude-abc" }),
      { onEvent: (e) => events.push(e), requestApproval: async () => "deny" },
    );
    // Nothing new was created; the runner inside simply reconnects with the token it already holds.
    const { id, token } = runnerCredentials(first.container);
    // The re-attachment is registered before the executor says so, so waiting for the line is how a
    // test knows the hub is ready — exactly as the real runner's reconnect backoff does.
    await waitFor(() => {
      expect(events.some((e) => e.type === "session_status" && e.detail?.includes("re-attaching"))).toBe(true);
    });
    const back = new FakeRunner(h.hub, id, token);
    back.connect();
    expect(back.attached).toBe(true);
    expect(h.docker.containers.size).toBe(1);

    // And it is the same conversation. The re-attaching runner does **not** re-send its
    // `provider_session` frame — the previous server incarnation acknowledged it, so the runner
    // dropped it — so this resolving at all is the point: it comes from what we are resuming.
    expect(await handle.providerSessionId).toBe("claude-abc");
    await handle.stop();
  });

  it("replaces a container configured for options the operator has since changed", async () => {
    const h = harness();
    const first = await startAndAttach(h, { autonomy: "attended" });
    await first.handle.detach!();

    // Same session, different autonomy: the running container is the wrong container.
    h.executor.start(startOptions({ autonomy: "bypass" }), h.ev);
    await waitFor(() => expect(h.docker.containers.size).toBe(2));
    expect(first.container.removed).toBe(true);
    const replacement = h.docker.nth(1);
    const options = RunnerOptions.parse(JSON.parse(envValue(replacement, RUNNER_ENV.options)!));
    expect(options.autonomy).toBe("bypass");
  });

  it("removes a container of this session that has stopped", async () => {
    const h = harness();
    const first = await startAndAttach(h);
    await first.handle.detach!();
    first.container.running = false; // the machine rebooted, say

    h.executor.start(startOptions(), h.ev);
    await waitFor(() => expect(first.container.removed).toBe(true));
    await waitFor(() => expect(h.docker.containers.size).toBe(2));
  });

  it("never adopts another session's container", async () => {
    const h = harness();
    const other = await startAndAttach(h, { sessionKey: "sess-other" });
    await other.handle.detach!();

    h.executor.start(startOptions({ sessionKey: "sess-mine" }), h.ev);
    await waitFor(() => expect(h.docker.containers.size).toBe(2));
    // The other session's container is untouched — not adopted and not destroyed.
    expect(other.container.removed).toBe(false);
    expect(other.container.running).toBe(true);
  });
});

describe("ContainerExecutor: cleaning up after a boot", () => {
  it("removes containers no live session claims, and leaves the ones that are claimed", async () => {
    const h = harness();
    const mine = await startAndAttach(h, { sessionKey: "sess-live" });
    await mine.handle.detach!();
    const orphan = await startAndAttach(h, { sessionKey: "sess-gone" });
    await orphan.handle.detach!();

    const removed = await h.executor.reapOrphans(new Set(["sess-live"]));
    expect(removed).toEqual([orphan.container.id]);
    expect(orphan.container.removed).toBe(true);
    // `RestartPolicy: unless-stopped` is what makes a container survive a machine reboot; without
    // this reaper it is also what would make an abandoned one come back forever.
    expect(mine.container.removed).toBe(false);
  });

  it("never touches another server instance's containers", async () => {
    // The bug this exists for cost a working agent during the M4 acceptance run: `reapOrphans` was
    // machine-wide, and a second server — `wsOrigin.test.ts` spawns one with an empty data dir —
    // booted, found no sessions of its own, and destroyed the first server's container.
    const theirs = harness();
    const victim = await startAndAttach(theirs, { sessionKey: "their-session" });
    await victim.handle.detach!();

    const other = new ContainerExecutor({
      docker: theirs.docker, hub: new RunnerHub(), instanceId: "/somewhere/else/.fabrica",
      socketDir: SOCKET_DIR, attachTimeoutMs: 50,
    });
    // A brand-new factory with no sessions at all: the most dangerous possible caller.
    expect(await other.reapOrphans(new Set())).toEqual([]);
    expect(victim.container.removed).toBe(false);
    expect(victim.container.running).toBe(true);

    // And it will not adopt one either, even for a session id that matches.
    const events: SessionEvent[] = [];
    other.start(startOptions({ sessionKey: "their-session" }),
      { onEvent: (e) => events.push(e), requestApproval: async () => "deny" });
    await waitFor(() => expect(theirs.docker.containers.size).toBe(2));
    expect(victim.container.removed).toBe(false);
  });

  it("a daemon it cannot reach is not a reason to fail a boot", async () => {
    const h = harness();
    h.docker.listContainers = async () => { throw new Error("connect ENOENT /var/run/docker.sock"); };
    await expect(h.executor.reapOrphans(new Set())).resolves.toEqual([]);
  });
});

describe("ContainerExecutor: running and stopping", () => {
  it("does not emit the working/user_prompt pair — the runner does, in order", async () => {
    const h = harness();
    const { handle, runner } = await startAndAttach(h);
    handle.send("write hello.txt");
    expect(runner.prompts()).toEqual(["write hello.txt"]);
    // If this executor emitted them too, every prompt would be in the log twice.
    expect(h.events.filter((e) => e.type === "user_prompt")).toEqual([]);
    expect(h.events.filter((e) => e.type === "session_status" && e.status === "working")).toEqual([]);
    await handle.stop();
  });

  it("carries an approval to the operator and the answer back", async () => {
    const h = harness();
    const { handle, runner } = await startAndAttach(h);
    runner.askApproval("req-1", "Bash", { command: "ls" });
    await waitFor(() => expect(h.approvals).toHaveLength(1));
    expect(h.approvals[0]!.toolName).toBe("Bash");
    h.approvals[0]!.resolve("allow");
    await waitFor(() => {
      expect(runner.approvalAnswers()).toEqual([{ requestId: "req-1", behavior: "allow" }]);
    });
    await handle.stop();
  });

  it("stop() asks the runner to close its query, then removes the container", async () => {
    const h = harness();
    const { handle, container, runner } = await startAndAttach(h);
    await handle.stop();
    // The stop request reaches the runner *before* the container is torn down — that ordering is
    // what leaves the provider session resumable rather than killed mid-write.
    expect(runner.received.some((m) => m.kind === "stop")).toBe(true);
    expect(container.stopped).toBe(true);
    expect(container.removed).toBe(true);
  });

  it("detach() leaves the container running, which is what a server restart must cost", async () => {
    const h = harness();
    const { handle, container, runner } = await startAndAttach(h);
    await handle.detach!();
    expect(container.running).toBe(true);
    expect(container.removed).toBe(false);
    expect(runner.received.some((m) => m.kind === "stop")).toBe(false);
  });

  it("drops events from a run it has already let go of", async () => {
    const h = harness();
    const { handle, runner } = await startAndAttach(h);
    const before = h.events.length;
    await handle.stop();
    runner.emit({ type: "agent_text", text: "too late" });
    expect(h.events.slice(before).some((e) => e.type === "agent_text")).toBe(false);
  });
});
