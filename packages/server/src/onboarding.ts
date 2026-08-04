import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  PROJECT_CHARTER_FILE, RoomSuggestion, type OnboardingState, type RoomSuggestionStatus,
} from "@superfabric/shared";
import type { Db } from "./db.js";
import type { ProjectManager } from "./projectManager.js";
import type { RoomManager } from "./roomManager.js";
import type { SessionManager } from "./sessionManager.js";

/**
 * First contact: point the factory at a folder nobody has written down, and an agent interviews you
 * about it.
 *
 * **The onboarder is an ordinary session with a role and a one-shot job**, exactly as the
 * orchestrator is — same runtime, same event log, same room (the project room), same transcript in
 * the same console. There is no second kind of agent here and no parallel runtime: `start` creates a
 * session with `roleId: "onboarding"` and sends it one turn. Everything that makes it an onboarder is
 * the charter in `roles/onboarding.yaml`, which is a file the operator can read and fork like every
 * other preset.
 *
 * **Un-onboarded means one thing: no `CLAUDE.md` at the project root.** Not "the folder looks empty",
 * not a file count, not a heuristic over what is in it. A guess would offer to interview someone about
 * a repository they documented last year, and would be wrong in a way they could not correct; a file
 * is a fact, it is the artefact the interview produces, and deleting it is how you ask for the offer
 * back. See `PROJECT_CHARTER_FILE`.
 *
 * **The rooms it proposes are proposals.** The agent's tool records them and creates nothing; the
 * operator sees a list they can edit and approve, and approving runs the ordinary
 * `RoomManager.createRoom` — so name safety, containment and the never-overwrite-a-charter rule all
 * still apply, because they are the same code path they always were. A factory that reorganised
 * itself on the say-so of an interview is not what an operator wants on first contact.
 */

/**
 * The role an onboarding agent wears, and the id of the file that carries its charter.
 *
 * A `roles/*.yaml` rather than a constant in this file, unlike the orchestrator's prompt: the
 * interview's wording is the part most likely to need tuning against a real transcript, and a role
 * file is already the thing an operator can override by id without touching the product. The trade is
 * that the id is now load-bearing — a fork that renames it is a fork with no onboarding.
 */
export const ONBOARDING_ROLE_ID = "onboarding";

/** Row shape of `room_suggestions`. */
interface SuggestionRow {
  id: string;
  project_id: string;
  session_id: string | null;
  name: string;
  charter: string;
  status: string;
  note: string | null;
  created_at: number;
}

/** One room an interview proposed, as the tool hands it over. */
export interface SuggestedRoom {
  name: string;
  charter: string;
}

/** One approval, with whatever the operator changed about it. */
export interface AcceptedSuggestion {
  id: string;
  name?: string;
  charter?: string;
}

/** What `accept` did: the rooms that now exist, and the proposals that could not become one. */
export interface AcceptResult {
  created: { id: string; name: string }[];
  /** A suggestion that stayed a suggestion, with the reason in `createRoom`'s own words. */
  failed: { id: string; name: string; message: string }[];
}

export interface OnboardingDeps {
  db: Db;
  projects: ProjectManager;
  rooms: RoomManager;
  /**
   * The session runner. The onboarder is one of its sessions like any other, so this class creates
   * nothing of its own — it asks for a session with a role and sends it a turn.
   */
  sessions: SessionManager;
  /**
   * Something about this project's onboarding changed. The hub turns it into a broadcast; a callback
   * rather than the hub itself, for the same reason the bus and the router take one — the dependency
   * stays one-way and a server without a hub is still constructible.
   */
  onChange?: (projectId: string) => void;
}

export class OnboardingManager {
  private readonly stmts;

