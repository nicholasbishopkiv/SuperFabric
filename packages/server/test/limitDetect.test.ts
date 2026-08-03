import { describe, it, expect } from "vitest";
import { classifyExecutorError } from "../src/executors/claudeCode.js";

describe("classifyExecutorError", () => {
  it("classifies HTTP 429 / rate_limit_error as rate_limited", () => {
    expect(classifyExecutorError("429 rate_limit_error: exceeded")).toBe("rate_limited");
  });
  it("classifies the claude.ai usage-limit message as rate_limited", () => {
    expect(classifyExecutorError("Claude usage limit reached|1754269200")).toBe("rate_limited");
  });
  it("classifies anything else as unknown", () => {
    expect(classifyExecutorError("boom")).toBe("unknown");
  });
  it("works on Error instances, not just strings", () => {
    expect(classifyExecutorError(new Error("Rate Limit hit"))).toBe("rate_limited");
    expect(classifyExecutorError(new Error("nope"))).toBe("unknown");
  });
});
