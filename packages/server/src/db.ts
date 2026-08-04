import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { Database } from "bun:sqlite";

/**
 * The only file in the package that names the SQLite driver. Everything else takes a `Db`, so
 * swapping the driver again stays a one-file change (see docs/decisions/0001-bun-runtime-keep-vite.md).
 */
export type Db = Database;

/**
 * A migration step. Plain SQL for everything that can be said in SQL; a function for the one thing
 * that cannot — step 5 has to *decide* which project existing rows belong to, which means reading
 * rows and the environment, and generating an id.
 */
type Migration = string | ((db: Db) => void);

/**
 * Ordered schema migrations. Step `i` takes the database from `user_version = i` to `i + 1`, so
 * `PRAGMA user_version` is always "how many steps have been applied". Rules:
 *
 * - never edit or reorder a shipped step — append a new one instead, or an existing
 *   `.fabrica/fabrica.db` and a fresh one end up with different schemas;
 * - every step is applied inside one transaction together with its version bump, so a crash
 *   mid-migration leaves the file at the previous version rather than half-upgraded.
 *
 * `CREATE TABLE IF NOT EXISTS` is kept in step 1 so databases created before migrations existed
 * (tables present, `user_version` still 0) upgrade cleanly instead of failing on re-create.
 */
const MIGRATIONS: readonly Migration[] = [
  // 1 — M0 baseline: sessions + append-only event log.
  `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      claude_session_id TEXT,
      state TEXT NOT NULL DEFAULT 'active',   -- active | paused | done | error
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    -- No foreign key to sessions(id) on purpose: this is an append-only audit log,
    -- and it must outlive the session row it describes so history survives deletion.
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL DEFAULT (unixepoch()),
      type TEXT NOT NULL,
      payload TEXT NOT NULL,                  -- JSON SessionEvent
      PRIMARY KEY (session_id, seq)
    );
  `,
  // 2 — per-agent autonomy (attended | auto | bypass). Existing rows inherit the product
  // default, so a database written before this column behaves exactly as it did.
  `
    ALTER TABLE sessions ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'auto';
  `,
  // 3 — M1a rooms. A room is a folder under the project root; the row is its identity on the
  // factory floor (position) and the name is the folder segment, hence UNIQUE. `sessions.room_id`
  // is deliberately nullable and without a foreign key: M0 sessions have no room, and a session's
  // history must not be destroyed by whatever happens to a room row.
  `
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'room',   -- project | room
      pos_x REAL NOT NULL DEFAULT 0,
      pos_z REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    ALTER TABLE sessions ADD COLUMN room_id TEXT;
  `,
  // 4 — M3a tasks and the factory bus. Both tables are deliberately free of foreign keys, for the
  // same reason `events` is: a task's card and a message's record must outlive whatever happens to
  // the room or session they name (a deleted room must not erase the history of what it asked for).
  // `tasks.room_id` NULL means unassigned — the orchestrator routes it (M3b).
  // `messages.delivered_at` NULL means "persisted, nobody has carried it yet"; the index is what
  // makes "what is still queued for this room" a lookup rather than a scan of all traffic, and it
  // is the query `FactoryBus.flushRoom` runs at every turn boundary.
  `
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      room_id TEXT,
      agent_id TEXT,
      blocked_on_message_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_room_id TEXT NOT NULL,
      to_room_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      task_id TEXT,
      delivered_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS messages_undelivered ON messages (to_room_id, delivered_at);
  `,
  // 5 — M1b projects. One SuperFabric serves several factories, so everything the operator looks at
  // is scoped by `project_id`: rooms, sessions, tasks and bus messages. See `migrateProjects`.
  migrateProjects,
  // 6 — per-agent model. NULL means "the CLI's own default", which is what every session written
  // before this column ran on — so existing rows keep behaving exactly as they did, and a row only
  // pins a model once someone chooses one. No CHECK and no enum: model ids are Anthropic's release
  // schedule, not our schema (see `ModelId` in the protocol).
  `
    ALTER TABLE sessions ADD COLUMN model TEXT;
  `,
  // 7 — M3b, the orchestrator. A senior agent is an ordinary session with a role, not a new kind of
  // row: one flag, and everything else about it — its room, its model, its event log — is exactly
  // what every other session has. INTEGER because SQLite has no boolean; NOT NULL DEFAULT 0 so every
  // session written before this column stays what it always was, an ordinary agent.
  //
  // **At most one orchestrator per project is enforced in code**, in `SessionManager.createSession`,
  // not by a partial unique index here. A UNIQUE index would also make it impossible to ever replace
  // an orchestrator whose session row is dead — a policy question for a later milestone, and not one
  // the schema should settle now. The index below is what makes "does this factory have one?" a
  // lookup rather than a scan, which is the question routing asks on every unassigned task.
  `
    ALTER TABLE sessions ADD COLUMN is_orchestrator INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS sessions_orchestrator ON sessions (project_id, is_orchestrator);
  `,
  // 8 — M3b, the Chronicle: decisions, and one FTS5 index over them and over what was actually said.
  migrateChronicle,
  // 9 — M2 accounts. An account is a `CLAUDE_CONFIG_DIR` on disk plus this row.
  //
  // **`config_dir` is UNIQUE, and that is a correctness constraint rather than tidiness.** The CLI
  // rewrites its refresh token in place inside that directory, so two accounts pointing at one
  // directory would each invalidate the other's session at unpredictable moments — the failure would
  // look like random logouts, days later, with nothing in the log to explain them. `AccountManager`
  // refuses a duplicate with a readable message *and* the schema refuses it, because this invariant
  // is too expensive to lose to a future write path that forgets to ask.
  //
  // Deliberately **not** scoped to a project: one subscription serves every factory (see
  // `AccountInfo`). The per-project choice is the *binding*, which is why the nullable `account_id`
  // goes on `sessions` (the account an agent actually runs on) and on `rooms` (the default new agents
  // there inherit). Both are nullable and default NULL, so every row written before this migration
  // keeps running on the ambient `~/.claude` exactly as it did.
  //
  // No foreign keys, for the same reason nothing else here has them: `AccountManager.remove` is what
  // enforces "not while an agent is running on it", and a session's history must survive the removal
  // of the account it happened to run on.
  `
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      config_dir TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_used_at INTEGER
    );
    ALTER TABLE sessions ADD COLUMN account_id TEXT;
    ALTER TABLE rooms ADD COLUMN account_id TEXT;
    CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id);
  `,
  // 10 — M2 the limit monitor. One row per reading, per account, forever: the meters must survive a
  // restart (a blank meter after a reboot reads as "you have used nothing", which is the wrong
  // direction to be wrong in) and the history is what makes "we were fine an hour ago" answerable.
  //
  // `windows` is JSON rather than a table of its own, and deliberately: the endpoint is
  // **undocumented** and already reports windows we had never heard of (`weekly_scoped` scoped to a
  // model, plus a dozen nullable code-named buckets). A normalised schema would need a migration
  // every time Anthropic adds one, and the adapter exists precisely so that does not happen. The
  // shape stored here is our own `UsageWindow[]`, which the parser has already made sense of.
  //
  // No foreign key to `accounts`, for the same reason nothing else here has one: a reading is a
  // record of a moment and must outlive the account row it was taken from.
  `
    CREATE TABLE IF NOT EXISTS usage_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      read_at INTEGER NOT NULL,           -- unix seconds
      source TEXT NOT NULL,               -- endpoint | estimate
      approximate INTEGER NOT NULL,       -- SQLite has no boolean
      windows TEXT NOT NULL,              -- JSON UsageWindow[]
      note TEXT,
      limited INTEGER NOT NULL DEFAULT 0,
      limited_until TEXT                  -- ISO-8601, or NULL when nothing said when
    );
    -- "the newest reading for this account", which is the only query the UI path makes.
    CREATE INDEX IF NOT EXISTS usage_snapshots_account ON usage_snapshots (account_id, read_at DESC);
  `,
  // 11 — M2 the scheduler: when an agent was paused for a limit, and when it is expected back.
  //
  // `sessions.state = 'paused'` already existed (it is in the M0 enum) and `resumeAll` already only
  // starts `'active'` rows, so pausing needs no new state — what it needs is the two facts a
  // countdown and an unattended resume are made of. Both NULL for every session that is not paused,
  // which is all of them until a limit is reached.
  //
  // **`paused_until` NULL on a paused row is meaningful, not missing**: it is what a 429 with no
  // known reset time leaves behind, and the scheduler reads it as "hold until a reading says
  // otherwise" rather than as "resume now". `paused_at` is what makes a *stale* reading unable to
  // resume anyone — only a reading taken after the pause can say the window has rolled.
  // `usage_snapshots.limited_by` rides along because it is the other half of the same feature: the
  // scheduler branches on *how* we know an account is spent (a reading, or the provider refusing a
  // turn) and a restart that forgot which would show the operator the wrong reason for a stopped
  // agent. NULL for every row written by migration 10, which is what "not limited" already meant.
  `
    ALTER TABLE sessions ADD COLUMN paused_at INTEGER;
    ALTER TABLE sessions ADD COLUMN paused_until INTEGER;
    ALTER TABLE usage_snapshots ADD COLUMN limited_by TEXT;
  `,
  // 12 — M1c roles. The fourth member of the `autonomy`/`model`/`account_id` family and stored the
  // same way, because it is the same kind of fact: a per-session choice that has to be re-applied
  // when the agent comes back, or a rebooted architect returns as a blank session standing in the
  // architect's room.
  //
  // **The id, not the role.** A role is a file; this column indexes it. Copying the charter onto the
  // row would freeze it at the moment the agent was created, so an operator who fixed a typo in a
  // preset would find their running agents still reciting the typo — and there would be no way to
  // tell which of them were on which version. NULL is "a plain agent", which is what every session
  // before this column was and still is.
  //
  // No foreign key and no CHECK, for the reason every other reference here has none: a role file the
  // operator deleted must not stop a session resuming. An id that resolves to nothing resolves to
  // "no role", loudly (see `SessionManager.roleOf`).
  `
    ALTER TABLE sessions ADD COLUMN role_id TEXT;
  `,
  // 13 — M1c onboarding: the rooms an interview *proposed*, which are not rooms.
  //
  // A table rather than a field on a session, because a proposal outlives the agent that made it: the
  // operator may close the tab, come back tomorrow and approve four of the five, and the interview
  // will be long over. `status` is what keeps the offer honest — an accepted row is the record of a
  // room that exists, a dismissed one is the record of an offer refused, and neither is ever silently
  // deleted, so "the agent suggested a docs room and I said no" stays answerable.
  //
  // No foreign keys, like everything else here: a suggestion names a project and a session, and it
  // must survive whatever happens to either. `name` is not UNIQUE — two interviews of the same project
  // proposing the same room is a real thing, and `createRoom` is what refuses the duplicate at the
  // moment it matters.
  `
    CREATE TABLE IF NOT EXISTS room_suggestions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT,                        -- the agent that proposed it; NULL if it has gone
      name TEXT NOT NULL,
      charter TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'proposed',-- proposed | accepted | dismissed
      note TEXT,                              -- why accepting it failed, verbatim
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS room_suggestions_project ON room_suggestions (project_id, created_at);
  `,
];

