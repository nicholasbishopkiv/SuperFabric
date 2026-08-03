import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { EventStore } from "./eventStore.js";
import type { Executor, ExecutorHandle } from "./executor.js";
import type { SessionInfo } from "@superfabric/shared";

export class SessionManager {
  private handles = new Map<string, ExecutorHandle>();
  private approvals = new Map<string, (b: "allow" | "deny") => void>(); // approvalId -> resolver

  constructor(private db: Db, private store: EventStore, private executor: Executor) {}

  createSession(cwd: string): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO sessions (id, cwd) VALUES (?, ?)").run(id, cwd);
    this.startExecutor(id, cwd, null);
    return id;
  }

  /** Restart executors for all sessions marked active. Returns resumed ids. */
  resumeAll(): string[] {
    const rows = this.db.prepare("SELECT id, cwd, claude_session_id FROM sessions WHERE state = 'active'").all() as
      { id: string; cwd: string; claude_session_id: string | null }[];
    for (const r of rows) if (!this.handles.has(r.id)) this.startExecutor(r.id, r.cwd, r.claude_session_id);
    return rows.map(r => r.id);
  }

  private startExecutor(id: string, cwd: string, resume: string | null) {
    const handle = this.executor.start(
      { cwd, resumeSessionId: resume },
      {
        onEvent: (event) => this.store.append(id, event),
        requestApproval: (toolName, input) =>
          new Promise((resolve) => {
            const approvalId = randomUUID();
            this.approvals.set(approvalId, resolve);
            this.store.append(id, { type: "approval_request", approvalId, toolName, input });
          }),
      },
    );
    this.handles.set(id, handle);
    void handle.providerSessionId.then((psid) =>
      this.db.prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?").run(psid, id));
  }

  prompt(id: string, text: string): void {
    const h = this.handles.get(id);
    if (!h) throw new Error(`no live session ${id}`);
    h.send(text);
  }

  approve(id: string, approvalId: string, behavior: "allow" | "deny"): void {
    const resolve = this.approvals.get(approvalId);
    if (!resolve) return;
    this.approvals.delete(approvalId);
    this.store.append(id, { type: "approval_resolved", approvalId, behavior });
    resolve(behavior);
  }

  async interrupt(id: string): Promise<void> { await this.handles.get(id)?.interrupt(); }

  /**
   * Stop every live executor. Sessions stay 'active' in the db so resumeAll() picks them up
   * next boot. Each stop() races an unref'd timeout so a wedged CLI subprocess can never wedge
   * shutdown; all stops settle (failures/timeouts are tolerated individually).
   */
  async stopAll(timeoutMs = 5000): Promise<void> {
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
    return (this.db.prepare("SELECT id, state, claude_session_id FROM sessions ORDER BY created_at").all() as
      { id: string; state: "active" | "paused" | "done"; claude_session_id: string | null }[])
      .map(r => ({
        id: r.id, state: r.state, claudeSessionId: r.claude_session_id,
        lastSeq: (this.db.prepare("SELECT COALESCE(MAX(seq),0) m FROM events WHERE session_id=?").get(r.id) as { m: number }).m,
      }));
  }
}
