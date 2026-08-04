import { CircleAlertIcon } from "lucide-react";
import { ACCOUNT_NONE_LABEL, useAccounts } from "../store";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";
import { cn } from "../ui/utils";

/**
 * Which account a room defaults to, or an agent runs on — the third member of the
 * `AutonomySelect`/`ModelSelect` family, and shared by both surfaces for the same reason they are:
 * two copies of "what may this be bound to" is how a UI ends up offering something the server will
 * refuse.
 *
 * The one thing it has to get right that the other two do not: **"default" is a claim about whose
 * subscription is being spent.** An agent on no account runs on the operator's own `~/.claude`, and
 * that is a real, chosen state rather than an empty one — so it is the first option and it is
 * labelled, never left blank.
 *
 * An account with no credentials is still offered, and marked. Refusing to offer it would be wrong
 * (binding a room *before* logging in is a perfectly good order to do things in) and offering it
 * silently would be worse: the agent would start and fail at its first turn.
 */

/**
 * The select value that means "no account". A named sentinel rather than `""`, which Radix reserves
 * as "nothing is chosen" and throws on. The distinction never leaves this file — `onChange` emits
 * `null`.
 */
const NONE_VALUE = "__none__";

export function AccountSelect({
  value,
  disabled,
  short = false,
  className,
  onChange,
}: {
  /** The bound account's id, or null for the ambient `~/.claude`. */
  value: string | null;
  disabled: boolean;
  /** Use the short labels: the room panel is narrow and lists one control per agent. */
  short?: boolean;
  className?: string;
  onChange: (accountId: string | null) => void;
}) {
  const accounts = useAccounts();
  const bound = accounts.find((a) => a.id === value);
  // Bound to something this tab holds no row for — a deleted account, or a list that has not
  // arrived yet. Show the id: "an account I cannot describe" is not the same fact as "no account".
  const label = value === null ? ACCOUNT_NONE_LABEL : (bound?.label ?? value);
  const needsLogin = bound !== undefined && !bound.credentialsPresent;

  return (
    <Select
      value={value ?? NONE_VALUE}
      disabled={disabled}
      onValueChange={(picked) => onChange(picked === NONE_VALUE ? null : picked)}
    >
      <SelectTrigger
        aria-label="Account"
        title={
          value === null
            ? "runs on your own ~/.claude — the account your Claude CLI is logged into"
            : `${label}${bound === undefined ? "" : ` · ${bound.configDir}`}`
              + (needsLogin ? " — not logged in yet" : "")
        }
        className={cn(short ? "w-24" : "w-52", className)}
      >
        <span className="flex min-w-0 items-center gap-1">
          {needsLogin && <CircleAlertIcon className="size-3 shrink-0 text-status-blocked" />}
          <span className="truncate">{label}</span>
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE_VALUE}>
          {short ? ACCOUNT_NONE_LABEL : `${ACCOUNT_NONE_LABEL} — your own ~/.claude`}
        </SelectItem>
        {accounts.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {short
              ? a.label
              : `${a.label}${a.credentialsPresent ? "" : " — not logged in yet"}`}
          </SelectItem>
        ))}
        {/* Bound to a row we do not hold: show what it actually is rather than silently
            re-rendering as "default", which would misreport whose quota is being spent. */}
        {value !== null && bound === undefined && <SelectItem value={value}>{value}</SelectItem>}
      </SelectContent>
    </Select>
  );
}
