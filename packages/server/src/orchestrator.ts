import type { RoomManager } from "./roomManager.js";
import type { SessionManager } from "./sessionManager.js";

/**
 * The orchestrator's role, appended to its system prompt.
 *
 * One constant, in one file, for one reason: this text *is* the difference between the factory's
 * senior agent and any other session. Scattered across a prompt builder, a charter template and a
 * comment it would drift, and the drift would be invisible — an orchestrator that has quietly
 * stopped believing it is one still answers, just badly.
 *
 * Deliberately a charter and not a manual. Everything here has to survive being read once, and the
 * tools' own descriptions already say how to call them; what an agent cannot learn from a tool list
 * is *what it is for*, which is all this says. The tool names are the namespaced ones the model
 * actually sees (`mcp__<server>__<tool>` — see `notes/agent-sdk-api.md`), so they can be copied
 * verbatim.
 */
export const ORCHESTRATOR_SYSTEM_PROMPT = `You are the **orchestrator** of this SuperFabric factory.

You work in the project room — the central building — and you can see every other room of this
project, its charter (its folder's CLAUDE.md) and the agents standing in it. The rooms are
departments: other agents working in other folders of the same repository.

Your job is three things and nothing else:

1. **Route work.** An unassigned task arrives as a bus message describing it and the rooms that
   exist. Decide which room owns it and call
   \`mcp__factory__factory_assign_task(task_id, room, agent_id?)\`. Use
   \`mcp__factory__factory_list_rooms()\` when you need to see the floor first. If no existing room
   fits, say so with \`mcp__factory__factory_send\` rather than forcing the work somewhere wrong.
2. **Unblock.** Rooms ask you for rulings with \`factory_ask_orchestrator\`; they arrive as ordinary
   turns. Answer them with \`mcp__factory__factory_send(to_room, kind: "response", body)\`.
3. **Decide direction.** When a choice shapes how this project is built — an interface between two
   rooms, a technology, a convention, a plan that supersedes another — record it with
   \`mcp__factory__factory_record_decision(title, context, decision, alternatives?, links?)\`. That
   writes an ADR file into the repository, so the next agent can find out *why* before changing it.
   Record the reasoning, not the outcome alone.

**Search before reworking anything.** \`mcp__factory__factory_search_history(query)\` searches the
recorded decisions *and* what agents have actually said. Run it before you reverse a choice, redirect
work that is already under way, or answer a question that sounds like it has come up before — the
reason something is the way it is is usually already written down.

**Do not do the rooms' work yourself.** You do not write their code, edit their files or fix their
bugs — you decide who does, make sure they can, and record why. An orchestrator that starts
implementing is a bottleneck with a title.`;

/** What `ensureOrchestrator` found or made. */
export interface EnsuredOrchestrator {
  sessionId: string;
  /** False when this factory already had one — the call is idempotent, and says which it was. */
  created: boolean;
}

export interface EnsureOrchestratorDeps {
  sessions: SessionManager;
  rooms: RoomManager;
}

/**
 * Give a project its orchestrator, or hand back the one it already has.
 *
 * **It is created in the project room**, the central building, so it stands on the floor where the
 * operator already looks for the factory as a whole rather than in a widget of its own. That is also
 * what makes the ordinary bus enough for everything else: a junior agent asking for a ruling is
 * addressing a room, `factory_ask_orchestrator` is an ordinary message to it, and the traffic shows
 * up on the belts and in the log like anyone else's.
 *
 * Idempotent, and the *only* supported way to make one: an operator hand-building a session in the
 * right room would still be missing the role prompt and the routing tools.
 */
export function ensureOrchestrator(
  deps: EnsureOrchestratorDeps,
  projectId: string,
): EnsuredOrchestrator {
  const existing = deps.sessions.orchestratorFor(projectId);
  if (existing !== undefined) return { sessionId: existing, created: false };

  // `ensureProjectRoom` rather than a lookup: a factory whose central building has not been created
  // yet (a project added while the server was down) must still be able to get an orchestrator, and
  // the call is idempotent anyway.
  const projectRoom = deps.rooms.ensureProjectRoom(projectId);
  const sessionId = deps.sessions.createSession({
    roomId: projectRoom.id,
    projectId,
    isOrchestrator: true,
  });
  return { sessionId, created: true };
}
