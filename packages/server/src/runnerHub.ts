import { timingSafeEqual } from "node:crypto";
import {
  RUNNER_PROTOCOL_VERSION,
  RunnerMessage,
  type RunnerServerMessage,
  type SessionEvent,
} from "@superfabric/shared";

/**
 * The server's end of the runner protocol: one place where a container's socket becomes a session's
 * events, and where a socket that has proved nothing is refused.
 *
 * It is the mirror of `packages/agent-runner`'s `SessionRunner`, and it is deliberately its own
 * class rather than a branch inside `WsHub`. The two hubs answer different questions and have
 * different threat models: `WsHub` serves a browser on loopback and is guarded by an `Origin`
 * allow-list, while this serves a *program* that sends no `Origin` at all and is guarded by a
 * per-container secret. Folding them together would have meant one `handleMessage` where a mistake
 * in either half leaks into the other.
 *
 * **Nothing about a session exists here until an executor registers it.** An attachment is created
 * by `ContainerExecutor` before the container is started, so a `hello` naming an id nobody
 * registered is refused outright rather than creating anything — which is what makes "a second
 * container cannot impersonate a session" true even before the token is compared.
 */

/** One live socket, as the transport hands it over. */
export interface RunnerConnection {
  send(data: string): void;
  close(): void;
}

/** What the transport drives when bytes arrive or the socket goes. */
export interface RunnerConnectionHandlers {
  message(raw: string): void;
  close(): void;
}

export interface RunnerAttachmentEvents {
  onEvent(event: SessionEvent): void;
  /** The SDK's own session id, learned from inside the container. What makes the session resumable. */
  onProviderSession(providerSessionId: string): void;
  requestApproval(toolName: string, input: unknown): Promise<"allow" | "deny">;
  /** The runner said goodbye. Not a failure: it is the clean end of a container's life. */
  onBye?(reason: string): void;
  /** The socket came or went. Diagnostics only — the protocol survives both. */
  onAttachChange?(attached: boolean): void;
}

export interface RunnerAttachmentOptions {
  /** The attachment id, which is what the runner puts in `hello.sessionId`. */
  id: string;
  /** The secret this attachment's container was given, and the only thing that proves it is that one. */
  token: string;
  events: RunnerAttachmentEvents;
}

/**
 * A registered attachment, from the executor's side.
 *
 * Every outbound call is safe to make before the container has attached and after it has gone: the
 * messages queue. That is not politeness, it is the reason `SessionManager` cannot tell a contained
 * session from a local one — `ExecutorHandle.send` is synchronous and void on the host path, so it
 * has to be synchronous and void here too, however far away the agent is.
 */
export interface RunnerAttachment {
  readonly id: string;
  readonly attached: boolean;
  /** Queue a user turn. The runner emits the `working`/`user_prompt` pair itself, in order. */
  prompt(text: string): void;
  interrupt(): void;
  /** Ask the runner to close its query cleanly. The provider session stays resumable. */
  requestStop(): void;
  /** Forget this attachment: no further frames are accepted, and a live socket is closed. */
  release(): void;
  /** Resolves the first time a runner attaches, or rejects after `timeoutMs`. */
  waitForAttach(timeoutMs: number): Promise<void>;
}

interface AttachmentState {
  readonly id: string;
  readonly token: string;
  readonly events: RunnerAttachmentEvents;
  conn: RunnerConnection | null;
  /**
   * The highest frame sequence already applied to the event log.
   *
   * The whole de-duplication contract in one number: the runner re-sends everything the server has
   * not acknowledged, on every re-attach, so a frame arriving twice is the *normal* case rather than
   * an error. `seq <= lastApplied` is dropped in silence.
   */
  lastApplied: number;
  /**
   * Approvals already asked about, by the runner's `requestId`.
   *
   * The runner re-sends an unanswered `approval_request` on every attach — which is what makes a
   * card survive a server restart — so this map is what stops the operator being shown the same
   * question twice. The answer is sent from here when the promise settles, and again if a duplicate
   * request arrives after it already has.
   */
  approvals: Map<string, { answered: "allow" | "deny" | null }>;
  /** Messages that arrived while nothing was attached. Sent, in order, the moment one is. */
  outbox: RunnerServerMessage[];
  released: boolean;
  attachWaiters: { resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }[];
}

/**
 * How many un-sent server→runner messages an attachment holds while no container is attached.
 *
 * Almost always zero or one: the only thing that queues in practice is a prompt sent in the seconds
 * between `create_session` and the container coming up. A bound exists for the same reason the
 * runner's own outbox has one — a container that never attaches must not grow the server's memory
 * — and past it the oldest are dropped, because the newest instruction is the one the operator is
 * waiting on.
 */
const MAX_QUEUED_MESSAGES = 100;

