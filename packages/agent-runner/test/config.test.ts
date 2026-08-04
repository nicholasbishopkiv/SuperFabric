import { describe, it, expect } from "bun:test";
import { RUNNER_ENV } from "@superfabric/shared";
import { readConfig } from "../src/config.js";

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [RUNNER_ENV.sessionId]: "sess-1",
    [RUNNER_ENV.serverUrl]: "ws://host.docker.internal:4620/runner",
    [RUNNER_ENV.token]: "tok",
    [RUNNER_ENV.options]: JSON.stringify({ cwd: "/work" }),
    ...overrides,
  };
}

describe("readConfig", () => {
  it("reads the four variables a container is given, and defaults the rest", () => {
    const config = readConfig(env());
    expect(config.sessionId).toBe("sess-1");
    expect(config.token).toBe("tok");
    expect(config.options).toEqual({
      cwd: "/work",
      resumeSessionId: null,
      model: null,
      allowedTools: [],
      ungatedToolPrefixes: [],
    });
  });

  it("carries the session's own settings across", () => {
    const options = {
      cwd: "/work",
      resumeSessionId: "prov-1",
      autonomy: "bypass",
      model: "claude-fable-5",
      appendSystemPrompt: "charter",
      allowedTools: ["Read"],
      ungatedToolPrefixes: ["mcp__factory__"],
    };
    expect(readConfig(env({ [RUNNER_ENV.options]: JSON.stringify(options) })).options).toEqual(options as never);
  });

  for (const missing of [RUNNER_ENV.sessionId, RUNNER_ENV.serverUrl, RUNNER_ENV.token, RUNNER_ENV.options]) {
    it(`refuses to start without ${missing}`, () => {
      expect(() => readConfig(env({ [missing]: undefined }))).toThrow(missing);
      expect(() => readConfig(env({ [missing]: "   " }))).toThrow(missing);
    });
  }

  it("names the variable when the options are not JSON, or not options", () => {
    expect(() => readConfig(env({ [RUNNER_ENV.options]: "{oops" }))).toThrow(/not valid JSON/);
    // `cwd` is the one thing with no sensible default: an agent has to work somewhere.
    expect(() => readConfig(env({ [RUNNER_ENV.options]: "{}" }))).toThrow(/not a valid RunnerOptions/);
    expect(() => readConfig(env({ [RUNNER_ENV.options]: '{"cwd":"/w","autonomy":"godmode"}' }))).toThrow(
      /not a valid RunnerOptions/,
    );
  });
});
