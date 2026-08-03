import type { TaskInfo, TaskStatus } from "@superfabric/shared";
import { memo, useState } from "react";
import {
  TASK_STATUS_ORDER,
  tasksByStatus,
  useFabric,
  useHudInsets,
  useTasks,
} from "../store";
import { send } from "../wsClient";
import { HUD } from "./theme";
import { useHudInset } from "./useHudInset";

/**
 * The task board: what the factory is supposed to be doing, as opposed to what it is doing right
 * now (the floor) or what one agent said (the console).
 *
 * It takes the **bottom** edge because the other two are spoken for, and it spans only the strip the
 * side panels leave uncovered — it reads `hudInsets` for that, the same numbers the camera framing
 * uses, so the board and the floor are laid out against one shared idea of where the free space is.
 * It reports its own height into the same record, so opening it re-frames the factory into what is
 * still visible instead of hiding a row of buildings behind it.
 *
 * Cards are grouped by status rather than laid out as columns of equal weight: the board is read
 * left to right as a pipeline, and the group that matters — `blocked` — is called out in the middle
 * where a reader lands rather than at the end.
 */

/** How tall the open board is allowed to get before its groups scroll. */
const BOARD_MAX_HEIGHT = "38vh";

/** Plain-words labels; the protocol's own strings are snake_case and read as code. */
const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
};

/**
 * `blocked` is the only status with a colour, and it is the amber the rest of the HUD already uses
 * for "this wants attention". Colouring all five would make the board a rainbow in which nothing is
 * emphasised, which is the same as colouring none of them.
 */
const STATUS_TINT: Partial<Record<TaskStatus, string>> = { blocked: HUD.card };

/** One card. Subscribes to nothing: the board hands it the task, and identity is preserved upstream. */
const TaskCard = memo(function TaskCard({ task }: { task: TaskInfo }) {
  const room = useFabric((s) => s.rooms.find((r) => r.id === task.roomId));
  const selectRoom = useFabric((s) => s.selectRoom);
  const blocked = task.blockedOnMessageId !== null;

  return (
    <li
      style={{
        border: `1px solid ${blocked ? HUD.card : HUD.line}`,
        borderRadius: 4,
        background: "#fff",
        padding: "5px 7px",
        marginBottom: 4,
      }}
    >
      <div style={{ marginBottom: 2 }} title={task.detail === "" ? undefined : task.detail}>
        {task.title}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 12 }}>
        {room === undefined ? (
          // Not a failure and not a placeholder: an unrouted task is the intended state of a task
          // nobody has assigned yet. See the note under the form.
          <span style={{ color: HUD.dim, fontStyle: "italic" }}>unassigned</span>
        ) : (
          <button
            onClick={() => selectRoom(room.id)}
            title={`Show the ${room.name} room on the floor`}
            style={{ font: "inherit", fontSize: 12, padding: "1px 5px", cursor: "pointer" }}
          >
            {room.name}
          </button>
        )}
        {task.agentId !== null && (
          <code style={{ color: HUD.dim }} title={task.agentId}>
            {task.agentId.slice(0, 8)}
          </code>
        )}
        {blocked && (
          <span
            style={{ color: HUD.card }}
            title={`Waiting on bus message ${task.blockedOnMessageId}`}
          >
            ⚑ waiting on another room
          </span>
        )}
      </div>
    </li>
  );
});

