import {
  RUNNER_ENV,
  RUNNER_PROTOCOL_VERSION,
  RunnerServerMessage,
  type RunnerFrameBody,
  type RunnerMessage,
  type SessionEvent,
} from "@superfabric/shared";
import type {
  ContainerInspectLike,
  ContainerSummaryLike,
  DockerContainerLike,
  DockerLike,
} from "../../src/executors/container.js";
import type { RunnerConnection, RunnerConnectionHandlers, RunnerHub } from "../../src/runnerHub.js";

/**
 * A Docker daemon that is a record of what was asked of it.
 *
 * The same trade `claudeExecutor.test.ts` makes with the SDK's `query`: a test against the real
 * thing would need a daemon, an image and two minutes, and it still could not exercise the failure
 * paths that matter most — a missing image, a container that comes up and never attaches, a stale
 * container left by a server that was killed. Those are the cases an operator actually meets.
 */

export interface FakeContainerRecord {
  id: string;
  create: Record<string, unknown>;
  started: boolean;
  stopped: boolean;
  removed: boolean;
  running: boolean;
  exitCode: number;
  logs: string;
}

/** Every call, in order, so a test can assert the *sequence* and not only the outcome. */
export type DockerCall =
  | { call: "getImage"; name: string }
  | { call: "createContainer"; id: string }
  | { call: "listContainers" }
  | { call: "start"; id: string }
  | { call: "stop"; id: string }
  | { call: "remove"; id: string }
  | { call: "inspect"; id: string }
  | { call: "logs"; id: string };

export class FakeDocker implements DockerLike {
  readonly containers = new Map<string, FakeContainerRecord>();
  readonly calls: DockerCall[] = [];
  /** Image names this machine has. Anything else is a 404, like the daemon's own answer. */
  images = new Set<string>();
  /** Set to make every `getImage` fail as an unreachable daemon rather than a missing image. */
  daemonError: string | null = null;
  /** Set to make `createContainer` throw, e.g. a name clash or an out-of-space daemon. */
  createError: string | null = null;
  private next = 0;

  constructor(opts: { images?: string[] } = {}) {
    for (const image of opts.images ?? []) this.images.add(image);
  }

  getImage(name: string): { inspect(): Promise<unknown> } {
    this.calls.push({ call: "getImage", name });
    return {
      inspect: async () => {
        if (this.daemonError !== null) throw new Error(this.daemonError);
        if (!this.images.has(name)) throw new Error(`(HTTP code 404) no such image - No such image: ${name} `);
        return { Id: `sha256:${name}` };
      },
    };
  }

  async createContainer(opts: Record<string, unknown>): Promise<DockerContainerLike> {
    if (this.createError !== null) throw new Error(this.createError);
    const id = `c${++this.next}`.padEnd(16, "0");
    this.containers.set(id, {
      id, create: opts, started: false, stopped: false, removed: false, running: false,
      exitCode: 0, logs: "",
    });
    this.calls.push({ call: "createContainer", id });
    return this.handle(id);
  }

  getContainer(id: string): DockerContainerLike {
    return this.handle(id);
  }

  async listContainers(_opts: Record<string, unknown>): Promise<ContainerSummaryLike[]> {
    this.calls.push({ call: "listContainers" });
    // The fake applies the label filter the executor passes, because "did it filter by session?" is
    // one of the things worth asserting — and a fake that ignored the filter would make a test that
    // adopted the wrong container pass.
    const wanted = labelFilter(_opts);
    return [...this.containers.values()]
      .filter((c) => !c.removed)
      .filter((c) => wanted.every(([k, v]) => labelsOf(c)[k] === v))
      .map((c) => ({
        Id: c.id,
        State: c.running ? "running" : "exited",
        Labels: labelsOf(c),
      }));
  }

  /** The container a test wants to look at, by the order it was created. */
  nth(n: number): FakeContainerRecord {
    const c = [...this.containers.values()][n];
    if (c === undefined) throw new Error(`no container ${n} (there are ${this.containers.size})`);
    return c;
  }

  /** Seed a container that a previous server left running — the re-attach case. */
  seedRunning(record: Partial<FakeContainerRecord> & { id: string; create: Record<string, unknown> }): void {
    this.containers.set(record.id, {
      started: true, stopped: false, removed: false, running: true, exitCode: 0, logs: "",
      ...record,
    });
  }

  private handle(id: string): DockerContainerLike {
    const docker = this;
    return {
      id,
      inspect: async (): Promise<ContainerInspectLike> => {
        docker.calls.push({ call: "inspect", id });
        const c = docker.require(id);
        return {
          Id: id,
          State: { Running: c.running, Status: c.running ? "running" : "exited", ExitCode: c.exitCode },
          Config: { Env: envOf(c), Labels: labelsOf(c) },
        };
      },
      start: async () => {
        docker.calls.push({ call: "start", id });
        const c = docker.require(id);
        c.started = true;
        c.running = true;
      },
      stop: async () => {
        docker.calls.push({ call: "stop", id });
        const c = docker.require(id);
        c.stopped = true;
        c.running = false;
      },
      remove: async () => {
        docker.calls.push({ call: "remove", id });
        docker.require(id).removed = true;
      },
      logs: async () => {
        docker.calls.push({ call: "logs", id });
        return Buffer.from(docker.require(id).logs, "utf8");
      },
    };
  }

