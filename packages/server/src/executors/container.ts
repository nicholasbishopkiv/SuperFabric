import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  RUNNER_CONFIG_DIR,
  RUNNER_ENV,
  RUNNER_IMAGE_TAG,
  RUNNER_SOCKET_DIR,
  RUNNER_SOCKET_FILE,
  RUNNER_WORKSPACE_DIR,
  RunnerOptions,
  runnerUnixUrl,
} from "@superfabric/shared";
import type { Executor, ExecutorEvents, ExecutorHandle, ExecutorStartOptions } from "../executor.js";
import { inProcessToolPrefixes } from "./claudeCode.js";
import type { RunnerAttachment, RunnerHub } from "../runnerHub.js";

/**
 * The second implementation of the `Executor` seam that has existed since M0 — and the reason it
 * exists at all.
 *
 * `ClaudeCodeExecutor` hosts the SDK's `query()` in the server's own process, as the operator, with
 * the operator's filesystem and the operator's `~/.claude`. This one hosts the *same* `query()`
 * inside a container that holds one room's folder, one account's credentials, capped CPU, memory and
 * processes, and a default-deny egress allow-list — and streams back the same `SessionEvent`s over a
 * socket. From `SessionManager`'s point of view the two are the same object: same interface, same
 * events, same approval flow, same resume. That equivalence is the whole payoff, and
 * `test/containerEquivalence.test.ts` is what keeps it a fact rather than a claim.
 *
 * **What it does not do:** it knows nothing about rooms, accounts, projects or the event log. It is
 * handed a workspace, a config directory and a set of options, exactly as the local executor is.
 * Choosing which executor a room's agents get is `SessionManager`'s job.
 */

// ---- the Docker seam ------------------------------------------------------

/**
 * The slice of dockerode this executor uses, as an interface of our own.
 *
 * Declared here rather than imported so the tests can hand over a fake — the same technique
 * `claudeExecutor.test.ts` uses for the SDK's `query`. A test that needed a real daemon would not
 * run in CI, would not run on a laptop with Docker stopped, and could not exercise the failure paths
 * that matter most (a missing image, a container that never attaches).
 */
export interface DockerContainerLike {
  readonly id: string;
  inspect(): Promise<ContainerInspectLike>;
  start(): Promise<unknown>;
  stop(opts?: { t?: number }): Promise<unknown>;
  remove(opts?: { force?: boolean; v?: boolean }): Promise<unknown>;
  logs(opts: { stdout?: boolean; stderr?: boolean; tail?: number; follow?: false }): Promise<unknown>;
}

export interface ContainerInspectLike {
  Id: string;
  State?: { Running?: boolean; Status?: string; ExitCode?: number };
  Config?: { Env?: string[] | null; Labels?: Record<string, string> | null };
}

export interface ContainerSummaryLike {
  Id: string;
  State?: string;
  Labels?: Record<string, string>;
}

export interface DockerLike {
  createContainer(opts: Record<string, unknown>): Promise<DockerContainerLike>;
  getContainer(id: string): DockerContainerLike;
  listContainers(opts: Record<string, unknown>): Promise<ContainerSummaryLike[]>;
  getImage(name: string): { inspect(): Promise<unknown> };
}

// ---- labels ---------------------------------------------------------------

/** Marks a container as ours, so cleanup can find every one of them and nothing else. */
export const LABEL_RUNNER = "superfabric.runner";
/** The SuperFabric session a container belongs to. What makes re-attaching after a restart possible. */
export const LABEL_SESSION = "superfabric.session";
/** The attachment id the runner inside is using. Diagnostics; the token is read from the env. */
export const LABEL_ATTACHMENT = "superfabric.attachment";
/**
 * A digest of everything that would make us configure a *different* container.
 *
 * The guard on re-attaching: a container running with the autonomy, model, role or account the
 * operator has since changed is not the container this call was asked for, and adopting it would
 * leave the running agent quietly disagreeing with its own row. A mismatch is destroyed and
 * replaced. `resumeSessionId` is deliberately not in the digest — it is null before the first turn
 * and set afterwards, so including it would mean no container was ever re-attachable.
 */
export const LABEL_SPEC = "superfabric.spec";

// ---- defaults -------------------------------------------------------------

