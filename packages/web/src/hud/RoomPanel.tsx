import type { AutonomyMode, SessionInfo } from "@superfabric/shared";
import { RoomName } from "@superfabric/shared";
import { memo, useEffect, useRef, useState } from "react";
import { BYPASS_COLOR, SELECT_COLOR, STATUS_COLOR } from "../scene/palette";
import type { FactoryStatus } from "../store";
import {
  agentStatus,
  useFabric,
  useIsSelected,
  useRoom,
  useRoomAgentCount,
  useRoomAgents,
  useRoomIds,
  useRoomlessSessions,
  useRoomStatus,
  useRoomTaskCount,
  useSelectedRoomId,
} from "../store";
import { send } from "../wsClient";
import { AutonomySelect } from "./AutonomySelect";
import { HUD } from "./theme";
import { useHudInset } from "./useHudInset";

/**
 * The room panel: the first surface from which a person can actually build a factory. Until now a
 * room could only be created by a WebSocket script, which made the whole floor a thing to look at
 * rather than a thing to use.
 *
 * It lives on the left because the console drawer owns the right edge; the two never overlap, and
 * between them the middle of the floor stays clear.
 *
 * Every row subscribes to its own room (`useRoom`, `useRoomAgentCount`, `useRoomStatus`), the same
 * way the buildings do — so an agent starting work in one room repaints one row, not the panel. And
 * selection is the *same* `selectedRoomId` the buildings use, which is what makes clicking a
 * building highlight its row and clicking a row ring the building.
 */

/** Plain-words version of `RoomName`'s regex, shown before the operator can get it wrong. */
const NAME_RULE =
  "lowercase letters, digits, dot, dash and underscore; must start with a letter or digit";

/** The room's name is a folder segment, so the same rule the server enforces is checked here first. */
function nameProblem(name: string): string | null {
  const parsed = RoomName.safeParse(name);
  if (parsed.success) return null;
  if (name === "") return "A room needs a name.";
  if (name.length > 64) return "Too long — 64 characters at most.";
  return `Not a usable folder name: ${NAME_RULE}.`;
}

/** The status vocabulary of the floor, as a 8px dot. Colours come from the scene's one table. */
function StatusDot({ status, title }: { status: FactoryStatus; title?: string }) {
  return (
    <span
      title={title ?? status}
      aria-label={status}
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: STATUS_COLOR[status],
        // An idle dot must not read as a light that is on; a ring around it says "known, quiet".
        boxShadow: status === "idle" ? "none" : `0 0 6px ${STATUS_COLOR[status]}`,
        flex: "none",
      }}
    />
  );
}

/** One room in the list: name, live agents, status dot. Selecting it selects the building. */
const RoomRow = memo(function RoomRow({ roomId }: { roomId: string }) {
  const room = useRoom(roomId);
  const agents = useRoomAgentCount(roomId);
  const tasks = useRoomTaskCount(roomId);
  const status = useRoomStatus(roomId);
  const selected = useIsSelected(roomId);
  const selectRoom = useFabric((s) => s.selectRoom);

  if (room === undefined) return null;

  return (
    <li>
      <button
        onClick={() => selectRoom(roomId)}
        title={room.path}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          font: "inherit",
          textAlign: "left",
          padding: "5px 7px",
          marginBottom: 3,
          cursor: "pointer",
          // Selection is cyan everywhere, on the floor and in this list: the two are the
          // same `selectedRoomId`, so they must not be two different colours.
          background: selected ? "#e6fbff" : "#fff",
          border: `1px solid ${selected ? SELECT_COLOR : HUD.line}`,
          borderRadius: 4,
        }}
      >
        <StatusDot status={status} />
        <span style={{ fontWeight: selected ? 700 : 400, overflow: "hidden", textOverflow: "ellipsis" }}>
          {room.name}
        </span>
        {room.kind === "project" && <span style={{ color: HUD.dim, fontSize: 12 }}>project</span>}
        <span style={{ flex: 1 }} />
        {/* Unfinished tasks owned by this room — the same count the board's cards add up to, so the
            list and the board can never disagree about who owes what. */}
        {tasks > 0 && (
          <span
            title={`${tasks} unfinished task${tasks === 1 ? "" : "s"} on the board`}
            style={{
              color: HUD.text,
              fontSize: 12,
              lineHeight: "16px",
              padding: "0 6px",
              borderRadius: 8,
              border: `1px solid ${HUD.line}`,
              background: "#f1f1f1",
              whiteSpace: "nowrap",
            }}
          >
            {tasks}
          </span>
        )}
        <span style={{ color: HUD.dim, fontSize: 12, whiteSpace: "nowrap" }}>
          {agents} agent{agents === 1 ? "" : "s"}
        </span>
      </button>
    </li>
  );
});

