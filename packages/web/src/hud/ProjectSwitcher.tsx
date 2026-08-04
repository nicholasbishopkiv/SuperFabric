import { ChevronsUpDownIcon, FactoryIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { useActiveProject, useFabric, useProjects } from "../store";
import { Button } from "../ui/button";
import { FieldNote, Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../ui/utils";
import { createProject, openProject } from "../wsClient";

/**
 * The project switcher: which factory this tab is looking at, and how to look at another.
 *
 * It sits along the top edge because the top edge is the one thing the HUD leaves free — the room
 * panel owns the left, the console the right, the board the bottom. `TopLeftBar` owns the placing
 * (and the offset past the room panel), so this component is just the control.
 *
 * Now a Radix popover rather than a box that grew when clicked: the list of factories and the
 * "add one" form only exist while they are being used, and growing a panel over the floor to hold
 * them cost a permanent hole in the view. Radix also brings what a hand-rolled dropdown over a
 * canvas gets wrong — click-outside, Escape, focus return, and a portal that clears the WebGL
 * surface.
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
  const clearError = useFabric((s) => s.clearError);

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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="md"
          className="max-w-[min(320px,50vw)] bg-panel/80 backdrop-blur-xl"
          title={active === undefined ? "Waiting for the server…" : `Factory root: ${active.root}`}
        >
          <FactoryIcon className="text-fg-faint" />
          <span className="truncate font-semibold">
            {active?.name ?? (connected ? "—" : "connecting…")}
          </span>
          <ChevronsUpDownIcon className="text-fg-faint" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[min(420px,90vw)]">
        <ul className="mb-2 space-y-0.5">
          {projects.map((p) => {
            const selected = p.id === activeProjectId;
            return (
              <li key={p.id}>
                <button
                  onClick={() => switchTo(p.id)}
                  disabled={!connected}
                  title={p.root}
                  className={cn(
                    "block w-full rounded-[3px] border px-2 py-1 text-left outline-none transition-colors",
                    "focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40",
                    // Selection is cyan everywhere in this UI: on the floor, in the room list, here.
                    selected
                      ? "border-accent/70 bg-accent/12"
                      : "border-transparent hover:border-line hover:bg-fg/5",
                  )}
                >
                  <div className={cn("truncate text-sm", selected ? "font-semibold text-accent" : "text-fg")}>
                    {p.name}
                  </div>
                  <div className="break-all font-mono text-2xs text-fg-muted">{p.root}</div>
                </button>
              </li>
            );
          })}
          {projects.length === 0 && (
            <li className="text-2xs text-fg-faint">
              {connected ? "No projects yet." : "Waiting for the server…"}
            </li>
          )}
        </ul>

        <form onSubmit={submit} className="border-t border-line pt-2">
          <div className="flex gap-1.5">
            <Input
              name="projectRoot"
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              placeholder="/absolute/path/to/a/project"
              className="flex-2 font-mono text-xs"
            />
            <Input
              name="projectName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name (optional)"
              className="flex-1"
            />
            <Button type="submit" variant="accent" disabled={!connected} className="shrink-0">
              <PlusIcon />
              Add
            </Button>
          </div>
          {/* Honest about what this field is. A real folder picker needs either the File System
              Access API (Chromium only, and it hands back a handle rather than a path the server
              could open) or a server-side browse endpoint; neither exists yet. */}
          <FieldNote>
            Type the folder's absolute path — the browser cannot hand the server a real directory
            path yet, so there is no folder picker. The folder must already exist.
          </FieldNote>
        </form>
      </PopoverContent>
    </Popover>
  );
}
