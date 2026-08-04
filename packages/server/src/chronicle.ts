import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChronicleHit } from "@superfabric/shared";
import type { Db } from "./db.js";
import type { ProjectManager } from "./projectManager.js";

/**
 * A hit is a **wire** type: the HUD's chronicle surface shows exactly what `factory_search_history`
 * shows an agent, so the shape is declared once in `@superfabric/shared` and re-exported here rather
 * than described twice. Two descriptions of one row is how a panel ends up missing the field that
 * makes a result actionable.
 */
export type { ChronicleHit };

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
      // Index rows only, and only when the whole factory goes. The FTS entries follow by trigger
      // (migration 16) rather than by a second statement here, for migration 8's reason: the index is
      // kept in step by construction, not by every delete path remembering.
      deleteForProject: db.prepare("DELETE FROM decisions WHERE project_id = ?"),
    };
  }

  /**
   * Forget a factory's decision *index*. Only ever called while the factory itself is being removed.
   *
   * **The ADR files are not touched, and that is the whole point of the design.** A decision is the
   * markdown file in the project's own `docs/decisions/`; this table is an index over it. Someone who
   * clones that repository must still find the reasoning, whether or not the factory that produced it
   * was ever removed from a switcher — deleting their files because they closed a floor would be
   * SuperFabric taking something that was never ours.
   */
  deleteForProject(projectId: string): number {
    return this.stmts.deleteForProject.run(projectId).changes;
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
   * Index an ADR that is **already in the repository** — the import path, and nothing else.
   *
   * `record` writes the file and then the row, because the file is the artefact. Importing a factory
   * inverts that: the ADR arrived with the repository (it is a committed file), and what is missing is
   * the index entry over it. So this is the one write path that does not create a file — and it
   * **refuses** when the file is not there, which is what keeps the invariant intact rather than
   * quietly making the Chronicle claim reasoning that does not exist.
   *
   * The body is read off disk rather than carried in the export, so the FTS index is built from the
   * real ADR and there is never a second copy of a decision's text to go stale. A file we cannot read
   * is refused for the same reason a missing one is.
   */
  indexImported(opts: {
    projectId: string;
    roomId: string | null;
    number: number;
    /** Absolute path of the ADR file, which must exist. */
    file: string;
    title: string;
    createdAt: number;
  }): DecisionRecord {
    let body: string;
    try { body = readFileSync(opts.file, "utf8"); }
    catch (err) { throw new Error(`the ADR file could not be read: ${String(err)}`); }

    const record: DecisionRecord = {
      id: randomUUID(),
      projectId: opts.projectId,
      roomId: opts.roomId,
      // Deliberately null: the agent and task that produced this decision were on another machine, and
      // an id from there resolves to nothing here. A wrong reference is worse than an absent one.
      agentId: null,
      taskId: null,
      number: opts.number,
      path: opts.file,
      title: opts.title,
      // The whole ADR as its own context, so a search finds every word the file actually contains.
      // `decision` may not be empty (the column is NOT NULL and the shape means something), and the
      // markdown is the most honest thing to put there: it *is* the decision, as written.
      context: "",
      decision: body,
      alternatives: "",
      links: [],
      createdAt: opts.createdAt,
    };
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

  /**
   * The newest decisions, in the same shape a search returns: what "no query" means.
   *
   * A chronicle surface that opened empty would ask the operator to guess a word before it showed
   * them this project has any recorded reasoning at all — and "what has been decided here?" is the
   * first question, not a search. The snippet is cut from the *context* (why it was a question)
   * rather than from the decision, because the title already says what was decided.
   */
  recentHits(projectId: string, limit = 10): ChronicleHit[] {
    return this.list(projectId, limit).map((d) => ({
      kind: "decision" as const,
      title: d.title,
      snippet: firstWords(d.context === "" ? d.decision : d.context),
      createdAt: d.createdAt,
      ref: d.id,
      seq: 0,
      roomId: d.roomId,
      path: d.path,
    }));
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

/**
 * The opening of a body, cut to the same length FTS5's `snippet()` produces, so a listed decision
 * and a matched one look like the same kind of thing in the same list. Whitespace is collapsed
 * because an ADR's context is markdown with line breaks in it and a one-line result is one line.
 */
function firstWords(text: string, tokens = SNIPPET_TOKENS): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter((w) => w !== "");
  if (words.length <= tokens) return words.join(" ");
  return `${words.slice(0, tokens).join(" ")}…`;
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
