import { describe, expect, it } from "vitest";
import { LIMIT_PAUSE_PERCENT, LIMIT_WARN_PERCENT } from "@superfabric/shared";
import { formatCountdown, resetLabel } from "../src/hud/UsageMeters";

/**
 * The pure parts of the limit meters: how a reset time is said, and that the marks drawn on a bar
 * are the numbers the server actually acts on.
 */

const NOW = new Date("2026-08-04T12:00:00Z");
const at = (iso: string) => new Date(iso);

describe("formatCountdown", () => {
  it("says a duration, not a timestamp — nobody plans in UTC", () => {
    expect(formatCountdown(at("2026-08-04T14:14:00Z"), NOW)).toBe("in 2 h 14 m");
    expect(formatCountdown(at("2026-08-04T12:07:00Z"), NOW)).toBe("in 7 m");
    expect(formatCountdown(at("2026-08-07T15:00:00Z"), NOW)).toBe("in 3 d 3 h");
  });

  it("does not round a nearly-elapsed window down to nothing", () => {
    expect(formatCountdown(at("2026-08-04T12:00:20Z"), NOW)).toBe("in under a minute");
  });

  it("a window that should already have rolled says so, rather than counting backwards", () => {
    // The poller is up to three minutes behind, so a reset time in the past is routine and must not
    // render as "in -2 m".
    expect(formatCountdown(at("2026-08-04T11:58:00Z"), NOW)).toBe("any moment now");
  });
});

describe("resetLabel", () => {
  it("carries the countdown for reading and the instant for hovering", () => {
    const label = resetLabel("2026-08-04T18:00:00Z", NOW);
    expect(label.short).toBe("resets in 6 h 0 m");
    expect(label.title).not.toBe("");
  });

  it("admits it does not know rather than inventing a time", () => {
    // A 429 with no reading behind it has no reset time at all, and a made-up one would be a promise
    // nobody made.
    expect(resetLabel(null, NOW).short).toBe("reset time unknown");
    expect(resetLabel("not a date", NOW).short).toBe("reset time unknown");
  });
});

describe("the marks on a bar", () => {
  it("are the server's own thresholds, so the drawing cannot disagree with the behaviour", () => {
    // Imported from the protocol, not written twice: a bar that turned amber at a different number
    // from the one that warns the agents would be a lie drawn to scale.
    expect(LIMIT_WARN_PERCENT).toBe(80);
    expect(LIMIT_PAUSE_PERCENT).toBe(95);
    expect(LIMIT_WARN_PERCENT).toBeLessThan(LIMIT_PAUSE_PERCENT);
  });
});
