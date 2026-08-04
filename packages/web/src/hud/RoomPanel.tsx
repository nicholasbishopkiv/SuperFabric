import type { AutonomyMode, RoomRuntime, SessionInfo } from "@superfabric/shared";
import { RoomName } from "@superfabric/shared";
import {
  BotIcon, CircleUserIcon, FlagIcon, FolderIcon, PencilIcon, PlusIcon, ShieldIcon, WarehouseIcon,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { FactoryStatus } from "../store";
import {
  accountLabel,
  agentStatus,
  useFabric,
  useIsSelected,
  useOrchestrator,
  useRoom,
  useRoomAgentCount,
  useRoomAgents,
  useRoomHasOrchestrator,
  useRoomIds,
  useRoomlessSessions,
  useRoomStatus,
  useRoomTaskCount,
  useSelectedRoomId,
  useAccounts,
  useRoleProblems,
} from "../store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { FieldNote, Input } from "../ui/input";
import { cn } from "../ui/utils";
import { send } from "../wsClient";
import { AccountSelect } from "./AccountSelect";
import { AutonomySelect } from "./AutonomySelect";
import { ModelSelect } from "./ModelSelect";
import { RoleSelect } from "./RoleSelect";
import { RUNTIME_SUMMARY, RuntimeSelect } from "./RuntimeSelect";
import { EdgePanel, PanelSection } from "./Panel";
import { StatusDot } from "./StatusDot";
import { formatCountdown, useTickingNow } from "./UsageMeters";

/**
 * The room panel: the first surface from which a person can actually build a factory.
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

/** One room in the list: name, live agents, status dot. Selecting it selects the building. */
const RoomRow = memo(function RoomRow({ roomId }: { roomId: string }) {
  const room = useRoom(roomId);
  const agents = useRoomAgentCount(roomId);
  const tasks = useRoomTaskCount(roomId);
  const status: FactoryStatus = useRoomStatus(roomId);
  const selected = useIsSelected(roomId);
  const orchestrator = useRoomHasOrchestrator(roomId);
  const selectRoom = useFabric((s) => s.selectRoom);

  if (room === undefined) return null;

  return (
    <li>
      <button
        onClick={() => selectRoom(roomId)}
        title={room.path}
        className={cn(
          "flex w-full items-center gap-2 rounded-[3px] border px-2 py-1 text-left text-sm",
          "outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent",
          // Selection is cyan everywhere, on the floor and in this list: the two are the same
          // `selectedRoomId`, so they must not be two different colours.
          selected
            ? "border-accent/70 bg-accent/12 text-accent"
            : "border-transparent text-fg hover:border-line hover:bg-fg/5",
        )}
      >
        <StatusDot status={status} />
        <span className={cn("truncate", selected && "font-semibold")}>{room.name}</span>
        {room.kind === "project" && (
          <span className="shrink-0 text-2xs text-fg-faint">project</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* The same fact the building's label carries, in the list: agents created here run in a
              container. Shown on the row rather than only in the detail, because "which of my
              departments are sandboxed" is a question about the whole floor. */}
          {room.runtime === "container" && (
            <ShieldIcon
              className="size-3 text-fg-muted"
              aria-label="new agents here run in a container"
            />
          )}
          {/* The same fact the building's label and the figure's standard carry, in the list: this
              is where the senior agent stands. */}
          {orchestrator && (
            <FlagIcon className="size-3 text-accent" aria-label="the orchestrator works here" />
          )}
          {/* Unfinished tasks owned by this room — the same count the board's cards add up to, so the
              list and the board can never disagree about who owes what. */}
          {tasks > 0 && (
            <Badge title={`${tasks} unfinished task${tasks === 1 ? "" : "s"} on the board`}>
              {tasks}
            </Badge>
          )}
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-2xs tabular-nums",
              agents > 0 ? "text-fg-muted" : "text-fg-faint",
            )}
            title={`${agents} live agent${agents === 1 ? "" : "s"}`}
          >
            <BotIcon className="size-3" />
            {agents}
          </span>
        </span>
      </button>
    </li>
  );
});

/**
 * The factory's senior agent, in the project room's detail — where an operator looking at the
 * central building already is.
 *
 * `ensure_orchestrator` is idempotent and argument-free, so this is one button with nothing to get
 * wrong: it makes one if there is none and hands back the one there is. It lives here rather than on
 * the board because the orchestrator is an *agent in a room*, not a property of the task list; the
 * board's job is to say when a task needs it (see `TaskPanel`).
 */
function OrchestratorLine({ connected }: { connected: boolean }) {
  const orchestrator = useOrchestrator();

  if (orchestrator === undefined) {
    return (
      <div className="mt-2 rounded-[3px] border border-line/60 bg-panel-sunken/40 px-1.5 py-1.5">
        <div className="flex items-center gap-1.5">
          <FlagIcon className="size-3 shrink-0 text-fg-faint" />
          <span className="text-2xs text-fg-muted">No orchestrator yet.</span>
          <Button
            size="xs"
            variant="accent"
            className="ml-auto"
            onClick={() => send({ kind: "ensure_orchestrator" })}
            disabled={!connected}
            title="Create the factory's senior agent here, in the project room"
          >
            <PlusIcon />
            orchestrator
          </Button>
        </div>
        <FieldNote className="mt-1">
          The senior agent: it routes unassigned tasks to rooms, answers{" "}
          <code className="font-mono">factory_ask_orchestrator</code>, and records why with an ADR.
          It stands here, in the central building.
        </FieldNote>
      </div>
    );
  }

  return (
    <FieldNote className="mt-1.5 flex items-center gap-1.5">
      <FlagIcon className="size-3 shrink-0 text-accent" />
      <span>
        The orchestrator is{" "}
        <code className="font-mono text-fg-muted" title={orchestrator.id}>
          {orchestrator.id.slice(0, 8)}
        </code>{" "}
        — the figure carrying the standard.
      </span>
    </FieldNote>
  );
}

/** One agent of the selected room: what it is doing, how much rope it has, and what it runs on. */
function AgentLine({ agent, connected }: { agent: SessionInfo; connected: boolean }) {
  const status = agentStatus(agent);
  // Only a paused agent with a known return time has anything to count down.
  const now = useTickingNow(status === "paused" && agent.pausedUntil !== null);
  return (
    // Two rows rather than one: the panel is narrow and an agent carries two controls. Wrapping
    // keeps them both readable instead of squeezing each into a few characters.
    <div className="flex flex-wrap items-center gap-1.5 rounded-[3px] border border-line/60 bg-panel-sunken/40 px-1.5 py-1">
      <StatusDot status={status} title={`${status} · ${agent.state}`} />
      <code className="font-mono text-2xs text-fg" title={agent.id}>
        {agent.id.slice(0, 8)}
      </code>
      <span className="text-2xs text-fg-muted">{status}</span>
      {/* A held agent says *when it comes back*, not merely that it stopped. "Paused" with no
          horizon reads as broken; a countdown reads as a thing that is being handled. */}
      {status === "paused" && (
        <span
          className="text-2xs text-status-paused"
          title={
            agent.pausedUntil === null
              ? "Held because its account is at its limit. Nothing said when that lifts, so it resumes as soon as a reading says the window has rolled."
              : new Date(agent.pausedUntil * 1000).toLocaleString()
          }
        >
          {agent.pausedUntil === null
            ? "waiting for the limit to lift"
            : `resumes ${formatCountdown(new Date(agent.pausedUntil * 1000), now)}`}
        </span>
      )}
      {agent.isOrchestrator && (
        <Badge variant="accent" title="The factory's senior agent: it routes work and records why">
          <FlagIcon />
          orchestrator
        </Badge>
      )}
      {/* Where this agent is *actually* running — its own runtime, not its room's. A room switched
          to `container` while this one was working has not moved it, and a badge that read off the
          room would claim an isolation that is not in force. */}
      {agent.runtime === "container" && (
        <Badge
          title="contained: only this room's folder and its account, capped CPU/memory, default-deny egress"
        >
          <ShieldIcon />
          sandboxed
        </Badge>
      )}
      {agent.autonomy === "bypass" && (
        <Badge
          variant="bypass"
          title={
            agent.runtime === "container"
              ? "ungated — nothing this agent does is asked about. It is contained: the blast radius "
                + "is this room's folder and its account."
              : "ungated — nothing this agent does is asked about, and it runs on the host as you. "
                + "Nothing contains it: it can reach your whole filesystem and every credential you "
                + "have. Switch this room to the sandboxed runtime to bound that."
          }
        >
          ungated{agent.runtime === "host" ? " · uncontained" : ""}
        </Badge>
      )}
      <span className="ml-auto flex items-center gap-1">
        {/* What this agent arrived as. Changing it restarts the executor on the new charter, model
            and tool servers, resuming the same conversation — and never touches its autonomy, which
            is the control immediately to its right and the operator's own. */}
        <RoleSelect
          value={agent.roleId}
          disabled={!connected}
          short
          onChange={(roleId) => send({ kind: "set_role", sessionId: agent.id, roleId })}
        />
        <AutonomySelect
          value={agent.autonomy}
          disabled={!connected}
          short
          onChange={(autonomy: AutonomyMode) =>
            send({ kind: "set_autonomy", sessionId: agent.id, autonomy })
          }
        />
        {/* Changing this restarts the agent's executor on the new model, resuming the same
            conversation — see `SessionManager.setModel`. */}
        <ModelSelect
          value={agent.model}
          disabled={!connected}
          short
          onChange={(model) => send({ kind: "set_model", sessionId: agent.id, model })}
        />
        {/* Which subscription this agent is spending. Shown on every agent rather than only on the
            ones that are bound, because "the operator's own ~/.claude" is a real answer to that
            question and an agent whose account is invisible is an agent whose cost is invisible.
            Changing it restarts the executor for the same reason the model does — `Options.env` is
            fixed for the lifetime of a `query()`. */}
        <AccountSelect
          value={agent.accountId}
          disabled={!connected}
          short
          onChange={(accountId) => send({ kind: "set_session_account", sessionId: agent.id, accountId })}
        />
      </span>
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
function RoomFolder({
  roomId,
  path: current,
  connected,
}: {
  roomId: string;
  path: string;
  connected: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState(current);
  const clearError = useFabric((s) => s.clearError);
  // How many agents would *not* move with the room. Said before the change rather than after: the
  // server cannot report it as an error (the change succeeded), and an operator who learns it
  // afterwards has already been surprised.
  const running = useRoomAgentCount(roomId);

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
      <div className="flex items-start gap-1.5">
        {/* The path is the room: "room = folder" is the product's central claim, so the folder is
            shown rather than hidden behind an id. */}
        <FolderIcon className="mt-0.5 size-3 shrink-0 text-fg-faint" />
        <span className="min-w-0 break-all font-mono text-2xs text-fg-muted">{current}</span>
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto shrink-0"
          onClick={() => {
            setPath(current);
            setEditing(true);
          }}
          disabled={!connected}
          title="Point this room at another folder"
          aria-label="Change folder"
        >
          <PencilIcon />
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <Input
        name="roomPath"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder="/absolute/path/to/the/folder"
        className="font-mono text-xs"
      />
      <div className="mt-1.5 flex gap-1.5">
        <Button type="submit" variant="accent" disabled={!connected}>
          Re-point
        </Button>
        <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
      <FieldNote>
        An absolute path, typed by hand — the browser cannot hand the server a real folder path, so
        there is no picker. Nothing is moved: this re-points the room, and new agents start in the new
        folder.
      </FieldNote>
      {running > 0 && (
        <FieldNote className="text-status-blocked">
          {running} agent{running === 1 ? "" : "s"} already running here will keep the folder{" "}
          {running === 1 ? "it was" : "they were"} started in until restarted — the SDK owns a live
          session's working directory.
        </FieldNote>
      )}
    </form>
  );
}

/**
 * The account new agents in this room start on.
 *
 * A *default*, and the line underneath says so: an agent resolves its account once, when it is
 * created, and carries it on its own row from then on. Changing it here cannot move someone already
 * working, because the SDK bakes the subprocess environment in when the session starts — the same
 * constraint the room's folder has, and said the same way.
 */
function RoomAccount({ roomId, accountId, connected }: {
  roomId: string;
  accountId: string | null;
  connected: boolean;
}) {
  const accounts = useAccounts();
  const running = useRoomAgentCount(roomId);
  const clearError = useFabric((s) => s.clearError);

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1.5">
        <CircleUserIcon className="size-3 shrink-0 text-fg-faint" />
        <span className="text-2xs text-fg-muted">New agents run on</span>
        <span className="ml-auto">
          <AccountSelect
            value={accountId}
            disabled={!connected}
            short
            onChange={(next) => {
              clearError();
              send({ kind: "set_room_account", roomId, accountId: next });
            }}
          />
        </span>
      </div>
      {running > 0 && (
        <FieldNote>
          {running} agent{running === 1 ? "" : "s"} already here{" "}
          {running === 1 ? "keeps" : "keep"} the account{" "}
          {running === 1 ? "it was" : "they were"} started on ({accountLabel(accounts, accountId)} is
          only the default for new ones) — a live session's environment is the SDK's, not ours.
        </FieldNote>
      )}
    </div>
  );
}

/**
 * Where this room's agents run.
 *
 * Beside the account rather than behind a settings screen, and for a stronger version of the same
 * reason the account is: it decides what an agent working here *can reach*, which is a property of
 * the department. The two sentences under it are the two things an operator cannot discover from
 * the control itself — that a sandbox needs an account, and that nobody already working moves.
 */
function RoomRuntimeLine({ roomId, runtime, accountId, connected }: {
  roomId: string;
  runtime: RoomRuntime;
  accountId: string | null;
  connected: boolean;
}) {
  const running = useRoomAgents(roomId).filter((a) => a.runtime !== null && a.runtime !== runtime);
  const clearError = useFabric((s) => s.clearError);

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1.5">
        <ShieldIcon className="size-3 shrink-0 text-fg-faint" />
        <span className="text-2xs text-fg-muted">New agents run</span>
        <span className="ml-auto">
          <RuntimeSelect
            value={runtime}
            disabled={!connected}
            short
            onChange={(next) => {
              clearError();
              send({ kind: "set_room_runtime", roomId, runtime: next });
            }}
          />
        </span>
      </div>
      <FieldNote>{RUNTIME_SUMMARY[runtime]}</FieldNote>
      {/* A container is the one runtime that cannot fall back to the operator's own `~/.claude`:
          mounting your home directory into a sandbox is the thing a sandbox is for preventing. Said
          here rather than discovered as a failed start. */}
      {runtime === "container" && accountId === null && (
        <FieldNote className="text-status-blocked">
          This room has no account, so a contained agent has no credentials — your own{" "}
          <code className="font-mono">~/.claude</code> is never mounted into a container. Bind an
          account above, or agents here will refuse to start.
        </FieldNote>
      )}
      {running.length > 0 && (
        <FieldNote className="text-status-blocked">
          {running.length} agent{running.length === 1 ? "" : "s"} already here{" "}
          {running.length === 1 ? "is" : "are"} still on the {running[0]!.runtime} runtime and{" "}
          {running.length === 1 ? "stays" : "stay"} there until restarted — a live session cannot be
          moved into or out of a container. Changing its model or its role restarts it.
        </FieldNote>
      )}
    </div>
  );
}

/**
 * What the next agent created here arrives as.
 *
 * A picker beside the button rather than a dialog behind it: choosing a role is the *normal* way to
 * add an agent — it is the whole point of the feature for someone who does not know Claude Code's
 * configuration surface — and a normal choice should not be one click further away than the default
 * one. Local to this panel, not persisted: it is a property of the click, not of the room.
 */
function NewAgentRole({
  roleId,
  connected,
  onChange,
}: {
  roleId: string | null;
  connected: boolean;
  onChange: (roleId: string | null) => void;
}) {
  const problems = useRoleProblems();

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1.5">
        <BotIcon className="size-3 shrink-0 text-fg-faint" />
        <span className="text-2xs text-fg-muted">New agents arrive as</span>
        <span className="ml-auto">
          <RoleSelect value={roleId} disabled={!connected} short onChange={onChange} />
        </span>
      </div>
      {/* A preset that did not load is the operator's own file being broken, and it is the one thing
          about roles they cannot discover any other way — the picker would just be one entry short. */}
      {problems.length > 0 && (
        <FieldNote className="text-status-error">
          {problems.length} role file{problems.length === 1 ? "" : "s"} did not load:{" "}
          {problems.map((p) => `${p.file} ${p.message}`).join(" · ")}
        </FieldNote>
      )}
    </div>
  );
}

