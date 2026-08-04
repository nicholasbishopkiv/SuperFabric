import type { AccountInfo, AccountMetrics } from "@superfabric/shared";
import { AGENT_PROVIDERS, DEFAULT_AGENT_PROVIDER } from "@superfabric/shared";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  CircleUserIcon,
  CopyIcon,
  ExternalLinkIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  useAccountMetrics, useAccounts, useAccountUsage, useAmbientCost, useFabric, useRoomCosts, useUsage,
} from "../store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { FieldNote, Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Progress } from "../ui/progress";
import { Toolchain } from "./Toolchain";
import { cn } from "../ui/utils";
import { LIMIT_PAUSE_PERCENT } from "@superfabric/shared";
import { STATUS_COLOR } from "../scene/palette";
import { BurnRate, formatRemaining, formatUsd } from "./BurnRate";
import { type LimitHeadline, limitHeadline, type LimitSeverity, SILENCE_TEXT } from "./limitHeadline";
import { UsageMeters } from "./UsageMeters";
import { send } from "../wsClient";

/**
 * The accounts: which Claude subscriptions this machine has, and how to log one in.
 *
 * It sits next to the project switcher because it answers the neighbouring question — the switcher
 * says *which factory*, this says *whose quota*. A popover rather than a fourth edge panel for the
 * same reason the chronicle is one: accounts are configured occasionally and read at a glance, and
 * a permanent hole in the floor is a high price for a list that is usually three rows long.
 *
 * **Accounts are machine-wide**, so nothing here is scoped to a project and switching factories does
 * not change what it shows. What is per-project is the *binding*, which lives where the thing being
 * bound lives: the room panel.
 *
 * The limit meters live here too rather than in a fourth edge panel, and for the same reason the
 * popover exists at all: "how much quota is left on which subscription" is the neighbouring question
 * to "which subscriptions do I have", and a permanent hole in the floor is a high price for three
 * rows of bars. The trigger carries the worst number across every account, so the question can be
 * answered without opening anything.
 */

/** Whether the trigger should be warning-coloured: an account exists but cannot run anything yet. */
function anyNeedsLogin(accounts: readonly AccountInfo[]): boolean {
  return accounts.some((a) => !a.credentialsPresent);
}

/** A stable empty array, so the metrics selector does not hand `useShallow` a new one each render. */
const EMPTY_METRICS: readonly AccountMetrics[] = [];

const SEVERITY_COLOR: Record<Exclude<LimitSeverity, "none">, string> = {
  ok: STATUS_COLOR.working,
  warn: STATUS_COLOR.blocked,
  critical: STATUS_COLOR.error,
};

/**
 * How much subscription is left, on the one control that is always on screen.
 *
 * The trigger has carried the worst percentage for a while. What it could not do was speak when
 * there was **no** percentage: with no accounts configured — the state a fresh machine is in — it
 * rendered nothing, and nothing reads as "fine" while `scheduler.ts` is standing by to pause every
 * agent on the floor at `LIMIT_PAUSE_PERCENT`. Each of the three silences is now a different
 * sentence, decided in `limitHeadline.ts` where it can be tested.
 *
 * The second addition is the **duration**. "At this rate you have about two hours" is what an
 * operator plans an afternoon around; a percentage is what they then have to convert. It is absent
 * far more often than it is present, so it degrades in two steps — the server's own reason when it
 * was asked and could not answer, and a bare dash when nothing has been measured yet. Those are
 * different facts and `BurnRate` already distinguishes them; flattening them here would undo that.
 */
function LimitReadout({ head }: { head: LimitHeadline }) {
  if (head.silence !== null) {
    return <span className="text-2xs font-normal text-fg-faint">{SILENCE_TEXT[head.silence]}</span>;
  }

  const color = SEVERITY_COLOR[head.severity === "none" ? "ok" : head.severity];
  const percent = Math.round(head.utilization ?? 0);

  return (
    <>
      <Progress
        value={percent}
        aria-hidden
        className="h-1 w-10 shrink-0"
        // Solid for a reading, hatched for a guess — the same texture `UsageMeters` uses, because it
        // is the one mark that survives a screenshot and a colour-blind reader.
        fill={{
          background: head.approximate
            ? `repeating-linear-gradient(115deg, ${color} 0 3px, transparent 3px 6px)`
            : color,
        }}
      />
      <span className="shrink-0 font-mono text-2xs tabular-nums" style={{ color }}>
        {head.approximate ? "≈" : ""}{percent}%
      </span>
      {/* The duration, and the one place a blank is the honest rendering.
          "Nothing has been measured yet" gets nothing: the percentage beside it is already on
          screen, so an absence here cannot read as "you are fine" — which is the failure this whole
          surface exists to prevent — whereas a bare em-dash butted against `100%` reads as a minus
          sign. Asked-and-unanswerable is different and still says so in words: that is a refusal the
          server made, and `BurnRate` keeps the two apart for the same reason. */}
      {(head.secondsToLimit !== null || head.burnUnknown !== null) && (
        <span className="shrink-0 font-mono text-2xs font-normal tabular-nums text-fg-faint">
          ·{" "}
          {head.secondsToLimit !== null
            ? formatRemaining(head.secondsToLimit).replace(/^about /, "≈")
            : "unknown"}
        </span>
      )}
    </>
  );
}