  private require(id: string): FakeContainerRecord {
    const c = this.containers.get(id);
    if (c === undefined) throw new Error(`(HTTP code 404) no such container - No such container: ${id}`);
    return c;
  }
}

export function labelsOf(c: FakeContainerRecord): Record<string, string> {
  return (c.create.Labels as Record<string, string> | undefined) ?? {};
}

export function envOf(c: FakeContainerRecord): string[] {
  return (c.create.Env as string[] | undefined) ?? [];
}

export function envValue(c: FakeContainerRecord, name: string): string | undefined {
  const prefix = `${name}=`;
  return envOf(c).find((e) => e.startsWith(prefix))?.slice(prefix.length);
}

export function hostConfig(c: FakeContainerRecord): Record<string, unknown> {
  return (c.create.HostConfig as Record<string, unknown> | undefined) ?? {};
}

function labelFilter(opts: Record<string, unknown>): [string, string][] {
  const raw = opts.filters;
  if (typeof raw !== "string") return [];
  const parsed = JSON.parse(raw) as { label?: string[] };
  return (parsed.label ?? []).map((entry) => {
    const eq = entry.indexOf("=");
    return [entry.slice(0, eq), entry.slice(eq + 1)] as [string, string];
  });
}

// ---------------------------------------------------------------------------
// a runner, in this process
// ---------------------------------------------------------------------------

/**
 * The far side of the socket, without a container.
 *
 * It speaks the real `RunnerMessage`/`RunnerServerMessage` schemas against the real `RunnerHub`, so
 * everything between "the agent emitted an event" and "the row is in the log" is genuinely
 * exercised. What it leaves out is the SDK, Docker and the socket — none of which the protocol
 * cares about. (`packages/agent-runner`'s own tests cover the opposite half: the real
 * `SessionRunner` against a fake socket.)
 */
export class FakeRunner {
  private handlers: RunnerConnectionHandlers | null = null;
  private seq = 0;
  /** Everything the server has said to this runner, parsed. */
  readonly received: RunnerServerMessage[] = [];
  closed = false;

  constructor(
    private readonly hub: RunnerHub,
    private readonly id: string,
    private readonly token: string,
  ) {}

  /** Open a connection and say hello. Returns whether the server accepted it. */
  connect(opts: { protocolVersion?: number; token?: string } = {}): void {
    const conn: RunnerConnection = {
      send: (data) => {
        const msg = RunnerServerMessage.parse(JSON.parse(data));
        this.received.push(msg);
        if (msg.kind === "fatal") this.closed = true;
      },
      close: () => {
        this.closed = true;
        this.handlers = null;
      },
    };
    this.handlers = this.hub.attach(conn);
    this.send({
      kind: "hello",
      protocolVersion: opts.protocolVersion ?? RUNNER_PROTOCOL_VERSION,
      sessionId: this.id,
      token: opts.token ?? this.token,
    });
  }

  /** The socket dropped. The runner keeps its outbox and its pending approvals. */
  disconnect(): void {
    this.handlers?.close();
    this.handlers = null;
  }

  get attached(): boolean {
    return this.received.some((m) => m.kind === "attached");
  }

  get refusal(): string | null {
    const fatal = this.received.find((m) => m.kind === "fatal");
    return fatal === undefined ? null : fatal.message;
  }

  emit(event: SessionEvent): number {
    return this.frame({ type: "event", event });
  }

  providerSession(providerSessionId: string): number {
    return this.frame({ type: "provider_session", providerSessionId });
  }

  /** Re-send a frame the server may already have — what a reconnect does. */
  reframe(seq: number, body: RunnerFrameBody): void {
    this.send({ kind: "frame", seq, body });
  }

  frame(body: RunnerFrameBody): number {
    const seq = ++this.seq;
    this.send({ kind: "frame", seq, body });
    return seq;
  }

  askApproval(requestId: string, toolName: string, input: unknown): void {
    this.send({ kind: "approval_request", requestId, toolName, input });
  }

  bye(reason = "done"): void {
    this.send({ kind: "bye", reason });
  }

  /** Anything at all, including deliberate nonsense — the hub has to survive it. */
  raw(data: string): void {
    this.handlers?.message(data);
  }

  private send(msg: RunnerMessage): void {
    this.handlers?.message(JSON.stringify(msg));
  }

  /** The prompts the server has sent, in order. */
  prompts(): string[] {
    return this.received.flatMap((m) => (m.kind === "prompt" ? [m.text] : []));
  }

  approvalAnswers(): { requestId: string; behavior: string }[] {
    return this.received.flatMap((m) =>
      m.kind === "approval_response" ? [{ requestId: m.requestId, behavior: m.behavior }] : [],
    );
  }
}

/** Read the attachment id and token a container was given, as its runner would. */
export function runnerCredentials(c: FakeContainerRecord): { id: string; token: string } {
  const id = envValue(c, RUNNER_ENV.sessionId);
  const token = envValue(c, RUNNER_ENV.token);
  if (id === undefined || token === undefined) throw new Error("the container carries no runner credentials");
  return { id, token };
}
