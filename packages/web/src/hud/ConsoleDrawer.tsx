import type { AutonomyMode, SessionEvent } from "@superfabric/shared";
import {
  ArrowRightIcon,
  CircleSlashIcon,
  FlagIcon,
  PaperclipIcon,
  PlusIcon,
  SendIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { composeTurn, uploadIntoComposer } from "../attachments";
import { toolGist, truncate } from "../gist";
import type { EventRow } from "../store";
import { useFabric, useStagedAttachments } from "../store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { cn } from "../ui/utils";
import { send, subscribe } from "../wsClient";
import { AutonomySelect, BypassWarning } from "./AutonomySelect";
import { ModelNote, ModelSelect } from "./ModelSelect";
import { EdgePanel, PanelSection } from "./Panel";

type ApprovalRequest = Extract<SessionEvent, { type: "approval_request" }>;

/**
 * **A demo, and labelled as one.** Real traffic reaches the belts through `applyMessages`: an agent
 * calls `factory_send`, the server broadcasts the bus's messages, and the store turns each new
 * delivery into a package keyed by the message's own id. This button puts a box on a belt with no
 * message behind it, which is worth keeping only for exercising the conveyors on a factory that has
 * no agents running — so it says so, and its packages carry `demo-…` ids.
 */
function PackageSender() {
  const rooms = useFabric((s) => s.rooms);
  const sendPackage = useFabric((s) => s.sendPackage);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  if (rooms.length < 2) {
    return <span className="text-2xs text-fg-faint">Belt demo — needs two rooms on the floor.</span>;
  }

  // Default to the project building and the first workshop: the belt that always exists.
  const source = from !== "" && rooms.some((r) => r.id === from) ? from : rooms[0].id;
  const target = to !== "" && rooms.some((r) => r.id === to) ? to : rooms[1].id;

  const options = rooms.map((r) => (
    <SelectItem key={r.id} value={r.id}>
      {r.name}
    </SelectItem>
  ));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        className="text-2xs text-fg-faint"
        title="No message behind it — real bus traffic animates on its own."
      >
        Belt demo
      </span>
      <Select value={source} onValueChange={setFrom}>
        <SelectTrigger aria-label="Package from" className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{options}</SelectContent>
      </Select>
      <ArrowRightIcon className="size-3 text-fg-faint" />
      <Select value={target} onValueChange={setTo}>
        <SelectTrigger aria-label="Package to" className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{options}</SelectContent>
      </Select>
      <Button size="xs" onClick={() => sendPackage(source, target)} disabled={source === target}>
        Send
      </Button>
    </div>
  );
}

/** Human-sized byte count for a chip's tooltip. */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The composer's attachment row: one removable chip per file already written to disk.
 *
 * They are files, not pending uploads — the bytes landed before the chip appeared — so removing one
 * takes it out of the *message*, not off the disk. The chip's title is the absolute path, because
 * that is literally what the agent will be told.
 */
function StagedRow() {
  const staged = useStagedAttachments();
  const unstage = useFabric((s) => s.unstageAttachment);
  const uploading = useFabric((s) => s.uploading);

  if (staged.length === 0 && !uploading) return null;

  return (
    <div data-testid="staged-attachments" className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {staged.map((a) => (
        <Badge
          key={a.path}
          variant="accent"
          title={`${a.path} · ${humanBytes(a.bytes)}`}
          className="max-w-full pr-0.5"
        >
          <PaperclipIcon />
          <span className="truncate">{a.name}</span>
          <button
            type="button"
            aria-label={`Remove ${a.name}`}
            title="Take it out of the message — the file stays on disk"
            onClick={() => unstage(a.path)}
            className="shrink-0 rounded-full p-0.5 hover:bg-accent/25"
          >
            <XIcon className="size-2.5" />
          </button>
        </Badge>
      ))}
      {uploading && <span className="text-2xs text-fg-faint">saving…</span>}
    </div>
  );
}

