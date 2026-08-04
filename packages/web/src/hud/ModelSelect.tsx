import { AGENT_MODELS } from "@superfabric/shared";
import { CheckIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";
import { cn } from "../ui/utils";

/**
 * Which model an agent runs on, as a control — the twin of `AutonomySelect`, and shared by every
 * surface that can change it for the same reason: two copies of a list of models is how a UI ends up
 * offering one the server cannot start.
 *
 * Three things it has to get right, all of them consequences of model ids being Anthropic's release
 * schedule rather than our protocol:
 *
 * - **"Default" is a real choice, not an empty one.** An agent that has pinned nothing runs on
 *   whatever the CLI would use, which is a different fact from "runs on the id we happen to think is
 *   current". It is the first option and the one a new agent starts on.
 * - **The list is short and the field is open.** `AGENT_MODELS` (in `@superfabric/shared`) is the
 *   single source of truth for the suggestions; "other…" takes any id the operator types, so a model
 *   that shipped this morning is usable today rather than after a SuperFabric release.
 * - **Whatever the agent is actually on is always shown.** An id from outside the list — typed here
 *   before, or set by another tab — is added to the options rather than silently displayed as
 *   something else.
 */

/**
 * The select value that means "no model pinned"; the wire carries `null`.
 *
 * A named sentinel rather than the empty string, which is what the native `<select>` used: Radix
 * reserves `""` as an item value (it is how a Select says "nothing is chosen"), so an item with that
 * value throws. The distinction never leaves this file — `onChange` still emits `null`.
 */
const DEFAULT_VALUE = "__default__";
/**
 * The value that opens the free-text field rather than choosing a model. Distinct from every id in
 * `AGENT_MODELS` and from anything Anthropic has ever named a model, which is as collision-proof as
 * a sentinel in an open-ended value space gets.
 */
const CUSTOM_VALUE = "__custom__";

/** What the "no model pinned" option says. Short enough for the room panel's one-line agent rows. */
export const MODEL_DEFAULT_LABEL = "default";

export function ModelSelect({
  value,
  disabled,
  short = false,
  className,
  onChange,
}: {
  /** The agent's model id, or null for the CLI's own default. */
  value: string | null;
  disabled: boolean;
  /** Use the short labels: the room panel is narrow and lists one control per agent. */
  short?: boolean;
  className?: string;
  onChange: (model: string | null) => void;
}) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");

  if (typing) {
    const commit = (): void => {
      const wanted = draft.trim();
      setTyping(false);
      setDraft("");
      // An empty box is "never mind", not "un-pin": un-pinning is the default option in the list.
      if (wanted !== "" && wanted !== value) onChange(wanted);
    };
    const cancel = (): void => {
      setTyping(false);
      setDraft("");
    };
    return (
      <span className="inline-flex items-center gap-1">
        <Input
          aria-label="Model id"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") cancel();
          }}
          placeholder="claude-…"
          className={cn("h-6.5 text-xs", short ? "w-28" : "w-44")}
        />
        <Button type="button" size="icon" variant="accent" onClick={commit} disabled={disabled} title="Set this model">
          <CheckIcon />
        </Button>
        <Button type="button" size="icon" variant="ghost" onClick={cancel} title="Never mind">
          <XIcon />
        </Button>
      </span>
    );
  }

  const listed = AGENT_MODELS.some((m) => m.id === value);
  const label = value === null ? MODEL_DEFAULT_LABEL : (AGENT_MODELS.find((m) => m.id === value)?.label ?? value);

  return (
    <Select
      value={value ?? DEFAULT_VALUE}
      disabled={disabled}
      onValueChange={(picked) => {
        if (picked === CUSTOM_VALUE) {
          setDraft(value ?? "");
          setTyping(true);
          return;
        }
        onChange(picked === DEFAULT_VALUE ? null : picked);
      }}
    >
      <SelectTrigger
        aria-label="Model"
        title={value ?? "the model your Claude CLI is set to"}
        className={cn(short ? "w-24" : "w-52", className)}
      >
        {/* The trigger shows the *short* label whatever the list shows, so a narrow agent row is not
            widened by an option whose text is a whole sentence. */}
        <span className="truncate">{label}</span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_VALUE}>
          {short ? MODEL_DEFAULT_LABEL : `${MODEL_DEFAULT_LABEL} — whatever the CLI is set to`}
        </SelectItem>
        {AGENT_MODELS.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {short ? m.label : `${m.label} — ${m.note}`}
          </SelectItem>
        ))}
        {/* The agent is on something we do not list: show what it is actually running, never a lie. */}
        {value !== null && !listed && <SelectItem value={value}>{value}</SelectItem>}
        <SelectItem value={CUSTOM_VALUE}>other…</SelectItem>
      </SelectContent>
    </Select>
  );
}

/** One line explaining the free-text escape hatch, for the surfaces that have room for it. */
export function ModelNote() {
  return (
    <span className="text-2xs text-fg-faint">
      “other…” takes any model id your Claude CLI knows — the list is a shortlist, not a limit.
    </span>
  );
}
