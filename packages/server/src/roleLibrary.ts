import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RoleSpec, type RoleProblem } from "@superfabric/shared";

/**
 * The role library: the presets SuperFabric ships, plus whatever the operator has written.
 *
 * **A role is a file, not a row.** It is content — a charter, a model, a list of skills — and content
 * belongs in something an operator can read, diff, fork and put in their own repository. That decides
 * nearly everything else here: the shipped presets live in `roles/*.yaml` at the product's root, the
 * operator's own live in `<data dir>/roles/*.yaml` and override by `id`, and an edited file is picked
 * up without bouncing the server, because someone tuning a preset should not have to.
 *
 * **A broken file is reported, never skipped.** `problems()` is as much a part of the answer as
 * `list()` is: a preset that quietly vanished from the picker because of a stray tab is the failure
 * mode a hand-written config format exists to design against, and so is a typo'd field name — which
 * is why `RoleSpec` is `.strict()` and an unknown key is an error rather than a shrug.
 *
 * YAML rather than JSON because these files are mostly prose: a charter written as a JSON string
 * literal, with `\n` for every line break, is a file nobody would edit twice. The parser is
 * **`Bun.YAML.parse`**, built into the runtime this package already requires (Bun 1.3+), so the
 * format costs no dependency at all.
 */

/** Where the shipped presets live, relative to the product root. */
const SHIPPED_DIRNAME = "roles";

/** Where an operator's own presets live, relative to the data directory. */
export const USER_ROLES_DIRNAME = "roles";

/** Environment override for the shipped directory. The test seam; also useful to an operator forking. */
export const ROLES_DIR_ENV = "SUPERFABRIC_ROLES";

export interface RoleLibraryOptions {
  /**
   * The shipped presets. Omitted => `SUPERFABRIC_ROLES` if set, else `roles/` beside this package's
   * repository root, which is where the product's own files are.
   */
  shippedDir?: string;
  /**
   * The operator's overrides, by id. Omitted => no override directory, which is a valid shape rather
   * than a broken one: a server whose data directory has no `roles/` simply ships what it shipped.
   */
  userDir?: string;
}

/** A loaded file, with where it came from — kept so an override can say what it replaced. */
interface Loaded {
  spec: RoleSpec;
  file: string;
}

export class RoleLibrary {
  private readonly shippedDir: string;
  private readonly userDir: string | undefined;
  /** id -> the winning spec. Rebuilt whenever the files on disk have moved. */
  private byId = new Map<string, Loaded>();
  private loadProblems: RoleProblem[] = [];
  /**
   * What the two directories looked like the last time we read them: every file's path, size and
   * mtime, folded into one string.
   *
   * This is the whole reload mechanism, and it is a signature rather than a watcher on purpose — a
   * watcher is a resource with a lifetime, and this is asked about a handful of times per socket. An
   * edited preset is picked up on the next `list()` or `get()`, which is the next time anybody looks.
   */
  private signature: string | null = null;

  constructor(opts: RoleLibraryOptions = {}) {
    this.shippedDir = opts.shippedDir ?? process.env[ROLES_DIR_ENV] ?? defaultShippedDir();
    this.userDir = opts.userDir;
  }

  /** Every role, by id. Shipped and user files are one list — an override replaces, it does not add. */
  list(): RoleSpec[] {
    this.refresh();
    return [...this.byId.values()].map((l) => l.spec).sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): RoleSpec | undefined {
    this.refresh();
    return this.byId.get(id)?.spec;
  }

  /** The files that did not load, and why. Part of the answer, not an aside. */
  problems(): RoleProblem[] {
    this.refresh();
    return [...this.loadProblems];
  }

  /** Which file a role came from — the honest answer to "why is this one different from the docs?". */
  fileOf(id: string): string | undefined {
    this.refresh();
    return this.byId.get(id)?.file;
  }

  /** Re-read both directories now, whatever the signature says. */
  reload(): void {
    this.signature = null;
    this.refresh();
  }

  /** Re-read only if something on disk has changed since the last read. */
  private refresh(): void {
    const signature = this.signatureOf();
    if (signature === this.signature) return;
    this.signature = signature;

    const byId = new Map<string, Loaded>();
    const problems: RoleProblem[] = [];
    // Shipped first, then the operator's: a later file with the same id wins, which is what "user
    // overrides by id" means. A *duplicate within one directory* is a different thing — nobody
    // intended it, and picking one silently would make the picker depend on readdir order.
    for (const dir of [this.shippedDir, this.userDir]) {
      if (dir === undefined) continue;
      const seenHere = new Map<string, string>();
      for (const file of roleFiles(dir)) {
        const loaded = readRole(file);
        if ("message" in loaded) { problems.push({ file, message: loaded.message }); continue; }
        const clash = seenHere.get(loaded.spec.id);
        if (clash !== undefined) {
          problems.push({
            file,
            message: `role id ${JSON.stringify(loaded.spec.id)} is already defined by ${clash} in the `
              + "same directory — one of the two files has to change",
          });
          continue;
        }
        seenHere.set(loaded.spec.id, file);
        byId.set(loaded.spec.id, { spec: loaded.spec, file });
      }
    }
    this.byId = byId;
    this.loadProblems = problems;
  }

  /** Path, size and mtime of every role file, in a stable order. See `signature`. */
  private signatureOf(): string {
    const parts: string[] = [];
    for (const dir of [this.shippedDir, this.userDir]) {
      if (dir === undefined) continue;
      for (const file of roleFiles(dir)) {
        try {
          const st = statSync(file);
          parts.push(`${file}:${st.size}:${st.mtimeMs}`);
        } catch {
          // Vanished between the listing and the stat. Treat it as a change so the next read sees it.
          parts.push(`${file}:gone`);
        }
      }
    }
    return parts.join("\n");
  }
}

/** The `.yaml`/`.yml` files of one directory, sorted so a listing is stable across machines. */
function roleFiles(dir: string): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/**
 * One file to one spec, or to the reason it is not one.
 *
 * Three ways a file can fail, and all three name the file: unreadable, not YAML, or YAML that is not
 * a role. The third is the interesting one — `RoleSpec` is `.strict()`, so `skill:` where `skills:`
 * was meant comes back here as "unrecognized key", which is exactly what the operator needs to read.
 */
function readRole(file: string): { spec: RoleSpec } | { message: string } {
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (err) { return { message: `could not be read: ${String(err)}` }; }

  let raw: unknown;
  try { raw = Bun.YAML.parse(text); }
  catch (err) { return { message: `is not valid YAML: ${messageOf(err)}` }; }

  // `Bun.YAML.parse` answers `null` for an empty document and an *array* for a multi-document file.
  // Both are legal YAML and neither is a role, so they are said out loud rather than crashing the
  // schema with a type error the operator would have to decode.
  if (raw === null || raw === undefined) return { message: "is empty" };
  if (Array.isArray(raw)) {
    return { message: "holds several YAML documents; a role file is one role" };
  }

  const parsed = RoleSpec.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length === 0 ? "(root)" : i.path.join(".")}: ${i.message}`)
      .join("; ");
    return { message: `is not a role: ${issues}` };
  }
  return { spec: parsed.data };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `roles/` at the product's own root — four levels up from this file
 * (`<root>/packages/server/src/roleLibrary.ts`).
 *
 * Derived from `import.meta.url` rather than from `process.cwd()`, because the server is routinely
 * started from the operator's project folder: a cwd-relative path would look for SuperFabric's
 * presets inside whatever repository the factory happens to be pointed at.
 */
function defaultShippedDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", SHIPPED_DIRNAME);
}
