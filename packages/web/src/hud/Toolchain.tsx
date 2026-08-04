import { TerminalIcon } from "lucide-react";
import { useFabric } from "../store";
import { FieldNote } from "../ui/input";
import { Hint } from "../ui/tooltip";
import { cn } from "../ui/utils";

/**
 * What agent CLIs are on the machine the server runs on.
 *
 * It exists because of a fair complaint: an operator with `claude`, `codex` and `agy` installed and
 * signed in opened the accounts popover and saw none of it. A tool whose whole job is driving
 * somebody's CLI should be able to say what it found.
 *
 * **And it must not imply more than that.** SuperFabric drives Claude Code and nothing else today —
 * one implementation behind the `Executor` seam — so every other entry says so in its own row rather
 * than sitting in a list that looks like a provider picker. `signedIn: null` prints as "sign-in not
 * readable from here", never as a cross: a CLI that keeps its credentials in a keyring is not a CLI
 * you are logged out of.
 *
 * Under the accounts rather than in a settings screen, because that is where the question is asked —
 * the operator is already looking at "what can this thing run on".
 */

/** What a row says about a CLI's sign-in, in the three states it can be in. */
function signInLine(signedIn: boolean | null): string {
  if (signedIn === true) return "signed in";
  if (signedIn === false) return "not signed in";
  return "sign-in not readable from here";
}

export function Toolchain() {
  const tools = useFabric((s) => s.toolchain);
  const found = tools.filter((t) => t.path !== null);
  if (tools.length === 0) return null;

  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="flex items-center gap-1.5">
        <TerminalIcon className="size-3 shrink-0 text-fg-faint" />
        <h3 className="text-2xs font-semibold tracking-wide text-fg-muted uppercase">
          CLIs on this machine
        </h3>
      </div>

      {found.length === 0 ? (
        <FieldNote className="mt-1">
          None of the agent CLIs this build knows about is on the server's <code className="font-mono">PATH</code>.
        </FieldNote>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {found.map((t) => (
            <li key={t.id} className="flex items-start gap-1.5">
              <span
                className={cn(
                  "mt-1 size-1.5 shrink-0 rounded-full",
                  t.runsAgents ? "bg-status-idle" : "bg-fg-faint/60",
                )}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="text-2xs text-fg">{t.name}</span>{" "}
                <Hint text={t.path}>
                  <code className="font-mono text-2xs text-fg-muted">{t.command}</code>
                </Hint>{" "}
                <span className="text-2xs text-fg-faint">
                  · {signInLine(t.signedIn)}
                </span>
                {/* The honest half: what SuperFabric can do with it. Said per row rather than once
                    at the bottom, because the row is what someone reads. */}
                <FieldNote className="mt-0">
                  {t.runsAgents
                    ? "agents run on this one"
                    : "SuperFabric cannot staff a room with this one yet — it drives Claude Code only"}
                </FieldNote>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