  constructor(private deps: OnboardingDeps) {
    const { db } = deps;
    this.stmts = {
      insert: db.prepare(
        "INSERT INTO room_suggestions (id, project_id, session_id, name, charter) VALUES (?, ?, ?, ?, ?)",
      ),
      byProject: db.prepare(
        "SELECT id, project_id, session_id, name, charter, status, note, created_at"
        + " FROM room_suggestions WHERE project_id = ? ORDER BY created_at, rowid",
      ),
      one: db.prepare(
        "SELECT id, project_id, session_id, name, charter, status, note, created_at"
        + " FROM room_suggestions WHERE id = ?",
      ),
      // "Is this room already on offer?" — so an agent that calls the tool twice revises its proposal
      // instead of doubling it.
      proposedByName: db.prepare(
        "SELECT id FROM room_suggestions WHERE project_id = ? AND name = ? AND status = 'proposed'",
      ),
      updateProposal: db.prepare("UPDATE room_suggestions SET charter = ?, session_id = ?, note = NULL WHERE id = ?"),
      settle: db.prepare("UPDATE room_suggestions SET status = ?, name = ?, charter = ?, note = ? WHERE id = ?"),
    };
  }

  /** Everything the UI needs about one factory's onboarding, in one object. */
  state(projectId: string): OnboardingState {
    return {
      projectId,
      onboarded: this.isOnboarded(projectId),
      sessionId: this.deps.sessions.onboarderFor(projectId) ?? null,
      suggestions: (this.stmts.byProject.all(projectId) as SuggestionRow[]).map(toSuggestion),
    };
  }

  /**
   * Has anyone written this project down? The whole test is whether `CLAUDE.md` is at its root.
   *
   * Re-stated (rather than cached) on every ask, because the thing that changes it is an *agent
   * writing a file* — there is no call to invalidate a cache from, and a stale "not onboarded" would
   * keep offering an interview that has already happened.
   */
  isOnboarded(projectId: string): boolean {
    const project = this.deps.projects.get(projectId);
    if (project === undefined) return false;
    return existsSync(path.join(project.root, PROJECT_CHARTER_FILE));
  }

  /**
   * Put an onboarding agent in the project room and give it its one instruction.
   *
   * Idempotent, like `ensureOrchestrator`: a second click hands back the interview already running
   * rather than standing a rival interviewer next to it. The kickoff turn is sent here rather than
   * left to the operator because an agent nobody has prompted says nothing at all — and "start
   * onboarding" that produces a silent agent is a button that appears not to work.
   */
  start(projectId: string): { sessionId: string; created: boolean } {
    const existing = this.deps.sessions.onboarderFor(projectId);
    if (existing !== undefined) return { sessionId: existing, created: false };

    const project = this.deps.projects.require(projectId);
    // Like the orchestrator: in the project room, whose folder is the project root — which is where
    // `CLAUDE.md` and `README.md` have to be written, so the agent's own cwd is the answer.
    const projectRoom = this.deps.rooms.ensureProjectRoom(projectId);
    const sessionId = this.deps.sessions.createSession({
      roomId: projectRoom.id,
      projectId,
      roleId: ONBOARDING_ROLE_ID,
    });
    this.deps.sessions.prompt(sessionId, kickoff(project.name, project.root));
    this.deps.onChange?.(projectId);
    return { sessionId, created: true };
  }

  /**
   * Record what an interview proposes. **Creates nothing** — no folder, no row in `rooms`, no charter.
   *
   * A second call naming a room that is still on offer revises that offer rather than adding a
   * duplicate: an agent correcting itself mid-interview is normal, and a list with "api" twice on it
   * is a list the operator has to reconcile before they can read it.
   */
  suggest(projectId: string, sessionId: string | null, rooms: readonly SuggestedRoom[]): RoomSuggestion[] {
    const out: RoomSuggestion[] = [];
    for (const room of rooms) {
      const existing = this.stmts.proposedByName.get(projectId, room.name) as { id: string } | null;
      if (existing != null) {
        this.stmts.updateProposal.run(room.charter, sessionId, existing.id);
        out.push(toSuggestion(this.stmts.one.get(existing.id) as SuggestionRow));
        continue;
      }
      const id = randomUUID();
      this.stmts.insert.run(id, projectId, sessionId, room.name, room.charter);
      out.push(toSuggestion(this.stmts.one.get(id) as SuggestionRow));
    }
    if (out.length > 0) this.deps.onChange?.(projectId);
    return out;
  }

