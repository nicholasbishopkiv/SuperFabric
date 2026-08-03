import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { Db } from "./db.js";
import type { EventStore } from "./eventStore.js";
import type { Executor, ExecutorHandle } from "./executor.js";
import type { SessionInfo } from "@superfabric/shared";

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
  private readonly stmts;

  constructor(private db: Db, private store: EventStore, private executor: Executor) {
    this.stmts = {
      insertSession: db.prepare("INSERT INTO sessions (id, cwd) VALUES (?, ?)"),
      setProviderSessionId: db.prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?"),
      activeSessions: db.prepare("SELECT id, cwd, claude_session_id FROM sessions WHERE state = 'active'"),
      markError: db.prepare("UPDATE sessions SET state = 'error' WHERE id = ? AND state = 'active'"),
      // One statement, one pass: a per-row MAX(seq) query inside a .map() is O(sessions) queries.
      listSessions: db.prepare(`
        SELECT s.id AS id, s.state AS state, s.claude_session_id AS claude_session_id,
               COALESCE(MAX(e.seq), 0) AS last_seq
        FROM sessions s LEFT JOIN events e ON e.session_id = s.id
        GROUP BY s.id ORDER BY s.created_at
      `),
    };
  }

  createSession(cwd: string): string {
    // `cwd` comes straight off the wire. An unchecked value is persisted forever and makes the
    // executor fail obscurely on this boot and every boot after it, so validate it here.
    let isDir = false;
    try { isDir = statSync(cwd).isDirectory(); }
    catch { throw new Error(`cwd does not exist: ${cwd}`); }
    if (!isDir) throw new Error(`cwd is not a directory: ${cwd}`);

    const id = randomUUID();
    this.stmts.insertSession.run(id, cwd);
    this.startExecutor(id, cwd, null);
    return id;
  }

  /**
   * Restart executors for all sessions marked active. Returns only the ids actually started, so a
   * second call (or a call with sessions already live) does not overstate what happened.
   */
  resumeAll(): string[] {
    const rows = this.stmts.activeSessions.all() as
      { id: string; cwd: string; claude_session_id: string | null }[];
    const started: string[] = [];
    for (const r of rows) {
      if (this.handles.has(r.id)) continue;
      this.startExecutor(r.id, r.cwd, r.claude_session_id);
      started.push(r.id);
    }
    return started;
  }

  private startExecutor(id: string, cwd: string, resume: string | null) {
    const handle = this.executor.start(
      { cwd, resumeSessionId: resume },
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
    return (this.stmts.listSessions.all() as
      { id: string; state: SessionInfo["state"]; claude_session_id: string | null; last_seq: number }[])
      .map(r => ({ id: r.id, state: r.state, claudeSessionId: r.claude_session_id, lastSeq: r.last_seq }));
  }
}
