import { useState } from "react";
import { useActiveProject, useFabric, useHudInsets, useProjects } from "../store";
import { SELECT_COLOR } from "../scene/palette";
import { createProject, openProject } from "../wsClient";
import { HUD } from "./theme";

/**
 * The project switcher: which factory this tab is looking at, and how to look at another.
 *
 * It sits along the top edge because the top edge is the one thing the HUD leaves free — the room
 * panel owns the left, the console the right, the board the bottom — and it is offset by the room
 * panel's own width so the two never overlap however wide the panel gets.
 *
 * Switching is a server round trip, not a local filter: the socket's active project is what scopes
 * every list, so this only sends `open_project` and waits. The store throws away the previous
 * factory's floor when the answer arrives (see `applyProjects`).
 */
export function ProjectSwitcher() {
  const [open, setOpen] = useState(false);
  const [root, setRoot] = useState("");
  const [name, setName] = useState("");
  const projects = useProjects();
  const active = useActiveProject();
  const activeProjectId = useFabric((s) => s.activeProjectId);
  const connected = useFabric((s) => s.connected);
  const lastError = useFabric((s) => s.lastError);
  const clearError = useFabric((s) => s.clearError);
  const insets = useHudInsets();

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    const wanted = root.trim();
    if (wanted === "") return;
    // A stale rejection ("does not exist") must not sit under a fresh attempt.
    clearError();
    createProject(wanted, name.trim());
    setRoot("");
    setName("");
  }

  function switchTo(projectId: string): void {
    if (projectId === activeProjectId) {
      setOpen(false);
      return;
    }
    clearError();
    openProject(projectId);
    setOpen(false);
  }

  return (
    <div
      style={{
        position: "fixed",
        top: 12,
        // The room panel measures itself into `hudInsets.left`; sitting past it is what keeps this
        // out of the panel's way when it is open and hard against the edge when it is collapsed.
        left: insets.left + 12,
        maxWidth: "min(420px, calc(100vw - 32px))",
        fontFamily: "system-ui, sans-serif",
        fontSize: 14,
        color: HUD.text,
        background: HUD.panel,
        border: `1px solid ${HUD.line}`,
        borderRadius: 6,
        padding: open ? "8px 10px" : "5px 8px",
        boxSizing: "border-box",
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        title={active === undefined ? "Waiting for the server…" : `Factory root: ${active.root}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          font: "600 13px system-ui, sans-serif",
          color: HUD.text,
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ color: HUD.dim, fontWeight: 400 }}>factory</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {active?.name ?? (connected ? "—" : "connecting…")}
        </span>
        <span style={{ color: HUD.dim, fontWeight: 400 }}>{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div style={{ marginTop: 8 }}>
          <ul style={{ listStyle: "none", margin: "0 0 8px", padding: 0 }}>
            {projects.map((p) => {
              const selected = p.id === activeProjectId;
              return (
                <li key={p.id}>
                  <button
                    onClick={() => switchTo(p.id)}
                    disabled={!connected}
                    title={p.root}
                    style={{
                      display: "block",
                      width: "100%",
                      font: "inherit",
                      textAlign: "left",
                      padding: "5px 7px",
                      marginBottom: 3,
                      cursor: "pointer",
                      // Selection is cyan everywhere in this UI: on the floor, in the room list, here.
                      background: selected ? "#e6fbff" : "#fff",
                      border: `1px solid ${selected ? SELECT_COLOR : HUD.line}`,
                      borderRadius: 4,
                    }}
                  >
                    <div style={{ fontWeight: selected ? 700 : 400 }}>{p.name}</div>
                    <div style={{ color: HUD.dim, fontSize: 12, wordBreak: "break-all" }}>{p.root}</div>
                  </button>
                </li>
              );
            })}
            {projects.length === 0 && (
              <li style={{ color: HUD.dim }}>{connected ? "No projects yet." : "Waiting for the server…"}</li>
            )}
          </ul>

          <form onSubmit={submit}>
            <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
              <input
                name="projectRoot"
                value={root}
                onChange={(e) => setRoot(e.target.value)}
                placeholder="/absolute/path/to/a/project"
                style={{ flex: 2, minWidth: 0, padding: "5px 7px", font: "inherit" }}
              />
              <input
                name="projectName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="name (optional)"
                style={{ flex: 1, minWidth: 0, padding: "5px 7px", font: "inherit" }}
              />
              <button type="submit" disabled={!connected} style={{ font: "inherit" }}>
                Add
              </button>
            </div>
            {/* Honest about what this field is. A real folder picker needs either the File System
                Access API (Chromium only, and it hands back a handle rather than a path the server
                could open) or a server-side browse endpoint; neither exists yet. */}
            <div style={{ color: HUD.dim, fontSize: 12 }}>
              Type the folder's absolute path — the browser cannot hand the server a real directory
              path yet, so there is no folder picker. The folder must already exist.
            </div>
            {lastError !== null && (
              <div style={{ color: HUD.err, fontSize: 12, marginTop: 4 }}>server: {lastError}</div>
            )}
          </form>
        </div>
      )}
    </div>
  );
}
