import { readConfig } from "./config.js";
import { SessionRunner } from "./runner.js";

export { SessionRunner, defaultBackoffMs, type SessionRunnerDeps, type QueryFn } from "./runner.js";
export { Outbox, type OutboxEntry } from "./outbox.js";
export { connectWebSocket, type ConnectFn, type RunnerSocket, type RunnerSocketHandlers } from "./socket.js";
export { readConfig, type RunnerConfig } from "./config.js";

/**
 * The container's entry point: one session, one `query()`, one socket back to the factory.
 *
 * Everything interesting is in `SessionRunner`; this is the thin shell that reads the environment,
 * wires the signals, and decides the exit code. It runs only when this module is the program —
 * importing the package (as the tests do) starts nothing.
 */
export async function main(): Promise<number> {
  const log = (line: string): void => {
    // stderr, not stdout: the container's logs are for the operator debugging the *runner*. The
    // agent's own output is not printed here at all — it goes over the socket into the event log,
    // which is the source of truth.
    process.stderr.write(`[agent-runner] ${line}\n`);
  };

  let runner: SessionRunner;
  try {
    const config = readConfig(process.env);
    log(`session ${config.sessionId} → ${config.serverUrl}`);
    runner = new SessionRunner({ ...config, log });
  } catch (err) {
    log(`refusing to start: ${String(err)}`);
    return 2;
  }

  // SIGTERM is how `docker stop` and `ContainerExecutor.stop()` ask for the agent back. Stop the
  // query so the provider session stays resumable, flush what can still be flushed, and exit
  // cleanly — a runner killed at SIGKILL after the grace period would leave the last few events
  // only in the CLI's transcript.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void runner.shutdown(signal);
    });
  }

  runner.start();
  await runner.done;
  log("done");
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`[agent-runner] fatal: ${String(err)}\n`);
      process.exit(1);
    },
  );
}