/**
 * The console: the drawer you open to talk to one agent, on the right edge.
 *
 * Rebuilt on the shared panel chrome, and re-laid-out around the one thing it is for. The old
 * version put four rows of controls (new session, belt demo, autonomy, model) above a fixed 420px
 * transcript and the composer below it, so the transcript — the only part that is *content* — got
 * whatever was left. Now the transcript is the flexible element and everything else is a fixed
 * band: a session tab strip on top, the composer pinned to the bottom, and the per-agent controls
 * folded into one line under the tabs. The settings that only affect the *next* session (autonomy,
 * model, the belt demo) moved into a "next session" section below the composer, because they are
 * not part of talking to the agent you are looking at.
 *
 * Its behaviour is unchanged: same session list, same autonomy and model controls, same transcript,
 * same approval cards, same attachment chips.
 */
export function ConsoleDrawer() {
  const [open, setOpen] = useState(true);
  const sessions = useFabric((s) => s.sessions);
  const events = useFabric((s) => s.events);
  const connected = useFabric((s) => s.connected);

  const staged = useStagedAttachments();
  const clearStaged = useFabric((s) => s.clearStagedAttachments);

  const [active, setActive] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const [newAutonomy, setNewAutonomy] = useState<AutonomyMode>("auto");
  /** The model the *next* session is created on; null leaves it on the CLI's own default. */
  const [newModel, setNewModel] = useState<string | null>(null);
  const knownIds = useRef(new Set<string>());
  const wantNewest = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  function select(sessionId: string): void {
    setActive(sessionId);
    subscribe(sessionId);
  }

  // Follow a session as soon as we learn about one: the freshly created one if the user just
  // pressed "New session", otherwise the newest known session when nothing is selected yet.
  useEffect(() => {
    const fresh = sessions.filter((s) => !knownIds.current.has(s.id));
    for (const s of sessions) knownIds.current.add(s.id);
    const newest = fresh.at(-1);
    if (wantNewest.current && newest) {
      wantNewest.current = false;
      select(newest.id);
      return;
    }
    if (sessions.length === 0) return;
    // Also re-point at the newest session if the selected one is gone from the server's list.
    if (active === null || !sessions.some((s) => s.id === active)) select(sessions[sessions.length - 1].id);
  }, [sessions, active]);

  const rows: EventRow[] = active !== null ? (events[active] ?? []) : [];

  // An approval is pending until an approval_resolved with the same id shows up.
  const resolutions = new Map<string, "allow" | "deny">();
  for (const { event } of rows) {
    if (event.type === "approval_resolved") resolutions.set(event.approvalId, event.behavior);
  }
  const pendingCount = rows.filter(
    (r) => r.event.type === "approval_request" && !resolutions.has(r.event.approvalId),
  ).length;

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length, pendingCount]);

  function answer(approvalId: string, behavior: "allow" | "deny"): void {
    if (active === null) return;
    send({ kind: "approval", sessionId: active, approvalId, behavior });
  }

  function submitPrompt(e: React.FormEvent): void {
    e.preventDefault();
    if (active === null) return;
    // The staged paths become lines of the turn: the agent is handed a file on disk, not bytes.
    // `null` means there was neither text nor an attachment — a send with only attachments is a
    // real thing to want and is allowed.
    const text = composeTurn(input, staged);
    if (text === null) return;
    send({ kind: "prompt", sessionId: active, text });
    setInput("");
    clearStaged();
  }

  const canSend = connected && active !== null;
  const activeSession = sessions.find((s) => s.id === active);

  return (
    <EdgePanel
      side="right"
      open={open}
      onOpenChange={setOpen}
      label="Console"
      icon={<SquareTerminalIcon />}
      summary={sessions.length}
      summaryTitle={`Open the console — ${sessions.length} session${sessions.length === 1 ? "" : "s"}`}
      headerExtra={
        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1 text-2xs",
            connected ? "text-status-working" : "text-status-error",
          )}
          title={connected ? "Connected to the server" : "The socket dropped — retrying"}
        >
          <span
            className={cn(
              "inline-block size-1.5 rounded-full",
              connected ? "bg-status-working" : "bg-status-error",
            )}
          />
          {connected ? "connected" : "reconnecting…"}
        </span>
      }
      className="w-[min(520px,44vw)]"
      contentClassName="overflow-hidden"
    >
      {/* The panel body is a column: tabs and controls fixed, transcript elastic, composer pinned.
          `overflow-y: auto` is on the Collapsible content, so this asks for `h-full` to fill it. */}
      <div className="flex h-full min-h-0 flex-col">
        {/* Session tabs. A strip that scrolls sideways rather than wrapping: the number of sessions
            is unbounded and a wrapping strip would push the transcript off the bottom. */}
        <div className="hud-scroll flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-3 pb-2">
          <Button
            size="xs"
            variant="accent"
            className="shrink-0"
            onClick={() => {
              wantNewest.current = true;
              send({
                kind: "create_session",
                autonomy: newAutonomy,
                // Omitted, not null: "no model" is the absence of a choice on the wire too.
                ...(newModel === null ? {} : { model: newModel }),
              });
            }}
            disabled={!connected}
            title="Start a session with no room — the settings below decide its autonomy and model"
          >
            <PlusIcon />
            session
          </Button>
          {sessions.map((s) => (
            <Button
              key={s.id}
              size="xs"
              variant="chip"
              className="shrink-0 font-mono"
              data-active={s.id === active}
              onClick={() => select(s.id)}
              title={`${s.id} · ${s.state}`}
            >
              {s.id.slice(0, 8)}
              <span className="opacity-60">{s.state}</span>
            </Button>
          ))}
        </div>

        {/* This agent, one line: what it is allowed to do, what it runs on, and how to stop it. */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
          <span className="text-2xs uppercase tracking-[0.08em] text-fg-faint">this agent</span>
          <AutonomySelect
            value={activeSession?.autonomy ?? "auto"}
            disabled={!canSend || activeSession === undefined}
            short
            onChange={(autonomy) => {
              if (active !== null) send({ kind: "set_autonomy", sessionId: active, autonomy });
            }}
          />
          {/* Changing it restarts this agent's executor on the new model and resumes the same
              conversation, so the stored model and the running one cannot disagree. */}
          <ModelSelect
            value={activeSession?.model ?? null}
            disabled={!canSend || activeSession === undefined}
            short
            onChange={(model) => {
              if (active !== null) send({ kind: "set_model", sessionId: active, model });
            }}
          />
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={() => active !== null && send({ kind: "interrupt", sessionId: active })}
            disabled={!canSend}
            title="Interrupt the turn this agent is in the middle of"
          >
            <CircleSlashIcon />
            interrupt
          </Button>
          {activeSession?.autonomy === "bypass" && (
            <div className="basis-full">
              <BypassWarning />
            </div>
          )}
        </div>

        {/* The transcript is the only elastic thing in the drawer — everything else is a band. */}
        <div
          ref={transcriptRef}
          className="hud-scroll min-h-24 flex-1 overflow-y-auto bg-panel-sunken/40 px-3 py-2"
        >
          {rows.length === 0 && (
            <div className="text-2xs text-fg-faint">
              {active === null ? "No session selected — create one." : "No events yet."}
            </div>
          )}
          {rows.map(({ seq, event }) => (
            <Entry key={seq} event={event} resolutions={resolutions} onAnswer={answer} />
          ))}
        </div>

        <form onSubmit={submitPrompt} className="shrink-0 border-t border-line px-3 py-2">
          <div className="flex gap-1.5">
            <Input
              name="prompt"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={active === null ? "Create a session first…" : "Message the agent…"}
            />
            {/* The third way in, next to paste and drop — and the only one that works when the
                operator's hands are already on the keyboard and the file is in a folder. */}
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="shrink-0"
              onClick={() => fileInput.current?.click()}
              disabled={!connected}
              aria-label="Attach files"
              title="Save a file into the project (or the selected room) and attach its path"
            >
              <PaperclipIcon />
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              aria-label="Attach files"
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                // Reset first: picking the same file twice in a row fires no change event otherwise.
                e.target.value = "";
                void uploadIntoComposer(files);
              }}
            />
            <Button
              type="submit"
              variant="accent"
              className="shrink-0"
              disabled={!canSend || (input.trim() === "" && staged.length === 0)}
            >
              <SendIcon />
              Send
            </Button>
          </div>
          <StagedRow />
        </form>

        {/* Settings that describe the *next* session rather than the one on screen, and the belt
            demo, which belongs to the floor rather than to any agent. Below the composer on
            purpose: everything above it is about the conversation you are having. */}
        <PanelSection title="Next session" className="shrink-0 border-line">
          <div className="flex flex-wrap items-center gap-1.5">
            <AutonomySelect value={newAutonomy} disabled={!connected} short onChange={setNewAutonomy} />
            <ModelSelect value={newModel} disabled={!connected} short onChange={setNewModel} />
          </div>
          {newAutonomy === "bypass" && <BypassWarning className="mt-1" />}
          <ModelNote />
          <div className="mt-1.5">
            <PackageSender />
          </div>
        </PanelSection>
      </div>
    </EdgePanel>
  );
}

