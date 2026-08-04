import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOM_SKILLS_DIR, SkillLibrary, describeInstall } from "../src/skills.js";

/**
 * Skills, as the thing a role actually delivers into a room.
 *
 * Two properties carry the weight. **A name that resolves to nothing is reported**, because a role
 * promising a skill the machine does not have is worse than a role with none — the operator picks it
 * and nothing anywhere says why the agent behaves like any other. And **a directory already in the
 * room is never touched**, which is the discipline `RoomManager` applies to a room's `CLAUDE.md`,
 * applied to a folder the operator may have edited.
 */

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sf-skills-"));
  const packA = join(root, "pack-a");
  const packB = join(root, "pack-b");
  const room = join(root, "room");
  mkdirSync(room, { recursive: true });
  const skill = (pack: string, name: string, body: string): string => {
    const dir = join(pack, name);
    mkdirSync(join(dir, "reference"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), body);
    writeFileSync(join(dir, "reference", "notes.md"), `notes for ${name}`);
    return dir;
  };
  return {
    root, packA, packB, room, skill,
    lib: (roots: string[] = [packA, packB]) => new SkillLibrary({ roots }),
    installed: (name: string, file = "SKILL.md") => join(room, ROOM_SKILLS_DIR, name, file),
    cleanup: () => { rmSync(root, { recursive: true, force: true }); },
  };
}

