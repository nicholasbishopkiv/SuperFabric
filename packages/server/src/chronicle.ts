import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
import type { ProjectManager } from "./projectManager.js";

/**
 * Where ADRs live inside a project, relative to its root. The same place this repository keeps its
 * own (`docs/decisions/0001-bun-runtime-keep-vite.md` and friends) — the worked example the format
 * is copied from, and the reason an agent that greps for prior reasoning finds it where it expects.
 */
export const DECISIONS_DIRNAME = path.join("docs", "decisions");

/** Longest slug taken from a title. Long enough to read in `ls`, short enough to stay a filename. */
const MAX_SLUG_CHARS = 60;

/** How many `NNNN-<slug>.md` collisions to walk past before giving up. */
const MAX_NUMBER_PROBES = 100;

/** How much of a matching body a search result quotes. */
const SNIPPET_TOKENS = 20;

/** Terms taken from one search query; more than this is a paste, not a question. */
const MAX_QUERY_TERMS = 20;

/** What a decision is, once recorded: a row, and the file the row indexes. */
export interface DecisionRecord {
  id: string;
  projectId: string;
  roomId: string | null;
  agentId: string | null;
  taskId: string | null;
  /** ADR number, taken from the decisions folder — this repo's own would continue at 0004. */
  number: number;
  /** Absolute path of the markdown file. **This** is the artefact; the row is an index over it. */
  path: string;
  title: string;
  context: string;
  decision: string;
  alternatives: string;
  links: string[];
  createdAt: number;
}

export interface RecordDecisionOptions {
  projectId: string;
  roomId?: string | null;
  agentId?: string | null;
  taskId?: string | null;
  title: string;
  context: string;
  decision: string;
  alternatives?: string;
  links?: string[];
}

/** One hit: enough to act on without opening anything — what, when, who, and the matching text. */
export interface ChronicleHit {
  /** `decision` is written-down reasoning; `event` is something that was actually said at the time. */
  kind: "decision" | "event";
  /** The decision's title, or the event's type. */
  title: string;
  /** The matching part of the body, with an ellipsis where it was cut. */
  snippet: string;
  createdAt: number;
  /** Decision id, or the session id whose log this came from. */
  ref: string;
  /** Event seq within that session's log; 0 for a decision. */
  seq: number;
  /** The room it came from, when there was one. */
  roomId: string | null;
  /** The ADR file, for a decision. `null` for an event, which has no file of its own. */
  path: string | null;
}

/** Row shape of `decisions`. */
interface DecisionRow {
  id: string;
  project_id: string;
  room_id: string | null;
  agent_id: string | null;
  task_id: string | null;
  number: number;
  path: string;
  title: string;
  context: string;
  decision: string;
  alternatives: string;
  links: string;
  created_at: number;
}

/**
 * The Chronicle: why this project is the way it is.
 *
 * **Repo-native first.** Recording a decision writes an ADR markdown file into the project's own
 * `docs/decisions/`, and *that file is the artefact*. Someone who clones the repository, never runs
 * SuperFabric and greps for "webhook" has to find the reasoning — so the row in `decisions` is an
 * index entry pointing at a file, never the only copy of it.
 *
 * The FTS5 table spans two sources at once (see migration 8): the decisions, and the meaningful text
 * of the event log. One query therefore answers both "was this decided?" and "what did anyone
 * actually say about it?", which are usually the same question asked by someone who does not yet
 * know a decision exists. Keeping the index in step is the triggers' job, not this class's: every
 * write path is covered by construction, including the ones that never come through here.
 */
export class Chronicle {
  private readonly stmts;

