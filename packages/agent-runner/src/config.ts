import { RUNNER_ENV, RunnerOptions } from "@superfabric/shared";

/**
 * The runner's configuration, read from the environment.
 *
 * A container gets no argv a human would type: it is created by `ContainerExecutor`, not launched
 * from a shell, so every knob arrives as an environment variable and every one of them is validated
 * here. A missing or malformed variable is a hard, named failure at start — the alternative is a
 * container that comes up, attaches, and then behaves as though the operator had chosen defaults
 * they never chose.
 */
export interface RunnerConfig {
  sessionId: string;
  serverUrl: string;
  token: string;
  options: RunnerOptions;
}

export function readConfig(env: Record<string, string | undefined>): RunnerConfig {
  const sessionId = required(env, RUNNER_ENV.sessionId);
  const serverUrl = required(env, RUNNER_ENV.serverUrl);
  const token = required(env, RUNNER_ENV.token);
  const raw = required(env, RUNNER_ENV.options);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${RUNNER_ENV.options} is not valid JSON: ${String(err)}`);
  }
  const options = RunnerOptions.safeParse(parsed);
  if (!options.success) {
    throw new Error(`${RUNNER_ENV.options} is not a valid RunnerOptions: ${options.error.message}`);
  }
  return { sessionId, serverUrl, token, options: options.data };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}
