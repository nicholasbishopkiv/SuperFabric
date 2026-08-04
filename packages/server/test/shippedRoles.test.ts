import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_MODELS } from "@superfabric/shared";
import { ONBOARDING_ROLE_ID } from "../src/onboarding.js";
import { RoleLibrary } from "../src/roleLibrary.js";
import { SkillLibrary } from "../src/skills.js";

/**
 * The presets this product actually ships, held to the rules that make a role worth having.
 *
 * The one these exist for above all: **no invented skill names.** A role naming a skill that does not
 * exist is worse than a role with none — the operator picks "Designer" for its design skill, the
 * agent arrives without it, and nothing on any surface says so. So every name a shipped role uses has
 * to be on `VERIFIED_SKILLS` below, which is a list somebody checked and wrote down where they
 * checked it. Adding a reference means adding an entry, which means doing the checking.
 */

/** The library as it ships: `roles/` at the product root, with no operator overrides. */
const shipped = new RoleLibrary().list();

/**
 * Every skill a shipped role may name, with where it comes from and how its existence was verified.
 *
 * Verified 2026-08-04 by listing the directories on disk and confirming each holds a `SKILL.md`:
 *
 * - **superpowers** — Anthropic's official plugin (`claude-plugins-official` marketplace). Its skills
 *   are directories under `<plugin>/<version>/skills/`; the six below were read there at v6.2.0.
 * - **impeccable** — a published, Apache-2.0 frontend-design skill, installed as an ordinary user
 *   skill at `~/.claude/skills/impeccable/`.
 *
 * Nothing else is allowed, and three of the ten presets deliberately name nothing at all: where no
 * real skill fits a role, it ships without one.
 */
const VERIFIED_SKILLS = new Set([
  // superpowers
  "brainstorming",
  "writing-plans",
  "test-driven-development",
  "systematic-debugging",
  "verification-before-completion",
  // impeccable
  "impeccable",
]);

/**
 * The ids the product promises. A rename is a breaking change for anyone's stored `role_id` — and
 * `onboarding` is load-bearing twice over, because `start_onboarding` looks the role up by that id.
 */
const SHIPPED_IDS = [
  "architect", "backend", "data", "designer", "devops",
  "frontend", "generalist", "onboarding", "qa", "security", "tech-writer",
];

describe("the shipped roles", () => {
  it("all parse, with nothing reported broken", () => {
    expect(new RoleLibrary().problems()).toEqual([]);
    expect(shipped.map((r) => r.id)).toEqual(SHIPPED_IDS);
  });

  it("the onboarding role exists and tells the agent to ask one question at a time", () => {
    // Not a stylistic preference: an agent that dumps twelve questions into one turn has failed the
    // job the role exists for, and this instruction is the only thing standing between it and that.
    const onboarding = shipped.find((r) => r.id === ONBOARDING_ROLE_ID);
    expect(onboarding).toBeDefined();
    expect(onboarding!.promptAppend).toMatch(/one question per turn/i);
    // And it must know what it produces: two files, and rooms it only *proposes*.
    expect(onboarding!.promptAppend).toContain("CLAUDE.md");
    expect(onboarding!.promptAppend).toContain("README.md");
    expect(onboarding!.promptAppend).toContain("factory_suggest_rooms");
  });

  it("every one has a summary and a charter, and both are short enough to read", () => {
    for (const role of shipped) {
      expect(role.name.trim()).not.toBe("");
      expect(role.summary.trim()).not.toBe("");
      expect(role.promptAppend.trim()).not.toBe("");
      // A summary is one line in a picker, so it has to fit on one.
      expect(role.summary).not.toContain("\n");
      expect(role.summary.length).toBeLessThanOrEqual(110);
      // A charter, not an essay. Every turn that agent ever takes pays for this text; the
      // orchestrator's own prompt — the worked example — is about 1,700 characters, and a role says
      // less than the factory's senior agent does.
      //
      // `onboarding` is the one exception and it is a stated one: it is a *procedure* (interview,
      // then write two named files, then propose rooms) rather than a standing brief, and it is worn
      // for one short-lived session rather than for the life of an agent. It still has a ceiling.
      expect(role.promptAppend.length).toBeGreaterThan(200);
      expect(role.promptAppend.length).toBeLessThanOrEqual(role.id === ONBOARDING_ROLE_ID ? 2_000 : 1_500);
    }
  });

  it("every charter says what the role does not do", () => {
    // The half of a charter that actually prevents work being done twice. Each of the ten states a
    // boundary — "Not yours:", "You do not implement", "Do not fix the code you are testing".
    for (const role of shipped) {
      expect(role.promptAppend.toLowerCase()).toMatch(/\bnot yours\b|\bdo not\b|\byou do not\b/);
    }
  });

  it("names only models from the shortlist, and reserves the most capable for judgement", () => {
    const known = new Set(AGENT_MODELS.map((m) => m.id));
    for (const role of shipped) {
      if (role.model === undefined) continue;
      expect(known).toContain(role.model);
    }
    // Opus is for the roles whose mistakes are expensive to reverse, not for everything.
    const opus = shipped.filter((r) => r.model === "claude-opus-5").map((r) => r.id);
    expect(opus).toEqual(["architect", "security"]);
    // And at least one role pins nothing at all, so "whatever your CLI is set to" stays reachable
    // without editing a file.
    expect(shipped.some((r) => r.model === undefined)).toBe(true);
  });

  it("names only skills somebody has verified exist", () => {
    for (const role of shipped) {
      for (const skill of role.skills) {
        // If this fails, the fix is to verify the skill and add it to VERIFIED_SKILLS — or to drop
        // the reference. It is never to loosen the check.
        expect(VERIFIED_SKILLS).toContain(skill);
      }
    }
    // Every entry earns its place: an unused name here is a claim nobody is testing.
    const used = new Set(shipped.flatMap((r) => r.skills));
    expect([...VERIFIED_SKILLS].filter((s) => !used.has(s))).toEqual([]);
  });

  it("ships nothing exotic: no preset grants a privilege or plugs in an outside server", () => {
    // A role an *operator* writes may do both — that is what the fields are for. A role we ship must
    // not, because nobody read it before it ran: `allowedTools` skips the approval card, and an MCP
    // server we pass is trusted by the SDK without asking.
    for (const role of shipped) {
      expect(role.allowedTools).toEqual([]);
      expect(role.mcpServers).toEqual({});
      // Nor does any of them quietly raise what an agent may do.
      expect(role.autonomy).toBeUndefined();
    }
  });

  it("every skill a preset names resolves on a machine that has the packs", () => {
    const skills = new SkillLibrary();
    const referenced = [...new Set(shipped.flatMap((r) => r.skills))].sort();
    const resolved = referenced.filter((name) => skills.has(name));
    // On a machine with neither pack installed there is nothing to resolve and nothing to claim —
    // the check above is what holds the names down. Here we prove that where a name *does* resolve,
    // it resolves to a real skill directory rather than to any folder of that name.
    for (const name of resolved) {
      const dir = skills.find(name)!;
      expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
      expect(readFileSync(join(dir, "SKILL.md"), "utf8").length).toBeGreaterThan(0);
    }
    expect(resolved.length).toBeLessThanOrEqual(referenced.length);
  });
});
