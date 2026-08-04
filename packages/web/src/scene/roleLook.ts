import { ROLE_HAT } from "./palette";

/**
 * What a role looks like on the floor, and what kind of work it is.
 *
 * ## Why the role is not a colour
 *
 * The vest is the **status** and it must stay the loudest thing on a figure; the building's band is
 * the **department**. `ROLE_HAT` explains why there is no hue left to give a role. So a role is told
 * by three things, in the order they survive being small:
 *
 * 1. **The hat's silhouette**, which is shared by a whole *work family* — a peaked cap is somebody
 *    who checks things, ear defenders are somebody who runs the plant. This is the only part legible
 *    at a 40-pixel figure, and it is deliberately the part that carries the *coarser* fact.
 * 2. **The carried tool**, one per family too, and the same vocabulary the room's props are drawn
 *    from: a builder carries a spanner and works at a bench, a checker carries a lens and works at a
 *    test rig. Two readings of one fact, so the floor teaches itself.
 * 3. **The hat's value** — one of five neutrals — which is what separates the two roles *inside* a
 *    family (a steel hard hat is the backend, a white one the frontend).
 *
 * Precise identification is not this table's job: the room panel and every agent row already name
 * the role in words, and eleven silhouettes nobody can hold in their head would be a legend the
 * operator has to learn before the floor means anything. What the floor gives at a glance is "this
 * department has two builders and a checker in it", which is the question a factory answers well.
 *
 * ## The families
 *
 * Five, each with two roles, plus the generalist which has none by definition. They are the
 * operator's own words for the props — "a workbench if they build, a lab bench if they run
 * tests/checks, a desk with a computer if they write or read" — extended in the same register:
 * a drafting table for the people who decide the shape, and a rack for the people who run it.
 *
 * Everything here is a pure table, so `test/roleLook.test.ts` can hold it against `roles/*.yaml` and
 * fail when a shipped preset arrives without a look.
 */

/**
 * The kind of work a role does — the thing the props are chosen by (`props.ts`) and the thing a
 * carried tool says. `none` is the generalist: no specialism is assumed, so nothing is implied.
 */
export type WorkKind = "plan" | "build" | "check" | "write" | "operate" | "none";

/**
 * The hat silhouettes, one per work family.
 *
 * - `hard` — the classic dome with a full brim. What every figure wore before roles existed, and
 *   therefore what a builder (and an agent with no role at all) wears.
 * - `flat` — a flat-topped bump cap with a wide brim: the people who draw the plans.
 * - `visor` — a dome with a peak at the front only, which reads as a cap rather than a helmet: the
 *   people who inspect.
 * - `soft` — a low dome with no brim: the people at a desk.
 * - `muffs` — a dome with an ear defender each side, which is the widest silhouette of the five and
 *   the one that says "plant": the people who run the machines.
 */
export type HatShape = "hard" | "flat" | "visor" | "soft" | "muffs";

/**
 * What a figure carries, one per work family. Deliberately five and not eleven: a silhouette per
 * role would be ten small shapes nobody could tell apart at the distance they are actually read at,
 * and the props already say the same thing at building scale.
 *
 * `none` is carried by the generalist and by an agent with no role — an empty hand is the honest
 * drawing of "no specialism was declared".
 */
export type CarryKind = "none" | "roll" | "spanner" | "lens" | "clipboard" | "valve";

export interface RoleLook {
  /** What kind of work this is. Drives the room's props as well as the carried tool. */
  work: WorkKind;
  shape: HatShape;
  /** One of `ROLE_HAT`'s five neutrals. Never a hue — see `ROLE_HAT`. */
  color: string;
  carry: CarryKind;
}

/** The tool each work family carries. One table, so a family and its tool cannot come apart. */
const CARRY_FOR_WORK: Record<WorkKind, CarryKind> = {
  plan: "roll",
  build: "spanner",
  check: "lens",
  write: "clipboard",
  operate: "valve",
  none: "none",
};

/** The hat silhouette each work family wears. Same reason as above: one table. */
const SHAPE_FOR_WORK: Record<WorkKind, HatShape> = {
  plan: "flat",
  build: "hard",
  check: "visor",
  write: "soft",
  operate: "muffs",
  none: "hard",
};

/**
 * The eleven shipped roles, as a work family plus the hat value that separates the two members of it.
 *
 * Keyed by role **id**, which is what `SessionInfo.roleId` carries and what a role file's `id:` field
 * says — so an operator's override of `qa.yaml` keeps the QA look, which is the point of overriding
 * by id rather than by file name.
 */
const ROLE_WORK: Record<string, { work: WorkKind; color: string }> = {
  // Plan: the shape of the thing, before it exists.
  architect: { work: "plan", color: ROLE_HAT.bone },
  designer: { work: "plan", color: ROLE_HAT.slate },
  // Build: it runs when they are done with it.
  backend: { work: "build", color: ROLE_HAT.steel },
  frontend: { work: "build", color: ROLE_HAT.white },
  // Check: independent evidence that it works, or that it cannot be broken into.
  qa: { work: "check", color: ROLE_HAT.white },
  security: { work: "check", color: ROLE_HAT.graphite },
  // Write: the words someone else reads. Onboarding belongs here — its whole output is two documents.
  "tech-writer": { work: "write", color: ROLE_HAT.bone },
  onboarding: { work: "write", color: ROLE_HAT.white },
  // Operate: the plant itself — how it ships, and the data flowing through it.
  devops: { work: "operate", color: ROLE_HAT.graphite },
  data: { work: "operate", color: ROLE_HAT.steel },
  // …and the one role that declares nothing: the pre-roles look, unchanged.
  generalist: { work: "none", color: ROLE_HAT.white },
};

/** Every role id this table knows a look for. Exported so a test can hold it against `roles/`. */
export const KNOWN_ROLE_IDS: readonly string[] = Object.keys(ROLE_WORK).sort();

/**
 * The look of an agent with no role, and of one wearing a role this build has never heard of.
 *
 * **The same look, on purpose.** A role file is the operator's to write, so an unknown id is the
 * normal case rather than an error, and the honest drawing of "we do not know what this agent's job
 * is" is the plain hard hat and the empty hand — the figure the factory drew before roles existed.
 * Inventing a silhouette from a hash of the id would put a spanner in the hand of a role that never
 * builds anything, and the operator could not tell that from a real reading.
 */
export const PLAIN_LOOK: RoleLook = {
  work: "none",
  shape: "hard",
  color: ROLE_HAT.white,
  carry: "none",
};

/** What this agent looks like. `null` (no role) and an unknown id both give `PLAIN_LOOK`. */
export function roleLook(roleId: string | null): RoleLook {
  if (roleId === null) return PLAIN_LOOK;
  const entry = ROLE_WORK[roleId];
  if (entry === undefined) return PLAIN_LOOK;
  return {
    work: entry.work,
    shape: SHAPE_FOR_WORK[entry.work],
    color: entry.color,
    carry: CARRY_FOR_WORK[entry.work],
  };
}

/**
 * What kind of work a role does, which is what a room is furnished for. Separate from `roleLook` so
 * `props.ts` can ask the cheaper question without pulling three-dimensional facts about hats into a
 * module that only cares what furniture to draw.
 */
export function roleWork(roleId: string | null): WorkKind {
  if (roleId === null) return "none";
  return ROLE_WORK[roleId]?.work ?? "none";
}
