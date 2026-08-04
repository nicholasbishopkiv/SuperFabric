import { beforeEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "@superfabric/shared";
import {
  agentRemovalWarning, projectRemovalWarning, roomRemovalWarning,
} from "../src/hud/removal";
import { initialFabricState, useFabric } from "../src/store";

/**
 * What a delete says before it happens, and what the store forgets after it has.
 *
 * Both halves are here because they are the same property from two ends: the operator is told
 * exactly what is about to go, and afterwards nothing of it is left lying around in the tab —
 * including the transcript the console could otherwise still be scrolled through.
 */

describe("what a delete says it will take", () => {
  it("names the transcript, because that is the part nobody expects to lose", () => {
    expect(agentRemovalWarning(0)).toBe("Removes this agent and its whole transcript.");
  });

  it("mentions tasks only when there are some, and counts them in English", () => {
    expect(agentRemovalWarning(1)).toContain("1 task it owns go back to the board");
    expect(agentRemovalWarning(3)).toContain("3 tasks it owns go back to the board");
    expect(agentRemovalWarning(0)).not.toContain("task");
  });

  it("promises the folder survives, whatever else the room holds", () => {
    for (const opts of [{ agents: 0, tasks: 0 }, { agents: 1, tasks: 1 }, { agents: 4, tasks: 9 }]) {
      expect(roomRemovalWarning(opts)).toContain("The folder stays exactly as it is.");
    }
  });

  it("says the agents go with the room, in the right number", () => {
    expect(roomRemovalWarning({ agents: 1, tasks: 0 }))
      .toContain("1 agent here is stopped and removed too, with everything it said.");
    expect(roomRemovalWarning({ agents: 2, tasks: 0 }))
      .toContain("2 agents here are stopped and removed too, with everything they said.");
    // An empty room says nothing about agents at all — a clause about zero is noise.
    expect(roomRemovalWarning({ agents: 0, tasks: 0 })).not.toContain("agent");
  });

  it("names the factory it is about, since the switcher shows several", () => {
    const warning = projectRemovalWarning("Payments Platform");
    expect(warning).toContain("Removes Payments Platform");
    // The reassurance is the other half of the sentence, and it is what makes this clickable.
    expect(warning).toContain("Every folder, charter and ADR on disk stays.");
  });
});

/** Two agents in one room, one of which the operator is about to delete. */
function session(id: string): SessionInfo {
  return {
    id, state: "active", claudeSessionId: null, lastSeq: 2, autonomy: "auto", model: null,
    roomId: "r1", accountId: null, roleId: null, pausedUntil: null, status: "idle", blocked: false,
    isOrchestrator: false, runtime: "host",
  };
}

describe("the store after a delete", () => {
  beforeEach(() => {
    useFabric.setState({ ...initialFabricState });
  });

  it("forgets the transcript of an agent the server no longer has", () => {
    const apply = (sessions: SessionInfo[]): void => {
      useFabric.getState().apply({ kind: "sessions", sessions });
    };
    apply([session("a"), session("b")]);
    useFabric.setState({
      events: {
        a: [{ seq: 1, event: { type: "agent_text", text: "the alligator" } }],
        b: [{ seq: 1, event: { type: "agent_text", text: "still here" } }],
      },
      lastSeq: { a: 1, b: 1 },
      contiguousSeq: { a: 1, b: 1 },
      needsResync: { a: true },
    });

    apply([session("b")]);

    const s = useFabric.getState();
    // Everything about `a` goes, in all four maps: the rows the console reads, and the three
    // watermarks a reconnect would resubscribe from.
    expect(Object.keys(s.events)).toEqual(["b"]);
    expect(Object.keys(s.lastSeq)).toEqual(["b"]);
    expect(Object.keys(s.contiguousSeq)).toEqual(["b"]);
    expect(Object.keys(s.needsResync)).toEqual([]);
    // And the agent that stayed keeps everything, including its identity — a delete next door must
    // not repaint the floor.
    expect(s.events.b).toHaveLength(1);
  });

  it("leaves the maps alone when nothing was deleted", () => {
    useFabric.getState().apply({ kind: "sessions", sessions: [session("a")] });
    useFabric.setState({ events: { a: [{ seq: 1, event: { type: "agent_text", text: "hi" } }] } });
    const before = useFabric.getState().events;

    // A status change, not a removal: the same agent, one field different.
    useFabric.getState().apply({
      kind: "sessions", sessions: [{ ...session("a"), status: "working" }],
    });

    expect(useFabric.getState().events).toBe(before);
  });
});
