import { RUNNER_OUTBOX_LIMIT, type RunnerFrameBody } from "@superfabric/shared";

/**
 * The runner's outbound stream: numbered, ordered, held until acknowledged, and bounded.
 *
 * This is the mechanism that makes "the operator restarted the server" survivable. The query keeps
 * running while the socket is down; everything it produces lands here with a sequence number, and a
 * re-attach replays whatever the server says it has not got (`attached { ackedSeq }`). Nothing is
 * lost — the runner still holds it — and nothing is duplicated, because the server applies frames
 * strictly by `seq > lastApplied` and the runner never re-uses a number.
 *
 * It is the same replay contract the browser already gets from `EventStore.subscribe(afterSeq)`,
 * pointing the other way: here the runner is the one holding the log and the server is catching up.
 */

/** One frame in flight. `dropped > 0` marks a gap: this frame *replaces* that many lost ones. */
export interface OutboxEntry {
  readonly seq: number;
  body: RunnerFrameBody;
  /**
   * Never evicted to make room. Exactly one kind of frame is: the one carrying the provider session
   * id, because losing it makes the session unresumable — the failure the whole buffer exists to
   * prevent, arriving by the back door.
   */
  readonly pinned: boolean;
  /** How many original frames this entry stands in for, or 0 when it is an ordinary frame. */
  dropped: number;
}

function gapEvent(count: number): RunnerFrameBody {
  return {
    type: "event",
    event: {
      type: "session_error",
      message:
        `${count} event${count === 1 ? "" : "s"} from this agent were dropped: the runner's buffer ` +
        "filled while the server was unreachable. The agent itself kept working; only the record of " +
        "this stretch is incomplete.",
    },
  };
}

export class Outbox {
  private readonly entries: OutboxEntry[] = [];
  private nextSeq = 1;
  private totalDropped = 0;

  constructor(private readonly limit: number = RUNNER_OUTBOX_LIMIT) {}

  /** Number the frame, hold it, and hand it back so the caller can send it if it can. */
  append(body: RunnerFrameBody): OutboxEntry {
    const entry: OutboxEntry = {
      seq: this.nextSeq++,
      body,
      pinned: body.type === "provider_session",
      dropped: 0,
    };
    this.entries.push(entry);
    this.evict();
    return entry;
  }

  /**
   * Cumulative acknowledgement: everything up to `seq` is durable on the server, so forget it.
   * Frames beyond it stay, in order, ready to be replayed on the next attach.
   */
  ack(seq: number): void {
    while (this.entries.length > 0 && this.entries[0]!.seq <= seq) this.entries.shift();
  }

  /** What the server has not confirmed, in order — exactly what a re-attach must resend. */
  pendingAfter(seq: number): OutboxEntry[] {
    return this.entries.filter((e) => e.seq > seq);
  }

  get pending(): readonly OutboxEntry[] {
    return this.entries;
  }

  /** How many original frames have been lost to the bound over this runner's life. */
  get droppedCount(): number {
    return this.totalDropped;
  }

  /**
   * Enforce the bound by losing the **oldest** events, never the newest.
   *
   * The newest events say what the agent is doing now, which is what an operator reconnecting to a
   * long-running agent needs; the oldest are the ones most likely already visible elsewhere. The
   * gap is not silent: the first casualty is rewritten in place — keeping its sequence number, so
   * the gap is marked exactly where it happened — into a `session_error` saying how many went, and
   * later casualties fold into that same marker.
   */
  private evict(): void {
    while (this.entries.length > this.limit) {
      const markerIndex = this.entries.findIndex((e) => e.dropped > 0);
      if (markerIndex === -1) {
        // First loss in this run: turn the oldest droppable frame into the marker. This frees no
        // room yet (the entry stays, carrying the news), so the loop comes round once more.
        const victim = this.entries.findIndex((e) => !e.pinned);
        if (victim === -1) return; // everything is pinned: hold the overflow rather than lose it
        this.entries[victim]!.dropped = 1;
        this.entries[victim]!.body = gapEvent(1);
        this.totalDropped++;
        continue;
      }
      // Fold the next droppable frame into the marker that already exists.
      const victim = this.entries.findIndex((e, i) => i !== markerIndex && !e.pinned);
      if (victim === -1) return;
      // A second marker can only exist on the far side of a pinned frame; folding one in carries
      // its count across without re-counting losses `totalDropped` already knows about.
      const folded = this.entries[victim]!.dropped;
      const marker = this.entries[markerIndex]!;
      marker.dropped += folded > 0 ? folded : 1;
      marker.body = gapEvent(marker.dropped);
      if (folded === 0) this.totalDropped++;
      this.entries.splice(victim, 1);
    }
  }
}
