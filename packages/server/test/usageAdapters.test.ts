import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_USER_AGENT,
  ESTIMATE_BUDGET_TOKENS,
  OAUTH_BETA_HEADER,
  OAuthUsageAdapter,
  TranscriptEstimateAdapter,
  UnrecognisedUsageShape,
  USAGE_ENDPOINT,
  parseUsagePayload,
  readBearer,
  tokensOfLine,
  type FetchLike,
} from "../src/usageAdapters.js";
import recorded from "./fixtures/oauth-usage.json" with { type: "json" };
import perModel from "./fixtures/oauth-usage-per-model.json" with { type: "json" };

/**
 * The usage adapters, against **recorded** bodies rather than invented ones.
 *
 * `fixtures/oauth-usage.json` is verbatim what the endpoint returned on 2026-08-04; the parser was
 * written from it rather than from memory of the research. `fixtures/oauth-usage-per-model.json` is
 * the shape `docs/RESEARCH.md` §2 documents, which is *not* what came back — the per-model weekly
 * figures have moved into a `limits` array and the old keys are null. Both are kept, because the
 * whole reason this sits behind an adapter is that neither is promised to us.
 */

/** A fetch that answers with one body, and remembers what it was asked. */
function fakeFetch(body: unknown, init: { ok?: boolean; status?: number; text?: string } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn: FetchLike = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: "",
      json: async () => body,
      text: async () => init.text ?? JSON.stringify(body),
    };
  };
  return { calls, fn };
}

function configDirWithToken(token: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-usage-"));
  if (token !== null) {
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  }
  return dir;
}

describe("parseUsagePayload — the body the endpoint actually returned", () => {
  it("reads the five-hour and weekly windows, with their reset times", () => {
    const { windows } = parseUsagePayload(recorded);
    const fiveHour = windows.find((w) => w.key === "five_hour")!;
    expect(fiveHour.utilization).toBe(43);
    expect(fiveHour.resetsAt).toBe("2026-08-04T04:10:00.849724+00:00");
    expect(fiveHour.label).toBe("5-hour");

    const weekly = windows.find((w) => w.key === "seven_day")!;
    expect(weekly.utilization).toBe(87);
    expect(weekly.resetsAt).toBe("2026-08-06T20:00:00.849745+00:00");
  });

  it("finds the per-model weekly bucket in `limits`, where it now lives", () => {
    // `seven_day_opus` was *present and null* in the recording; the same figure came back as a
    // `weekly_scoped` entry with the model in its scope. A parser that only knew the named keys
    // would have shown the operator no per-model meter at all while one was at 100%.
    const { windows } = parseUsagePayload(recorded);
    const opus = windows.find((w) => w.key === "weekly_scoped:Opus")!;
    expect(opus).toBeDefined();
    expect(opus.utilization).toBe(100);
    expect(opus.label).toBe("Weekly · Opus");
  });

  it("does not show `session` and `weekly_all` a second time — they restate the named windows", () => {
    const { windows } = parseUsagePayload(recorded);
    expect(windows.map((w) => w.key).sort()).toEqual(["five_hour", "seven_day", "weekly_scoped:Opus"]);
  });

  it("ignores the dozen null code-named buckets without calling them unrecognised", () => {
    // `tangelo`, `iguana_necktie`, `nimbus_quill` … are all null in the recording. Present-but-empty
    // is the normal case for a window this account does not have, not a shape we failed to read.
    expect(parseUsagePayload(recorded).unrecognised).toBe(0);
  });

  it("reads the documented shape too — all four named windows, no `limits` array", () => {
    const { windows, unrecognised } = parseUsagePayload(perModel);
    expect(unrecognised).toBe(0);
    expect(windows.map((w) => w.key)).toEqual([
      "five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet",
    ]);
    expect(windows.find((w) => w.key === "seven_day_opus")!.utilization).toBe(96);
    expect(windows.find((w) => w.key === "seven_day_sonnet")!.label).toBe("Weekly · Sonnet");
  });
});