/** One status group, always drawn: an empty "Blocked" column is worth seeing. */
function StatusGroup({ status, tasks }: { status: TaskStatus; tasks: TaskInfo[] }) {
  // Narrow on purpose: five groups have to fit the strip between the side panels before the row
  // starts scrolling, and a card's title wraps happily.
  return (
    <section style={{ flex: "1 1 120px", minWidth: 120 }}>
      <h3
        style={{
          font: "inherit",
          fontWeight: 700,
          fontSize: 12,
          margin: "0 0 4px",
          color: STATUS_TINT[status] ?? HUD.dim,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        {STATUS_LABEL[status]} <span style={{ color: HUD.dim, fontWeight: 400 }}>{tasks.length}</span>
      </h3>
      {tasks.length === 0 ? (
        <div style={{ color: HUD.line, fontSize: 12 }}>—</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {tasks.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The new-task form. **Leaving the room empty is the intended path**, not a shortcut: an unrouted
 * task is one the orchestrator will route (M3b), and until that exists it sits in the board's
 * unassigned cards saying so. Nothing here guesses a room — a fake routing would be a board that
 * lies about who owns the work.
 */
function NewTask({ connected }: { connected: boolean }) {
  const rooms = useFabric((s) => s.rooms);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [roomId, setRoomId] = useState("");

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
      ...(roomId === "" ? {} : { roomId }),
    });
    setTitle("");
    setDetail("");
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      <input
        name="taskTitle"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="new task…"
        style={{ flex: "2 1 200px", minWidth: 0, padding: "4px 6px", font: "inherit" }}
      />
      <input
        name="taskDetail"
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        placeholder="detail (optional)"
        style={{ flex: "3 1 240px", minWidth: 0, padding: "4px 6px", font: "inherit" }}
      />
      <select
        aria-label="Room"
        value={roomId}
        onChange={(e) => setRoomId(e.target.value)}
        style={{ font: "inherit" }}
      >
        <option value="">no room — the orchestrator decides</option>
        {rooms.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      <button type="submit" disabled={!connected} style={{ font: "inherit" }}>
        Add
      </button>
    </form>
  );
}

export function TaskPanel() {
  const [open, setOpen] = useState(true);
  const tasks = useTasks();
  const connected = useFabric((s) => s.connected);
  const insets = useHudInsets();
  // The board measures its own height into the same record it reads the side panels' widths from.
  const inset = useHudInset<HTMLElement>("bottom");

  const groups = tasksByStatus(tasks);
  const unfinished = tasks.filter((t) => t.status !== "done").length;
  const blocked = tasks.filter((t) => t.blockedOnMessageId !== null).length;

  return (
    <aside
      ref={inset}
      style={{
        position: "fixed",
        // The strip the side panels leave: the same numbers the camera frames into.
        left: insets.left,
        right: insets.right,
        bottom: 0,
        boxSizing: "border-box",
        maxHeight: BOARD_MAX_HEIGHT,
        display: "flex",
        flexDirection: "column",
        fontFamily: "system-ui, sans-serif",
        fontSize: 14,
        color: HUD.text,
        background: open ? HUD.panel : "transparent",
        borderTop: open ? `1px solid ${HUD.line}` : "none",
        padding: open ? "8px 12px 10px" : 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={() => setOpen(!open)}
          title={open ? "Collapse the task board" : "Open the task board"}
          style={{ font: "inherit" }}
        >
          {open ? "⌄ tasks" : "⌃ tasks"}
        </button>
        <span style={{ color: HUD.dim, fontSize: 12 }}>
          {tasks.length === 0
            ? "no tasks yet"
            : `${unfinished} open · ${tasks.length} total${blocked > 0 ? ` · ${blocked} waiting on another room` : ""}`}
        </span>
        {open && (
          <>
            <span style={{ flex: 1 }} />
            <NewTask connected={connected} />
          </>
        )}
      </div>

      {open && (
        <>
          <div style={{ color: HUD.dim, fontSize: 12, margin: "4px 0 6px" }}>
            A task with no room stays unassigned — routing arrives with the orchestrator (M3b).
          </div>
          {/* Scrolls inside itself, on both axes: five groups do not fit a narrow strip, and a board
              that pushed the page sideways would move the whole factory with it. */}
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
              flex: 1,
              minHeight: 0,
              overflow: "auto",
            }}
          >
            {groups.map((g) => (
              <StatusGroup key={g.status} status={g.status} tasks={g.tasks} />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

/** Exported for the tests that pin the board's reading order to the protocol's own statuses. */
export const BOARD_ORDER = TASK_STATUS_ORDER;
