import { toolGist, truncate } from "../gist";
import type { EventRow, FactoryStatus } from "../store";

/**
 * What one agent's thought bubble says, from what the store already knows about it.
 *
 * ## Where the words come from
 *
 * The agent's own log, and nothing else. There is no summarising model, no guess and no invented
 * phrasing of what an agent "is probably doing": the newest thing it did is a `tool_use` with a name
 * and an input, or an `agent_thinking`, or an `approval_request` nobody has answered. The tool input is
 * reduced by `toolGist` — the **same** function the console's transcript uses, so the bubble and the
 * drawer can never describe one call two ways.
 *
 * Four facts outrank the log because they are about the operator rather than about the work: a failure,
 * an approval waiting on them, a pause, and — at the bottom — plain "working", which is what an agent
 * whose log this tab has not been sent still honestly is.
 *
 * ## Why a line of text and not a glyph
 *
 * A wrench over a figure's head says "a tool", which the operator already knew. The question is *which*
 * tool and on what, and only words answer it. It is one short line, capped, on one line — the console
 * is where prose belongs.
 *
 * Pure, and therefore tested: which of the four states wins, what each of them says, and that an idle
 * agent says nothing at all.
 */

/** One bubble: a line to show, and the status it belongs to (which colours its stripe). */
export interface Bubble {
  text: string;
  /** Always the figure's own status, so the bubble's stripe and its vest are the same colour. */
  status: FactoryStatus;
}

/**
 * How long a bubble's line may be. Short on purpose: this is text drawn over a factory floor, and a
 * bubble wide enough to cover the building behind it is a bubble that has stopped being an annotation.
 * The console shows the same call in full.
 */
export const BUBBLE_MAX = 26;

/** The rows this looks at, newest last — the shape the store keeps per session. */
type Rows = readonly EventRow[];

/**
 * What the bubble over this agent says, or `null` when it has nothing to say.
 *
 * Takes the figure's already-derived `status` rather than a `SessionInfo`, for the reason
 * `errands.ts` does the same: the store imports from `scene/*` and never the other way round at run
 * time, and there must be exactly one `agentStatus`.
 *
 * `rows` may legitimately be **empty**: the tab only holds the log of a session it has subscribed to,
 * so an agent nobody has looked at yet still gets the honest short answer ("working", "waiting for
 * you") rather than a fabricated one.
 */
export function agentBubble(
  agent: { status: FactoryStatus; pausedUntil: number | null },
  rows: Rows,
  now: number = Date.now(),
): Bubble | null {
  const { status } = agent;

  // 1. It failed. The log usually says why in one line, and that line is the most useful thing on the
  //    floor at that moment.
  if (status === "error") {
    const failure = newest(rows, "session_error");
    return {
      status,
      text: failure === undefined ? "failed" : `failed · ${short(failure.message)}`,
    };
  }

  // 2. It is waiting on the operator. Which tool it is asking about is the whole question, so it is
  //    named when we hold the log that says it.
  if (status === "blocked") {
    const pending = pendingApproval(rows);
    return {
      status,
      text: pending === undefined ? "waiting for you" : `waiting for you · ${pending}`,
    };
  }

  // 3. It was stopped by the limit scheduler, not by anything it did. `pausedUntil` is unix *seconds*
  //    and may legitimately be null — a 429 with no reading behind it knows no reset time, and
  //    inventing one would be a promise nobody made (see `SessionInfo.pausedUntil`).
  if (status === "paused") {
    const until = agent.pausedUntil;
    if (until === null) return { status, text: "paused · waiting for the limit" };
    const left = until * 1000 - now;
    // A countdown that has run out is not a countdown: the scheduler resumes on its own clock, so the
    // honest line while that is happening is that it is due, not "back in under a minute".
    if (left <= 0) return { status, text: "paused · due back" };
    return { status, text: `paused · back in ${untilText(left)}` };
  }

  // 4. It is working. Walk back from the newest event to the first one that says something.
  if (status === "working") {
    for (let i = rows.length - 1; i >= 0; i--) {
      const event = rows[i].event;
      switch (event.type) {
        case "agent_thinking":
          return { status, text: "thinking…" };
        case "tool_use": {
          const gist = toolGist(event.input, BUBBLE_MAX);
          return { status, text: gist === "" ? event.toolName : `${event.toolName} · ${gist}` };
        }
        case "agent_text":
          // Deliberately not a snippet of the reply. Streaming prose would rewrite the bubble on
          // every chunk, and a floor plan is not where anyone reads an agent's sentences — the
          // console is. "Replying" is the whole of what the floor needs to say.
          return { status, text: "replying" };
        case "user_prompt":
          return { status, text: "reading your message" };
        // A finished tool call says nothing new: the `tool_use` behind it is what names the work, so
        // keep walking. Statuses and turn boundaries are book-keeping and do the same.
        case "tool_result":
        case "session_status":
        case "turn_complete":
        case "approval_request":
        case "approval_resolved":
        case "session_error":
          continue;
      }
    }
    // No log for this session in this tab, or nothing in it yet. Still true, still worth saying.
    return { status, text: "working" };
  }

  // 5. Idle. Nothing is happening, and a bubble saying so on every quiet agent is exactly the noise
  //    that would make the floor unreadable — the vest and the beacon already say quiet.
  return null;
}

/** The newest event of a type, or `undefined`. */
function newest<T extends EventRow["event"]["type"]>(
  rows: Rows,
  type: T,
): Extract<EventRow["event"], { type: T }> | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].event.type === type) return rows[i].event as Extract<EventRow["event"], { type: T }>;
  }
  return undefined;
}

/**
 * The tool name of the newest approval nobody has answered, or `undefined`.
 *
 * Resolved by `approvalId` rather than by position, exactly as the console's transcript does it: an
 * agent can raise a second card while the first is still open, and the *unanswered* one is the one the
 * operator is being asked about.
 */
function pendingApproval(rows: Rows): string | undefined {
  const answered = new Set<string>();
  for (const { event } of rows) {
    if (event.type === "approval_resolved") answered.add(event.approvalId);
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const event = rows[i].event;
    if (event.type === "approval_request" && !answered.has(event.approvalId)) return event.toolName;
  }
  return undefined;
}

/** A countdown in the words the room panel already uses, so the two never disagree in style. */
function untilText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes <= 0) return "under a minute";
  if (minutes === 1) return "a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const short = (s: string): string => truncate(s, BUBBLE_MAX);
