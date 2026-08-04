import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Where skills live on this machine, and how one gets into a room's folder.
 *
 * **A skill is a directory with a `SKILL.md` in it**, and installing one is copying that directory to
 * `<room>/.claude/skills/<name>/`. That is the whole mechanic, and it is why installing is a file
 * copy rather than a registration: Claude Code discovers project skills from the folder it is run in,
 * so a room that has them is a room a plain `claude` session in that folder also has them in — with
 * or without SuperFabric running. The repository stays self-contained, which is the same property
 * "room = folder" and the repo-native ADRs are after.
 *
 * **Nothing here invents a skill.** A role names a directory name; this resolves it against the
 * directories that actually exist on the machine, and a name that resolves to nothing is *reported*.
 * An aspirational skill reference is worse than none — the operator picks a role, the agent arrives
 * without the thing they picked it for, and no surface anywhere says so.
 */

/** The directory a room's skills live in, relative to the room's own folder. */
export const ROOM_SKILLS_DIR = path.join(".claude", "skills");

/** The file that makes a directory a skill. Its absence means the directory is something else. */
const SKILL_MANIFEST = "SKILL.md";

/**
 * Ceilings on what may be copied into the operator's repository in one go.
 *
 * A skill pack is normally tens of files and a few hundred kilobytes; the largest real one measured
 * here (`impeccable`, with its scripts) is 143 files and 3.2 MB. Anything wildly past that is either
 * not a skill or has a `node_modules` in it, and quietly writing it into someone's repo — where it
 * would then be committed — is not a thing to do on their behalf. Refused and reported, not truncated:
 * half a skill would be worse than none.
 */
const MAX_SKILL_FILES = 2_000;
const MAX_SKILL_BYTES = 32 * 1024 * 1024;

/** Environment override for the search path, `:`-separated. Replaces the defaults rather than adding. */
export const SKILL_PATH_ENV = "SUPERFABRIC_SKILL_PATH";

/** What one `installInto` did, per skill named. Every name in the request appears in exactly one list. */
export interface SkillInstallReport {
  /** Copied in just now. */
  installed: string[];
  /** A directory of that name was already in the room; left exactly as it was. */
  kept: string[];
  /** Nothing on the search path has this name. The role asked for something this machine lacks. */
  missing: string[];
  /** Found, but refused — too large to write into a repository unasked. Carries the reason. */
  refused: { name: string; reason: string }[];
}

export interface SkillLibraryOptions {
  /**
   * The search path, in order. Omitted => `SUPERFABRIC_SKILL_PATH` if set, else the machine's own
   * skill directories. Given, it is used verbatim — the test seam, and an operator who keeps their
   * packs somewhere else.
   */
  roots?: string[];
  /** Home directory to derive the default roots from. Only tests pass one. */
  home?: string;
}

export class SkillLibrary {
  private readonly configuredRoots: string[] | undefined;
  private readonly home: string;

  constructor(opts: SkillLibraryOptions = {}) {
    this.configuredRoots = opts.roots;
    this.home = opts.home ?? homedir();
  }

  /**
   * The directories searched for skills, in priority order.
   *
   * Recomputed on every call rather than cached: a plugin installed while the server is up should be
   * usable without a restart, for the same reason an edited role file is. It is a handful of
   * `readdir`s on a path that is only walked when a role is applied.
   *
   * The default path is the two places Claude Code itself keeps them:
   *
   * 1. `~/.claude/skills` — the operator's own.
   * 2. `~/.claude/plugins/cache/<marketplace>/<plugin>[/<version>]/skills` — installed plugin packs.
   *    Both layouts are matched because both exist in the wild, and versions are walked
   *    newest-name-first so an upgraded pack wins over the copy of itself it replaced.
   */
  roots(): string[] {
    if (this.configuredRoots !== undefined) return this.configuredRoots.filter(isDirectory);
    const fromEnv = process.env[SKILL_PATH_ENV];
    if (fromEnv !== undefined && fromEnv.trim() !== "") {
      return fromEnv.split(path.delimiter).map((p) => p.trim()).filter((p) => p !== "").filter(isDirectory);
    }
    return this.defaultRoots();
  }