/** One agent of the selected room: what it is doing, and how much rope it has. */
function AgentLine({ agent, connected }: { agent: SessionInfo; connected: boolean }) {
  const status = agentStatus(agent);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
      <StatusDot status={status} title={`${status} · ${agent.state}`} />
      <code style={{ fontSize: 12 }} title={agent.id}>
        {agent.id.slice(0, 8)}
      </code>
      <span style={{ color: HUD.dim, fontSize: 12 }}>{status}</span>
      {agent.autonomy === "bypass" && (
        <span title="ungated — nothing this agent does is asked about" style={{ color: BYPASS_COLOR, fontSize: 12 }}>
          ungated
        </span>
      )}
      <span style={{ flex: 1 }} />
      <AutonomySelect
        value={agent.autonomy}
        disabled={!connected}
        short
        onChange={(autonomy: AutonomyMode) =>
          send({ kind: "set_autonomy", sessionId: agent.id, autonomy })
        }
      />
    </div>
  );
}

/**
 * The room's folder, and how to point it somewhere else.
 *
 * Kept next to the path rather than behind a settings screen because the folder *is* the room: a
 * department may live in a separate repository, and re-pointing it is a normal thing to do rather than
 * a repair. The two things an operator must know are said out loud: nothing is moved on disk, and an
 * agent already running keeps the folder its session started in.
 */
function RoomFolder({ roomId, path: current, connected }: { roomId: string; path: string; connected: boolean }) {
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState(current);
  const clearError = useFabric((s) => s.clearError);

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    const wanted = path.trim();
    if (wanted === "" || wanted === current) {
      setEditing(false);
      return;
    }
    clearError();
    send({ kind: "set_room_path", roomId, path: wanted });
    setEditing(false);
  }

  if (!editing) {
    return (
      <div style={{ marginBottom: 4 }}>
        {/* The path is the room: "room = folder" is the product's central claim, so the folder is
            shown rather than hidden behind an id. */}
        <div style={{ color: HUD.dim, fontSize: 12, wordBreak: "break-all" }}>{current}</div>
        <button
          onClick={() => { setPath(current); setEditing(true); }}
          disabled={!connected}
          style={{ font: "inherit", fontSize: 12, marginTop: 2 }}
        >
          Change folder…
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={{ marginBottom: 4 }}>
      <input
        name="roomPath"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder="/absolute/path/to/the/folder"
        style={{ width: "100%", boxSizing: "border-box", padding: "5px 7px", font: "inherit" }}
      />
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <button type="submit" disabled={!connected} style={{ font: "inherit" }}>
          Re-point
        </button>
        <button type="button" onClick={() => setEditing(false)} style={{ font: "inherit" }}>
          Cancel
        </button>
      </div>
      <div style={{ color: HUD.dim, fontSize: 12, marginTop: 4 }}>
        An absolute path, typed by hand — the browser cannot hand the server a real folder path, so
        there is no picker. Nothing is moved: this re-points the room. Agents already running here keep
        their old folder until they are restarted; new ones use the new one.
      </div>
    </form>
  );
}