  /**
   * Turn approved proposals into rooms, **through the ordinary `createRoom`** — which is the point of
   * the whole arrangement. Every invariant that path already has (the name is a usable folder segment,
   * the folder stays under the project root, an existing `CLAUDE.md` is never overwritten) applies
   * unchanged, because this is not a second way to make a room.
   *
   * One failure does not sink the others: a name `createRoom` refuses leaves that suggestion
   * `proposed` with the reason attached, so the operator can rename it and approve it again.
   */
  accept(projectId: string, accepted: readonly AcceptedSuggestion[]): AcceptResult {
    const result: AcceptResult = { created: [], failed: [] };
    for (const entry of accepted) {
      const row = this.stmts.one.get(entry.id) as SuggestionRow | null;
      if (row == null) throw new Error(`unknown room suggestion ${entry.id}`);
      // Suggestion ids are unique across the server, so a client holding another factory's id could
      // otherwise create a room on a floor it is not even looking at.
      if (row.project_id !== projectId) {
        throw new Error(`room suggestion ${entry.id} belongs to another project`);
      }
      if (row.status !== "proposed") continue;

      const name = (entry.name ?? row.name).trim();
      const charter = (entry.charter ?? row.charter).trim();
      try {
        const room = this.deps.rooms.createRoom(name, { projectId, summary: charter });
        this.stmts.settle.run("accepted", name, charter, null, row.id);
        result.created.push({ id: room.id, name: room.name });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.stmts.settle.run("proposed", name, charter, message.slice(0, 300), row.id);
        result.failed.push({ id: row.id, name, message });
      }
    }
    if (result.created.length > 0 || result.failed.length > 0) this.deps.onChange?.(projectId);
    return result;
  }

  /** Take one proposal off the list. Nothing is created and nothing is deleted; it stops being offered. */
  dismiss(projectId: string, suggestionId: string): void {
    const row = this.stmts.one.get(suggestionId) as SuggestionRow | null;
    if (row == null) throw new Error(`unknown room suggestion ${suggestionId}`);
    if (row.project_id !== projectId) {
      throw new Error(`room suggestion ${suggestionId} belongs to another project`);
    }
    if (row.status !== "proposed") return;
    this.stmts.settle.run("dismissed", row.name, row.charter, null, row.id);
    this.deps.onChange?.(projectId);
  }
}

/**
 * The one turn an onboarding agent is sent.
 *
 * Deliberately thin: the charter in `roles/onboarding.yaml` is where the *job* is described, and
 * repeating it here would give an operator two places to edit and one of them wouldn't work. All this
 * carries is what the charter cannot know — which folder, and that the interview starts now with a
 * single question.
 */
export function kickoff(projectName: string, root: string): string {
  return `Onboard this project. It is called ${JSON.stringify(projectName)} and its root folder is `
    + `${root} — that is where CLAUDE.md and README.md go, and it has neither.\n\n`
    + "Start the interview now: ask your first question, one question only, and wait for my answer.";
}

function toSuggestion(row: SuggestionRow): RoomSuggestion {
  return RoomSuggestion.parse({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    charter: row.charter,
    status: asStatus(row.status),
    note: row.note,
    createdAt: row.created_at,
  });
}

/**
 * `status` is a TEXT column, so a hand-edited database could hold anything. Anything unrecognised
 * reads as `proposed` — the state in which nothing has happened yet, which is the safe direction to
 * be wrong in: it offers the operator a decision rather than recording one nobody made.
 */
function asStatus(value: string): RoomSuggestionStatus {
  return value === "accepted" || value === "dismissed" ? value : "proposed";
}