export class RunnerHub {
  private readonly attachments = new Map<string, AttachmentState>();
  private readonly log: (line: string) => void;

  constructor(opts: { log?: (line: string) => void } = {}) {
    this.log = opts.log ?? (() => {});
  }

  /** How many attachments are registered. Diagnostics, and the shutdown path's sanity check. */
  get size(): number {
    return this.attachments.size;
  }

  /**
   * Register an attachment *before* the container that will claim it exists.
   *
   * The ordering is the security property: the hub only ever answers `attached` to an id it was
   * told about by an executor in this process, holding the token that executor generated. A
   * container the operator started by hand, or a second container of a *different* session that
   * happens to be running as the same user and can therefore reach the socket, matches neither.
   */
  register(opts: RunnerAttachmentOptions): RunnerAttachment {
    if (this.attachments.has(opts.id)) throw new Error(`attachment ${opts.id} is already registered`);
    const state: AttachmentState = {
      id: opts.id,
      token: opts.token,
      events: opts.events,
      conn: null,
      lastApplied: 0,
      approvals: new Map(),
      outbox: [],
      released: false,
      attachWaiters: [],
    };
    this.attachments.set(opts.id, state);
    return this.handleOf(state);
  }

  private handleOf(state: AttachmentState): RunnerAttachment {
    const hub = this;
    return {
      id: state.id,
      get attached() {
        return state.conn !== null;
      },
      prompt: (text) => hub.toRunner(state, { kind: "prompt", text }),
      interrupt: () => hub.toRunner(state, { kind: "interrupt" }),
      requestStop: () => hub.toRunner(state, { kind: "stop" }),
      release: () => hub.release(state),
      waitForAttach: (timeoutMs) =>
        new Promise<void>((resolve, reject) => {
          if (state.conn !== null) return resolve();
          if (state.released) return reject(new Error("the attachment was released before a runner attached"));
          const timer = setTimeout(() => {
            state.attachWaiters = state.attachWaiters.filter((w) => w.timer !== timer);
            reject(new Error(`no runner attached within ${timeoutMs} ms`));
          }, timeoutMs);
          timer.unref?.();
          state.attachWaiters.push({ resolve, reject, timer });
        }),
    };
  }

  private release(state: AttachmentState): void {
    if (state.released) return;
    state.released = true;
    this.attachments.delete(state.id);
    for (const w of state.attachWaiters) {
      clearTimeout(w.timer);
      w.reject(new Error("the attachment was released"));
    }
    state.attachWaiters = [];
    const conn = state.conn;
    state.conn = null;
    conn?.close();
  }

  /**
   * A socket arrived. Nothing is trusted until `hello` has been parsed, versioned and authenticated
   * — until then this connection belongs to no attachment at all, which is why `bound` starts null.
   */
  attach(conn: RunnerConnection): RunnerConnectionHandlers {
    let bound: AttachmentState | null = null;

    const fatal = (message: string): void => {
      this.log(`refusing a runner: ${message}`);
      try { conn.send(JSON.stringify({ kind: "fatal", message } satisfies RunnerServerMessage)); }
      catch { /* the socket is already gone; there is nobody to tell */ }
      conn.close();
    };

    return {
      message: (raw) => {
        let msg: RunnerMessage;
        try { msg = RunnerMessage.parse(JSON.parse(raw)); }
        catch {
          // Deliberately not `fatal`: an unparseable frame from an *authenticated* runner is a bug
          // in one message, not a reason to abandon a working agent. An unauthenticated peer that
          // cannot speak the protocol is closed on the next line anyway, having learned nothing.
          if (bound === null) return fatal("the first frame was not a valid runner message");
          this.log(`ignoring an unparseable frame from ${bound.id}`);
          return;
        }

        if (msg.kind === "hello") {
          if (bound !== null) return fatal("a second hello on one connection");
          const state = this.authenticate(msg.protocolVersion, msg.sessionId, msg.token);
          if (typeof state === "string") return fatal(state);
          bound = state;
          this.bind(state, conn);
          return;
        }

        // Everything else requires a hello first. A peer that skips it is not a runner of ours.
        if (bound === null) return fatal("the first frame must be a hello");
        this.handleAuthenticated(bound, msg);
      },
      close: () => {
        if (bound === null || bound.conn !== conn) return;
        bound.conn = null;
        bound.events.onAttachChange?.(false);
        this.log(`runner ${bound.id} detached`);
      },
    };
  }

