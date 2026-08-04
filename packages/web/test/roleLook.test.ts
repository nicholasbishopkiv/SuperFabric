import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KNOWN_ROLE_IDS,
  PLAIN_LOOK,
  type RoleLook,
  roleLook,
  roleWork,
  type WorkKind,
} from "../src/scene/roleLook";
import { ROLE_HAT, STATUS_COLOR, STATUS_HUE_BANDS } from "../src/scene/palette";

/**
 * What a role looks like on the floor. Pure tables, so the two claims that actually matter are
 * testable: **every shipped role has a look** (held against `roles/*.yaml` itself, not against a list
 * copied out of it), and **no role look can be mistaken for a status** — which is the invariant the
 * whole scheme exists to protect.
 */

/**
 * How far a colour is from grey, in [0, 1] — `max - min` of its channels.
 *
 * **Chroma rather than HSL saturation, and deliberately.** HSL divides the difference out by
 * lightness, so it calls the bone white of the floor's own paint 29% "saturated" while calling the
 * `idle` slate 7% — which inverts the only question being asked here: *could this be mistaken for an
 * alarm from across the floor?* Absolute distance from grey answers that, and the two reference points
 * below (the quietest status and the loudest) are what make the number mean something.
 */
function chromaOf(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return Math.max(...c) - Math.min(...c);
}

/** The role files as shipped: the ids the floor actually has to draw. */
function shippedRoleIds(): string[] {
  const dir = join(__dirname, "../../../roles");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""))
    .sort();
}

describe("roleLook", () => {
  it("has a look for every shipped role, read from roles/ rather than from a copy of it", () => {
    // The file name is the role's id by convention in `roles/`; the ids are also asserted below.
    expect(KNOWN_ROLE_IDS).toEqual(shippedRoleIds());
    expect(KNOWN_ROLE_IDS).toHaveLength(11);
  });

  it("gives an agent with no role, and one wearing a role we have never heard of, the plain look", () => {
    // An operator's own `roles/*.yaml` is the normal case, not an error: the honest drawing of "we do
    // not know what this agent's job is" is the hat every figure wore before roles existed.
    expect(roleLook(null)).toEqual(PLAIN_LOOK);
    expect(roleLook("some-role-of-mine")).toEqual(PLAIN_LOOK);
    expect(roleWork("some-role-of-mine")).toBe("none");
    expect(PLAIN_LOOK.carry).toBe("none");
    expect(PLAIN_LOOK.shape).toBe("hard");
  });

  it("tells all eleven apart: no two roles share a (shape, colour, carry) triple", () => {
    const seen = new Map<string, string>();
    for (const id of KNOWN_ROLE_IDS) {
      const look = roleLook(id);
      const key = `${look.shape}|${look.color}|${look.carry}`;
      expect(seen.get(key), `${id} looks exactly like ${seen.get(key) ?? ""}`).toBeUndefined();
      seen.set(key, id);
    }
    expect(seen.size).toBe(11);
  });

  it("**never lets a role read as a status**: every hat is a neutral, not a hue", () => {
    // The reference points, so the threshold is the floor's own rather than a number picked here: the
    // `idle` slate is the quietest thing the status palette contains and its hue is declared to mean
    // nothing, and `blocked` is the loudest. A hat has to sit at the quiet end.
    const idle = chromaOf(STATUS_COLOR.idle);
    const loudest = Math.max(...Object.values(STATUS_COLOR).map(chromaOf));
    expect(loudest).toBeGreaterThan(0.5); // the palette really is loud where it means something
    for (const [name, hex] of Object.entries(ROLE_HAT)) {
      const chroma = chromaOf(hex);
      expect(chroma, `${name} (${hex}) is colourful enough to compete with a status`)
        .toBeLessThan(idle * 1.5);
      // Belt and braces: nothing on a hat is within hailing distance of an alarm colour.
      expect(chroma).toBeLessThan(loudest / 4);
    }
    // …and if any of them ever were saturated, this is the band it would have to stay out of.
    expect(STATUS_HUE_BANDS.length).toBeGreaterThan(0);
  });

  it("draws every hat from that closed set, so no role invents a colour inline", () => {
    const allowed = new Set<string>(Object.values(ROLE_HAT));
    for (const id of KNOWN_ROLE_IDS) expect(allowed.has(roleLook(id).color)).toBe(true);
  });

  it("shares one hat shape and one tool per work family, and the two never come apart", () => {
    const byWork = new Map<WorkKind, RoleLook[]>();
    for (const id of KNOWN_ROLE_IDS) {
      const look = roleLook(id);
      expect(look.work).toBe(roleWork(id));
      const list = byWork.get(look.work) ?? [];
      list.push(look);
      byWork.set(look.work, list);
    }
    // Five families of two, plus the generalist alone in `none`.
    expect([...byWork.keys()].sort()).toEqual(["build", "check", "none", "operate", "plan", "write"]);
    for (const [work, looks] of byWork) {
      const shapes = new Set(looks.map((l) => l.shape));
      const carries = new Set(looks.map((l) => l.carry));
      expect(shapes.size, `${work} wears two hat shapes`).toBe(1);
      expect(carries.size, `${work} carries two different tools`).toBe(1);
      // Inside a family the *value* is what separates the roles, so it must actually differ.
      expect(new Set(looks.map((l) => l.color)).size).toBe(looks.length);
    }
    expect(byWork.get("none")).toHaveLength(1);
  });

  it("gives the generalist the plain look, because it declares no specialism", () => {
    expect(roleLook("generalist")).toEqual(PLAIN_LOOK);
  });

  it("puts the shipped roles in the families the props are chosen by", () => {
    // Named explicitly rather than derived: this is the mapping an operator would argue with, and a
    // test that recomputed it from the table would agree with any answer.
    expect(roleWork("architect")).toBe("plan");
    expect(roleWork("designer")).toBe("plan");
    expect(roleWork("backend")).toBe("build");
    expect(roleWork("frontend")).toBe("build");
    expect(roleWork("qa")).toBe("check");
    expect(roleWork("security")).toBe("check");
    expect(roleWork("tech-writer")).toBe("write");
    expect(roleWork("onboarding")).toBe("write");
    expect(roleWork("devops")).toBe("operate");
    expect(roleWork("data")).toBe("operate");
    expect(roleWork("generalist")).toBe("none");
  });
});
