import { FactoryIcon, FolderPlusIcon } from "lucide-react";
import { useState } from "react";
import { useFabric, useHudInsets, useProjects } from "../store";
import { Button } from "../ui/button";
import { FieldNote, Input } from "../ui/input";
import { cn } from "../ui/utils";
import { createProject } from "../wsClient";
import { QuickGuide } from "./QuickGuide";

/**
 * The screen a fresh install opens on: one question, and the guide that makes it answerable.
 *
 * **This exists because the server stopped answering the question for you.** It used to build a
 * factory out of whatever directory it happened to be started in, which meant the first thing an
 * operator saw was a floor over SuperFabric's own source tree — a project nobody chose, that came
 * back on every boot. Choosing the folder you actually work in is the first real decision here, so
 * it is the first thing asked, and nothing is created until it is answered.
 *
 * Over the floor rather than in a panel, for `Onboarding`'s reason and more so: there is no floor
 * yet. The two never collide — onboarding needs a project to be about.
 */
export function FirstRun() {
  const projects = useProjects();
  const connected = useFabric((s) => s.connected);
  const clearError = useFabric((s) => s.clearError);
  const insets = useHudInsets();
  const [root, setRoot] = useState("");
  const [name, setName] = useState("");

  // Only when this server genuinely has nothing. A tab that is merely *between* projects still has a
  // switcher full of them, and covering the floor with a first-run screen would be a lie about state.
  if (!connected || projects.length > 0) return null;

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    const wanted = root.trim();
    if (wanted === "") return;
    clearError();
    createProject(wanted, name.trim());
    setRoot("");
    setName("");
  }

  return (
    <div
      className="pointer-events-none fixed top-20 z-40 flex justify-center px-3"
      style={{ left: insets.left, right: insets.right }}
    >
      <div
        data-testid="first-run"
        className={cn(
          "pointer-events-auto max-h-[76vh] w-[min(560px,100%)] overflow-y-auto rounded-[4px] border",
          "border-accent/50 bg-panel/90 p-3 shadow-[0_8px_28px_rgba(0,0,0,0.5)] backdrop-blur-xl",
        )}
      >
        <div className="flex items-center gap-1.5">
          <FactoryIcon className="size-3.5 shrink-0 text-accent" />
          <h2 className="text-xs font-semibold text-fg">No factory yet</h2>
        </div>
        <FieldNote className="mt-1">
          Point SuperFabric at a project folder you already have. Nothing is created inside it until
          you ask — and nothing is ever created from the folder this server happens to be running in.
        </FieldNote>

        <form onSubmit={submit} className="mt-2">
          <div className="flex gap-1.5">
            <Input
              name="projectRoot"
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              placeholder="/absolute/path/to/your/project"
              className="flex-2 font-mono text-xs"
              autoFocus
            />
            <Input
              name="projectName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name (optional)"
              className="flex-1"
            />
            <Button type="submit" variant="accent" className="shrink-0" disabled={!connected}>
              <FolderPlusIcon />
              Create
            </Button>
          </div>
          {/* The same honesty the switcher's field carries: there is no picker, and this is why. */}
          <FieldNote>
            An absolute path, typed by hand — a browser cannot hand a server a real directory path,
            so there is no folder picker. The folder must already exist.
          </FieldNote>
        </form>

        <div className="mt-3 border-t border-line/60 pt-2.5">
          <h3 className="mb-2 text-2xs font-semibold tracking-wide text-fg-muted uppercase">
            How this works
          </h3>
          <QuickGuide />
        </div>
      </div>
    </div>
  );
}
