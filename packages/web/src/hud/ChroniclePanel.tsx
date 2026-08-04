import type { ChronicleHit } from "@superfabric/shared";
import { BookOpenTextIcon, CopyIcon, FileTextIcon, MessageSquareQuoteIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useChronicle, useFabric, useHudInsets } from "../store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { FieldNote, Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../ui/utils";
import { searchChronicle } from "../wsClient";

/**
 * The Chronicle: why this factory is the way it is, searchable by the operator.
 *
 * ## Why this is a popover and not a fourth panel
 *
 * The HUD has three edges and a floor in the middle, and the middle is the product. A fourth
 * permanent surface would cost a strip of the factory for something nobody reads continuously —
 * searching the chronicle is a thing you do *when you have a question*, in the same way the project
 * switcher is a thing you use when you change factories. So: a button in the free top strip, and a
 * popover that exists only while it is open. Nothing here reports a `hudInset`, for the same reason
 * the switcher and the fit button do not — none of them is an edge panel, and the camera already
 * frames into the strip between the three that are.
 *
 * ## What a result has to carry
 *
 * A hit is only useful if it can be acted on without opening anything: **what** (the title), **when**
 * (the date), **who** (a decision in a room, or a line someone actually said in a session) and the
 * matching text. A decision also carries its ADR file, which is the artefact — the row in the
 * database is an index over a markdown file that lives in the operator's own repository.
 *
 * The path is offered as *copy*, not as a link. A browser cannot open a `file://` target from an
 * `http://` page (Chrome refuses silently, which would be the worst of both), and the useful thing
 * to do with an absolute path is paste it into an editor, a terminal, or the composer of an agent
 * that should go and read it.
 */

/** How long the "copied" acknowledgement stays on a path button. */
const COPIED_MS = 1_200;

/** A hit's date, to the day. Chronicle timestamps are unix **seconds**. */
function hitDate(createdAt: number): string {
  return new Date(createdAt * 1000).toISOString().slice(0, 10);
}

function HitRow({ hit }: { hit: ChronicleHit }) {
  const room = useFabric((s) => s.rooms.find((r) => r.id === hit.roomId));
  const setError = useFabric((s) => s.setError);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const decision = hit.kind === "decision";
  const where = room?.name ?? (hit.roomId === null ? "no room" : hit.roomId);

  function copyPath(path: string): void {
    // A clipboard write can be refused (an insecure origin, a denied permission); saying so on the
    // one channel the server's failures use beats a button that silently did nothing.
    void navigator.clipboard?.writeText(path).then(
      () => setCopied(true),
      (err: unknown) => setError(`could not copy the path: ${String(err)}`),
    );
  }

  return (
    <li className="rounded-[3px] border border-line bg-panel-raised/50 px-2 py-1.5">
      <div className="flex items-start gap-1.5">
        <span className="mt-0.5 shrink-0 text-fg-faint [&_svg]:size-3">
          {decision ? <FileTextIcon /> : <MessageSquareQuoteIcon />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <span className={cn("text-xs", decision ? "font-semibold text-fg" : "text-fg-muted")}>
              {hit.title}
            </span>
            {/* A decision is reasoning someone committed to the repository; an event is evidence of
                what was said at the time. They carry different authority, so they say which. */}
            <Badge variant={decision ? "accent" : "neutral"}>
              {decision ? "decision" : "said"}
            </Badge>
            <span className="text-2xs tabular-nums text-fg-faint">{hitDate(hit.createdAt)}</span>
            <span className="text-2xs text-fg-faint">· {where}</span>
          </div>
          <p className="mt-0.5 break-words text-2xs leading-snug text-fg-muted">{hit.snippet}</p>
          {hit.path !== null && (
            <button
              type="button"
              onClick={() => copyPath(hit.path!)}
              title={`Copy ${hit.path} — the ADR file is in the repository, open it in your editor`}
              className={cn(
                "mt-1 flex max-w-full items-center gap-1 rounded-[2px] text-left font-mono text-2xs",
                "underline underline-offset-2 outline-none focus-visible:ring-1 focus-visible:ring-accent",
                copied ? "text-status-working" : "text-accent hover:text-accent/80",
              )}
            >
              <CopyIcon className="size-2.5 shrink-0" />
              <span className="truncate">{copied ? "path copied" : hit.path}</span>
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export function ChroniclePanel() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const chronicle = useChronicle();
  const connected = useFabric((s) => s.connected);
  // Decisions are a project's own; switching factories under an open popover has to re-ask rather
  // than leave the previous floor's ADRs on screen (the store has already dropped them).
  const activeProjectId = useFabric((s) => s.activeProjectId);
  const insets = useHudInsets();

  // Opening asks for the newest decisions, so the surface shows what this factory has decided
  // instead of an empty box waiting for a word to be guessed.
  useEffect(() => {
    if (!open || !connected) return;
    searchChronicle(query);
    // Deliberately not keyed on `query`: typing must not fire a search per keystroke, which would
    // be one socket round trip per character over a full-text index. The form's submit does that.
  }, [open, connected, activeProjectId]);

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    searchChronicle(query);
  }

  const waiting = chronicle.answered === null;
  const searched = chronicle.answered ?? "";

  return (
    <div
      // The top strip's right end, mirroring the project switcher at its left, and offset by the
      // console drawer's own width so the two never overlap however wide it is.
      className="fixed top-3 z-40"
      style={{ right: insets.right + 12 }}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="md"
            className="bg-panel/80 backdrop-blur-xl"
            title="Search the chronicle — recorded decisions and what agents actually said"
          >
            <BookOpenTextIcon className="text-fg-faint" />
            chronicle
          </Button>
        </PopoverTrigger>

        <PopoverContent align="end" className="w-[min(520px,92vw)]">
          <form onSubmit={submit} className="flex gap-1.5">
            <Input
              name="chronicleQuery"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="why is it like this? — search decisions and transcripts…"
            />
            <Button type="submit" variant="accent" disabled={!connected} className="shrink-0">
              <SearchIcon />
              Search
            </Button>
          </form>

          <div className="hud-scroll mt-2 max-h-[52vh] overflow-y-auto">
            {chronicle.hits.length === 0 ? (
              <div className="px-0.5 py-1 text-2xs text-fg-faint">
                {!connected
                  ? "Waiting for the server…"
                  : waiting
                    ? "Searching…"
                    : searched === ""
                      ? "Nothing has been recorded in this factory yet. Agents write decisions with "
                        + "factory_record_decision, and each one becomes an ADR file in the project's "
                        + "docs/decisions/."
                      : `Nothing matches “${searched}”. Every word has to appear; try fewer.`}
              </div>
            ) : (
              <ul className="space-y-1">
                {chronicle.hits.map((hit) => (
                  <HitRow key={`${hit.kind}:${hit.ref}:${hit.seq}`} hit={hit} />
                ))}
              </ul>
            )}
          </div>

          <FieldNote>
            {searched === "" && chronicle.hits.length > 0
              ? "The newest decisions. Search to include what agents said in their sessions."
              : "Decisions and transcripts, newest first — the same index agents search with "
                + "factory_search_history."}
          </FieldNote>
        </PopoverContent>
      </Popover>
    </div>
  );
}