describe("parseUsagePayload — degrading on a shape we do not recognise", () => {
  it("keeps the windows it understands and counts the ones it does not", () => {
    const { windows, unrecognised } = parseUsagePayload({
      five_hour: { utilization: 30, resets_at: "2026-08-04T04:00:00Z" },
      seven_day: { utilization: "quite a lot" },     // a type nobody promised would stay a number
      limits: [{ kind: "session", percent: 30 }, { nonsense: true }],
    });
    expect(windows.map((w) => w.key)).toEqual(["five_hour"]);
    expect(unrecognised).toBe(2);
  });

  it("takes a window whose kind this build has never heard of rather than dropping it", () => {
    // The endpoint has already invented `weekly_scoped`, `seven_day_cowork` and half a dozen code
    // names. A meter labelled awkwardly beats a limit the operator never saw coming.
    const { windows } = parseUsagePayload({
      limits: [{ kind: "fortnightly_gerbil", percent: 55, resets_at: "2026-08-10T00:00:00Z" }],
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]!.key).toBe("fortnightly_gerbil");
    expect(windows[0]!.label).toBe("Fortnightly Gerbil");
    expect(windows[0]!.utilization).toBe(55);
  });

  it("throws only when it understands nothing at all — that is the signal to fall back", () => {
    expect(() => parseUsagePayload({ message: "moved permanently", docs: "elsewhere" }))
      .toThrow(UnrecognisedUsageShape);
    expect(() => parseUsagePayload("not json at all")).toThrow(UnrecognisedUsageShape);
    expect(() => parseUsagePayload(null)).toThrow(UnrecognisedUsageShape);
  });

  it("clamps a utilization outside 0–100 rather than putting an impossible number on a meter", () => {
    const { windows } = parseUsagePayload({ five_hour: { utilization: 140, resets_at: null } });
    expect(windows[0]!.utilization).toBe(100);
    expect(windows[0]!.resetsAt).toBeNull();
  });
});

