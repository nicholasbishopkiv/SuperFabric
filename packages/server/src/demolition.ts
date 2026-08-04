import type { ProjectInfo, RoomInfo } from "@superfabric/shared";
import type { Chronicle } from "./chronicle.js";
import type { FactoryBus } from "./factoryBus.js";
import type { OnboardingManager } from "./onboarding.js";
import type { ProjectManager } from "./projectManager.js";
import type { RoomManager } from "./roomManager.js";
import type { SessionManager } from "./sessionManager.js";
import type { TaskStore } from "./taskStore.js";

/**
 * Taking things away: an agent, a room, a whole factory.
 *
 * A class of its own rather than three methods spread across the managers, because the interesting
 * part of a delete is not any single row — every table's owner already knows how to remove its own —
 * it is the **order**, and what is deliberately *not* removed. Both are policy, and policy that lives
 * in one file can be read in one sitting.
 *
 * Four rules hold everywhere below.
 *
 * 1. **Nothing on disk is ever touched.** Not a room's folder, not a project root, not an ADR in
 *    `docs/decisions/`. Room = folder: the row is what SuperFabric adds, so removing it hands the
 *    directory back exactly as it was, and a repository cloned without SuperFabric is unchanged
 *    either way. This is what makes a delete safe to offer at all.
 * 2. **Refuse before you destroy.** Every cascade validates first — the project room, the boot
 *    project, the last project — because discovering the refusal after four agents have been stopped
 *    is the worst available order.
 * 3. **Live processes go before rows.** An executor whose session row had already been deleted is a
 *    CLI subprocess nothing can stop and nothing can explain.
 * 4. **What outlives what.** A task outlives its room and its assignee (the work is the operator's,
 *    the department was only where it was being done). A bus message outlives the room it was sent
 *    to. A room suggestion outlives the agent that proposed it. Only two things are ever destroyed
 *    on purpose: an agent's transcript, when the operator deletes that agent, and a whole factory's
 *    records, when they delete the factory.
 */
export interface DemolitionDeps {
  sessions: SessionManager;
  rooms: RoomManager;
  projects: ProjectManager;
  /** The board. Absent => there are no cards to unassign, which is a valid (M3a-less) server. */
  tasks?: TaskStore;
  /** The bus. Absent => there is no traffic to drop with a factory. */
  bus?: FactoryBus;
  /** The chronicle's index. Absent => nothing indexed the decisions; the ADR files are untouched anyway. */
  chronicle?: Chronicle;
  /** Onboarding. Absent => nothing proposed rooms, so there are no proposals to detach or drop. */
  onboarding?: OnboardingManager;
}

/** What removing one agent did. */
export interface SessionRemoval {
  projectId: string | null;
  roomId: string | null;
  /** Cards that lost their assignee and stayed on the board. */
  tasksUnassigned: number;
}

/** What removing one room did. */
export interface RoomRemoval {
  room: RoomInfo;
  projectId: string;
  /** Agents stopped and deleted with it, transcripts included. */
  agents: number;
  /** Cards handed back to the board, unassigned. */
  tasksUnassigned: number;
}

/** What removing one factory did. Every number is a row count, and none of them is a file. */
export interface ProjectRemoval {
  project: ProjectInfo;
  rooms: number;
  agents: number;
  tasks: number;
  messages: number;
  /** Index rows. The ADR files in the repository are untouched — see `Chronicle.deleteForProject`. */
  decisions: number;
}

export class Demolition {
  constructor(private deps: DemolitionDeps) {}

  /**
   * Remove one agent: its row, its transcript, and every reference that would otherwise dangle.
   *
   * The references are cleared **first**. A task pointing at a session that no longer exists is not
   * merely untidy — `TaskStore.update` refuses to write a card whose assignee it cannot resolve, so
   * the operator would be left with a card they could not move. Clearing before deleting means a
   * failure part-way through leaves a card with no assignee (a state the board draws every day)
   * rather than a card nobody can touch.
   */
  async deleteSession(sessionId: string): Promise<SessionRemoval> {
    const tasksUnassigned = this.deps.tasks?.unassignAgent(sessionId) ?? 0;
    this.deps.onboarding?.forgetSession(sessionId);
    const { projectId, roomId } = await this.deps.sessions.deleteSession(sessionId);
    return { projectId, roomId, tasksUnassigned };
  }

  /**
   * Remove one room, and the agents standing in it.
   *
   * The agents go because a session's `cwd` **is** the room: an agent left behind would be working in
   * a department that no longer exists, in a folder the floor no longer draws, and nothing in the UI
   * could show it to the operator except the "unassigned agents" list it never belonged in. So this
   * destroys transcripts, and the client says how many before it asks.
   *
   * What stays: the folder, the room's tasks (unassigned), and its bus traffic.
   */
  async deleteRoom(roomId: string): Promise<RoomRemoval> {
    // Before anything is stopped: the project room is refused, and so is an unknown id.
    const room = this.deps.rooms.requireDeletable(roomId);
    const projectId = this.deps.rooms.projectOf(roomId)!;

    const agents = this.deps.sessions.sessionIdsInRoom(roomId);
    for (const id of agents) await this.deleteSession(id);
    // After the agents, so the count is what the room's own cards lost rather than what its agents
    // did — every card those agents held has already been unassigned by the loop above.
    const tasksUnassigned = this.deps.tasks?.unassignRoom(roomId) ?? 0;
    this.deps.rooms.deleteRoom(roomId);
    return { room, projectId, agents: agents.length, tasksUnassigned };
  }

  /**
   * Remove a whole factory: its agents, its rooms (the central building included, which is the one
   * case where that is allowed), its board, its bus traffic, its proposals and its decision index.
   *
   * Nothing on disk goes with it — not the project root, not a room's folder, and above all not the
   * ADR files, which are the decisions themselves and belong to the repository. Reopening the same
   * folder as a project later gives back an empty floor over a repository that still holds everything
   * the factory wrote down.
   */
  async deleteProject(projectId: string): Promise<ProjectRemoval> {
    // Before anything is stopped: the boot project and the last remaining project are both refused.
    const project = this.deps.projects.requireDeletable(projectId);

    const agents = this.deps.sessions.sessionIdsInProject(projectId);
    // Through `SessionManager` rather than this class's own `deleteSession`: the per-agent reference
    // clearing is pointless here — the board and the proposals are being deleted wholesale two lines
    // down — and doing it anyway would emit a board change per agent for a board that is about to go.
    for (const id of agents) await this.deps.sessions.deleteSession(id);

    const tasks = this.deps.tasks?.deleteForProject(projectId) ?? 0;
    const messages = this.deps.bus?.deleteForProject(projectId) ?? 0;
    this.deps.onboarding?.deleteForProject(projectId);
    const decisions = this.deps.chronicle?.deleteForProject(projectId) ?? 0;
    const rooms = this.deps.rooms.deleteRoomsForProject(projectId);
    this.deps.projects.remove(projectId);

    return { project, rooms, agents: agents.length, tasks, messages, decisions };
  }
}