/**
 * The login conversation for one account, as it actually is: a link to open and a box for the code
 * that page gives back.
 *
 * There is no terminal here and there deliberately is not one — `claude auth login` needs no TTY, so
 * the whole interaction is two fields (see `docs/decisions/0004-account-login-over-a-pipe.md`). The
 * out-of-band command is offered alongside rather than instead: an operator who would rather do this
 * in their own shell gets a line they can paste unedited, and the server notices either way.
 */
function LoginFlow({ account, connected }: { account: AccountInfo; connected: boolean }) {
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const { status, url, message } = account.login;

  // Exactly what the operator would have to type themselves. Quoted, because a home directory with
  // a space in it is a command that fails in a way nobody enjoys debugging.
  const command = `CLAUDE_CONFIG_DIR=${JSON.stringify(account.configDir)} claude auth login`;

  function copy(): void {
    void navigator.clipboard?.writeText(command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => useFabric.getState().setError("could not copy to the clipboard"),
    );
  }

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    const wanted = code.trim();
    if (wanted === "") return;
    useFabric.getState().clearError();
    send({ kind: "submit_account_login_code", accountId: account.id, code: wanted });
    setCode("");
  }

  if (status === "idle") {
    return (
      <div className="mt-1.5">
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            variant="accent"
            disabled={!connected}
            onClick={() => {
              useFabric.getState().clearError();
              send({ kind: "begin_account_login", accountId: account.id });
            }}
            title={`Run "claude auth login" against ${account.configDir}`}
          >
            {account.credentialsPresent ? "Log in again" : "Log in"}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={copy}
            title="Copy the command to run it in your own terminal instead"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "copied" : "copy command"}
          </Button>
        </div>
        <FieldNote>
          Opens a Claude sign-in page and asks you for the code it gives back. Or run it
          yourself — this account lights up either way, as soon as{" "}
          <code className="font-mono">.credentials.json</code> appears.
        </FieldNote>
      </div>
    );
  }

  return (
    <div className="mt-1.5 rounded-[3px] border border-line/60 bg-panel-sunken/40 p-1.5">
      {status === "starting" && (
        <div className="text-2xs text-fg-muted">Starting the sign-in…</div>
      )}

      {url !== null && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="flex items-start gap-1 text-2xs text-accent underline underline-offset-2 hover:text-accent/80"
        >
          <ExternalLinkIcon className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 break-all">Open the Claude sign-in page</span>
        </a>
      )}

      {status === "awaiting_code" && (
        <form onSubmit={submit} className="mt-1.5">
          <div className="flex gap-1.5">
            <Input
              name="loginCode"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="paste the code from that page"
              className="flex-1 font-mono text-xs"
              autoComplete="off"
            />
            <Button type="submit" variant="accent" size="xs" disabled={!connected} className="shrink-0">
              Send
            </Button>
          </div>
        </form>
      )}

      {status === "finishing" && <div className="mt-1 text-2xs text-fg-muted">Checking the code…</div>}

      {/* The CLI's own words, not a paraphrase of them. */}
      {message !== null && (
        <FieldNote className={cn(status === "failed" ? "text-status-error" : "text-status-blocked")}>
          {message}
        </FieldNote>
      )}

      <Button
        size="xs"
        variant="ghost"
        className="mt-1"
        onClick={() => send({ kind: "cancel_account_login", accountId: account.id })}
      >
        {status === "failed" ? "Dismiss" : "Cancel"}
      </Button>
    </div>
  );
}

