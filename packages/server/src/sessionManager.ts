import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { Db } from "./db.js";
import type { EventStore } from "./eventStore.js";
import type { Executor, ExecutorHandle } from "./executor.js";
import { AutonomyMode, DEFAULT_AUTONOMY, type SessionInfo } from "@superfabric/shared";

/** A tool call waiting on an operator decision, bound to the session that asked. */
interface PendingApproval {
  sessionId: string;
  resolve: (behavior: "allow" | "deny") => void;
}

export class SessionManager {
  private handles = new Map<string, ExecutorHandle>();
  /**
   * approvalId -> pending decision. The session id is recorded server-side on purpose: a client
   * must not be able to steer where an `approval_resolved` row lands by sending someone else's
   * (or a bogus) session id alongside a valid approvalId.
   */
  private approvals = new Map<string, PendingApproval>();
  /** Set by stopAll(): no new executor may be started once shutdown has begun. */
  private stopping = false;
  private readonly stmts;

  constructor(private db: Db, private store: EventStore, private executor: Executor) {
    this.stmts = {
      insertSession: db.prepare("INSERT INTO sessions (id, cwd, autonomy) VALUES (?, ?, ?)"),
      setProviderSessionId: db.prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?"),
      activeSessions: db.prepare("SELECT id, cwd, claude_session_id, autonomy FROM sessions WHERE state = 'active'"),
      markError: db.prepare("UPDATE sessions SET state = 'error' WHERE id = ? AND state = 'active'"),
      session: db.prepare("SELECT id, cwd, claude_session_id, autonomy FROM sessions WHERE id = ?"),
      setAutonomy: db.prepare("UPDATE sessions SET autonomy = ? WHERE id = ?"),
      // One statement, one pass: a per-row MAX(seq) query inside a .map() is O(sessions) queries.
      listSessions: db.prepare(`
        SELECT s.id AS id, s.state AS state, s.claude_session_id AS claude_session_id,
               s.autonomy AS autonomy, COALESCE(MAX(e.seq), 0) AS last_seq
        FROM sessions s LEFT JOIN events e ON e.session_id = s.id
        GROUP BY s.id ORDER BY s.created_at
      `),
    };
  }

  createSession(cwd: string, autonomy: AutonomyMode = DEFAULT_AUTONOMY): string {
    // `cwd` comes straight off the wire. An unchecked value is persisted forever and makes the
    // executor fail obscurely on this boot and every boot after it, so validate it here.
    let isDir = false;
    try { isDir = statSync(cwd).isDirectory(); }
    catch { throw new Error(`cwd does not exist: ${cwd}`); }
    if (!isDir) throw new Error(`cwd is not a directory: ${cwd}`);

    const id = randomUUID();
    this.stmts.insertSession.run(id, cwd, autonomy);
    this.startExecutor(id, cwd, null, autonomy);
    return id;
  }

  /**
   * Switch an agent's autonomy. The SDK's permission mode is fixed for the lifetime of a `query()`,
   * so a live session is restarted — resuming from the stored `claude_session_id`, which keeps the
   * conversation — instead of being mutated in place. (`Query.setPermissionMode()` exists and would
   * avoid the restart, but "bypassPermissions" additionally requires the
   * `allowDangerouslySkipPermissions` spawn flag, so a mid-flight switch into bypass is not
   * guaranteed to be honoured by the CLI; a restart makes the stored mode and the mode actually in
   * force identical in every direction.) The new mode is persisted first: even if the restart
   * fails, the next boot starts the agent in the mode the operator asked for.
   */
  async setAutonomy(id: string, autonomy: AutonomyMode): Promise<void> {
    const row = this.stmts.session.get(id) as SessionRow | undefined;
    if (row === undefined) throw new Error(`unknown session ${id}`);
    this.stmts.setAutonomy.run(autonomy, id);

    const handle = this.handles.get(id);
    if (handle === undefined) {
      // Nothing live to restart (stopped, errored, or not resumed yet); the stored mode applies
      // the next time this session starts.
      this.store.append(id, {
        type: "session_status", status: "idle",
        detail: `autonomy: ${autonomy} (applies when the session next starts)`,
      });
      return;
    }

    this.store.append(id, {
      type: "session_status", status: "starting", detail: `autonomy: ${autonomy}`,
    });
    // Order matters: the old executor must be gone before a new one resumes the same provider
    // session. Pending approvals belong to the turn that is being torn down, so deny them.
    this.handles.delete(id);
    this.denyPendingApprovals(id);
    // A wedged CLI subprocess must not wedge the toggle; the abort in stop() still fires.
    await this.stopWithTimeout(handle, 5000).catch(() => {});
    // Shutdown may have started while we were stopping the old executor. Spawning a replacement
    // now would leak a CLI subprocess past the server's exit; the stored mode still applies on the
    // next boot.
    if (this.stopping) return;
    this.startExecutor(id, row.cwd, row.claude_session_id, autonomy);
  }

  /**
   * Restart executors for all sessions marked active. Returns only the ids actually started, so a
   * second call (or a call with sessions already live) does not overstate what happened.
   */
  resumeAll(): string[] {
    const rows = this.stmts.activeSessions.all() as SessionRow[];
    const started: string[] = [];
    for (const r of rows) {
      if (this.handles.has(r.id)) continue;
      // The stored mode is what a session comes back as: a bypass agent stays bypass across a
      // restart, an attended one stays attended.
      this.startExecutor(r.id, r.cwd, r.claude_session_id, asAutonomy(r.autonomy));
      started.push(r.id);
    }
    return started;
  }

