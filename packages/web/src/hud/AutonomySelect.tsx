import type { AutonomyMode } from "@superfabric/shared";
import { TriangleAlertIcon } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { cn } from "../ui/utils";

/**
 * The autonomy control, shared by every surface that can change how much rope an agent gets. It was
 * born inside the console drawer; the room panel needs exactly the same control for the agents of one
 * room, and two copies of a list of permission modes is how a UI ends up offering a mode the server
 * does not have.
 *
 * On Radix rather than a native `<select>`: the native widget is drawn by the OS, so it was the one
 * control in the HUD that stayed light over a dark panel — and its option text could not be given
 * two weights, which is what lets the long labels below stay readable.
 */

/** Human labels for the autonomy modes — the HUD never shows SDK permission-mode jargon. */
export const AUTONOMY_LABELS: Record<AutonomyMode, string> = {
  attended: "Attended — every gated action asks",
  auto: "Auto — classifier decides (default)",
  bypass: "Bypass — nothing is gated",
};

/** Short forms, for the places where a whole sentence in a select would not fit. */
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
  className,
  onChange,
}: {
  value: AutonomyMode;
  disabled: boolean;
  /** Use the one-word labels: the room panel is narrow and lists one control per agent. */
  short?: boolean;
  className?: string;
  onChange: (autonomy: AutonomyMode) => void;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(v) => onChange(v as AutonomyMode)}>
      <SelectTrigger
        aria-label="Autonomy"
        title={AUTONOMY_LABELS[value]}
        className={cn(short ? "w-[5.5rem]" : "w-56", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {AUTONOMY_MODES.map((m) => (
          <SelectItem key={m} value={m} className={m === "bypass" ? "text-bypass" : undefined}>
            {short ? AUTONOMY_SHORT[m] : AUTONOMY_LABELS[m]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** One-line, no-modal warning shown only while Bypass is the selected mode. */
export function BypassWarning({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-2xs text-bypass", className)}>
      <TriangleAlertIcon className="size-3 shrink-0" />
      this agent can run any command without asking — only for a sandboxed room (M4)
    </span>
  );
}
