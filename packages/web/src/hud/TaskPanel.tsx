import type { TaskInfo, TaskStatus } from "@superfabric/shared";
import { FlagIcon, ListChecksIcon, PlusIcon, SignpostIcon } from "lucide-react";
import { memo, useState } from "react";
import {
  TASK_STATUS_ORDER,
  tasksByStatus,
  unassignedTasks,
  useFabric,
  useHasOrchestrator,
  useHudInsets,
  useTasks,
} from "../store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { FieldNote, Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { cn } from "../ui/utils";
import { send } from "../wsClient";
import { EdgePanel } from "./Panel";

/**
 * The task board: what the factory is supposed to be doing, as opposed to what it is doing right
 * now (the floor) or what one agent said (the console).
 *
 * ## It stays a bottom strip, and it got much shorter
 *
 * The bottom edge is the only one left, and it is the right one anyway: five statuses read left to
 * right as a pipeline, which is a shape a horizontal strip has and a vertical list does not. What
 * changed is the density. The old board spent its height on furniture — a standing paragraph
 * explaining unassigned tasks, a permanently-open new-task form in the header, and two-line cards
 * with a button inside each — and could take 38% of the screen to show a handful of tasks. So:
 *
 * - **A task is one line.** Title, then its room, its agent and its blocked flag as inline meta at
 *   11px. Two lines per card is what made five columns tall.
 * - **The new-task form is a popover** behind a `+` in the header. It is the same form, defaulting
 *   the same way (no room — the orchestrator decides), and the explanation that used to be a
 *   standing line of the board now lives in it, where it is read at the moment it applies.
 * - **The ceiling came down to 30vh**, because it now fits.
 *
 * It spans only the strip the side panels leave uncovered — it reads `hudInsets` for that, the same
 * numbers the camera framing uses — and it reports its own height into the same record, so opening
 * it re-frames the factory into what is still visible instead of hiding a row of buildings.
 */

/** How tall the open board is allowed to get before its groups scroll. */
const BOARD_MAX_HEIGHT = "30vh";

/** Plain-words labels; the protocol's own strings are snake_case and read as code. */
const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
};

/**
 * `blocked` is the only status with a colour, and it is the floor's own amber for "this wants
 * attention". Colouring all five would make the board a rainbow in which nothing is emphasised,
 * which is the same as colouring none of them.
 */
const STATUS_TINT: Partial<Record<TaskStatus, string>> = { blocked: "text-status-blocked" };

/**
 * The unassigned card's affordance: ask the orchestrator where this belongs.
 *
 * **It asks; it never assigns.** `route_task` sends the orchestrator a message describing the task
 * and the floor, and the card stays visibly unassigned until it actually answers — routing is a
 * model decision, so it is allowed to be slow, and a board that moved the card optimistically would
 * be claiming a decision nobody has made. With no orchestrator there is nothing to ask, so the note
 * that has always explained an unassigned card stays exactly where it was, now saying what to do
 * about it.
 */
