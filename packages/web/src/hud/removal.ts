/**
 * The sentences a delete is asked with.
 *
 * Pure functions in a file of their own, because the sentence **is** the feature. A confirm that says
 * "Are you sure?" has told the operator nothing they did not already know; what they cannot see from
 * the floor is how much goes with the thing they clicked — how many agents stand in that room, whose
 * transcripts those are, which of their tasks come loose, and above all what is *not* touched. Every
 * removal in SuperFabric is irreversible and none of them touches a file, and both halves have to be
 * in the words.
 *
 * Separate from the components so they can be read against each other and tested without a DOM: the
 * risk here is a plural that lies or a reassurance that is no longer true, and neither is visible in
 * a rendered screenshot.
 */

/** `1 agent` / `3 agents` — the plural, in one place, because it is what a warning gets wrong. */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Removing one agent. The transcript is the part an operator does not think of until it is gone, so
 * it is named first; the tasks are mentioned only when there are some, because a clause about zero
 * tasks is noise in a sentence that has to be read in a second.
 */
export function agentRemovalWarning(tasksOwned: number): string {
  const tasks = tasksOwned === 0
    ? ""
    : ` ${count(tasksOwned, "task")} it owns go back to the board.`;
  return `Removes this agent and its whole transcript.${tasks}`;
}

/**
 * Removing a room. Three facts in the order they matter: the building goes, the agents in it go
 * *with their transcripts* (the surprise), the tasks come loose, and the folder does not move.
 *
 * The folder sentence is last and unconditional. It is the one thing that makes this safe to click,
 * and it must be true of every room whatever else is in it.
 */
export function roomRemovalWarning(opts: { agents: number; tasks: number }): string {
  const agents = opts.agents === 0
    ? ""
    : ` ${count(opts.agents, "agent")} here ${opts.agents === 1 ? "is" : "are"} stopped and removed `
      + `too, with everything ${opts.agents === 1 ? "it" : "they"} said.`;
  const tasks = opts.tasks === 0
    ? ""
    : ` ${count(opts.tasks, "unfinished task")} go back to the board, unassigned.`;
  return `Removes the room from the floor.${agents}${tasks} The folder stays exactly as it is.`;
}

/**
 * Removing a whole factory. Named rather than "this project": the switcher shows several, the
 * control is per row, and a confirm that does not say *which* one is a confirm that can be answered
 * about the wrong floor.
 */
export function projectRemovalWarning(name: string): string {
  return `Removes ${name}: its rooms, its agents and their transcripts, its board and its chronicle `
    + "index. Every folder, charter and ADR on disk stays.";
}
