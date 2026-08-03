import type { AutonomyMode, SessionEvent } from "@superfabric/shared";
import { useEffect, useRef, useState } from "react";
import { composeTurn, uploadIntoComposer } from "../attachments";
import type { EventRow } from "../store";
import { useFabric, useStagedAttachments } from "../store";
import { send, subscribe } from "../wsClient";
import { AutonomySelect, BypassWarning } from "./AutonomySelect";
import { ModelNote, ModelSelect } from "./ModelSelect";
import { HUD as C } from "./theme";
import { useHudInset } from "./useHudInset";

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
    return (
      <div style={{ color: C.dim, marginBottom: 12 }}>
        Belt demo — needs two rooms on the floor.
      </div>
    );
  }

  // Default to the project building and the first workshop: the belt that always exists.
  const source = from !== "" && rooms.some((r) => r.id === from) ? from : rooms[0].id;
  const target = to !== "" && rooms.some((r) => r.id === to) ? to : rooms[1].id;

  const options = rooms.map((r) => (
    <option key={r.id} value={r.id}>
      {r.name}
    </option>
  ));

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 12 }}>
      <span style={{ color: C.dim }} title="No message behind it — real bus traffic animates on its own.">
        Belt demo:
      </span>
      <select aria-label="Package from" value={source} onChange={(e) => setFrom(e.target.value)} style={{ font: "inherit" }}>
        {options}
      </select>
      <span style={{ color: C.dim }}>→</span>
      <select aria-label="Package to" value={target} onChange={(e) => setTo(e.target.value)} style={{ font: "inherit" }}>
        {options}
      </select>
      <button onClick={() => sendPackage(source, target)} disabled={source === target}>
        Send a demo package
      </button>
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
    <div
      data-testid="staged-attachments"
      style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 8 }}
    >
      {staged.map((a) => (
        <span
          key={a.path}
          title={`${a.path} · ${humanBytes(a.bytes)}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            maxWidth: "100%",
            padding: "2px 4px 2px 8px",
            borderRadius: 12,
            border: `1px solid ${C.accent}`,
            background: "#e6fbff",
            fontSize: 12,
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            📎 {a.name}
          </span>
          <button
            type="button"
            aria-label={`Remove ${a.name}`}
            title="Take it out of the message — the file stays on disk"
            onClick={() => unstage(a.path)}
            style={{ font: "inherit", lineHeight: 1, padding: "0 4px", cursor: "pointer" }}
          >
            ×
          </button>
        </span>
      ))}
      {uploading && <span style={{ color: C.dim, fontSize: 12 }}>saving…</span>}
    </div>
  );
}

/**
 * The M0 console, moved verbatim out of `App.tsx` and demoted to an overlay: the 3D floor is the
 * primary surface now, and this is the drawer you open to talk to one agent. Its behavior is
 * unchanged — same session list, same autonomy control, same transcript, same approval cards — only
 * its container and a collapse toggle are new. The socket itself is opened by `App`, because the
 * floor needs it whether or not this drawer is open.
 */
export function ConsoleDrawer() {
  const [open, setOpen] = useState(true);
  const sessions = useFabric((s) => s.sessions);
  const events = useFabric((s) => s.events);
  const connected = useFabric((s) => s.connected);
  const lastError = useFabric((s) => s.lastError);

  const lastNotice = useFabric((s) => s.lastNotice);
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

  // How much of the canvas this drawer covers, so the camera can frame the floor that is visible.
  const inset = useHudInset<HTMLDivElement>("right");

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
    <div
      ref={inset}
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: open ? "min(560px, 46vw)" : "auto",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        fontFamily: "system-ui, sans-serif",
        fontSize: 14,
        color: C.text,
        background: open ? C.panel : "transparent",
        borderLeft: open ? `1px solid ${C.line}` : "none",
        padding: open ? "12px 14px" : 8,
        overflowY: "auto",
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        title={open ? "Collapse the console" : "Open the console"}
        style={{ alignSelf: "flex-end", font: "inherit", marginBottom: open ? 6 : 0 }}
      >
        {open ? "› console" : "‹ console"}
      </button>
      {/* Kept mounted while collapsed: unmounting would drop the transcript this tab has already
          received and the "which session am I following" state with it. */}
      <div style={{ display: open ? "block" : "none" }}>
      <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>SuperFabric — console</h1>
      <div style={{ color: connected ? C.dim : C.err, marginBottom: 12 }}>
        {connected ? "● connected" : "○ reconnecting…"}
        {lastError !== null && <span style={{ color: C.err }}> · server error: {lastError}</span>}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 12 }}>
        <button
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
        >
          New session
        </button>
        <AutonomySelect value={newAutonomy} disabled={!connected} onChange={setNewAutonomy} />
        <ModelSelect value={newModel} disabled={!connected} onChange={setNewModel} />
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => select(s.id)}
            title={s.id}
            style={{ fontWeight: s.id === active ? 700 : 400 }}
          >
            {s.id.slice(0, 8)} [{s.state}]
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => active !== null && send({ kind: "interrupt", sessionId: active })}
          disabled={!canSend}
        >
          Interrupt
        </button>
        {newAutonomy === "bypass" && (
          <div style={{ flexBasis: "100%" }}>
            <BypassWarning /> <span style={{ color: C.dim }}>(applies to the next new session)</span>
          </div>
        )}
      </div>

      <PackageSender />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 12 }}>
        <span style={{ color: C.dim }}>Autonomy of this agent:</span>
        <AutonomySelect
          value={activeSession?.autonomy ?? "auto"}
          disabled={!canSend || activeSession === undefined}
          onChange={(autonomy) => {
            if (active !== null) send({ kind: "set_autonomy", sessionId: active, autonomy });
          }}
        />
        {activeSession?.autonomy === "bypass" && <BypassWarning />}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 12 }}>
        <span style={{ color: C.dim }}>Model of this agent:</span>
        {/* Changing it restarts this agent's executor on the new model and resumes the same
            conversation, so the stored model and the running one cannot disagree. */}
        <ModelSelect
          value={activeSession?.model ?? null}
          disabled={!canSend || activeSession === undefined}
          onChange={(model) => {
            if (active !== null) send({ kind: "set_model", sessionId: active, model });
          }}
        />
        <ModelNote />
      </div>

      <div
        ref={transcriptRef}
        style={{
          border: `1px solid ${C.line}`,
          borderRadius: 4,
          padding: 12,
          height: 420,
          overflowY: "auto",
          background: "#fff",
        }}
      >
        {rows.length === 0 && (
          <div style={{ color: C.dim }}>
            {active === null ? "No session selected — create one." : "No events yet."}
          </div>
        )}
        {rows.map(({ seq, event }) => (
          <Entry key={seq} event={event} resolutions={resolutions} onAnswer={answer} />
        ))}
      </div>

      <form onSubmit={submitPrompt} style={{ marginTop: 12 }}>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            name="prompt"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={active === null ? "Create a session first…" : "Message the agent…"}
            style={{ flex: 1, minWidth: 0, padding: "6px 8px", font: "inherit" }}
          />
          {/* The third way in, next to paste and drop — and the only one that works when the
              operator's hands are already on the keyboard and the file is in a folder. */}
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={!connected}
            title="Save a file into the project (or the selected room) and attach its path"
          >
            📎 Attach
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            aria-label="Attach files"
            style={{ display: "none" }}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              // Reset first: picking the same file twice in a row fires no change event otherwise.
              e.target.value = "";
              void uploadIntoComposer(files);
            }}
          />
          <button type="submit" disabled={!canSend || (input.trim() === "" && staged.length === 0)}>
            Send
          </button>
        </div>
        <StagedRow />
        {/* Where the file landed. Green, because it is the server saying something worked — the
            protocol's `notice`, not its `error`. */}
        {lastNotice !== null && (
          <div style={{ color: C.ok, fontSize: 12, marginTop: 6, wordBreak: "break-all" }}>
            {lastNotice}
          </div>
        )}
      </form>
      </div>
    </div>
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
        <p style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>
          <b>you:</b> {event.text}
        </p>
      );
    case "agent_text":
      return (
        <p style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>
          <b>agent:</b> {event.text}
        </p>
      );
    case "agent_thinking":
      return <p style={{ margin: "4px 0", color: C.dim, fontStyle: "italic" }}>thinking…</p>;
    case "tool_use":
      return (
        <p style={{ margin: "4px 0", color: C.dim }}>
          ⚙ {event.toolName} <span>{summarize(event.input)}</span>
        </p>
      );
    case "tool_result":
      return (
        <p style={{ margin: "4px 0", color: event.isError === true ? C.err : C.dim }}>
          ↳ {event.toolName}
          {event.output !== undefined && event.output !== "" ? `: ${truncate(event.output, 200)}` : ""}
        </p>
      );
    case "session_status":
      return (
        <p style={{ margin: "4px 0", color: C.dim }}>
          · {event.status}
          {event.detail !== undefined ? ` — ${event.detail}` : ""}
        </p>
      );
    case "turn_complete":
      return (
        <p style={{ margin: "4px 0", color: C.dim }}>
          · turn complete{event.costUsd !== undefined ? ` · $${event.costUsd.toFixed(4)}` : ""}
        </p>
      );
    case "session_error":
      return <p style={{ margin: "6px 0", color: C.err }}>✖ {event.message}</p>;
    case "approval_request": {
      const behavior = resolutions.get(event.approvalId);
      if (behavior !== undefined) {
        return (
          <p style={{ margin: "4px 0", color: C.dim }}>
            ⚑ {event.toolName} — {behavior === "allow" ? "allowed" : "denied"}
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

function ApprovalCard({
  request,
  onAnswer,
}: {
  request: ApprovalRequest;
  onAnswer: (approvalId: string, behavior: "allow" | "deny") => void;
}) {
  return (
    <div
      style={{
        border: `2px solid ${C.card}`,
        borderRadius: 4,
        padding: 8,
        margin: "8px 0",
        background: "#fff8ec",
      }}
    >
      <div style={{ marginBottom: 6 }}>
        <b>Approve {request.toolName}?</b>
      </div>
      <pre
        style={{
          margin: "0 0 8px",
          padding: 6,
          background: "#fff",
          border: `1px solid ${C.line}`,
          borderRadius: 3,
          maxHeight: 160,
          overflow: "auto",
          fontSize: 12,
          whiteSpace: "pre-wrap",
        }}
      >
        {JSON.stringify(request.input, null, 2)}
      </pre>
      <button onClick={() => onAnswer(request.approvalId, "allow")}>Allow</button>{" "}
      <button onClick={() => onAnswer(request.approvalId, "deny")}>Deny</button>
    </div>
  );
}

/** One-line gist of a tool input, so the transcript stays readable instead of a JSON dump. */
function summarize(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "description"]) {
    const v = o[key];
    if (typeof v === "string" && v !== "") return truncate(v, 120);
  }
  return truncate(JSON.stringify(o), 120);
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
