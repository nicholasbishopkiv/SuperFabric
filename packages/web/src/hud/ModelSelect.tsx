import { AGENT_MODELS } from "@superfabric/shared";
import { useState } from "react";
import { HUD } from "./theme";

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

/** The `<select>` value that means "no model pinned"; the wire carries `null`. */
const DEFAULT_VALUE = "";
/**
 * The `<select>` value that opens the free-text field rather than choosing a model. Distinct from
 * every id in `AGENT_MODELS` and from anything Anthropic has ever named a model, which is as
 * collision-proof as a sentinel in an open-ended value space gets.
 */
const CUSTOM_VALUE = "__custom__";

/** What the "no model pinned" option says. Short enough for the room panel's one-line agent rows. */
export const MODEL_DEFAULT_LABEL = "default";

export function ModelSelect({
  value,
  disabled,
  short = false,
  onChange,
}: {
  /** The agent's model id, or null for the CLI's own default. */
  value: string | null;
  disabled: boolean;
  /** Use the short labels: the room panel is narrow and lists one control per agent. */
  short?: boolean;
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
    return (
      <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
        <input
          aria-label="Model id"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setTyping(false); setDraft(""); }
          }}
          placeholder="claude-…"
          size={short ? 14 : 22}
          style={{ font: "inherit", fontSize: 12, padding: "2px 4px" }}
        />
        <button type="button" onClick={commit} disabled={disabled} style={{ font: "inherit", fontSize: 12 }}>
          set
        </button>
        <button
          type="button"
          onClick={() => { setTyping(false); setDraft(""); }}
          style={{ font: "inherit", fontSize: 12 }}
        >
          ✕
        </button>
      </span>
    );
  }

  const listed = AGENT_MODELS.some((m) => m.id === value);
  return (
    <select
      aria-label="Model"
      value={value ?? DEFAULT_VALUE}
      disabled={disabled}
      onChange={(e) => {
        const picked = e.target.value;
        if (picked === CUSTOM_VALUE) {
          setDraft(value ?? "");
          setTyping(true);
          return;
        }
        onChange(picked === DEFAULT_VALUE ? null : picked);
      }}
      style={{ font: "inherit" }}
    >
      <option value={DEFAULT_VALUE}>
        {short ? MODEL_DEFAULT_LABEL : `${MODEL_DEFAULT_LABEL} — whatever the CLI is set to`}
      </option>
      {AGENT_MODELS.map((m) => (
        <option key={m.id} value={m.id} title={m.id}>
          {short ? m.label : `${m.label} — ${m.note}`}
        </option>
      ))}
      {/* The agent is on something we do not list: show what it is actually running, never a lie. */}
      {value !== null && !listed && <option value={value}>{value}</option>}
      <option value={CUSTOM_VALUE}>other…</option>
    </select>
  );
}

/** One line explaining the free-text escape hatch, for the surfaces that have room for it. */
export function ModelNote() {
  return (
    <span style={{ color: HUD.dim, fontSize: 12 }}>
      "other…" takes any model id your Claude CLI knows — the list is a shortlist, not a limit.
    </span>
  );
}