/**
 * The event types worth indexing, and the JSON path each keeps its text at.
 *
 * **Not every event.** The log holds every `agent_text`, every `tool_use` input and every
 * `tool_result` output; a file an agent read is in there verbatim, and indexing all of it would
 * roughly double the largest table in the file to make "the contents of package.json" searchable as
 * if someone had said it. So the Chronicle indexes what *carries meaning* — what an agent said
 * (`agent_text`), what it was asked (`user_prompt`), and the one-line status an agent reports about
 * itself (`session_status.detail`) — and leaves the mechanical bulk out. A `tool_result` is evidence,
 * not reasoning; the ADR file is where the reasoning goes.
 *
 * One expression, used by the trigger and by the backfill (which read the same column under
 * different qualifiers), so the predicate cannot end up being two things.
 */
const CHRONICLE_EVENT_TYPES = "('agent_text', 'user_prompt', 'session_status')";
const chronicleEventText = (row: string): string =>
  `COALESCE(json_extract(${row}.payload, '$.text'), json_extract(${row}.payload, '$.detail'), '')`;

/**
 * Migration 8: the Chronicle — an ADR row per decision, plus one FTS5 index spanning decisions *and*
 * the event log's meaningful text, so a single query answers "why is this the way it is?" from both
 * the reasoning that was written down and what was actually said at the time.
 *
 * A function rather than SQL because the trigger bodies and the backfill share generated predicates,
 * and because the backfill has to run inside the same transaction as the schema it fills.
 *
 * **Repo-native first.** The row is an *index entry*: the artefact is the markdown file
 * `<project>/docs/decisions/NNNN-<slug>.md` that `Chronicle.record` writes, and a grep in a checkout
 * with no SuperFabric running has to find the reasoning. Nothing here is the source of truth for a
 * decision; `decisions.path` records which file is.
 *
 * **Kept in sync by triggers, not by explicit inserts.** The FTS table is an index over two tables,
 * and putting the sync in SQL next to them means every write path is indexed by construction — the
 * one in `EventStore.append` today, the backfill below, and whatever writes next. Both sources are
 * append-only (the event log by design; a decision is the record of a moment and is never edited),
 * so AFTER INSERT is the entire contract: there is no UPDATE or DELETE path for the index to drift
 * through. The cost is that a write happens outside TypeScript's sight, which is what the tests in
 * `chronicle.test.ts` (an ordinary `EventStore.append` becomes searchable) exist to hold down.
 */
