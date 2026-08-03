import type { AutonomyMode } from "@superfabric/shared";
import { HUD } from "./theme";

/**
 * The autonomy control, shared by every surface that can change how much rope an agent gets. It was
 * born inside the console drawer; the room panel needs exactly the same control for the agents of one
 * room, and two copies of a list of permission modes is how a UI ends up offering a mode the server
 * does not have.
 */

/** Human labels for the autonomy modes — the HUD never shows SDK permission-mode jargon. */
export const AUTONOMY_LABELS: Record<AutonomyMode, string> = {
  attended: "Attended — every gated action asks",
  auto: "Auto — classifier decides (default)",
  bypass: "Bypass — nothing is gated",
};

/** Short forms, for the places where a whole sentence in a `<select>` would not fit. */
export const AUTONOMY_SHORT: Record<AutonomyMode, string> = {
  attended: "attended",
  auto: "auto",
  bypass: "bypass",
};

export const AUTONOMY_MODES = ["attended", "auto", "bypass"] as const;

export function AutonomySelect({
  value,
  disabled,
  short = false,
  onChange,
}: {
  value: AutonomyMode;
  disabled: boolean;
  /** Use the one-word labels: the room panel is narrow and lists one control per agent. */
  short?: boolean;
  onChange: (autonomy: AutonomyMode) => void;
}) {
  return (
    <select
      aria-label="Autonomy"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as AutonomyMode)}
      style={{ font: "inherit" }}
    >
      {AUTONOMY_MODES.map((m) => (
        <option key={m} value={m}>
          {short ? AUTONOMY_SHORT[m] : AUTONOMY_LABELS[m]}
        </option>
      ))}
    </select>
  );
}

/** One-line, no-modal warning shown only while Bypass is the selected mode. */
export function BypassWarning() {
  return (
    <span style={{ color: HUD.err }}>
      ⚠ this agent can run any command without asking — only for a sandboxed room (M4)
    </span>
  );
}
