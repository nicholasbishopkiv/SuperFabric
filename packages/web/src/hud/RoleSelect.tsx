import { ROLE_NONE_LABEL, useRoles } from "../store";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";
import { cn } from "../ui/utils";

/**
 * Which role an agent arrives as, as a control — the fourth of the family beside `AutonomySelect`,
 * `ModelSelect` and `AccountSelect`, and shared by the two surfaces that can set it for the same
 * reason they are: one list, so the picker offering a role and the picker showing one cannot disagree.
 *
 * Two things it has to get right:
 *
 * - **"No role" is a real choice.** A plain agent is what every session was before roles existed and
 *   is still the right answer for a room whose charter already says everything. It is the first
 *   option, and it is what an agent created without one shows.
 * - **Whatever the agent actually is, is shown.** A role whose file the operator has since deleted or
 *   renamed still appears — as its id — rather than silently reading as "no role", because those are
 *   different facts about a running agent.
 *
 * Unlike `ModelSelect` there is no free-text escape hatch: a role is a file, and an id that names no
 * file is not something the operator can usefully type — they would write the file instead.
 */
export function RoleSelect({
  value,
  disabled,
  short = false,
  className,
  onChange,
}: {
  /** The agent's role id, or null for a plain agent. */
  value: string | null;
  disabled: boolean;
  /** Use the short labels: the room panel is narrow and lists one control per agent. */
  short?: boolean;
  className?: string;
  onChange: (roleId: string | null) => void;
}) {
  const roles = useRoles();
  const listed = roles.some((r) => r.id === value);
  const current = roles.find((r) => r.id === value);
  const label = value === null ? ROLE_NONE_LABEL : (current?.name ?? value);

  return (
    <Select
      value={value ?? NONE_VALUE}
      disabled={disabled}
      onValueChange={(picked) => onChange(picked === NONE_VALUE ? null : picked)}
    >
      <SelectTrigger
        aria-label="Role"
        title={current?.summary ?? (value === null ? "a plain agent — no charter beyond the room's own" : value)}
        className={cn(short ? "w-24" : "w-52", className)}
      >
        {/* The trigger shows the name alone whatever the list shows: a summary is a sentence, and an
            agent row is one line. */}
        <span className="truncate">{label}</span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE_VALUE}>
          {short ? ROLE_NONE_LABEL : `${ROLE_NONE_LABEL} — just an agent in this room`}
        </SelectItem>
        {roles.map((r) => (
          <SelectItem key={r.id} value={r.id} title={r.summary}>
            {/* The summary is the whole point of the picker: "architect" tells an operator who does
                not know Claude Code nothing, and one line of what it owns tells them everything. */}
            {short ? r.name : `${r.name} — ${r.summary}`}
          </SelectItem>
        ))}
        {/* The agent is a role we hold no spec for — deleted, renamed, or from another server. Show
            what it actually is. */}
        {value !== null && !listed && <SelectItem value={value}>{value}</SelectItem>}
      </SelectContent>
    </Select>
  );
}

/**
 * The select value that means "no role"; the wire carries `null`.
 *
 * A named sentinel rather than the empty string for the same reason `ModelSelect` has one: Radix
 * reserves `""` as an item value, so an item carrying it throws. It never leaves this file.
 */
const NONE_VALUE = "__none__";