  /**
   * The whole gate, in one function: a version we speak, an id an executor registered, and a token
   * that matches it. Returns the attachment, or the sentence the peer is refused with.
   *
   * The refusal messages are deliberately identical for "no such attachment" and "wrong token": a
   * caller learning *which* of the two it got wrong learns whether an id exists, and there is no
   * reason to tell it. The server's own log records which it was.
   */
  private authenticate(version: number, id: string, token: string): AttachmentState | string {
    if (version !== RUNNER_PROTOCOL_VERSION) {
      return `this server speaks runner protocol ${RUNNER_PROTOCOL_VERSION}, the runner speaks ${version}`
        + " — rebuild the agent-runner image (pnpm -F @superfabric/agent-runner image)";
    }
    const state = this.attachments.get(id);
    if (state === undefined || state.released) {
      this.log(`hello for unknown attachment ${id}`);
      return "this server is not expecting that runner";
    }
    if (!tokensMatch(state.token, token)) {
      this.log(`hello for attachment ${id} carried the wrong token`);
      return "this server is not expecting that runner";
    }
    return state;
  }

  /** Adopt a socket for an attachment, replacing whatever was there. */
  private bind(state: AttachmentState, conn: RunnerConnection): void {
    // A half-open socket the server has not noticed yet would otherwise keep receiving prompts
    // nobody reads. The newest connection is the live one; the old one is closed without ceremony.
    if (state.conn !== null && state.conn !== conn) state.conn.close();
    state.conn = conn;
    this.send(state, { kind: "attached", ackedSeq: state.lastApplied });
    // Anything that piled up while the container was starting, in the order it was asked for.
    const queued = state.outbox;
    state.outbox = [];
    for (const msg of queued) this.send(state, msg);
    for (const w of state.attachWaiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
    state.attachWaiters = [];
    state.events.onAttachChange?.(true);
    this.log(`runner ${state.id} attached (acked ${state.lastApplied})`);
  }

  private handleAuthenticated(state: AttachmentState, msg: RunnerMessage): void {
    switch (msg.kind) {
      case "hello":
        return; // handled by the caller
      case "frame": {
        // At-least-once in, exactly-once applied. A re-sent frame is the normal case after a
        // reconnect, so it is dropped in silence — but still acknowledged, or the runner would keep
        // re-sending something the log already holds.
        if (msg.seq > state.lastApplied) {
          state.lastApplied = msg.seq;
          if (msg.body.type === "event") state.events.onEvent(msg.body.event);
          else state.events.onProviderSession(msg.body.providerSessionId);
        }
        this.send(state, { kind: "ack", seq: state.lastApplied });
        return;
      }
      case "approval_request": {
        const seen = state.approvals.get(msg.requestId);
        if (seen !== undefined) {
          // Asked before. If the operator has already answered, say so again — the runner's copy of
          // the answer may have died with the socket. If not, the card is already on screen.
          if (seen.answered !== null) {
            this.send(state, {
              kind: "approval_response", requestId: msg.requestId, behavior: seen.answered,
            });
          }
          return;
        }
        const entry = { answered: null as "allow" | "deny" | null };
        state.approvals.set(msg.requestId, entry);
        void state.events.requestApproval(msg.toolName, msg.input).then(
          (behavior) => {
            entry.answered = behavior;
            this.send(state, { kind: "approval_response", requestId: msg.requestId, behavior });
          },
          (err: unknown) => {
            // The operator's side failed (a session torn down mid-card). Denying is the safe
            // reading, and the runner must hear *something* or the agent's turn never continues.
            entry.answered = "deny";
            this.log(`approval ${msg.requestId} failed, denying: ${String(err)}`);
            this.send(state, { kind: "approval_response", requestId: msg.requestId, behavior: "deny" });
          },
        );
        return;
      }
      case "bye":
        this.log(`runner ${state.id} said goodbye: ${msg.reason}`);
        state.events.onBye?.(msg.reason);
        return;
    }
  }

  /** Send now, or hold until a runner attaches. */
  private toRunner(state: AttachmentState, msg: RunnerServerMessage): void {
    if (state.released) return;
    if (state.conn === null) {
      if (state.outbox.length >= MAX_QUEUED_MESSAGES) state.outbox.shift();
      state.outbox.push(msg);
      return;
    }
    this.send(state, msg);
  }

  private send(state: AttachmentState, msg: RunnerServerMessage): void {
    const conn = state.conn;
    if (conn === null) return;
    try { conn.send(JSON.stringify(msg)); }
    catch {
      // A socket we cannot write to is gone whatever it thinks. Drop it and let the runner
      // reconnect — it is holding everything we have not acknowledged.
      state.conn = null;
      state.events.onAttachChange?.(false);
    }
  }
}

/**
 * Compare two secrets without leaking their prefix through timing.
 *
 * The tokens are 256-bit random hex and an attacker would need the socket first, so this is belt and
 * braces rather than the thing standing between them and a session — but a plain `===` on a secret
 * is the kind of line that is copied into somewhere it matters. `Buffer.byteLength` differing is
 * checked separately because `timingSafeEqual` throws on unequal lengths.
 */
function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