function migrateChronicle(db: Db): void {
  db.exec(`
    -- No foreign keys, for the same reason 'events' has none: a decision must outlive the room,
    -- session or task it names. The reasoning is the thing worth keeping longest.
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      room_id TEXT,
      agent_id TEXT,
      task_id TEXT,
      -- The ADR's number and the file it was written to. Not decoration: without them the row
      -- cannot point at the artefact it indexes, and search could only quote it, never open it.
      number INTEGER NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL,
      alternatives TEXT NOT NULL DEFAULT '',
      links TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS decisions_project ON decisions (project_id, created_at);

    -- One index, two sources, discriminated by 'kind'. A separate table per source would mean every
    -- search is a UNION whose two halves rank on different scales — and the whole point is that one
    -- query searches decisions and what was said.
    --
    -- UNINDEXED columns are stored and retrievable but contribute no tokens, so scoping a search to
    -- one factory does not also make the word "project" match every row in it.
    CREATE VIRTUAL TABLE IF NOT EXISTS chronicle_fts USING fts5(
      title,
      body,
      kind UNINDEXED,
      ref UNINDEXED,            -- decision id, or the session id an event belongs to
      seq UNINDEXED,            -- event seq; 0 for a decision
      project_id UNINDEXED,
      room_id UNINDEXED,
      created_at UNINDEXED,
      tokenize = 'porter unicode61'
    );
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
      INSERT INTO chronicle_fts (title, body, kind, ref, seq, project_id, room_id, created_at)
      VALUES (
        new.title,
        new.context || char(10) || new.decision || char(10) || new.alternatives || char(10) || new.links,
        'decision', new.id, 0, new.project_id, new.room_id, new.created_at
      );
    END;
  `);

  // The session's project and room are copied in at insert time rather than joined at query time:
  // the log outlives the session row it describes, and a search that lost its scope the day someone
  // deleted a session would be a search that quietly stops finding things.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events
    WHEN new.type IN ${CHRONICLE_EVENT_TYPES}
     AND ${chronicleEventText("new")} <> ''
    BEGIN
      INSERT INTO chronicle_fts (title, body, kind, ref, seq, project_id, room_id, created_at)
      VALUES (
        new.type,
        ${chronicleEventText("new")},
        'event', new.session_id, new.seq,
        (SELECT project_id FROM sessions WHERE id = new.session_id),
        (SELECT room_id FROM sessions WHERE id = new.session_id),
        new.ts
      );
    END;
  `);

  // Backfill, so an upgrade does not produce a chronicle that begins today. Everything an operator's
  // factory has already said stays findable; the same predicate as the trigger, so the index has one
  // definition of "meaningful" rather than two that can disagree.
  db.exec(`
    INSERT INTO chronicle_fts (title, body, kind, ref, seq, project_id, room_id, created_at)
    SELECT e.type, ${chronicleEventText("e")},
           'event', e.session_id, e.seq, s.project_id, s.room_id, e.ts
    FROM events e LEFT JOIN sessions s ON s.id = e.session_id
    WHERE e.type IN ${CHRONICLE_EVENT_TYPES}
      AND ${chronicleEventText("e")} <> ''
  `);
}

/**
 * Migration 5: `projects`, a `project_id` on everything scoped to one, and a backfill.
 *
 * A function rather than SQL for three reasons: the project a pre-M1b database's rows belong to has
 * to be *worked out* (from the central building's folder, or failing that from the environment the
 * server runs in), ids are generated, and `rooms` has to be rebuilt rather than altered — its `name`
 * was globally UNIQUE, and two projects are each allowed a room called "backend".
 *
 * The backfill is what turns an existing `.fabrica/fabrica.db` into a one-project world instead of an
 * empty one: without it every room, agent, task and message in the file would belong to no project
 * and be invisible on every floor. A database with nothing in it gets no project here — boot's
 * `ProjectManager.defaultProject()` creates that one, and seeding a second row from a test's cwd
 * would be a surprise, not a service.
 */
function migrateProjects(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root TEXT NOT NULL UNIQUE,          -- one folder is one factory
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_opened_at INTEGER               -- NULL until a socket has switched to it
    );
  `);

  const legacyId = seedLegacyProject(db);

  // `rooms` is rebuilt, not altered: SQLite cannot drop the inline UNIQUE on `name`, and per-project
  // uniqueness is the whole point — two factories may each have a "backend". `project_id` is NOT NULL
  // here because a room without a floor to stand on is not a room; the other three tables take a
  // nullable column instead, since rebuilding the message and event-adjacent history to tighten a
  // constraint would rewrite the largest tables in the file for no gain.
  db.exec(`
    CREATE TABLE rooms_v5 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'room',
      pos_x REAL NOT NULL DEFAULT 0,
      pos_z REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE (project_id, name)
    );
  `);
  db.prepare(`
    INSERT INTO rooms_v5 (id, project_id, name, path, kind, pos_x, pos_z, created_at)
    SELECT id, ?, name, path, kind, pos_x, pos_z, created_at FROM rooms
  `).run(legacyId);
  db.exec("DROP TABLE rooms");
  db.exec("ALTER TABLE rooms_v5 RENAME TO rooms");

  db.exec(`
    ALTER TABLE sessions ADD COLUMN project_id TEXT;
    ALTER TABLE tasks ADD COLUMN project_id TEXT;
    ALTER TABLE messages ADD COLUMN project_id TEXT;
  `);
  if (legacyId !== null) {
    for (const table of ["sessions", "tasks", "messages"]) {
      db.prepare(`UPDATE ${table} SET project_id = ?`).run(legacyId);
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS sessions_project ON sessions (project_id);
    CREATE INDEX IF NOT EXISTS tasks_project ON tasks (project_id);
    CREATE INDEX IF NOT EXISTS messages_project ON messages (project_id, created_at);
  `);
}

/**
 * The project a pre-M1b database's rows belong to, or `null` when the file holds nothing to assign.
 *
 * The root is taken from the central building's folder when there is one: that row *is* the record of
 * which folder this factory was running on, and it beats the environment — a server started from
 * another directory must not end up with a project whose root does not contain its own rooms. With no
 * central building (an M0-era file: sessions and events only) there is nothing better than the root
 * this process was told about, which is what boot would use anyway.
 */
function seedLegacyProject(db: Db): string | null {
  const counts = ["sessions", "rooms", "tasks", "messages"].map(
    (t) => (db.query(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c,
  );
  if (counts.every((c) => c === 0)) return null;

  const projectRoom = db.query("SELECT path FROM rooms WHERE kind = 'project' ORDER BY created_at, rowid LIMIT 1")
    .get() as { path: string } | null;
  const root = resolve(projectRoom?.path ?? process.env.SUPERFABRIC_PROJECT ?? process.cwd());
  const id = randomUUID();
  db.prepare("INSERT INTO projects (id, name, root) VALUES (?, ?, ?)")
    .run(id, basename(root) || root, root);
  return id;
}

/** Schema version a freshly opened database is brought up to. */
export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(path: string): Db {
  const db = new Database(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

/** Current `PRAGMA user_version`, i.e. how many migration steps this file has seen. */
function userVersion(db: Db): number {
  const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
  return Number(row?.user_version ?? 0);
}

/** Apply every migration the database has not seen yet. Returns the resulting version. */
export function migrate(db: Db): number {
  const from = userVersion(db);
  if (from >= MIGRATIONS.length) return from;
  db.transaction(() => {
    for (let v = from; v < MIGRATIONS.length; v++) {
      const step = MIGRATIONS[v]!;
      if (typeof step === "string") db.exec(step);
      else step(db);
      // PRAGMA takes a literal, not a bound parameter; `v + 1` is a loop counter, not user input.
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
  })();
  return MIGRATIONS.length;
}