/** The selected room in full: where it lives on disk, who works there, and how to add someone. */
function SelectedRoom({ roomId, connected }: { roomId: string; connected: boolean }) {
  const room = useRoom(roomId);
  const agents = useRoomAgents(roomId);
  if (room === undefined) return null;

  return (
    <section style={{ borderTop: `1px solid ${HUD.line}`, paddingTop: 10, marginBottom: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>{room.name}</div>
      {room.kind === "project" ? (
        // The central building stands for the project root itself, so its folder is the project's —
        // changing it here would let the two disagree. Another factory is another project.
        <div style={{ color: HUD.dim, fontSize: 12, wordBreak: "break-all", marginBottom: 4 }}>
          {room.path}
        </div>
      ) : (
        <RoomFolder roomId={roomId} path={room.path} connected={connected} />
      )}
      {/* The charter is where an agent learns it is a department with a bus. A room created here
          gets that section written for it; a folder that already had a CLAUDE.md keeps its own,
          untouched — so for those it is the operator who has to say it. */}
      <div style={{ color: HUD.dim, fontSize: 12, marginBottom: 8 }}>
        Charter: <code>CLAUDE.md</code> in that folder. New rooms are told about the factory bus in
        theirs; a folder that already had one is never overwritten, so add it by hand there.
      </div>

      {agents.length === 0 ? (
        <div style={{ color: HUD.dim, marginBottom: 8 }}>No agents here yet.</div>
      ) : (
        <div style={{ marginBottom: 8 }}>
          {agents.map((a) => (
            <AgentLine key={a.id} agent={a} connected={connected} />
          ))}
        </div>
      )}

      <button
        onClick={() => send({ kind: "create_session", roomId })}
        disabled={!connected}
        style={{ font: "inherit" }}
      >
        New agent here
      </button>
    </section>
  );
}

/**
 * Sessions that belong to no room. They are deliberately visible and deliberately not draggable into
 * one: hiding a running agent because the floor cannot draw it would be the panel lying about what
 * the server is running. Moving them into a room is a separate feature and a separate protocol
 * message that does not exist yet.
 */
function UnassignedSessions() {
  const sessions = useRoomlessSessions();
  if (sessions.length === 0) return null;

  return (
    <section style={{ borderTop: `1px solid ${HUD.line}`, paddingTop: 10 }}>
      <div style={{ fontWeight: 700 }}>Unassigned agents</div>
      <div style={{ color: HUD.dim, fontSize: 12, marginBottom: 6 }}>
        In no room, so nothing on the floor draws them.
      </div>
      {sessions.map((s) => (
        <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
          <StatusDot status={agentStatus(s)} title={`${agentStatus(s)} · ${s.state}`} />
          <code style={{ fontSize: 12 }} title={s.id}>
            {s.id.slice(0, 8)}
          </code>
          <span style={{ color: HUD.dim, fontSize: 12 }}>{s.state}</span>
        </div>
      ))}
    </section>
  );
}

export function RoomPanel() {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState("");
  /** An explicit folder for the new room, empty for the default `<project>/<name>`. */
  const [path, setPath] = useState("");
  const [showPath, setShowPath] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const roomIds = useRoomIds();
  const selectedRoomId = useSelectedRoomId();
  const connected = useFabric((s) => s.connected);
  const lastError = useFabric((s) => s.lastError);
  const clearError = useFabric((s) => s.clearError);
  const selectRoom = useFabric((s) => s.selectRoom);
  /** The name we are waiting for the server to confirm, so the new room can be selected on arrival. */
  const pending = useRef<string | null>(null);
  // How much of the canvas this panel covers, so the camera can frame the floor that is visible.
  const inset = useHudInset<HTMLElement>("left");

  // Select a room the operator just created the moment the broadcast introduces it: they asked for
  // it, so it is what they want to look at — and the detail section is where "New agent here" is.
  useEffect(() => {
    if (pending.current === null) return;
    const room = useFabric.getState().rooms.find((r) => r.name === pending.current);
    if (room === undefined) return;
    pending.current = null;
    selectRoom(room.id);
  }, [roomIds, selectRoom]);

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    const wanted = name.trim();
    const bad = nameProblem(wanted);
    setProblem(bad);
    if (bad !== null) return;
    const folder = showPath ? path.trim() : "";
    // A stale rejection ("already exists") must not sit under a fresh attempt.
    clearError();
    pending.current = wanted;
    // With a folder the room lives exactly there, anywhere on disk; without one it is
    // `<project root>/<name>` and the server keeps it inside the root.
    send({ kind: "create_room", name: wanted, ...(folder === "" ? {} : { path: folder }) });
    setName("");
    setPath("");
  }

  return (
    <aside
      ref={inset}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        bottom: 0,
        width: open ? "min(320px, 32vw)" : "auto",
        boxSizing: "border-box",
        fontFamily: "system-ui, sans-serif",
        fontSize: 14,
        color: HUD.text,
        background: open ? HUD.panel : "transparent",
        borderRight: open ? `1px solid ${HUD.line}` : "none",
        padding: open ? "12px 14px" : 8,
        overflowY: "auto",
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        title={open ? "Collapse the room panel" : "Open the room panel"}
        style={{ font: "inherit", marginBottom: open ? 8 : 0 }}
      >
        {open ? "‹ rooms" : "rooms ›"}
      </button>

      {/* Kept mounted while collapsed so a half-typed room name survives a collapse. */}
      <div style={{ display: open ? "block" : "none" }}>
        <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Rooms</h2>

        <form onSubmit={submit} style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              name="roomName"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setProblem(null);
              }}
              placeholder="new room name…"
              style={{ flex: 1, minWidth: 0, padding: "5px 7px", font: "inherit" }}
            />
            <button type="submit" disabled={!connected} style={{ font: "inherit" }}>
              Create
            </button>
          </div>
          <div style={{ color: HUD.dim, fontSize: 12, marginTop: 4 }}>
            The name is the folder name: {NAME_RULE}.
          </div>
          {/* The default is `<project>/<name>`, which is what "room = folder" means most of the
              time. A department that lives in a separate repository is the exception, so the field
              for it is out of the way until it is asked for. */}
          {showPath ? (
            <>
              <input
                name="roomPath"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/absolute/path/to/an/existing/repo"
                style={{ width: "100%", boxSizing: "border-box", marginTop: 6, padding: "5px 7px", font: "inherit" }}
              />
              <div style={{ color: HUD.dim, fontSize: 12, marginTop: 4 }}>
                Typed by hand — the browser cannot hand the server a real folder path, so there is no
                picker. Leave it empty to use the project's own folder. An existing{" "}
                <code>CLAUDE.md</code> there is never overwritten.{" "}
                <button
                  type="button"
                  onClick={() => { setShowPath(false); setPath(""); }}
                  style={{ font: "inherit", fontSize: 12 }}
                >
                  use the default
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setShowPath(true)}
              style={{ font: "inherit", fontSize: 12, marginTop: 4 }}
            >
              Choose a folder outside the project…
            </button>
          )}
          {problem !== null && <div style={{ color: HUD.err, fontSize: 12, marginTop: 4 }}>{problem}</div>}
          {lastError !== null && (
            <div style={{ color: HUD.err, fontSize: 12, marginTop: 4 }}>server: {lastError}</div>
          )}
        </form>

        {roomIds.length === 0 ? (
          <div style={{ color: HUD.dim, marginBottom: 12 }}>
            {connected ? "No rooms yet." : "Waiting for the server…"}
          </div>
        ) : (
          <ul style={{ listStyle: "none", margin: "0 0 12px", padding: 0 }}>
            {roomIds.map((id) => (
              <RoomRow key={id} roomId={id} />
            ))}
          </ul>
        )}

        {selectedRoomId !== null && <SelectedRoom roomId={selectedRoomId} connected={connected} />}
        <UnassignedSessions />
      </div>
    </aside>
  );
}