describe("OAuthUsageAdapter", () => {
  it("sends the bearer, the beta header and a claude-code User-Agent to the documented URL", async () => {
    const dir = configDirWithToken("sk-ant-oat01-test");
    try {
      const { calls, fn } = fakeFetch(recorded);
      const reading = await new OAuthUsageAdapter({ fetch: fn }).read({ id: "a", configDir: dir });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(USAGE_ENDPOINT);
      expect(calls[0]!.headers.Authorization).toBe("Bearer sk-ant-oat01-test");
      expect(calls[0]!.headers["anthropic-beta"]).toBe(OAUTH_BETA_HEADER);
      expect(calls[0]!.headers["User-Agent"]).toBe(DEFAULT_USER_AGENT);

      expect(reading.source).toBe("endpoint");
      expect(reading.approximate).toBe(false);
      expect(reading.note).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says on the wire when part of the answer was in a shape it could not read", async () => {
    const dir = configDirWithToken("t");
    try {
      const { fn } = fakeFetch({ five_hour: { utilization: 10 }, seven_day: { utilization: null } });
      const reading = await new OAuthUsageAdapter({ fetch: fn }).read({ id: "a", configDir: dir });
      expect(reading.approximate).toBe(false);   // what it *did* read is still authoritative
      expect(reading.note).toContain("does not recognise");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws with the endpoint's own words when it refuses", async () => {
    const dir = configDirWithToken("t");
    try {
      const { fn } = fakeFetch(null, { ok: false, status: 429, text: "rate_limit_error" });
      await expect(new OAuthUsageAdapter({ fetch: fn }).read({ id: "a", configDir: dir }))
        .rejects.toThrow(/429.*rate_limit_error/s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an account with no credentials rather than asking the endpoint with no bearer", async () => {
    const dir = configDirWithToken(null);
    try {
      const { calls, fn } = fakeFetch(recorded);
      await expect(new OAuthUsageAdapter({ fetch: fn }).read({ id: "a", configDir: dir }))
        .rejects.toThrow(/no OAuth token/);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readBearer", () => {
  it("reads the CLI's nested shape, and a flat one, and gives up quietly on anything else", () => {
    const nested = mkdtempSync(join(tmpdir(), "sf-cred-"));
    const flat = mkdtempSync(join(tmpdir(), "sf-cred-"));
    const junk = mkdtempSync(join(tmpdir(), "sf-cred-"));
    try {
      writeFileSync(join(nested, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "n" } }));
      writeFileSync(join(flat, ".credentials.json"), JSON.stringify({ access_token: "f" }));
      writeFileSync(join(junk, ".credentials.json"), "{ not json");
      expect(readBearer(nested)).toBe("n");
      expect(readBearer(flat)).toBe("f");
      expect(readBearer(junk)).toBeUndefined();
      expect(readBearer(join(junk, "nowhere"))).toBeUndefined();
    } finally {
      for (const d of [nested, flat, junk]) rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("TranscriptEstimateAdapter", () => {
  const NOW = Date.parse("2026-08-04T12:00:00Z");

  /** A config dir with one transcript holding the given (age in hours, tokens) rows. */
  function withTranscript(rows: { hoursAgo: number; tokens: number }[]): string {
    const dir = mkdtempSync(join(tmpdir(), "sf-estimate-"));
    mkdirSync(join(dir, "projects", "-home-someone-repo"), { recursive: true });
    const lines = rows.map((r) => JSON.stringify({
      timestamp: new Date(NOW - r.hoursAgo * 3600_000).toISOString(),
      message: { usage: { input_tokens: r.tokens, output_tokens: 0 } },
    }));
    // A line with no usage at all, and a line that is not JSON: both are routine in these files.
    lines.push(JSON.stringify({ type: "summary", timestamp: new Date(NOW).toISOString() }), "{ broken");
    writeFileSync(join(dir, "projects", "-home-someone-repo", "s1.jsonl"), `${lines.join("\n")}\n`);
    return dir;
  }

  it("counts only what is inside each window, and is always marked approximate", async () => {
    const dir = withTranscript([
      { hoursAgo: 1, tokens: 4_000_000 },    // inside the 5-hour window and the week
      { hoursAgo: 30, tokens: 6_000_000 },   // inside the week only
      { hoursAgo: 24 * 9, tokens: 999_000_000 }, // older than both; must not be counted
    ]);
    try {
      const reading = await new TranscriptEstimateAdapter({ now: () => NOW })
        .read({ id: "a", configDir: dir });

      expect(reading.source).toBe("estimate");
      expect(reading.approximate).toBe(true);

      const five = reading.windows.find((w) => w.key === "five_hour")!;
      const week = reading.windows.find((w) => w.key === "seven_day")!;
      expect(five.utilization).toBeCloseTo(4_000_000 / ESTIMATE_BUDGET_TOKENS.five_hour! * 100, 6);
      expect(week.utilization).toBeCloseTo(10_000_000 / ESTIMATE_BUDGET_TOKENS.seven_day! * 100, 6);
      expect(five.detail).toBe("≈4.0M tokens on this machine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("labels every window as an estimate and says what it cannot see", async () => {
    const dir = withTranscript([{ hoursAgo: 1, tokens: 1000 }]);
    try {
      const reading = await new TranscriptEstimateAdapter({ now: () => NOW })
        .read({ id: "a", configDir: dir });
      // The label is on the meter itself, not only in a tooltip: a screenshot of the HUD must not be
      // able to show a guess that reads as a measurement.
      for (const w of reading.windows) expect(w.label).toContain("estimated");
      expect(reading.note).toContain("cannot see usage from your other devices");
      expect(reading.note).toContain("does not know when the real window began");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a floor, and says so, for a config dir with no transcripts at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-estimate-"));
    try {
      const reading = await new TranscriptEstimateAdapter({ now: () => NOW })
        .read({ id: "a", configDir: dir });
      expect(reading.windows.every((w) => w.utilization === 0)).toBe(true);
      expect(reading.note).toContain("this is a floor, not a reading");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tokensOfLine", () => {
  it("adds fresh and cached tokens alike, and skips lines that carry no usage", () => {
    const line = JSON.stringify({
      timestamp: "2026-08-04T10:00:00Z",
      message: { usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 4, cache_read_input_tokens: 8 } },
    });
    expect(tokensOfLine(line)!.tokens).toBe(15);
    expect(tokensOfLine(JSON.stringify({ timestamp: "2026-08-04T10:00:00Z" }))).toBeNull();
    expect(tokensOfLine(JSON.stringify({ message: { usage: { input_tokens: 5 } } }))).toBeNull();
    expect(tokensOfLine("not json")).toBeNull();
  });
});