  constructor(
    private db: Db,
    private projects: ProjectManager,
    /** Seam: `unixepoch()`-resolution timestamps are untestable against a real clock. */
    private now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.stmts = {
      insert: db.prepare(`
        INSERT INTO decisions
          (id, project_id, room_id, agent_id, task_id, number, path, title, context, decision,
           alternatives, links, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      one: db.prepare("SELECT * FROM decisions WHERE id = ?"),
      list: db.prepare(
        "SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      ),
      highestNumber: db.prepare(
        "SELECT COALESCE(MAX(number), 0) AS n FROM decisions WHERE project_id = ?",
      ),
      // Newest first rather than by rank: an agent asking "why is this like this?" wants the most
      // recent word on it — an older decision that scores better is very often the one that was
      // superseded. `rowid` breaks ties, because unixepoch() has one-second resolution.
      search: db.prepare(`
        SELECT kind, ref, seq, room_id, created_at, title,
               snippet(chronicle_fts, 1, '', '', '…', ${SNIPPET_TOKENS}) AS snippet
        FROM chronicle_fts
        WHERE chronicle_fts MATCH ? AND project_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      `),
      pathOf: db.prepare("SELECT path FROM decisions WHERE id = ?"),
    };
  }

  /**
   * Record a decision: the ADR file, then the row.
   *
   * **That order is the design.** The file is the artefact and the row is an index over it: if the
   * insert fails there is an orphan ADR in the repository, which is greppable and fixable, whereas a
   * row written first and a failed write would leave an index entry pointing at nothing — the
   * Chronicle claiming reasoning exists when it does not.
   */
  record(opts: RecordDecisionOptions): DecisionRecord {
    const title = opts.title.trim();
    if (title === "") throw new Error("a decision needs a title");
    const decision = opts.decision.trim();
    if (decision === "") throw new Error("a decision needs to say what was decided");

    const root = this.projects.root(opts.projectId);
    const dir = path.join(root, DECISIONS_DIRNAME);
    mkdirSync(dir, { recursive: true });

    const createdAt = this.now();
    const links = (opts.links ?? []).map((l) => l.trim()).filter((l) => l !== "");
    const draft = {
      id: randomUUID(),
      projectId: opts.projectId,
      roomId: opts.roomId ?? null,
      agentId: opts.agentId ?? null,
      taskId: opts.taskId ?? null,
      title,
      context: opts.context.trim(),
      decision,
      alternatives: (opts.alternatives ?? "").trim(),
      links,
      createdAt,
    };

    const written = this.writeAdr(dir, this.nextNumber(opts.projectId, dir), draft);
    const record: DecisionRecord = { ...draft, number: written.number, path: written.path };
    this.stmts.insert.run(
      record.id, record.projectId, record.roomId, record.agentId, record.taskId,
      record.number, record.path, record.title, record.context, record.decision,
      record.alternatives, record.links.join("\n"), record.createdAt,
    );
    return record;
  }

  /**
   * Search decisions *and* the event log at once, newest first.
   *
   * An empty chronicle, a query with nothing searchable in it, and a query that matches nothing all
   * return `[]`. None of them is an error: "nobody has written this down" is the answer, and an
   * agent that gets an exception instead learns nothing and retries.
   */
  search(projectId: string, query: string, limit = 10): ChronicleHit[] {
    const match = ftsQuery(query);
    if (match === null) return [];
    const rows = this.stmts.search.all(match, projectId, Math.max(1, Math.min(limit, 50))) as {
      kind: string; ref: string; seq: number; room_id: string | null; created_at: number;
      title: string; snippet: string;
    }[];
    return rows.map((r) => {
      const kind = r.kind === "decision" ? "decision" as const : "event" as const;
      return {
        kind,
        title: r.title,
        snippet: r.snippet,
        createdAt: r.created_at,
        ref: r.ref,
        seq: r.seq,
        roomId: r.room_id,
        path: kind === "decision" ? this.pathOf(r.ref) : null,
      };
    });
  }

  /** One factory's decisions, newest first. */
  list(projectId: string, limit = 50): DecisionRecord[] {
    return (this.stmts.list.all(projectId, limit) as DecisionRow[]).map(toDecisionRecord);
  }

  /** `undefined` for an unknown id — the absent-row shape the rest of the package speaks. */
  get(id: string): DecisionRecord | undefined {
    // `== null`, not `=== undefined`: "no such row" is `null` for the driver db.ts uses.
    const row = this.stmts.one.get(id) as DecisionRow | null;
    return row == null ? undefined : toDecisionRecord(row);
  }

  private pathOf(id: string): string | null {
    const row = this.stmts.pathOf.get(id) as { path: string } | null;
    return row == null ? null : row.path;
  }

  /**
   * The next ADR number: one past the highest already on disk *or* already recorded.
   *
   * Disk first, because the folder is the artefact — a repository that already holds
   * `0003-ui-library.md` continues at 0004 whether or not this database has ever seen it, which is
   * what makes the Chronicle continuous with decisions a human wrote by hand.
   */
  private nextNumber(projectId: string, dir: string): number {
    let highest = (this.stmts.highestNumber.get(projectId) as { n: number }).n;
    let names: string[];
    try { names = readdirSync(dir); }
    catch { names = []; }
    for (const name of names) {
      const match = /^(\d{4,})-/.exec(name);
      if (match !== null) highest = Math.max(highest, Number(match[1]));
    }
    return highest + 1;
  }

  /**
   * Write the ADR, claiming its number by *creating the file exclusively*.
   *
   * `wx` rather than a check-then-write: two decisions recorded in the same second would otherwise
   * both compute the same next number and the second would silently overwrite the first. The loop
   * walks forward until a name is genuinely free, so the collision costs a number and never a file.
   */
  private writeAdr(
    dir: string,
    from: number,
    draft: Omit<DecisionRecord, "number" | "path">,
  ): { number: number; path: string } {
    const slug = slugify(draft.title);
    for (let number = from; number < from + MAX_NUMBER_PROBES; number++) {
      const file = path.join(dir, `${String(number).padStart(4, "0")}-${slug}.md`);
      try {
        writeFileSync(file, adrMarkdown(number, draft), { flag: "wx" });
        return { number, path: file };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    throw new Error(`could not find a free ADR number in ${dir} after ${MAX_NUMBER_PROBES} tries`);
  }
}

/**
 * The ADR itself, in the same shape as this repository's own `docs/decisions/`: a numbered title, a
 * one-line metadata rule, then Context / Decision and whatever else was given. Empty sections are
 * omitted rather than left as headings with nothing under them — a heading is a promise.
 */
function adrMarkdown(number: number, d: Omit<DecisionRecord, "number" | "path">): string {
  const meta = [`Date: ${isoDate(d.createdAt)}`, "Status: accepted"];
  const lines = [
    `# ${String(number).padStart(4, "0")} — ${d.title}`,
    "",
    meta.join(" · "),
    "",
    "## Context",
    "",
    d.context === "" ? "_Not recorded._" : d.context,
    "",
    "## Decision",
    "",
    d.decision,
  ];
  if (d.alternatives !== "") lines.push("", "## Alternatives", "", d.alternatives);
  if (d.links.length > 0) lines.push("", "## Links", "", ...d.links.map((l) => `- ${l}`));
  lines.push("");
  return lines.join("\n");
}

function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** A title as one filename segment: lowercase, words joined by dashes, nothing else. */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/, "");
  return slug === "" ? "decision" : slug;
}

/**
 * Turn whatever an agent typed into an FTS5 expression that cannot throw.
 *
 * FTS5's query language has operators (`"`, `*`, `NEAR`, `-`, `:`), and an unbalanced quote is a
 * syntax error — so a model searching `the "retry policy` would get an exception instead of an
 * answer. Every term is therefore extracted and re-quoted as a one-word phrase, which makes any
 * input syntactically valid and means no punctuation an agent happens to type can change what the
 * query *means*.
 *
 * Terms are joined by FTS5's implicit AND: "webhook retry policy" finds the row about all three
 * rather than every row that ever said "policy". `null` for a query with nothing searchable in it.
 */
export function ftsQuery(raw: string): string | null {
  const terms = (raw.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, MAX_QUERY_TERMS);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(" ");
}

function toDecisionRecord(row: DecisionRow): DecisionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    roomId: row.room_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    number: row.number,
    path: row.path,
    title: row.title,
    context: row.context,
    decision: row.decision,
    alternatives: row.alternatives,
    links: row.links === "" ? [] : row.links.split("\n"),
    createdAt: row.created_at,
  };
}
