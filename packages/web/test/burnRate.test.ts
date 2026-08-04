import { beforeEach, describe, expect, it } from "vitest";
import type { AccountBurn, FactoryMetrics, ServerMessage } from "@superfabric/shared";
import { formatRate, formatRemaining, formatUsd } from "../src/hud/BurnRate";
import { initialFabricState, useFabric } from "../src/store";

/**
 * The burn-rate surface's pure parts, and how a metrics frame lands in the store.
 *
 * The thing being held down here is that **a duration is what an operator acts on** and that the
 * resolution it is said at does not over-claim: a projection off a handful of coarse percentages cannot
 * support "1 h 47 m", so it says "about 1.75 h" and no finer.
 */

describe("formatRemaining", () => {
  it("says a duration at a resolution the projection can support", () => {
    expect(formatRemaining(25 * 60)).toBe("about 25 min");
    expect(formatRemaining(2 * 3600)).toBe("about 2 h");
    // Quarter-hour resolution beyond ninety minutes: the slope of five coarse readings does not
    // justify a figure to the minute, and stating one would be a claim the data cannot back.
    expect(formatRemaining(107 * 60)).toBe("about 1.75 h");
    expect(formatRemaining(3 * 24 * 3600)).toBe("about 3 d");
  });

  it("does not round a nearly-spent account down to nothing", () => {
    expect(formatRemaining(30)).toBe("under a minute");
  });

  it("says an account already at the threshold is already there, not 'in 0 min'", () => {
    // The server answers zero seconds for a window at or past the pause line. "already there" is the
    // truth; "about 0 min" reads as a projection that happens to be small.
    expect(formatRemaining(0)).toBe("already there");
  });
});

describe("formatUsd", () => {
  it("stays readable at both ends and never shows a rounded-to-zero figure as zero", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(1.75)).toBe("$1.75");
    expect(formatUsd(132.4)).toBe("$132");
  });
});

describe("formatRate", () => {
  it("shows more precision the slower the window fills", () => {
    expect(formatRate(31.7)).toBe("32 pts/h");
    expect(formatRate(4.25)).toBe("4.3 pts/h");
    // A weekly window creeping up needs two decimals to be distinguishable from flat.
    expect(formatRate(0.08)).toBe("0.08 pts/h");
  });
});

const BURN: AccountBurn = {
  accountId: "a1", windowKey: "five_hour", windowLabel: "5-hour", percentPerHour: 20,
  secondsToLimit: 7200, resetsFirst: false, approximate: false, samples: 21, spanSeconds: 3600,
  unknown: null,
};
const rollups = (day: number, week: number): FactoryMetrics["ambient"] => ({
  day: { usd: day, turns: 1 }, week: { usd: week, turns: 2 },
});
const metrics = (over: Partial<FactoryMetrics> = {}): FactoryMetrics => ({
  accounts: [{ accountId: "a1", burn: BURN, cost: rollups(0.4, 1.2) }],
  ambient: rollups(0, 0),
  rooms: [{ roomId: "r1", cost: rollups(0.3, 0.9) }],
  ...over,
});

const apply = (msg: ServerMessage): void => { useFabric.getState().apply(msg); };

// `setState` with no replace flag, so the store's actions survive the reset.
beforeEach(() => {
  useFabric.setState({ ...initialFabricState, metrics: null, usage: [], projects: [], activeProjectId: null });
});

describe("a metrics frame in the store", () => {
  it("starts null, because nothing measured is not the same fact as nothing spent", () => {
    expect(useFabric.getState().metrics).toBeNull();
  });

  it("keeps the identity of a row whose numbers did not move", () => {
    apply({ kind: "metrics", metrics: metrics() });
    const first = useFabric.getState().metrics!;
    // The frame arrives on every poll *and* every turn boundary; most of it is unchanged each time.
    apply({ kind: "metrics", metrics: metrics() });
    expect(useFabric.getState().metrics).toBe(first);

    apply({
      kind: "metrics",
      metrics: metrics({ accounts: [{ accountId: "a1", burn: BURN, cost: rollups(0.9, 1.7) }] }),
    });
    const second = useFabric.getState().metrics!;
    expect(second).not.toBe(first);
    expect(second.accounts[0]).not.toBe(first.accounts[0]);
    // The room row did not move, so it kept its object: one changed account must not repaint the rest.
    expect(second.rooms[0]).toBe(first.rooms[0]);
  });

  it("notices a projection turning from a figure into an honest unknown", () => {
    apply({ kind: "metrics", metrics: metrics() });
    const before = useFabric.getState().metrics!.accounts[0]!;
    apply({
      kind: "metrics",
      metrics: metrics({
        accounts: [{
          accountId: "a1",
          burn: {
            ...BURN, windowKey: null, windowLabel: null, percentPerHour: null, secondsToLimit: null,
            samples: 1, spanSeconds: 0, unknown: "only 1 reading of 5-hour so far — a rate needs two",
          },
          cost: rollups(0.4, 1.2),
        }],
      }),
    });
    const after = useFabric.getState().metrics!.accounts[0]!;
    expect(after).not.toBe(before);
    expect(after.burn.secondsToLimit).toBeNull();
    expect(after.burn.unknown).toContain("a rate needs two");
  });

  it("is cleared by a factory switch, because the room half belongs to one floor", () => {
    const projects = [
      { id: "p1", name: "one", root: "/a", lastOpenedAt: null },
      { id: "p2", name: "two", root: "/b", lastOpenedAt: null },
    ];
    // Land on a floor first: the first frame of a connection has nothing to drop.
    apply({ kind: "projects", projects, activeProjectId: "p1" });
    apply({ kind: "metrics", metrics: metrics() });
    expect(useFabric.getState().metrics).not.toBeNull();
    // Now switch. The store drops everything the previous floor owned and waits for the new floor's own
    // frame. Attributing one factory's spend to another's rooms would be worse than a gap.
    apply({ kind: "projects", projects, activeProjectId: "p2" });
    expect(useFabric.getState().metrics).toBeNull();
    // The meters, by contrast, survive: an account's quota is machine-wide.
    expect(useFabric.getState().usage).toEqual([]);
  });
});
