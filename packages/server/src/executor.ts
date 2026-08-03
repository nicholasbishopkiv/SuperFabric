import type { SessionEvent } from "@superfabric/shared";

export interface ExecutorEvents {
  onEvent: (event: SessionEvent) => void;
  /** Ask the operator to approve a tool call. Resolves allow/deny. */
  requestApproval: (toolName: string, input: unknown) => Promise<"allow" | "deny">;
}

export interface ExecutorStartOptions {
  cwd: string;
  /** Provider-native session id to resume, if any. */
  resumeSessionId?: string | null;
}

export interface ExecutorHandle {
  /** Provider-native session id, available after start. */
  readonly providerSessionId: Promise<string>;
  send(text: string): void;          // queue a user turn into the live session
  interrupt(): Promise<void>;
  stop(): Promise<void>;             // graceful shutdown, session stays resumable
}

export interface Executor {
  readonly name: string;             // "claude-code", later "codex", ...
  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorHandle;
}
