import type { RoomRuntime } from "@superfabric/shared";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";
import { cn } from "../ui/utils";

/**
 * Where a room's agents run — the fifth member of the
 * `AutonomySelect`/`ModelSelect`/`AccountSelect`/`RoleSelect` family, and shaped like them for the
 * same reason: an operator who has learned one of these controls has learned all of them.
 *
 * What it has to get right that the others do not: **it is the only control on the panel whose
 * wrong answer is a security answer.** So the trade-off is stated on the option itself rather than
 * in a paragraph underneath it — one line each, saying what you give up, because "container" that
 * only listed benefits would be a recommendation rather than a choice.
 */

const LABEL: Record<RoomRuntime, string> = {
  host: "host",
  container: "sandboxed",
};

/** The one line each option gets. Both name the cost, not only the benefit. */
const SUMMARY: Record<RoomRuntime, string> = {
  host: "fastest, no Docker — but an agent here is you: your whole filesystem, your credentials",
  container: "only this room's folder and its account, capped CPU/memory, no internet beyond "
    + "Anthropic — slower to start, and the room needs an account of its own",
};

export function RuntimeSelect({
  value,
  disabled,
  short = false,
  className,
  onChange,
}: {
  value: RoomRuntime;
  disabled: boolean;
  /** Use the short labels: the room panel is narrow. */
  short?: boolean;
  className?: string;
  onChange: (runtime: RoomRuntime) => void;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(picked) => onChange(picked as RoomRuntime)}>
      <SelectTrigger
        aria-label="Runtime"
        title={SUMMARY[value]}
        className={cn(short ? "w-28" : "w-56", className)}
      >
        <span className="truncate">{LABEL[value]}</span>
      </SelectTrigger>
      <SelectContent>
        {(["host", "container"] as const).map((runtime) => (
          <SelectItem key={runtime} value={runtime}>
            {short ? LABEL[runtime] : `${LABEL[runtime]} — ${SUMMARY[runtime]}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export { LABEL as RUNTIME_LABEL, SUMMARY as RUNTIME_SUMMARY };