  private startExecutor(id: string, cwd: string, resume: string | null, autonomy: AutonomyMode) {
    const handle = this.executor.start(
      { cwd, resumeSessionId: resume, autonomy },
      {
        onEvent: (event) => {
          this.store.append(id, event);
          // A terminal executor failure must move the session off 'active', otherwise resumeAll()
          // re-spawns a known-broken session on every boot, forever.
          if (event.type === "session_error") this.stmts.markError.run(id);
        },
        requestApproval: (toolName, input) =>
          new Promise((resolve) => {
            const approvalId = randomUUID();
            this.approvals.set(approvalId, { sessionId: id, resolve });
            this.store.append(id, { type: "approval_request", approvalId, toolName, input });
          }),
      },
    );
    this.handles.set(id, handle);
    void handle.providerSessionId.then((psid) => this.stmts.setProviderSessionId.run(psid, id));
  }

  prompt(id: string, text: string): void {
    const h = this.handles.get(id);
    if (!h) throw new Error(`no live session ${id}`);
    h.send(text);
  }

  /**
   * Record an operator decision. Throws on anything unexpected (unknown/expired approvalId, a
   * session id that does not own the approval); WsHub turns the throw into an `error` reply.
   */
  approve(id: string, approvalId: string, behavior: "allow" | "deny"): void {
    const pending = this.approvals.get(approvalId);
    if (!pending) return this.closeExpiredApproval(id, approvalId);
    if (pending.sessionId !== id) {
      throw new Error(`approval ${approvalId} does not belong to session ${id}`);
    }
    this.approvals.delete(approvalId);
    // The stored session id wins over the client's: the log is the source of truth and must
    // record the decision against the session that actually asked.
    this.store.append(pending.sessionId, { type: "approval_resolved", approvalId, behavior });
    pending.resolve(behavior);
  }

  /**
   * No live resolver for this approvalId. Either it never existed, or it is an `approval_request`
   * replayed from the log after a restart — the tool call died with the previous process, so
   * "denied" is the truthful record. Close the card out in the log and report the reason, instead
   * of returning silently and leaving the UI's approval card orange forever.
   */
  private closeExpiredApproval(id: string, approvalId: string): never {
    const events = this.store.listAfter(id, 0).map((r) => r.event);
    const requested = events.some((e) => e.type === "approval_request" && e.approvalId === approvalId);
    if (!requested) throw new Error(`unknown approval ${approvalId} for session ${id}`);
    if (events.some((e) => e.type === "approval_resolved" && e.approvalId === approvalId)) {
      throw new Error(`approval ${approvalId} is already resolved`);
    }
    this.store.append(id, { type: "approval_resolved", approvalId, behavior: "deny" });
    throw new Error(`approval ${approvalId} expired with the previous process; recorded as denied`);
  }

  /**
   * Resolve every approval still pending for a session with "deny" and log it. Called whenever a
   * session's executor goes away: the SDK's canUseTool promise would otherwise never settle, and
   * the log (and the UI card derived from it) would never close out.
   */
  private denyPendingApprovals(sessionId: string): void {
    for (const [approvalId, pending] of this.approvals) {
      if (pending.sessionId !== sessionId) continue;
      this.approvals.delete(approvalId);
      this.store.append(sessionId, { type: "approval_resolved", approvalId, behavior: "deny" });
      pending.resolve("deny");
    }
  }

  async interrupt(id: string): Promise<void> { await this.handles.get(id)?.interrupt(); }

  /**
   * Stop every live executor. Sessions stay 'active' in the db so resumeAll() picks them up
   * next boot. Each stop() races an unref'd timeout so a wedged CLI subprocess can never wedge
   * shutdown; all stops settle (failures/timeouts are tolerated individually).
   */
  async stopAll(timeoutMs = 5000): Promise<void> {
    this.stopping = true;
    for (const id of this.handles.keys()) this.denyPendingApprovals(id);
    const handles = [...this.handles.values()];
    this.handles.clear();
    await Promise.allSettled(handles.map((h) => this.stopWithTimeout(h, timeoutMs)));
  }

  private stopWithTimeout(handle: ExecutorHandle, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stop() timed out")), timeoutMs);
      timer.unref();
      handle.stop().then(
        () => { clearTimeout(timer); resolve(); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  listSessions(): SessionInfo[] {
    return (this.stmts.listSessions.all() as {
      id: string; state: SessionInfo["state"]; claude_session_id: string | null;
      autonomy: string; last_seq: number;
    }[]).map(r => ({
      id: r.id,
      state: r.state,
      claudeSessionId: r.claude_session_id,
      lastSeq: r.last_seq,
      autonomy: asAutonomy(r.autonomy),
    }));
  }
}

/** Row shape of the columns the manager needs off `sessions`. */
interface SessionRow {
  id: string;
  cwd: string;
  claude_session_id: string | null;
  autonomy: string;
}

/**
 * `sessions.autonomy` is a TEXT column, so a hand-edited or downgraded database could hold anything.
 * An unparseable value falls back to the product default rather than crashing a listing — and never
 * silently escalates, because the default is the least privileged mode we run agents in by default.
 */
function asAutonomy(value: string): AutonomyMode {
  const parsed = AutonomyMode.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_AUTONOMY;
}