/** The selected room in full: where it lives on disk, who works there, and how to add someone. */
function SelectedRoom({ roomId, connected }: { roomId: string; connected: boolean }) {
  const room = useRoom(roomId);
  const agents = useRoomAgents(roomId);
  /** The role the next "+ agent" click uses. Null is a plain agent, which is the default. */
  const [roleId, setRoleId] = useState<string | null>(null);
  if (room === undefined) return null;

  return (
    <PanelSection
      title={room.name}
      right={
        <Button
          size="xs"
          variant="accent"
          onClick={() =>
            send({ kind: "create_session", roomId, ...(roleId === null ? {} : { roleId }) })
          }
          disabled={!connected}
          title="Start a Claude Code session in this room's folder"
        >
          <PlusIcon />
          agent
        </Button>
      }
    >
      {room.kind === "project" ? (
        // The central building stands for the project root itself, so its folder is the project's —
        // changing it here would let the two disagree. Another factory is another project.
        <>
          <div className="flex items-start gap-1.5">
            <FolderIcon className="mt-0.5 size-3 shrink-0 text-fg-faint" />
            <span className="min-w-0 break-all font-mono text-2xs text-fg-muted">{room.path}</span>
          </div>
          <OrchestratorLine connected={connected} />
        </>
      ) : (
        <RoomFolder roomId={roomId} path={room.path} connected={connected} />
      )}
      {/* Every room, including the central building: the orchestrator spends quota like anyone. */}
      <RoomAccount roomId={roomId} accountId={room.accountId} connected={connected} />
      <RoomRuntimeLine
        roomId={roomId}
        runtime={room.runtime}
        accountId={room.accountId}
        connected={connected}
      />
      <NewAgentRole roleId={roleId} connected={connected} onChange={setRoleId} />
      {/* The charter is where an agent learns it is a department with a bus. A room created here
          gets that section written for it; a folder that already had a CLAUDE.md keeps its own,
          untouched — so for those it is the operator who has to say it. */}
      <FieldNote>
        Charter: <code className="font-mono">CLAUDE.md</code> in that folder. New rooms are told
        about the factory bus in theirs; a folder that already had one is never overwritten, so add
        it by hand there.
      </FieldNote>

      <div className="mt-2 space-y-1">
        {agents.length === 0 ? (
          <div className="text-2xs text-fg-faint">No agents here yet.</div>
        ) : (
          agents.map((a) => <AgentLine key={a.id} agent={a} connected={connected} />)
        )}
      </div>
    </PanelSection>
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
    <PanelSection title="Unassigned agents">
      <FieldNote className="mt-0 mb-1.5">In no room, so nothing on the floor draws them.</FieldNote>
      <div className="space-y-0.5">
        {sessions.map((s) => (
          <div key={s.id} className="flex items-center gap-1.5">
            <StatusDot status={agentStatus(s)} title={`${agentStatus(s)} · ${s.state}`} />
            <code className="font-mono text-2xs text-fg" title={s.id}>
              {s.id.slice(0, 8)}
            </code>
            <span className="text-2xs text-fg-muted">{s.state}</span>
          </div>
        ))}
      </div>
    </PanelSection>
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
  const clearError = useFabric((s) => s.clearError);
  const selectRoom = useFabric((s) => s.selectRoom);
  /** The name we are waiting for the server to confirm, so the new room can be selected on arrival. */
  const pending = useRef<string | null>(null);

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
    <EdgePanel
      side="left"
      open={open}
      onOpenChange={setOpen}
      label="Rooms"
      icon={<WarehouseIcon />}
      summary={roomIds.length}
      summaryTitle={`Open the room panel — ${roomIds.length} room${roomIds.length === 1 ? "" : "s"}`}
      headerExtra={
        <span className="ml-auto text-2xs tabular-nums text-fg-faint">{roomIds.length}</span>
      }
      className="w-[min(320px,32vw)]"
    >
      <div className="px-3 pb-2">
        <form onSubmit={submit}>
          <div className="flex gap-1.5">
            <Input
              name="roomName"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setProblem(null);
              }}
              placeholder="new room name…"
            />
            <Button type="submit" variant="accent" disabled={!connected} className="shrink-0">
              <PlusIcon />
              Create
            </Button>
          </div>
          <FieldNote>The name is the folder name: {NAME_RULE}.</FieldNote>
          {/* The default is `<project>/<name>`, which is what "room = folder" means most of the
              time. A department that lives in a separate repository is the exception, so the field
              for it is out of the way until it is asked for. */}
          {showPath ? (
            <>
              <Input
                name="roomPath"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/absolute/path/to/an/existing/repo"
                className="mt-1.5 font-mono text-xs"
              />
              <FieldNote>
                Typed by hand — the browser cannot hand the server a real folder path, so there is no
                picker. Leave it empty to use the project's own folder. An existing{" "}
                <code className="font-mono">CLAUDE.md</code> there is never overwritten.{" "}
                <button
                  type="button"
                  onClick={() => {
                    setShowPath(false);
                    setPath("");
                  }}
                  className="text-accent underline underline-offset-2 hover:text-accent/80"
                >
                  use the default
                </button>
              </FieldNote>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setShowPath(true)}
              className="mt-1 text-2xs text-fg-muted underline underline-offset-2 hover:text-fg"
            >
              Choose a folder outside the project…
            </button>
          )}
          {/* Local validation only. Anything the *server* says lives in the one notice bar — see
              `NoticeBar`. */}
          {problem !== null && (
            <FieldNote className="text-status-error">{problem}</FieldNote>
          )}
        </form>
      </div>

      <div className="px-3 pb-2.5">
        {roomIds.length === 0 ? (
          <div className="text-2xs text-fg-faint">
            {connected ? "No rooms yet." : "Waiting for the server…"}
          </div>
        ) : (
          <ul className="space-y-0.5">
            {roomIds.map((id) => (
              <RoomRow key={id} roomId={id} />
            ))}
          </ul>
        )}
      </div>

      {selectedRoomId !== null && <SelectedRoom roomId={selectedRoomId} connected={connected} />}
      <UnassignedSessions />
    </EdgePanel>
  );
}