  private defaultRoots(): string[] {
    const claude = path.join(this.home, ".claude");
    const roots = [path.join(claude, "skills")];
    const cache = path.join(claude, "plugins", "cache");
    for (const marketplace of subdirectories(cache)) {
      for (const plugin of subdirectories(marketplace)) {
        roots.push(path.join(plugin, "skills"));
        // A versioned layout: `<plugin>/6.2.0/skills`. Descending, so the newest directory name is
        // searched first — a plain lexical sort, which is right for the `major.minor.patch` names
        // seen in practice and is at worst a stable, explainable choice for anything else.
        for (const version of subdirectories(plugin).sort().reverse()) {
          roots.push(path.join(version, "skills"));
        }
      }
    }
    return roots.filter(isDirectory);
  }

  /** Where this skill's directory is, or `undefined` when no root has one by that name. */
  find(name: string): string | undefined {
    for (const root of this.roots()) {
      const dir = path.join(root, name);
      // The manifest is what distinguishes a skill from any other folder someone left there.
      if (isDirectory(dir) && existsSync(path.join(dir, SKILL_MANIFEST))) return dir;
    }
    return undefined;
  }

  has(name: string): boolean {
    return this.find(name) !== undefined;
  }

  /** Every skill name the search path offers, deduplicated, first root winning. */
  list(): string[] {
    const seen = new Set<string>();
    for (const root of this.roots()) {
      for (const dir of subdirectories(root)) {
        if (!existsSync(path.join(dir, SKILL_MANIFEST))) continue;
        seen.add(path.basename(dir));
      }
    }
    return [...seen].sort();
  }

  /**
   * Put these skills into a folder's `.claude/skills/`.
   *
   * **A skill directory that is already there is never touched.** Not the files inside it either: the
   * operator may have edited the charter, and merging our copy into theirs would produce a
   * half-and-half skill neither of us wrote — the discipline `RoomManager` already applies to a room's
   * `CLAUDE.md`, applied to a directory. Deleting the folder is how an operator asks for a fresh copy,
   * and it is a thing they can see and undo.
   *
   * Every requested name comes back in exactly one bucket of the report, so a caller can say out loud
   * what actually landed instead of implying it all did.
   */
  installInto(targetDir: string, names: readonly string[]): SkillInstallReport {
    const report: SkillInstallReport = { installed: [], kept: [], missing: [], refused: [] };
    if (names.length === 0) return report;

    const skillsDir = path.join(targetDir, ROOM_SKILLS_DIR);
    for (const name of names) {
      const dest = path.join(skillsDir, name);
      if (existsSync(dest)) {
        report.kept.push(name);
        continue;
      }
      const source = this.find(name);
      if (source === undefined) {
        report.missing.push(name);
        continue;
      }
      const size = measure(source);
      if (size.files > MAX_SKILL_FILES || size.bytes > MAX_SKILL_BYTES) {
        report.refused.push({
          name,
          reason: `${size.files} files / ${Math.round(size.bytes / 1024 / 1024)} MB is too large to `
            + "copy into a repository unasked",
        });
        continue;
      }
      mkdirSync(skillsDir, { recursive: true });
      // `force: false` is belt-and-braces — `dest` does not exist, checked above — and
      // `dereference` so a pack held together by symlinks arrives as files rather than as links
      // into the operator's home that a clone of the repository would not have.
      cpSync(source, dest, { recursive: true, force: false, errorOnExist: false, dereference: true });
      report.installed.push(name);
    }
    return report;
  }
}

/** One line describing an install, or `null` when there is nothing worth saying. */
export function describeInstall(report: SkillInstallReport): string | null {
  const parts: string[] = [];
  if (report.installed.length > 0) parts.push(`installed ${report.installed.join(", ")}`);
  if (report.kept.length > 0) parts.push(`kept the existing ${report.kept.join(", ")}`);
  // The two that are *problems* are worded as problems: a role whose skills did not arrive has to
  // read as a partial success, not as a success.
  if (report.missing.length > 0) {
    parts.push(`not installed on this machine: ${report.missing.join(", ")}`);
  }
  for (const { name, reason } of report.refused) parts.push(`refused ${name} (${reason})`);
  return parts.length === 0 ? null : parts.join("; ");
}

function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** Absolute paths of the subdirectories of `dir`, or nothing when it is not one. */
function subdirectories(dir: string): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
}

/** How many files a directory tree holds and how many bytes, for the ceilings above. */
function measure(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string): void => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      files += 1;
      try { bytes += statSync(full).size; } catch { /* vanished mid-walk; not worth failing over */ }
      // A runaway tree must not cost an unbounded walk just to be refused.
      if (files > MAX_SKILL_FILES) return;
    }
  };
  walk(dir);
  return { files, bytes };
}