describe("skill library", () => {
  it("finds a skill by directory name, and only when it has a SKILL.md", () => {
    const f = fixture();
    try {
      f.skill(f.packA, "test-driven-development", "# TDD");
      // A folder with no manifest is something else the operator left there, not a skill.
      mkdirSync(join(f.packA, "notes"), { recursive: true });
      const lib = f.lib();
      expect(lib.find("test-driven-development")).toBe(join(f.packA, "test-driven-development"));
      expect(lib.has("notes")).toBe(false);
      expect(lib.find("nope")).toBeUndefined();
      expect(lib.list()).toEqual(["test-driven-development"]);
    } finally { f.cleanup(); }
  });

  it("the first root wins a name collision, deterministically", () => {
    const f = fixture();
    try {
      f.skill(f.packA, "review", "# from A");
      f.skill(f.packB, "review", "# from B");
      expect(f.lib([f.packA, f.packB]).find("review")).toBe(join(f.packA, "review"));
      expect(f.lib([f.packB, f.packA]).find("review")).toBe(join(f.packB, "review"));
    } finally { f.cleanup(); }
  });

  it("installs a skill into the room's .claude/skills, files and all", () => {
    const f = fixture();
    try {
      f.skill(f.packA, "tdd", "# TDD");
      const report = f.lib().installInto(f.room, ["tdd"]);
      expect(report).toEqual({ installed: ["tdd"], kept: [], missing: [], refused: [] });
      // The whole tree, not just the manifest: a skill's reference material is part of it.
      expect(readFileSync(f.installed("tdd"), "utf8")).toBe("# TDD");
      expect(readFileSync(f.installed("tdd", join("reference", "notes.md")), "utf8")).toBe("notes for tdd");
    } finally { f.cleanup(); }
  });

  it("never overwrites a skill the operator already has there", () => {
    const f = fixture();
    try {
      f.skill(f.packA, "tdd", "# ours");
      const dest = join(f.room, ROOM_SKILLS_DIR, "tdd");
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "SKILL.md"), "# theirs, edited");

      const report = f.lib().installInto(f.room, ["tdd"]);
      expect(report.kept).toEqual(["tdd"]);
      expect(report.installed).toEqual([]);
      // Their edit survives, and so does the fact that nothing new was merged into it.
      expect(readFileSync(f.installed("tdd"), "utf8")).toBe("# theirs, edited");
      expect(existsSync(f.installed("tdd", join("reference", "notes.md")))).toBe(false);
    } finally { f.cleanup(); }
  });

  it("reports a name nothing on the search path has, rather than installing nothing quietly", () => {
    const f = fixture();
    try {
      f.skill(f.packA, "tdd", "# TDD");
      const report = f.lib().installInto(f.room, ["tdd", "does-not-exist"]);
      expect(report.installed).toEqual(["tdd"]);
      expect(report.missing).toEqual(["does-not-exist"]);
      expect(describeInstall(report)).toBe("installed tdd; not installed on this machine: does-not-exist");
    } finally { f.cleanup(); }
  });

  it("copies through a symlink, so a room does not depend on the operator's home directory", () => {
    const f = fixture();
    try {
      const real = join(f.root, "real-notes.md");
      writeFileSync(real, "the real thing");
      const dir = f.skill(f.packA, "linked", "# linked");
      symlinkSync(real, join(dir, "linked.md"));
      f.lib().installInto(f.room, ["linked"]);
      // A clone of the repository has the file, not a dangling link into somebody's home.
      expect(readFileSync(f.installed("linked", "linked.md"), "utf8")).toBe("the real thing");
    } finally { f.cleanup(); }
  });

  it("asking for nothing writes nothing — no empty .claude/skills appears in the room", () => {
    const f = fixture();
    try {
      expect(f.lib().installInto(f.room, [])).toEqual({
        installed: [], kept: [], missing: [], refused: [],
      });
      expect(existsSync(join(f.room, ".claude"))).toBe(false);
      expect(describeInstall({ installed: [], kept: [], missing: [], refused: [] })).toBeNull();
    } finally { f.cleanup(); }
  });

  it("a root that does not exist is simply not searched", () => {
    const f = fixture();
    try {
      f.skill(f.packA, "tdd", "# TDD");
      const lib = f.lib([join(f.root, "gone"), f.packA]);
      expect(lib.roots()).toEqual([f.packA]);
      expect(lib.has("tdd")).toBe(true);
    } finally { f.cleanup(); }
  });

  it("defaults to the machine's own skill directories, and reads SUPERFABRIC_SKILL_PATH over them", () => {
    const f = fixture();
    try {
      const home = join(f.root, "home");
      mkdirSync(join(home, ".claude", "skills", "mine"), { recursive: true });
      writeFileSync(join(home, ".claude", "skills", "mine", "SKILL.md"), "# mine");
      // The versioned plugin layout, which is what an installed pack actually looks like on disk.
      const plugin = join(home, ".claude", "plugins", "cache", "official", "superpowers");
      mkdirSync(join(plugin, "6.2.0", "skills", "tdd"), { recursive: true });
      writeFileSync(join(plugin, "6.2.0", "skills", "tdd", "SKILL.md"), "# 6.2.0");
      mkdirSync(join(plugin, "5.1.0", "skills", "tdd"), { recursive: true });
      writeFileSync(join(plugin, "5.1.0", "skills", "tdd", "SKILL.md"), "# 5.1.0");

      const lib = new SkillLibrary({ home });
      expect(lib.has("mine")).toBe(true);
      // The newer directory wins, so an upgraded pack is not shadowed by the copy it replaced.
      expect(readFileSync(join(lib.find("tdd")!, "SKILL.md"), "utf8")).toBe("# 6.2.0");

      const before = process.env.SUPERFABRIC_SKILL_PATH;
      process.env.SUPERFABRIC_SKILL_PATH = f.packA;
      try {
        f.skill(f.packA, "elsewhere", "# elsewhere");
        const overridden = new SkillLibrary({ home });
        // Replaces the defaults rather than adding to them: an operator who says where their skills
        // are is answering the question, not contributing to it.
        expect(overridden.list()).toEqual(["elsewhere"]);
      } finally {
        if (before === undefined) delete process.env.SUPERFABRIC_SKILL_PATH;
        else process.env.SUPERFABRIC_SKILL_PATH = before;
      }
    } finally { f.cleanup(); }
  });
});
