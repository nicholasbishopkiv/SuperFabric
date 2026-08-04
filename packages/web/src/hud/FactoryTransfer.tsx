import type { FactoryExport } from "@superfabric/shared";
import { AlertTriangleIcon, DownloadIcon, UploadIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useActiveProject, useFabric } from "../store";
import { Button } from "../ui/button";
import { FieldNote, Input } from "../ui/input";
import { send } from "../wsClient";

/**
 * Moving a factory: saving this one to a file, and building one back from a file.
 *
 * It lives in the project switcher because that is where "which factory" is answered — an export is a
 * factory, and an import produces one.
 *
 * **Two things this surface has to say out loud**, because they are the two the operator would
 * otherwise be surprised by:
 *
 * 1. **The file holds no credentials.** Accounts travel as the labels they were given, and an import
 *    re-binds them by hand. Said here, and said again inside the file itself.
 * 2. **An import reports what it could not do.** A room that already existed, an account label this
 *    machine does not have, an ADR that is not in the repository — each is a line in the result, shown
 *    until dismissed. A partial import that claimed to be complete would send the operator looking for
 *    a room that is not there.
 */

/** A filename that sorts and reads well in a downloads folder. */
export function exportFilename(factory: FactoryExport): string {
  const slug = factory.project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const day = new Date(factory.exportedAt * 1000).toISOString().slice(0, 10);
  return `${slug === "" ? "factory" : slug}-factory-${day}.json`;
}

/** One line summarising what landed, so the problems below it have something to be problems *with*. */
function summary(result: {
  roomsCreated: string[];
  tasksCreated: number;
  decisionsIndexed: number;
}): string {
  const parts = [
    `${result.roomsCreated.length} room${result.roomsCreated.length === 1 ? "" : "s"}`,
    `${result.tasksCreated} task${result.tasksCreated === 1 ? "" : "s"}`,
    `${result.decisionsIndexed} decision${result.decisionsIndexed === 1 ? "" : "s"} indexed`,
  ];
  return parts.join(" · ");
}

export function FactoryTransfer() {
  const active = useActiveProject();
  const connected = useFabric((s) => s.connected);
  const clearError = useFabric((s) => s.clearError);
  const setError = useFabric((s) => s.setError);
  const factoryExport = useFabric((s) => s.factoryExport);
  const clearFactoryExport = useFabric((s) => s.clearFactoryExport);
  const result = useFabric((s) => s.factoryImport);
  const clearResult = useFabric((s) => s.clearFactoryImport);
  const [root, setRoot] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  // The download, in a component rather than in the socket handler: writing a file is a DOM side
  // effect, and the store is a reducer. Cleared immediately, so one export is one file.
  useEffect(() => {
    if (factoryExport === null) return;
    const blob = new Blob([JSON.stringify(factoryExport, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFilename(factoryExport);
    link.click();
    URL.revokeObjectURL(url);
    clearFactoryExport();
  }, [factoryExport, clearFactoryExport]);

  function pickFile(): void {
    clearError();
    clearResult();
    fileInput.current?.click();
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    // Reset the input, so choosing the same file twice actually fires twice.
    e.target.value = "";
    if (file === undefined) return;
    const wanted = root.trim();
    if (wanted === "") {
      setError("type the folder to import into first — an import needs a root");
      return;
    }
    void file.text().then(
      (text) => {
        let parsed: unknown;
        try { parsed = JSON.parse(text); }
        catch { setError(`${file.name} is not JSON, so it is not a factory export`); return; }
        // Sent unvalidated on purpose: the server parses it with the real schema and answers with a
        // message naming what is wrong, which is a better error than anything guessable here.
        send({ kind: "import_factory", root: wanted, factory: parsed });
      },
      () => setError(`${file.name} could not be read`),
    );
  }

  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="xs"
          variant="ghost"
          disabled={!connected || active === undefined}
          onClick={() => { clearError(); send({ kind: "export_project" }); }}
          title="Save this factory's rooms, staffing, board and decision index to a file"
        >
          <DownloadIcon />
          Export this factory
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!connected}
          onClick={pickFile}
          title="Rebuild a factory from an exported file, in the folder named below"
        >
          <UploadIcon />
          Import into…
        </Button>
        <Input
          name="importRoot"
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          placeholder="/absolute/path/to/import/into"
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={onFile}
        />
      </div>
      <FieldNote>
        The file describes rooms, staffing, the board and the decision index. It holds{" "}
        <strong className="font-semibold text-fg-muted">no credentials</strong>: accounts travel as
        their labels and you re-bind them here. Agents are described, not started.
      </FieldNote>

      {result !== null && (
        <div className="mt-1.5 rounded-[3px] border border-line/60 bg-panel-sunken/40 p-1.5">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-2xs font-semibold text-fg">
              Imported into {result.projectName}
            </span>
            <span className="ml-auto shrink-0 font-mono text-2xs text-fg-muted">{summary(result)}</span>
            <Button
              size="icon-xs"
              variant="ghost"
              className="shrink-0"
              onClick={clearResult}
              aria-label="Dismiss the import report"
            >
              <XIcon />
            </Button>
          </div>
          {result.roomsCreated.length > 0 && (
            <div className="mt-0.5 font-mono text-2xs text-fg-muted">
              {result.roomsCreated.join(", ")}
            </div>
          )}
          {/* The half that matters. Amber rather than red: none of these is a failure of the import —
              they are the things it refused to do silently. */}
          {result.problems.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {result.problems.map((problem) => (
                <li key={problem} className="flex items-start gap-1 text-2xs text-status-blocked">
                  <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
                  <span className="min-w-0">{problem}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