/**
 * The caps a contained agent runs under.
 *
 * Numbers chosen to be generous for one Claude Code session and cheap to hit if something runs away:
 * a `bun install` in a workspace, a test suite, a compiler. They are the difference between "an
 * agent wrote a fork bomb" and "an agent wrote a fork bomb and the operator's machine is gone" —
 * which is the whole reason `bypass` in a container is a different proposition from `bypass` on the
 * host.
 */
export const CONTAINER_DEFAULTS = {
  memoryMb: 2048,
  cpus: 2,
  pids: 512,
  /** tmpfs sizes for the two writable spots a read-only rootfs still needs. */
  tmpMb: 512,
  homeMb: 256,
} as const;

/** How long a container gets to start its runner and attach before the start is called a failure. */
const DEFAULT_ATTACH_TIMEOUT_MS = 120_000;
/** How long `docker stop` waits for SIGTERM to be honoured before SIGKILL. */
const DEFAULT_STOP_GRACE_S = 10;

export interface ContainerExecutorOptions {
  docker: DockerLike;
  hub: RunnerHub;
  /** Absolute path of the directory holding the runner socket, on the host. Bind-mounted read-only. */
  socketDir: string;
  /**
   * The URL a container dials. Defaults to the unix-socket form. A TCP URL
   * (`ws://host.docker.internal:<port>/runner`) is the documented fallback, and setting it is also
   * what makes `host.docker.internal` be added to the container's hosts file.
   */
  serverUrl?: string;
  image?: string;
  memoryMb?: number;
  cpus?: number;
  pids?: number;
  attachTimeoutMs?: number;
  stopGraceSeconds?: number;
  /**
   * Process-wide fallback `CLAUDE_CONFIG_DIR`, mirroring `ClaudeCodeExecutorOptions.configDir`. A
   * session's own wins; with neither, the start is **refused** rather than falling back to the
   * ambient `~/.claude` — see `resolveConfigDir`.
   */
  configDir?: string;
  log?: (line: string) => void;
}

export class ContainerExecutor implements Executor {
  readonly name = "claude-code-container";

  constructor(private readonly opts: ContainerExecutorOptions) {}

  /** The image this executor looks for. Exposed so the UI and the docs can name the same string. */
  get image(): string {
    return this.opts.image ?? RUNNER_IMAGE_TAG;
  }