function RouteIt({ taskId }: { taskId: string }) {
  const hasOrchestrator = useHasOrchestrator();
  const connected = useFabric((s) => s.connected);

  if (!hasOrchestrator) {
    return (
      <span
        className="italic text-fg-faint"
        title="Unassigned. Routing needs an orchestrator — create one in the project room's panel."
      >
        unassigned — no orchestrator
      </span>
    );
  }

  return (
    <button
      onClick={() => send({ kind: "route_task", taskId })}
      disabled={!connected}
      title="Ask the orchestrator which room this belongs to. It stays unassigned until it answers."
      className={cn(
        "inline-flex items-center gap-0.5 rounded-[2px] text-accent underline underline-offset-2",
        "outline-none hover:text-accent/80 focus-visible:ring-1 focus-visible:ring-accent",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      <SignpostIcon className="size-2.5" />
      route it
    </button>
  );
}

/** One card. Subscribes to nothing: the board hands it the task, and identity is preserved upstream. */
const TaskCard = memo(function TaskCard({ task }: { task: TaskInfo }) {
  const room = useFabric((s) => s.rooms.find((r) => r.id === task.roomId));
  const selectRoom = useFabric((s) => s.selectRoom);
  const blocked = task.blockedOnMessageId !== null;

  return (
    <li
      className={cn(
        "rounded-[3px] border bg-panel-raised/60 px-1.5 py-1",
        blocked ? "border-status-blocked/60" : "border-line",
      )}
    >
      <div className="truncate text-xs text-fg" title={task.detail === "" ? task.title : task.detail}>
        {task.title}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-2xs">
        {room === undefined ? (
          // Not a failure and not a placeholder: an unrouted task is the intended state of a task
          // nobody has assigned yet — and with an orchestrator on the floor it is one click from
          // being decided. See `RouteIt`.
          <RouteIt taskId={task.id} />
        ) : (
          <button
            onClick={() => selectRoom(room.id)}
            title={`Show the ${room.name} room on the floor`}
            className="rounded-[2px] text-accent underline underline-offset-2 hover:text-accent/80"
          >
            {room.name}
          </button>
        )}
        {task.agentId !== null && (
          <code className="font-mono text-fg-faint" title={task.agentId}>
            {task.agentId.slice(0, 8)}
          </code>
        )}
        {blocked && (
          <span
            className="inline-flex items-center gap-0.5 text-status-blocked"
            title={`Waiting on bus message ${task.blockedOnMessageId}`}
          >
            <FlagIcon className="size-2.5" />
            waiting on another room
          </span>
        )}
      </div>
    </li>
  );
});

/** One status group, always drawn: an empty "Blocked" column is worth seeing. */
function StatusGroup({ status, tasks }: { status: TaskStatus; tasks: TaskInfo[] }) {
  // Narrow on purpose: five groups have to fit the strip between the side panels before the row
  // starts scrolling, and a card's title truncates rather than wraps.
  return (
    <section className="min-w-[130px] flex-1">
      <h3
        className={cn(
          "mb-1 flex items-center gap-1 text-2xs font-semibold uppercase tracking-[0.08em]",
          STATUS_TINT[status] ?? "text-fg-faint",
        )}
      >
        {STATUS_LABEL[status]}
        <span className="font-normal tabular-nums text-fg-faint">{tasks.length}</span>
      </h3>
      {tasks.length === 0 ? (
        <div className="text-2xs text-fg-faint/60">—</div>
      ) : (
        <ul className="space-y-1">
          {tasks.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The new-task form, in a popover off the board's header.
 *
 * **Leaving the room empty is the intended path**, not a shortcut: an unrouted task is one the
 * orchestrator will route (M3b), and until that exists it sits in the board's unassigned cards
 * saying so. Nothing here guesses a room — a fake routing would be a board that lies about who owns
 * the work. The Radix select needs a real sentinel for "no room" because it reserves the empty
 * string; the wire still just leaves the field out.
 */
const NO_ROOM = "__none__";

function NewTask({ connected }: { connected: boolean }) {
  const rooms = useFabric((s) => s.rooms);
  const hasOrchestrator = useHasOrchestrator();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [roomId, setRoomId] = useState(NO_ROOM);

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    const wanted = title.trim();
    if (wanted === "") return;
    send({
      kind: "create_task",
      title: wanted,
      ...(detail.trim() === "" ? {} : { detail: detail.trim() }),
      // Omitted, never null: "the orchestrator decides" is the absence of a room, and the protocol
      // says so by leaving the field out.
      ...(roomId === NO_ROOM ? {} : { roomId }),
    });
    setTitle("");
    setDetail("");
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="xs" variant="accent" disabled={!connected} title="Add a task to the board">
          <PlusIcon />
          task
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-80">
        <form onSubmit={submit} className="space-y-1.5">
          <Input
            name="taskTitle"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="new task…"
          />
          <Input
            name="taskDetail"
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="detail (optional)"
          />
          <div className="flex items-center gap-1.5">
            <Select value={roomId} onValueChange={setRoomId}>
              <SelectTrigger aria-label="Room" className="flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ROOM}>no room — the orchestrator decides</SelectItem>
                {rooms.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" variant="accent" disabled={!connected}>
              Add
            </Button>
          </div>
          <FieldNote>
            {hasOrchestrator
              ? "A task with no room goes to the orchestrator, which decides where it belongs and "
                + "tells that room. It stays unassigned on the board until it answers."
              : "A task with no room stays unassigned: routing needs an orchestrator, and this "
                + "factory has none. Create one in the project room's panel."}
          </FieldNote>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function TaskPanel() {
  const [open, setOpen] = useState(true);
  const tasks = useTasks();
  const connected = useFabric((s) => s.connected);
  const insets = useHudInsets();

  const groups = tasksByStatus(tasks);
  const unfinished = tasks.filter((t) => t.status !== "done").length;
  const blocked = tasks.filter((t) => t.blockedOnMessageId !== null).length;
  // Unassigned cards are scattered across the status groups (most are `open`, but an agent can move
  // one before anybody routed it), so the count belongs in the header where it can be seen at once.
  const unassigned = unassignedTasks(tasks).length;

  return (
    <EdgePanel
      side="bottom"
      open={open}
      onOpenChange={setOpen}
      label="Tasks"
      icon={<ListChecksIcon />}
      summary={
        blocked > 0 ? (
          <span className="text-status-blocked">
            {unfinished}·{blocked}⚑
          </span>
        ) : (
          unfinished
        )
      }
      summaryTitle={`Open the task board — ${unfinished} unfinished${blocked > 0 ? `, ${blocked} waiting on another room` : ""}`}
      headerExtra={
        <>
          <span className="text-2xs tabular-nums text-fg-muted">
            {tasks.length === 0 ? "none yet" : `${unfinished} open · ${tasks.length} total`}
          </span>
          {blocked > 0 && (
            <Badge variant="warn" title={`${blocked} waiting on another room`}>
              <FlagIcon />
              {blocked}
            </Badge>
          )}
          {unassigned > 0 && (
            <Badge
              title={`${unassigned} task${unassigned === 1 ? "" : "s"} with no room — "route it" on the card asks the orchestrator`}
            >
              <SignpostIcon />
              {unassigned} unassigned
            </Badge>
          )}
          <span className="ml-auto">
            <NewTask connected={connected} />
          </span>
        </>
      }
      // The strip the side panels leave: the same numbers the camera frames into.
      style={{ left: insets.left, right: insets.right, maxHeight: BOARD_MAX_HEIGHT }}
    >
      {/* Scrolls inside itself, on both axes: five groups do not fit a narrow strip, and a board
          that pushed the page sideways would move the whole factory with it. */}
      <div className="hud-scroll flex min-h-0 flex-1 items-start gap-3 overflow-auto px-3 pb-2.5">
        {groups.map((g) => (
          <StatusGroup key={g.status} status={g.status} tasks={g.tasks} />
        ))}
      </div>
    </EdgePanel>
  );
}

/** Exported for the tests that pin the board's reading order to the protocol's own statuses. */
export const BOARD_ORDER = TASK_STATUS_ORDER;