/** One account: whether it can actually run anything, where its credentials live, and the login. */
function AccountRow({ account, connected }: { account: AccountInfo; connected: boolean }) {
  const usage = useAccountUsage(account.id);
  const metrics = useAccountMetrics(account.id);
  return (
    <li className="rounded-[3px] border border-line/60 bg-panel-sunken/30 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        {/* Green when this account can start an agent, amber when it cannot. It is the same
            question the operator has when they look at this list, so it is the first thing on the row. */}
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            account.credentialsPresent ? "bg-status-idle" : "bg-status-blocked",
          )}
        />
        <span className="truncate text-sm font-semibold text-fg">{account.label}</span>
        {/* Which CLI this subscription belongs to. Only when it is not the default: on a machine
            where every account is a Claude one the badge would be noise on every row, and its
            absence is unambiguous. It matters because the two are read differently — a Codex meter
            is the number its own CLI recorded on the last turn, not something we polled. */}
        {account.provider !== DEFAULT_AGENT_PROVIDER && (
          <Badge title={AGENT_PROVIDERS.find((p) => p.id === account.provider)?.summary ?? account.provider}>
            {AGENT_PROVIDERS.find((p) => p.id === account.provider)?.name ?? account.provider}
          </Badge>
        )}
        {!account.credentialsPresent && (
          <Badge variant="warn" title="No credentials in this directory yet — agents on it would fail">
            not logged in
          </Badge>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto shrink-0"
          disabled={!connected}
          onClick={() => {
            useFabric.getState().clearError();
            send({ kind: "remove_account", accountId: account.id });
          }}
          title="Forget this account. Refused while an agent still runs on it; the folder is left alone."
          aria-label={`Remove ${account.label}`}
        >
          <Trash2Icon />
        </Button>
      </div>
      <div className="mt-0.5 break-all font-mono text-2xs text-fg-muted">{account.configDir}</div>
      {/* Only for an account that could have a reading at all: a meter under "not logged in" would
          be answering a question the operator has not reached yet. */}
      {account.credentialsPresent && <UsageMeters usage={usage} />}
      {/* The projection sits directly under the meters it is derived from: the bars say how full the
          windows are, this says how long that leaves — the question the operator asks next. */}
      {account.credentialsPresent && <BurnRate burn={metrics?.burn} cost={metrics?.cost} />}
      <LoginFlow account={account} connected={connected} />
    </li>
  );
}

/**
 * Where this factory's quota went, by department — and what the operator's own `~/.claude` spent.
 *
 * In the accounts popover rather than on the room panel, because it answers the question directly
 * after "how long do I have": *where is it going*. It is the one thing here that is **per project**
 * (a room belongs to one floor, unlike a subscription), which is why the heading says so out loud
 * rather than leaving the operator to wonder whether they are looking at every factory at once.
 *
 * Rooms that have cost nothing are simply absent: a list of eleven rooms at $0.00 buries the two that
 * are spending.
 */
function FactorySpend() {
  const rooms = useFabric(useShallow((s) => s.rooms));
  const costs = useRoomCosts();
  const ambient = useAmbientCost();
  if (costs.length === 0 && (ambient === null || ambient.week.usd === 0)) return null;

  const nameOf = (roomId: string): string => rooms.find((r) => r.id === roomId)?.name ?? "a former room";
  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="text-2xs font-semibold uppercase tracking-wide text-fg-faint">
        This factory&rsquo;s spend, by room
      </div>
      <ul className="mt-1 space-y-0.5">
        {costs.map((room) => (
          <li key={room.roomId} className="flex items-baseline gap-1.5 text-2xs">
            <span className="truncate text-fg-muted">{nameOf(room.roomId)}</span>
            <span className="ml-auto shrink-0 font-mono tabular-nums text-fg-muted">
              ≈{formatUsd(room.cost.day.usd)} <span className="text-fg-faint">/ 24 h</span>
            </span>
            <span className="shrink-0 font-mono tabular-nums text-fg-muted">
              ≈{formatUsd(room.cost.week.usd)} <span className="text-fg-faint">/ 7 d</span>
            </span>
          </li>
        ))}
      </ul>
      {/* Agents with no account bound run on the operator's own `~/.claude`, which has no row above to
          hang a figure on — so it is said here rather than folded into an account that never ran it. */}
      {ambient !== null && ambient.week.usd > 0 && (
        <FieldNote>
          Agents on your own <code className="font-mono">~/.claude</code> (no account bound):{" "}
          ≈{formatUsd(ambient.day.usd)} in 24 h, ≈{formatUsd(ambient.week.usd)} in 7 d. Every figure
          here is a cost-equivalent from the CLI&rsquo;s own numbers — on a subscription no money
          changes hands per turn.
        </FieldNote>
      )}
    </div>
  );
}