  start(opts: ExecutorStartOptions, ev: ExecutorEvents): ExecutorHandle {
    const log = this.opts.log ?? (() => {});
    ev.onEvent({ type: "session_status", status: "starting", detail: "starting a container" });

    let resolveProviderSession!: (id: string) => void;
    // Never rejected, exactly as the local executor's is: `SessionManager` consumes it with a bare
    // `.then()`, so a rejection would surface as an unhandled rejection. A failed start reports
    // through `session_error` and leaves this pending.
    const providerSessionId = new Promise<string>((resolve) => {
      resolveProviderSession = resolve;
    });

    const attachmentId = randomUUID();
    const token = randomBytes(32).toString("hex");
    /** Set once the run is over, so a late event from a container we have let go of is dropped. */
    let stopped = false;
    /** Filled in as the start progresses, so teardown can clean up whatever exists by then. */
    let container: DockerContainerLike | null = null;
    let attachment: RunnerAttachment | null = null;
    /** Set when we adopted a container that was already running — nothing was created here. */
    let adopted = false;

    const attachment_ = this.opts.hub.register({
      id: attachmentId,
      token,
      events: {
        onEvent: (event) => {
          if (stopped) return;
          ev.onEvent(event);
        },
        onProviderSession: (id) => resolveProviderSession(id),
        requestApproval: (toolName, input) => ev.requestApproval(toolName, input),
        onBye: (reason) => log(`runner ${attachmentId} said goodbye: ${reason}`),
        onAttachChange: (isAttached) => log(`attachment ${attachmentId} ${isAttached ? "up" : "down"}`),
      },
    });
    attachment = attachment_;

    const started = (async () => {
      const runnerOptions = this.runnerOptions(opts);
      const configDir = this.resolveConfigDir(opts);
      const spec = specDigest({
        image: this.image,
        workspace: opts.cwd,
        configDir,
        runner: runnerOptions,
        serverUrl: this.serverUrl(),
      });

      await this.requireImage();

      const existing = opts.sessionKey === undefined
        ? null
        : await this.findExisting(opts.sessionKey, spec);
      if (existing !== null) {
        // The container outlived the server. Everything it has been doing since is in its outbox,
        // and it is already trying to reconnect — this only has to teach the hub the token it is
        // holding, which is stored where the container itself keeps it.
        container = existing.container;
        adopted = true;
        attachment_.release();
        attachment = this.opts.hub.register({
          id: existing.attachmentId,
          token: existing.token,
          events: {
            onEvent: (event) => { if (!stopped) ev.onEvent(event); },
            onProviderSession: (id) => resolveProviderSession(id),
            requestApproval: (toolName, input) => ev.requestApproval(toolName, input),
            onBye: (reason) => log(`runner ${existing.attachmentId} said goodbye: ${reason}`),
          },
        });
        ev.onEvent({
          type: "session_status",
          status: "starting",
          detail: `re-attaching to the container this agent was already running in (${short(existing.container.id)})`,
        });
      } else {
        container = await this.createContainer({
          attachmentId, token, spec, configDir, runnerOptions, opts,
        });
        await container.start();
        log(`container ${short(container.id)} started for attachment ${attachmentId}`);
      }

      await attachment.waitForAttach(this.opts.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS);
      if (!adopted) {
        ev.onEvent({
          type: "session_status",
          status: "starting",
          detail: `contained in ${short(container.id)} (${this.image})`,
        });
      }
    })();

    started.catch(async (err: unknown) => {
      if (stopped) return;
      stopped = true;
      const detail = await this.diagnose(err, container);
      // A failed start is a `session_error`, never a crash: the operator gets a line in the agent's
      // own log saying what went wrong *and what to do about it*, and `SessionManager` moves the
      // session off 'active' so the next boot does not try the same broken thing forever.
      ev.onEvent({ type: "session_error", message: detail });
      ev.onEvent({ type: "session_status", status: "error" });
      attachment?.release();
      // Whatever we created must not survive the failure to use it.
      if (container !== null && !adopted) await this.destroy(container).catch(() => {});
    });

    return {
      providerSessionId,
      send: (text) => {
        if (stopped) return;
        // Deliberately **not** emitting `working` / `user_prompt` here, though the local executor
        // does. The runner emits that pair itself when the prompt reaches it, which is the only way
        // they can land in the stream *in order* with what the agent then does — the socket makes
        // "the moment we asked" and "the moment it heard" two different times. Emitting here too
        // would double every prompt in the log.
        attachment?.prompt(text);
      },
      interrupt: async () => {
        attachment?.interrupt();
      },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await this.shutdown(attachment, container, { destroy: true, adopted }).catch((err: unknown) => {
          log(`stopping attachment ${attachmentId} failed: ${String(err)}`);
        });
      },
      /**
       * The server is going away, the agent is not.
       *
       * This is the whole reason the runner buffers its output and reconnects: an operator
       * restarting SuperFabric must not cost them a working agent. So shutdown lets go of the
       * socket and leaves the container running; the next boot finds it by its label, reads the
       * token out of its own environment, and the runner replays everything the server missed.
       */
      detach: async () => {
        if (stopped) return;
        stopped = true;
        attachment?.release();
        log(`left container ${container === null ? "(none)" : short(container.id)} running`);
      },
    };
  }

  // ---- creating the container ---------------------------------------------

  private async createContainer(args: {
    attachmentId: string;
    token: string;
    spec: string;
    configDir: string;
    runnerOptions: RunnerOptions;
    opts: ExecutorStartOptions;
  }): Promise<DockerContainerLike> {
    const { attachmentId, token, spec, configDir, runnerOptions, opts } = args;
    const memoryMb = this.opts.memoryMb ?? CONTAINER_DEFAULTS.memoryMb;
    const cpus = this.opts.cpus ?? CONTAINER_DEFAULTS.cpus;
    const pids = this.opts.pids ?? CONTAINER_DEFAULTS.pids;
    const tcp = this.opts.serverUrl !== undefined;

    return this.opts.docker.createContainer({
      Image: this.image,
      // A name a human scanning `docker ps` can act on. The attachment id keeps it unique, including
      // across the seconds an outgoing and an incoming container of one session overlap.
      name: `superfabric-${attachmentId.slice(0, 12)}`,
      Labels: {
        [LABEL_RUNNER]: "1",
        [LABEL_ATTACHMENT]: attachmentId,
        [LABEL_SPEC]: spec,
        ...(opts.sessionKey !== undefined ? { [LABEL_SESSION]: opts.sessionKey } : {}),
      },
      Env: [
        `${RUNNER_ENV.sessionId}=${attachmentId}`,
        `${RUNNER_ENV.serverUrl}=${this.serverUrl()}`,
        `${RUNNER_ENV.token}=${token}`,
        `${RUNNER_ENV.options}=${JSON.stringify(runnerOptions)}`,
        // The account, as the CLI understands it. One mount, one variable — and because the runner
        // never sets `Options.env`, the `claude` subprocess inherits it rather than being handed a
        // replacement environment.
        `CLAUDE_CONFIG_DIR=${RUNNER_CONFIG_DIR}`,
      ],
      WorkingDir: RUNNER_WORKSPACE_DIR,
      HostConfig: {
        /**
         * **The whole mount list, and nothing else.** Three entries, each of which had to argue for
         * itself:
         *   - the room's folder, read-write: it is what the agent is *for*.
         *   - that account's `CLAUDE_CONFIG_DIR`, read-write: the CLI rewrites its refresh token in
         *     place, which is the mechanical reason one directory is one account.
         *   - the runner socket's directory, read-only: how the agent talks to the factory.
         * Never the operator's `~/.claude`, never another account's directory, never the project
         * root when the room lives elsewhere, and never the docker socket — a container that could
         * reach the daemon could start a container without any of this.
         */
        Binds: [
          `${opts.cwd}:${RUNNER_WORKSPACE_DIR}:rw`,
          `${configDir}:${RUNNER_CONFIG_DIR}:rw`,
          `${this.opts.socketDir}:${RUNNER_SOCKET_DIR}:ro`,
        ],
        Memory: memoryMb * 1024 * 1024,
        // Docker's own unit: 1e9 nano-CPUs is one core's worth of time.
        NanoCpus: Math.round(cpus * 1e9),
        PidsLimit: pids,
        /**
         * The image is read-only; the two places that still have to be written are a tmpfs each.
         * `/tmp` because everything shells out through it, and `$HOME` because the CLI, git and bun
         * all keep caches there — the image's `/home/bun` holds nothing but shell dotfiles, so
         * replacing it with a tmpfs costs nothing and means a compromised agent cannot leave
         * anything behind for the next container to find.
         */
        ReadonlyRootfs: true,
        Tmpfs: {
          "/tmp": `rw,nosuid,nodev,size=${CONTAINER_DEFAULTS.tmpMb}m`,
          "/home/bun": `rw,nosuid,nodev,size=${CONTAINER_DEFAULTS.homeMb}m,uid=1000,gid=1000,mode=0700`,
        },
        // The firewall — the one thing in the container that runs as root, through a single sudo
        // rule naming one file. Without these two the allow-list cannot be installed and
        // `init-firewall.sh` exits non-zero rather than starting an unprotected agent.
        CapAdd: ["NET_ADMIN", "NET_RAW"],
        // Everything else Docker grants by default and the agent has no use for. CHOWN/SETUID/SETGID
        // stay because sudo needs them.
        CapDrop: ["MKNOD", "AUDIT_WRITE", "NET_BIND_SERVICE", "SYS_CHROOT"],
        // Restart on its own after a machine reboot or a daemon restart, but never after it has
        // exited on purpose: `unless-stopped` is what makes "the container survives" true for more
        // than a server restart.
        RestartPolicy: { Name: "unless-stopped" },
        // Only for the TCP fallback. With the unix socket the container needs no route to the host
        // at all, so it is not given one.
        ...(tcp ? { ExtraHosts: ["host.docker.internal:host-gateway"] } : {}),
      },
    });
  }

  /** The URL the container dials. The unix socket unless an operator asked for TCP. */
  private serverUrl(): string {
    return this.opts.serverUrl ?? runnerUnixUrl(RUNNER_SOCKET_DIR, RUNNER_SOCKET_FILE);
  }

  /**
   * The subset of `ExecutorStartOptions` that survives the boundary.
   *
   * `mcpServers` cannot: an in-process (`type: "sdk"`) server is a live object in *this* process.
   * What crosses instead is the fact the runner actually needs from it — which tool names are ours
   * and must therefore never raise an approval card (ADR 0002). Anything else a role brought is
   * outside-facing and stays gated, exactly as it does on the host path.
   */
  private runnerOptions(opts: ExecutorStartOptions): RunnerOptions {
    return RunnerOptions.parse({
      cwd: RUNNER_WORKSPACE_DIR,
      resumeSessionId: opts.resumeSessionId ?? null,
      ...(opts.autonomy !== undefined ? { autonomy: opts.autonomy } : {}),
      model: opts.model ?? null,
      ...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
      allowedTools: [...(opts.allowedTools ?? [])],
      ungatedToolPrefixes: inProcessToolPrefixes(opts.mcpServers),
    });
  }

  /**
   * The account's directory, or a refusal.
   *
   * **A contained session with no account is refused rather than run.** The fallback everywhere else
   * in the product is the ambient `~/.claude`, and here that would mean bind-mounting the operator's
   * own home directory into a sandbox — the single thing this executor exists to prevent. Running
   * without it instead would produce a container that comes up, fails to authenticate, and reports
   * something about OAuth; the operator would have no way to connect that to the runtime they chose.
   */
  private resolveConfigDir(opts: ExecutorStartOptions): string {
    const dir = opts.configDir ?? this.opts.configDir;
    if (dir === undefined || dir.trim() === "") {
      throw new StartRefused(
        "a container room needs an account of its own. This agent is on the ambient ~/.claude, and "
        + "the operator's own home directory is never mounted into a sandbox — add an account (the "
        + "account switcher, top left), bind it to this room, and start the agent again",
      );
    }
    return dir;
  }

  /** Fail early and by name when the image nobody built is the reason nothing works. */
  private async requireImage(): Promise<void> {
    try {
      await this.opts.docker.getImage(this.image).inspect();
    } catch (err) {
      const s = String(err);
      if (/no such image|not found|404/i.test(s)) {
        throw new StartRefused(
          `the container image ${this.image} is not on this machine. Build it once with `
          + "`pnpm -F @superfabric/agent-runner image` (a few minutes), then start the agent again",
        );
      }
      throw new StartRefused(
        `Docker is not reachable (${s}). Is the daemon running, and is your user in the \`docker\` `
        + "group? A room can be switched back to the host runtime in the room panel meanwhile",
      );
    }
  }

  /**
   * The container this session was already running in, if there is one worth adopting.
   *
   * Docker is the store here, deliberately: the container's own labels say which session it belongs
   * to and its own environment holds the token it is presenting, so there is no second record that
   * can disagree with it — and nothing to clean up when a container is removed by hand. A container
   * that is *not* running, or that was configured for options the operator has since changed, is
   * removed rather than adopted.
   */
  private async findExisting(
    sessionKey: string,
    spec: string,
  ): Promise<{ container: DockerContainerLike; attachmentId: string; token: string } | null> {
    const found = await this.opts.docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${LABEL_RUNNER}=1`, `${LABEL_SESSION}=${sessionKey}`] }),
    });
    let adoptable: { container: DockerContainerLike; attachmentId: string; token: string } | null = null;
    for (const summary of found) {
      const container = this.opts.docker.getContainer(summary.Id);
      const stale = summary.State !== "running" || summary.Labels?.[LABEL_SPEC] !== spec;
      if (stale || adoptable !== null) {
        // Either it cannot serve this start, or we already have one that can. Two containers for
        // one session both resuming the same provider conversation is worse than one.
        await this.destroy(container).catch(() => {});
        continue;
      }
      const info = await container.inspect().catch(() => null);
      const env = envMap(info?.Config?.Env ?? []);
      const attachmentId = env[RUNNER_ENV.sessionId];
      const token = env[RUNNER_ENV.token];
      if (attachmentId === undefined || token === undefined) {
        await this.destroy(container).catch(() => {});
        continue;
      }
      adoptable = { container, attachmentId, token };
    }
    return adoptable;
  }

  /**
   * End a run.
   *
   * The order is the design: ask the runner to close its query *first* so the provider session stays
   * resumable (SIGTERM would do it too, but only after `docker stop`'s grace period, and only if the
   * signal is honoured), then stop the container, then remove it. A container we adopted and are now
   * stopping is still ours to remove — adoption is about who created it, not about who owns it.
   */
  private async shutdown(
    attachment: RunnerAttachment | null,
    container: DockerContainerLike | null,
    opts: { destroy: boolean; adopted: boolean },
  ): Promise<void> {
    attachment?.requestStop();
    // A moment for the runner to close the query cleanly. Bounded: a wedged container must not be
    // able to wedge a pause that exists to save quota.
    if (attachment !== null && container !== null) await delay(400);
    attachment?.release();
    if (container !== null && opts.destroy) await this.destroy(container);
  }

  /** Stop and remove, tolerating a container that is already gone. */
  private async destroy(container: DockerContainerLike): Promise<void> {
    const grace = this.opts.stopGraceSeconds ?? DEFAULT_STOP_GRACE_S;
    await container.stop({ t: grace }).catch(() => { /* already stopped, or never started */ });
    // `v: true` removes the anonymous volumes Docker would otherwise leave behind for every
    // container that ever ran; the bind mounts are the operator's directories and are untouched.
    await container.remove({ force: true, v: true }).catch(() => { /* already gone */ });
  }

  /**
   * Turn a failed start into a sentence the operator can act on.
   *
   * A `session_error` reading "Error: (HTTP code 404)" is a dead end: the operator does not know
   * whether they are missing an image, a daemon, a group membership or a firewall rule. Where the
   * container did start, its own last lines are attached — the firewall script's self-check writes
   * there, and it is the one place that says *which* verification failed.
   */
  private async diagnose(err: unknown, container: DockerContainerLike | null): Promise<string> {
    if (err instanceof StartRefused) return err.message;
    const base = String(err);
    if (container === null) return `the container could not be started: ${base}`;

    const tail = await this.logTail(container);
    const info = await container.inspect().catch(() => null);
    const exited = info?.State?.Running === false;
    const parts = [`the container started but the agent never attached (${base})`];
    if (exited) {
      parts.push(`it has exited with code ${info?.State?.ExitCode ?? "?"}`);
    }
    if (this.opts.serverUrl !== undefined) {
      // The TCP fallback is the only configuration where the host's own firewall is in the path.
      parts.push(
        "this server is using the TCP runner transport, so the container has to reach the host over "
        + "the docker bridge. If this machine runs ufw, that is dropped by default and needs a rule "
        + "such as `sudo ufw allow in on docker0 from 172.17.0.0/16 to any port <runner port> proto "
        + "tcp` — or unset SUPERFABRIC_RUNNER_TCP_PORT and use the unix socket, which needs no rule",
      );
    }
    if (tail !== null) parts.push(`its last output was:\n${tail}`);
    return parts.join(". ");
  }

  private async logTail(container: DockerContainerLike): Promise<string | null> {
    try {
      const raw = await container.logs({ stdout: true, stderr: true, tail: 20, follow: false });
      const text = demultiplex(raw).trim();
      return text === "" ? null : text.split("\n").slice(-12).join("\n");
    } catch {
      return null;
    }
  }
}

