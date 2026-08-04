import type { OnboardingState, RoomSuggestion } from "@superfabric/shared";
import { RoomName } from "@superfabric/shared";
import { CheckIcon, MessagesSquareIcon, SparklesIcon, WarehouseIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { useFabric, useHudInsets, useOnboarding } from "../store";
import { Button } from "../ui/button";
import { FieldNote, Input } from "../ui/input";
import { cn } from "../ui/utils";
import { send } from "../wsClient";

/**
 * First contact, and nothing else.
 *
 * **This surface is prominent when a project has never been written down and invisible afterwards.**
 * An operator who points the factory at an empty folder should not have to discover that onboarding
 * exists; an operator whose project has a `CLAUDE.md` should never see a word of it. That is the whole
 * rule, and `onboardingSurface` below is where it is decided — one pure function, so what shows when
 * is a thing that can be read and tested rather than a pile of conditions inside JSX.
 *
 * It sits over the floor rather than inside a panel: the interview *is* the task on a factory with no
 * rooms yet, and the room panel it would otherwise live in is the one place there is nothing to look
 * at. It shares the free strip with the notice bar and sits under it.
 */

/** What, if anything, this surface is showing. */
export type OnboardingSurface = "none" | "offer" | "interview" | "proposal";

/**
 * Which of the four it is.
 *
 * The precedence is the interesting part: **an outstanding proposal outranks everything**, including
 * a project that is by now onboarded. The interview writes `CLAUDE.md` and *then* proposes rooms, so
 * for the last minute of its life the project is documented and the operator still has a decision in
 * front of them. Ordering it the other way round would make the room list vanish at the moment it
 * appeared.
 *
 * Everything else keys off `onboarded`, **including the "under way" strip**, and that is a fix rather
 * than an oversight: a finished onboarding session stays `active` (nothing stops it, and nothing
 * should — the operator may still be talking to it), so a strip that keyed off "a session exists"
 * would sit on the floor for the rest of the factory's life. Once the file the interview exists to
 * produce is on disk, this surface has nothing left to say.
 */
export function onboardingSurface(state: OnboardingState | null): OnboardingSurface {
  if (state === null) return "none";
  if (state.suggestions.some((s) => s.status === "proposed")) return "proposal";
  if (state.onboarded) return "none";
  return state.sessionId === null ? "offer" : "interview";
}

/** The proposals still waiting on a decision, in the order the interview made them. */
export function outstanding(state: OnboardingState | null): RoomSuggestion[] {
  return (state?.suggestions ?? []).filter((s) => s.status === "proposed");
}

/** One proposed room: a checkbox, an editable name, its one-line charter, and a way to say no. */
function SuggestionRow({
  suggestion,
  chosen,
  name,
  connected,
  onToggle,
  onRename,
}: {
  suggestion: RoomSuggestion;
  chosen: boolean;
  name: string;
  connected: boolean;
  onToggle: (chosen: boolean) => void;
  onRename: (name: string) => void;
}) {
  // The same rule the server enforces, checked here first so a bad edit is caught before the round
  // trip rather than coming back as an error against a list the operator has moved on from.
  const bad = name.trim() !== "" && !RoomName.safeParse(name.trim()).success;

  return (
    <li className="flex items-start gap-2 rounded-[3px] border border-line/60 bg-panel-sunken/40 px-2 py-1.5">
      <input
        type="checkbox"
        checked={chosen}
        onChange={(e) => onToggle(e.target.checked)}
        aria-label={`Create the ${suggestion.name} room`}
        className="mt-1 size-3 shrink-0 accent-[var(--color-accent)]"
      />
      <div className="min-w-0 flex-1">
        <Input
          value={name}
          onChange={(e) => onRename(e.target.value)}
          aria-label={`Name for the ${suggestion.name} room`}
          className="h-5.5 font-mono text-xs"
        />
        <p className="mt-1 text-2xs leading-snug text-fg-muted">{suggestion.charter}</p>
        {bad && (
          <FieldNote className="text-status-error">
            Not a usable folder name: lowercase letters, digits, dot, dash and underscore.
          </FieldNote>
        )}
        {/* Why it is not on the floor yet, in the server's own words — a duplicate name, a folder
            that escapes the root. The operator can fix it in the field above and try again. */}
        {suggestion.note !== null && (
          <FieldNote className="text-status-error">{suggestion.note}</FieldNote>
        )}
      </div>
      <Button
        size="icon-xs"
        variant="ghost"
        className="mt-0.5 shrink-0"
        disabled={!connected}
        aria-label={`Dismiss the ${suggestion.name} room`}
        title="Drop this one — nothing is created and nothing is deleted"
        onClick={() => send({ kind: "dismiss_room_suggestion", suggestionId: suggestion.id })}
      >
        <XIcon />
      </Button>
    </li>
  );
}

/**
 * The accept/edit list.
 *
 * **Nothing here has happened yet**, and the card says so twice: the heading calls them proposals and
 * the button says how many folders it is about to create. A factory that reorganised itself on an
 * interview's say-so is not what anyone wants on first contact, so the agent's tool recorded a list
 * and this is the only thing that turns any of it into a room.
 */
function Proposal({ suggestions, connected }: { suggestions: RoomSuggestion[]; connected: boolean }) {
  /** Which ones the operator wants. Everything is checked to begin with: the agent was asked for this. */
  const [dropped, setDropped] = useState<Record<string, true>>({});
  /** Renames, by suggestion id. Absent means "as proposed". */
  const [names, setNames] = useState<Record<string, string>>({});

  const chosen = suggestions.filter((s) => dropped[s.id] !== true);
  const nameOf = (s: RoomSuggestion): string => names[s.id] ?? s.name;
  const usable = chosen.filter((s) => RoomName.safeParse(nameOf(s).trim()).success);

  return (
    <>
      <div className="flex items-center gap-1.5">
        <WarehouseIcon className="size-3.5 shrink-0 text-accent" />
        <h2 className="text-xs font-semibold text-fg">Rooms the interview proposes</h2>
      </div>
      <FieldNote className="mt-1">
        Nothing has been created. Edit a name, drop what you do not want, then approve — each one
        becomes a folder under the project root with that line as its charter. An existing{" "}
        <code className="font-mono">CLAUDE.md</code> in a folder is never overwritten.
      </FieldNote>
      <ul className="mt-2 space-y-1">
        {suggestions.map((s) => (
          <SuggestionRow
            key={s.id}
            suggestion={s}
            chosen={dropped[s.id] !== true}
            name={nameOf(s)}
            connected={connected}
            onToggle={(keep) =>
              setDropped((d) => {
                const next = { ...d };
                if (keep) delete next[s.id];
                else next[s.id] = true;
                return next;
              })
            }
            onRename={(value) => setNames((n) => ({ ...n, [s.id]: value }))}
          />
        ))}
      </ul>
      <div className="mt-2 flex items-center gap-1.5">
        <Button
          variant="accent"
          disabled={!connected || usable.length === 0}
          onClick={() =>
            send({
              kind: "accept_room_suggestions",
              rooms: usable.map((s) => ({ id: s.id, name: nameOf(s).trim(), charter: s.charter })),
            })
          }
        >
          <CheckIcon />
          Create {usable.length} room{usable.length === 1 ? "" : "s"}
        </Button>
        <Button
          variant="ghost"
          disabled={!connected}
          title="Drop all of them — nothing is created"
          onClick={() => {
            for (const s of suggestions) {
              send({ kind: "dismiss_room_suggestion", suggestionId: s.id });
            }
          }}
        >
          Dismiss all
        </Button>
      </div>
    </>
  );
}

export function Onboarding() {
  const state = useOnboarding();
  const connected = useFabric((s) => s.connected);
  const insets = useHudInsets();
  const surface = onboardingSurface(state);

  if (surface === "none") return null;

  return (
    <div
      // Spans the strip the panels leave free and never takes the pointer as a whole — the floor
      // under it is still draggable. Below the notice bar, which is where the server's own word about
      // what just happened lands.
      className="pointer-events-none fixed top-24 z-40 flex justify-center px-3"
      style={{ left: insets.left, right: insets.right }}
    >
      <div
        data-testid="onboarding"
        className={cn(
          "pointer-events-auto max-h-[60vh] w-[min(520px,100%)] overflow-y-auto rounded-[4px] border",
          "border-accent/50 bg-panel/90 p-3 shadow-[0_8px_28px_rgba(0,0,0,0.5)] backdrop-blur-xl",
        )}
      >
        {surface === "proposal" && (
          <Proposal suggestions={outstanding(state)} connected={connected} />
        )}
        {surface === "interview" && (
          <div className="flex items-start gap-2">
            <MessagesSquareIcon className="mt-0.5 size-3.5 shrink-0 text-accent" />
            <div className="min-w-0">
              <h2 className="text-xs font-semibold text-fg">Onboarding is under way</h2>
              <FieldNote>
                The agent in the project room is asking one question at a time — answer it in the
                console on the right. When it has enough it writes{" "}
                <code className="font-mono">CLAUDE.md</code> and{" "}
                <code className="font-mono">README.md</code> here, and proposes the first rooms.
              </FieldNote>
            </div>
          </div>
        )}
        {surface === "offer" && (
          <>
            <div className="flex items-center gap-1.5">
              <SparklesIcon className="size-3.5 shrink-0 text-accent" />
              <h2 className="text-xs font-semibold text-fg">
                This project has no <code className="font-mono">CLAUDE.md</code>
              </h2>
            </div>
            <FieldNote className="mt-1">
              Nobody has written down what it is, so an agent arriving here starts from nothing. An
              onboarding agent can interview you — one question at a time — then write{" "}
              <code className="font-mono">CLAUDE.md</code> and{" "}
              <code className="font-mono">README.md</code> at the project root and propose the rooms
              this factory should have. It creates no folders: you approve those yourself.
            </FieldNote>
            <div className="mt-2">
              <Button
                variant="accent"
                disabled={!connected}
                onClick={() => send({ kind: "start_onboarding" })}
              >
                <SparklesIcon />
                Start onboarding
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