export function AccountSwitcher() {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [configDir, setConfigDir] = useState("");
  const accounts = useAccounts();
  const usage = useUsage();
  const accountMetrics = useFabric(useShallow((s) => s.metrics?.accounts ?? EMPTY_METRICS));
  const connected = useFabric((s) => s.connected);
  const clearError = useFabric((s) => s.clearError);

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    const wantedLabel = label.trim();
    const wantedDir = configDir.trim();
    if (wantedLabel === "" || wantedDir === "") return;
    clearError();
    send({ kind: "create_account", label: wantedLabel, configDir: wantedDir });
    setLabel("");
    setConfigDir("");
  }

  const needsLogin = anyNeedsLogin(accounts);
  const anyLimited = usage.some((u) => u.limited);
  // One decision, made in one place and tested there: which account is worst, how loud that is, and
  // — the part the trigger could not say before — what to put where the number goes when there is no
  // number at all. See `limitHeadline.ts`.
  const head = limitHeadline(accounts, usage, accountMetrics);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="md"
          className={cn(
            "bg-panel/80 backdrop-blur-xl",
            // The control itself takes the colour once the scheduler is about to act. Below the warn
            // threshold it stays ordinary chrome: a limit meter that is loud all the time is a limit
            // meter nobody reads.
            head.severity === "warn" && "border-status-blocked/60 bg-status-blocked/10",
            head.severity === "critical" && "border-status-error/60 bg-status-error/10",
          )}
          title={
            head.silence === "no-accounts"
              ? "No accounts yet — agents run on this machine's ambient CLI configuration, whose limits SuperFabric cannot read"
              : head.silence === "not-logged-in"
                ? "An account is configured but has no credentials yet, so nothing can be read from it"
                : head.silence === "no-reading"
                  ? "The monitor polls every three minutes. The meters appear after the first reading."
                  : `${head.windowLabel} on ${head.accountLabel} is ${head.approximate ? "about " : ""}`
                    + `${Math.round(head.utilization ?? 0)}% full. Agents on this account are paused at `
                    + `${LIMIT_PAUSE_PERCENT}%.`
                    + (head.approximate
                      ? " This reading is counted from this machine's transcripts rather than read from the provider — it cannot see your other devices."
                      : "")
                    + (head.burnUnknown !== null ? ` No projection: ${head.burnUnknown}.` : "")
          }
        >
          <CircleUserIcon
            className={cn(
              anyLimited ? "text-status-error" : needsLogin ? "text-status-blocked" : "text-fg-faint",
            )}
          />
          <span className="font-semibold tabular-nums">
            {accounts.length === 0 ? "Accounts" : accounts.length}
          </span>
          <LimitReadout head={head} />
          <ChevronsUpDownIcon className="text-fg-faint" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="max-h-[70vh] w-[min(460px,92vw)] overflow-y-auto">
        <ul className="mb-2 space-y-1.5">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} connected={connected} />
          ))}
          {accounts.length === 0 && (
            <li className="text-2xs text-fg-faint">
              {/* An empty list now means something specific: the server looked at this machine's own
                  `~/.claude` on boot and found no login there. Saying so is more useful than "no
                  accounts yet", which reads as "you have not got round to it" on a machine where the
                  operator has in fact been using Claude Code all along. */}
              {connected
                ? "No accounts. This machine's own ~/.claude is not logged in — add an account here, "
                  + "or run `claude auth login` in a terminal and it will appear."
                : "Waiting for the server…"}
            </li>
          )}
        </ul>

        {/* What else is on this machine. Under the accounts because that is where the question is
            asked, and honest about the one thing that matters: only Claude Code runs agents. */}
        <Toolchain />

        <FactorySpend />

        <form onSubmit={submit} className="border-t border-line pt-2">
          <div className="flex gap-1.5">
            <Input
              name="accountLabel"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="name (e.g. work)"
              className="flex-1"
            />
            <Input
              name="accountConfigDir"
              value={configDir}
              onChange={(e) => setConfigDir(e.target.value)}
              placeholder="/absolute/path/to/a/config/dir"
              className="flex-2 font-mono text-xs"
            />
            <Button type="submit" variant="accent" disabled={!connected} className="shrink-0">
              <PlusIcon />
              Add
            </Button>
          </div>
          {/* The invariant, said before it can be broken rather than only in the rejection. */}
          <FieldNote>
            An account is a <code className="font-mono">CLAUDE_CONFIG_DIR</code> — its own copy of
            everything <code className="font-mono">~/.claude</code> holds. The folder is created if
            it is not there. <strong className="font-semibold text-fg-muted">One folder is one
            account:</strong> the CLI rewrites its refresh token in place, so two accounts sharing a
            folder would log each other out, and a second account on the same one is refused.
          </FieldNote>
        </form>
      </PopoverContent>
    </Popover>
  );
}