/**
 * A start we refused on purpose, with a message already written for the operator.
 *
 * Distinguished from an unexpected failure so `diagnose` passes it through verbatim instead of
 * wrapping it in "the container could not be started" — the sentence is the point.
 */
class StartRefused extends Error {}

/** `["A=1","B=2"]` — Docker's own shape for an environment — as an object. */
function envMap(env: string[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of env ?? []) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/**
 * Docker's log stream is multiplexed when the container has no TTY: each chunk is an 8-byte header
 * (stream id, three zeros, a big-endian length) followed by that many bytes. Undoing it here rather
 * than asking dockerode to demultiplex keeps the seam a plain promise the fake can satisfy.
 */
function demultiplex(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!(raw instanceof Uint8Array)) return "";
  const buf = Buffer.from(raw);
  // A stream that was never multiplexed (a TTY container, or a fake) has no plausible header.
  if (buf.length < 8 || buf[0]! > 2 || buf[1] !== 0 || buf[2] !== 0 || buf[3] !== 0) {
    return buf.toString("utf8");
  }
  const parts: string[] = [];
  let at = 0;
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at + 4);
    parts.push(buf.subarray(at + 8, at + 8 + len).toString("utf8"));
    at += 8 + len;
  }
  return parts.join("");
}

/** Everything that would make us configure a different container, as one short string. */
function specDigest(input: {
  image: string;
  workspace: string;
  configDir: string;
  runner: RunnerOptions;
  serverUrl: string;
}): string {
  const { resumeSessionId: _ignored, ...runner } = input.runner;
  return createHash("sha256")
    .update(JSON.stringify({ ...input, runner }))
    .digest("hex")
    .slice(0, 32);
}

function short(id: string): string {
  return id.slice(0, 12);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
