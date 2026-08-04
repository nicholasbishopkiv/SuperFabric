import { AGENT_PROVIDERS, type AgentProvider } from "@superfabric/shared";
import { useFabric } from "../store";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";
import { cn } from "../ui/utils";

/**
 * Which CLI the next agent in this room arrives on.
 *
 * **Only what is actually on the machine is offered.** The picker is filtered by `list_toolchain`,
 * so an operator without `codex` installed never sees a choice that would fail — and one who has it
 * sees it without having to be told the feature exists. A provider we cannot find is simply not a
 * choice; it is not a greyed-out row inviting a support question.
 *
 * The provider is chosen **once, when the agent is created**, and there is no equivalent of
 * `set_model` for it: `claude_session_id` is a provider-native handle, so moving a conversation
 * between CLIs would silently forget everything in it. That is why this control lives beside "New
 * agents arrive as" and never on an agent's own row.
 */
export function ProviderSelect({
  value,
  onChange,
  disabled = false,
  short = false,
}: {
  value: AgentProvider;
  onChange: (provider: AgentProvider) => void;
  disabled?: boolean;
  short?: boolean;
}) {
  const toolchain = useFabric((s) => s.toolchain);
  // Before the first `toolchain` frame there is nothing to filter by; Claude Code is the one this
  // product cannot run without, so it stands alone rather than the picker being empty.
  const installed = AGENT_PROVIDERS.filter(
    (p) => p.id === "claude" || toolchain.some((t) => t.id === p.id && t.path !== null),
  );
  // One choice is not a choice: a machine with only Claude Code should not carry a dropdown that
  // can only ever say "Claude Code".
  if (installed.length < 2) return null;

  const current = installed.find((p) => p.id === value) ?? installed[0]!;

  return (
    <Select
      value={current.id}
      disabled={disabled}
      onValueChange={(picked) => onChange(picked as AgentProvider)}
    >
      <SelectTrigger aria-label="Provider" title={current.summary} className={cn(short ? "w-28" : "w-52")}>
        <span className="truncate">{current.name}</span>
      </SelectTrigger>
      <SelectContent>
        {installed.map((p) => (
          <SelectItem key={p.id} value={p.id} title={p.summary}>
            {/* The summary is where the difference between providers is said — the bus, the approval
                cards, the sandbox — because choosing is the moment it matters. */}
            {short ? p.name : `${p.name} — ${p.summary}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