function Entry({
  event,
  resolutions,
  onAnswer,
}: {
  event: SessionEvent;
  resolutions: Map<string, "allow" | "deny">;
  onAnswer: (approvalId: string, behavior: "allow" | "deny") => void;
}) {
  switch (event.type) {
    case "user_prompt":
      return (
        <p className="my-1 whitespace-pre-wrap text-sm">
          <span className="font-semibold text-accent">you</span>{" "}
          <span className="text-fg">{event.text}</span>
        </p>
      );
    case "agent_text":
      return (
        <p className="my-1 whitespace-pre-wrap text-sm">
          <span className="font-semibold text-status-working">agent</span>{" "}
          <span className="text-fg">{event.text}</span>
        </p>
      );
    case "agent_thinking":
      return <p className="my-0.5 text-2xs italic text-fg-faint">thinking…</p>;
    case "tool_use":
      return (
        <p className="my-0.5 font-mono text-2xs text-fg-muted">
          <span className="text-fg-faint">⚙ </span>
          {event.toolName} <span className="text-fg-faint">{toolGist(event.input)}</span>
        </p>
      );
    case "tool_result":
      return (
        <p
          className={cn(
            "my-0.5 font-mono text-2xs",
            event.isError === true ? "text-status-error" : "text-fg-faint",
          )}
        >
          ↳ {event.toolName}
          {event.output !== undefined && event.output !== "" ? `: ${truncate(event.output, 200)}` : ""}
        </p>
      );
    case "session_status":
      return (
        <p className="my-0.5 text-2xs text-fg-faint">
          · {event.status}
          {event.detail !== undefined ? ` — ${event.detail}` : ""}
        </p>
      );
    case "turn_complete":
      return (
        <p className="my-0.5 text-2xs text-fg-faint">
          · turn complete{event.costUsd !== undefined ? ` · $${event.costUsd.toFixed(4)}` : ""}
        </p>
      );
    case "session_error":
      return <p className="my-1 text-xs text-status-error">✖ {event.message}</p>;
    case "approval_request": {
      const behavior = resolutions.get(event.approvalId);
      if (behavior !== undefined) {
        return (
          <p className="my-0.5 text-2xs text-fg-faint">
            <FlagIcon className="mr-1 inline size-2.5" />
            {event.toolName} — {behavior === "allow" ? "allowed" : "denied"}
          </p>
        );
      }
      return <ApprovalCard request={event} onAnswer={onAnswer} />;
    }
    // approval_resolved is rendered as part of its request line above.
    case "approval_resolved":
      return null;
  }
}

/**
 * The one thing in the transcript that is not a record but a question. Amber — the floor's
 * `blocked`, because that is exactly what this agent is: waiting on the operator. The same colour
 * is on its beacon at the same moment.
 */
function ApprovalCard({
  request,
  onAnswer,
}: {
  request: ApprovalRequest;
  onAnswer: (approvalId: string, behavior: "allow" | "deny") => void;
}) {
  return (
    <div className="my-1.5 rounded-[4px] border border-status-blocked/70 bg-status-blocked/8 p-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-status-blocked">
        <FlagIcon className="size-3" />
        Approve {request.toolName}?
      </div>
      <pre className="hud-scroll mb-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-[3px] border border-line bg-panel-sunken/70 p-1.5 font-mono text-2xs text-fg-muted">
        {JSON.stringify(request.input, null, 2)}
      </pre>
      <div className="flex gap-1.5">
        <Button size="xs" variant="accent" onClick={() => onAnswer(request.approvalId, "allow")}>
          Allow
        </Button>
        <Button size="xs" variant="danger" onClick={() => onAnswer(request.approvalId, "deny")}>
          Deny
        </Button>
      </div>
    </div>
  );
}

