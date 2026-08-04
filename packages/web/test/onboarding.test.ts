import type { OnboardingState, ProjectInfo, RoomSuggestion } from "@superfabric/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { onboardingSurface, outstanding } from "../src/hud/Onboarding";
import { initialFabricState, useFabric } from "../src/store";

/**
 * Onboarding in the client: what shows when, and that a factory switch does not carry one project's
 * answer onto another's floor.
 *
 * The rule being held down is the one from the design: **prominent when a project has never been
 * written down, invisible afterwards** — with the single exception that a proposal outranks
 * everything, because the interview writes `CLAUDE.md` before it proposes rooms and the list must not
 * vanish at the moment it appears.
 */

const apply = (msg: Parameters<ReturnType<typeof useFabric.getState>["apply"]>[0]) =>
  useFabric.getState().apply(msg);

const project = (id: string, root: string): ProjectInfo =>
  ({ id, name: id, root, lastOpenedAt: null });

const suggestion = (over: Partial<RoomSuggestion> = {}): RoomSuggestion => ({
  id: "s1", projectId: "p1", name: "api", charter: "The service.", status: "proposed",
  note: null, createdAt: 1, ...over,
});

const state = (over: Partial<OnboardingState> = {}): OnboardingState => ({
  projectId: "p1", onboarded: false, sessionId: null, suggestions: [], ...over,
});

beforeEach(() => {
  useFabric.setState({ ...initialFabricState });
});

describe("which onboarding surface shows", () => {
  it("shows nothing until the server has said anything at all", () => {
    // Not the same as "this project has never been written down": an un-answered question must not
    // draw the same card as a definite no.
    expect(onboardingSurface(null)).toBe("none");
  });

  it("offers the interview only for a project with no CLAUDE.md", () => {
    expect(onboardingSurface(state({ onboarded: false }))).toBe("offer");
    expect(onboardingSurface(state({ onboarded: true }))).toBe("none");
  });

  it("shows the interview while it is still the thing that has not happened", () => {
    expect(onboardingSurface(state({ sessionId: "s" }))).toBe("interview");
  });

  it("stops showing it the moment the file it exists to produce is on disk", () => {
    // A finished onboarding session stays `active` — nothing stops it — so keying this off "a
    // session exists" left the strip on the floor for the rest of the factory's life. Found in the
    // M1c live run, which is what a live run is for.
    expect(onboardingSurface(state({ onboarded: true, sessionId: "s" }))).toBe("none");
  });

  it("a proposal outranks everything, including a project that is by now documented", () => {
    // The interview writes the docs and *then* proposes rooms, so this is the ordinary end state of
    // a successful onboarding — and it is exactly when the operator has a decision to make.
    expect(onboardingSurface(state({
      onboarded: true, sessionId: "s", suggestions: [suggestion()],
    }))).toBe("proposal");
    // Settled ones do not keep the card up.
    expect(onboardingSurface(state({
      onboarded: true,
      suggestions: [suggestion({ status: "accepted" }), suggestion({ id: "s2", status: "dismissed" })],
    }))).toBe("none");
  });

  it("lists only the proposals still waiting on a decision", () => {
    const s = state({
      suggestions: [
        suggestion({ id: "a", status: "accepted" }),
        suggestion({ id: "b", name: "docs" }),
        suggestion({ id: "c", status: "dismissed" }),
      ],
    });
    expect(outstanding(s).map((x) => x.id)).toEqual(["b"]);
    expect(outstanding(null)).toEqual([]);
  });
});

describe("the onboarding frame in the store", () => {
  it("replaces the whole state, because the server sends the whole state", () => {
    apply({ kind: "onboarding", onboarding: state() });
    expect(useFabric.getState().onboarding).toEqual(state());
    const answered = state({ onboarded: true, suggestions: [suggestion({ status: "accepted" })] });
    apply({ kind: "onboarding", onboarding: answered });
    expect(useFabric.getState().onboarding).toEqual(answered);
  });

  it("is dropped when the tab switches factory, rather than describing the wrong one", () => {
    apply({ kind: "projects", projects: [project("p1", "/a"), project("p2", "/b")], activeProjectId: "p1" });
    apply({ kind: "onboarding", onboarding: state({ projectId: "p1", onboarded: true }) });
    expect(useFabric.getState().onboarding).not.toBeNull();

    apply({ kind: "projects", projects: [project("p1", "/a"), project("p2", "/b")], activeProjectId: "p2" });
    // Null, not "false": "we have not been told about this floor" is not "this floor needs
    // onboarding", and offering an interview on the strength of the previous project's answer is
    // exactly the wrong first impression.
    expect(useFabric.getState().onboarding).toBeNull();
    expect(onboardingSurface(useFabric.getState().onboarding)).toBe("none");
  });
});
