import type { AccountInfo } from "@superfabric/shared";
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
import { useAccounts, useFabric } from "../store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { FieldNote, Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../ui/utils";
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
 */

/** Whether the trigger should be warning-coloured: an account exists but cannot run anything yet. */
function anyNeedsLogin(accounts: readonly AccountInfo[]): boolean {
  return accounts.some((a) => !a.credentialsPresent);
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
      <LoginFlow account={account} connected={connected} />
    </li>
  );
}

export function AccountSwitcher() {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [configDir, setConfigDir] = useState("");
  const accounts = useAccounts();
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="md"
          className="bg-panel/80 backdrop-blur-xl"
          title={
            accounts.length === 0
              ? "No accounts yet — agents run on your own ~/.claude"
              : `${accounts.length} account${accounts.length === 1 ? "" : "s"}`
          }
        >
          <CircleUserIcon className={cn(needsLogin ? "text-status-blocked" : "text-fg-faint")} />
          <span className="font-semibold tabular-nums">
            {accounts.length === 0 ? "Accounts" : accounts.length}
          </span>
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
              {connected
                ? "No accounts yet. Agents run on your own ~/.claude until you add one."
                : "Waiting for the server…"}
            </li>
          )}
        </ul>

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
