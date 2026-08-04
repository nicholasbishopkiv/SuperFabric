import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ACCOUNT_CREDENTIALS_FILE, type UsageWindow } from "@superfabric/shared";

/**
 * Reading an account's rate-limit usage — the seam, and the two things behind it.
 *
 * **There is no official API for subscription limits.** What exists is an undocumented endpoint the
 * CLI itself calls (`docs/RESEARCH.md` §2), and counting tokens out of the transcripts on this disk.
 * The first is authoritative and may vanish without notice; the second always works and is always a
 * guess. That asymmetry is the reason for the adapter: the monitor asks for a reading and does not
 * know, or care, which door it came through — but the *reading* carries where it came from, so
 * nothing downstream can accidentally present a guess as a measurement.
 */

/** One adapter's answer. `approximate` is the field the whole design turns on. */
export interface UsageReading {
  source: "endpoint" | "estimate";
  approximate: boolean;
  windows: UsageWindow[];
  /** Why this reading is degraded, in words for the operator, or null when it is not. */
  note: string | null;
  /**
   * When the *provider* produced these numbers, in unix seconds — not when we looked.
   *
   * Omitted by an adapter that asks over the network, where the two are the same moment. Set by one
   * that reads a **record** the CLI wrote (see `CodexUsageAdapter`): a figure from yesterday's turn
   * shown as if it had just been read would be the meter lying about its own age, which is the one
   * thing every reading in this product is careful not to do.
   */
  readAt?: number;
  /**
   * The provider itself says whether this account can work — set only by an adapter that *knows*,
   * and then it decides `limited` instead of the percentage does.
   *
   * It exists because a percentage is not always the whole story. A Codex account can sit at 100 % of
   * its plan window and keep working on credits: pausing its agents on the number alone would hold
   * them for a limit that is not in force. The reverse matters too — `spend_control_reached` blocks
   * an account whose windows look fine. Omitted, and the fullest window decides, exactly as before.
   */
  blocked?: boolean;
}

export interface UsageAccount {
  id: string;
  /**
   * This account's configuration directory — `CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for
   * Codex. Everything an adapter needs is inside it, which is what lets one seam serve providers
   * that authenticate and record entirely differently.
   */
  configDir: string;
}

export interface UsageAdapter {
  readonly name: string;
  /** Read this account's usage, or throw. A throw is what makes the monitor fall back. */
  read(account: UsageAccount): Promise<UsageReading>;
}

// ---- the primary: Anthropic's own usage endpoint -------------------------------------------------

export const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

/**
 * The beta header the CLI sends with the OAuth-token requests this endpoint belongs to. Undocumented
 * like the endpoint itself; it is here because it is what was observed to work.
 */
export const OAUTH_BETA_HEADER = "oauth-2025-04-20";

/**
 * What we call ourselves. `claude-code/<version>` because that is the client this endpoint exists to
 * serve, and a request that does not look like one is a request that may be turned away — we are a
 * guest on an interface nobody promised us.
 */
export const DEFAULT_USER_AGENT = "claude-code/2.1.220";

/** Injected so tests never touch the network. */
export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  /**
   * Optional so a test double stays two lines. Only `Retry-After` is ever read, and only on a
   * failure — see `retryAfterMs`.
   */
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/**
 * The bearer for one account, out of its `.credentials.json`.
 *
 * **It has to be the CLI's own OAuth token, and only `claude auth login` writes one with the scope
 * that reaches this endpoint.** `claude setup-token` issues `user:inference` only — see
 * `docs/decisions/0004-account-login-over-a-pipe.md`, which is why that path was not adopted.
 *
 * Both spellings of the field are accepted because the file belongs to a tool we do not own: today it
 * is `claudeAiOauth.accessToken`, and a reader that only knew one shape would fail silently the day
 * that changed. `undefined` rather than a throw for "no file": an account nobody has logged into yet
 * is an ordinary state, not an error.
 */
export function readBearer(configDir: string): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(configDir, ACCOUNT_CREDENTIALS_FILE), "utf8"));
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object") return undefined;
  const outer = raw as Record<string, unknown>;
  const inner = (outer.claudeAiOauth ?? outer) as Record<string, unknown>;
  if (inner === null || typeof inner !== "object") return undefined;
  const token = inner.accessToken ?? inner.access_token;
  return typeof token === "string" && token !== "" ? token : undefined;
}

/** Raised when the endpoint answered but nothing in the body was a window we understood. */
export class UnrecognisedUsageShape extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnrecognisedUsageShape";
  }
}

/**
 * The fixed windows the endpoint names as top-level keys, and what to call each on screen.
 *
 * Observed live on 2026-08-04 against a Max subscription: `five_hour` and `seven_day` carried
 * objects; `seven_day_opus` and `seven_day_sonnet` were present but **null**, alongside a dozen more
 * nullable keys with internal code names (`tangelo`, `iguana_necktie`, `nimbus_quill`, …). So a key
 * being absent, null, or unheard-of is the normal case and never an error — the per-model figures
 * have moved into the `limits` array, which is read below.
 */
const NAMED_WINDOWS: Readonly<Record<string, string>> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
};

/** `limits[].kind` values that restate a top-level window. Kept only when the named key is absent. */
const LIMIT_KIND_ALIAS: Readonly<Record<string, string>> = {
  session: "five_hour",
  weekly_all: "seven_day",
};

/** Turn an unknown key into something readable rather than dropping the window it names. */
function humanise(key: string): string {
  return key.replace(/[_:]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A utilization we are willing to believe: a finite number, clamped to the range it claims. */
function asPercent(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(100, v));
}

function asResetsAt(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * The endpoint's body, as meters.
 *
 * **Degrade, never crash.** This parses a body from an interface nobody documented and that has
 * already changed once under us — the per-model weekly figures are now inside a `limits` array and
 * the old top-level keys are null. So: take every window that makes sense, count the ones that do
 * not, and let the caller say so on the wire. The only failure is understanding *nothing*, which is
 * the signal that the endpoint has moved somewhere we cannot follow and the estimate should take
 * over.
 *
 * The shape read on 2026-08-04 (field names and types, values elided):
 *
 * ```
 * five_hour: { utilization: number, resets_at: string, limit_dollars: null, … } | null
 * seven_day, seven_day_opus, seven_day_sonnet, seven_day_oauth_apps, …: the same | null
 * limits: [{ kind: string, group: string, percent: number, severity: string,
 *            resets_at: string, scope: { model: { id, display_name } } | null, is_active: boolean }]
 * extra_usage: {…}, spend: {…}, member_dashboard_available: boolean
 * ```
 */
export function parseUsagePayload(body: unknown): { windows: UsageWindow[]; unrecognised: number } {
  if (!isRecord(body)) {
    throw new UnrecognisedUsageShape("the usage endpoint answered with something that is not an object");
  }

  const windows: UsageWindow[] = [];
  const seen = new Set<string>();
  let unrecognised = 0;

  const push = (key: string, label: string, utilization: number, resetsAt: string | null): void => {
    if (seen.has(key)) return;
    seen.add(key);
    windows.push({ key, label, utilization, resetsAt, detail: null });
  };

  // The named windows first, so they keep their order and their human labels.
  for (const [key, label] of Object.entries(NAMED_WINDOWS)) {
    const raw = body[key];
    if (raw === null || raw === undefined) continue;  // present-but-empty is the normal case
    if (!isRecord(raw)) { unrecognised++; continue; }
    const utilization = asPercent(raw.utilization);
    if (utilization === undefined) { unrecognised++; continue; }
    push(key, label, utilization, asResetsAt(raw.resets_at));
  }

  // Then `limits[]`, which is where the per-model weekly buckets now live. An entry that restates a
  // window we already have is dropped rather than shown twice; one we do not have is taken, whatever
  // its kind, because a window we cannot name is still a window the operator is being measured on.
  const limits = body.limits;
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      if (!isRecord(entry)) { unrecognised++; continue; }
      const kind = typeof entry.kind === "string" ? entry.kind : null;
      const utilization = asPercent(entry.percent);
      if (kind === null || utilization === undefined) { unrecognised++; continue; }

      const alias = LIMIT_KIND_ALIAS[kind];
      if (alias !== undefined) {
        // `session` is `five_hour` and `weekly_all` is `seven_day`. Only useful when the named key
        // was missing — the day the top-level keys go the way of `seven_day_opus`, this is the
        // parser still working.
        push(alias, NAMED_WINDOWS[alias] ?? humanise(alias), utilization, asResetsAt(entry.resets_at));
        continue;
      }

      // A scoped limit is identified by what it is scoped *to*: `weekly_scoped` on its own would
      // collapse two models onto one meter.
      const scope = isRecord(entry.scope) ? entry.scope : null;
      const model = scope !== null && isRecord(scope.model) ? scope.model : null;
      const modelName = model !== null && typeof model.display_name === "string" && model.display_name !== ""
        ? model.display_name
        : null;
      const key = modelName === null ? kind : `${kind}:${modelName}`;
      const label = modelName === null
        ? humanise(kind)
        : `${kind.startsWith("weekly") ? "Weekly" : humanise(kind)} · ${modelName}`;
      push(key, label, utilization, asResetsAt(entry.resets_at));
    }
  } else if (limits !== undefined && limits !== null) {
    unrecognised++;
  }

  if (windows.length === 0) {
    throw new UnrecognisedUsageShape(
      "the usage endpoint answered with no window this build recognises — "
      + `keys: ${Object.keys(body).slice(0, 12).join(", ") || "(none)"}`,
    );
  }
  return { windows, unrecognised };
}

export interface OAuthUsageAdapterOptions {
  fetch?: FetchLike;
  userAgent?: string;
}

/**
 * The primary adapter: the account's own bearer against the endpoint the CLI uses.
 *
 * Every failure is a throw, and every throw is caught by the monitor and turned into a fallback plus
 * a note. That is the contract: this class never returns a half-truth.
 */
/**
 * The endpoint answered, and it was not a reading.
 *
 * A class rather than a message, because the caller has to *branch* on it: a 429 means "you asked
 * too often" and deserves a long back-off, a 401 means "this account is not logged in" and no
 * back-off will fix it, and a 500 is neither. Deciding that by matching prose would put the meaning
 * of the interface in a regular expression — see `LimitMonitor.poll`.
 */
export class UsageHttpError extends Error {
  constructor(
    message: string,
    /** HTTP status as the endpoint sent it. */
    readonly status: number,
    /** `Retry-After`, in milliseconds, when the response carried one. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "UsageHttpError";
  }
}

/**
 * `Retry-After` as milliseconds — seconds or an HTTP date, both of which the header allows.
 *
 * Honoured over our own back-off when present: the endpoint saying when to come back is better
 * information than anything we could assume, and ignoring it would be rude in the specific way that
 * gets an undocumented interface closed.
 */
function retryAfterMs(res: { headers?: { get(name: string): string | null } }): number | undefined {
  const raw = res.headers?.get("retry-after");
  if (raw === undefined || raw === null || raw.trim() === "") return undefined;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export class OAuthUsageAdapter implements UsageAdapter {
  readonly name = "oauth-usage-endpoint";
  private readonly fetchFn: FetchLike;
  private readonly userAgent: string;

  constructor(opts: OAuthUsageAdapterOptions = {}) {
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  }

  async read(account: UsageAccount): Promise<UsageReading> {
    const bearer = readBearer(account.configDir);
    if (bearer === undefined) {
      throw new Error(
        `no OAuth token in ${path.join(account.configDir, ACCOUNT_CREDENTIALS_FILE)} — `
        + "log this account in before its limits can be read",
      );
    }

    const res = await this.fetchFn(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
        "User-Agent": this.userAgent,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      // The body is often the only thing that says *why*, and this is an interface with no
      // documentation to look it up in.
      const detail = await res.text().catch(() => "");
      throw new UsageHttpError(
        `the usage endpoint answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`
        + (detail === "" ? "" : `: ${detail.slice(0, 200)}`),
        res.status,
        retryAfterMs(res),
      );
    }

    const { windows, unrecognised } = parseUsagePayload(await res.json());
    return {
      source: "endpoint",
      approximate: false,
      windows,
      // A partly-understood body is a working monitor with a piece missing, and the operator has to
      // be told which — silently showing four meters where there are five is how a limit arrives
      // without warning.
      note: unrecognised === 0
        ? null
        : `${unrecognised} field${unrecognised === 1 ? "" : "s"} in the usage endpoint's answer are `
          + "in a shape this build does not recognise and were ignored — the endpoint is "
          + "undocumented and may have changed",
    };
  }
}

// ---- the fallback: counting what is on this disk --------------------------------------------------

/**
 * The token budget each window's estimate is measured against.
 *
 * **These are assumptions, and that is exactly why every reading built on them is marked
 * `approximate`.** Anthropic publishes no subscription limit in tokens; the caps are dynamic, cache
 * tokens are weighted opaquely, and the same account used on a phone is invisible from here
 * (`docs/RESEARCH.md` §2). A denominator had to be picked for a percentage to exist at all, so it is
 * picked *here*, in one place, with its status written on it — rather than being smuggled into a
 * meter that looks like the real one.
 */
export const ESTIMATE_BUDGET_TOKENS: Readonly<Record<string, number>> = {
  five_hour: 20_000_000,
  seven_day: 140_000_000,
};

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** How many transcript files are read at most, newest first. A busy account has thousands. */
const MAX_TRANSCRIPTS = 400;

/** Every `*.jsonl` under `<configDir>/projects/`, newest first. */
function transcriptFiles(configDir: string): { file: string; mtimeMs: number }[] {
  const root = path.join(configDir, "projects");
  const out: { file: string; mtimeMs: number }[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    let names: string[];
    try { names = readdirSync(path.join(root, dir)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(root, dir, name);
      try { out.push({ file, mtimeMs: statSync(file).mtimeMs }); } catch { /* vanished under us */ }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, MAX_TRANSCRIPTS);
}

/** Tokens on one transcript line, or 0 for a line that carries no usage. */
export function tokensOfLine(line: string): { at: number; tokens: number } | null {
  let row: unknown;
  try { row = JSON.parse(line); } catch { return null; }
  if (!isRecord(row)) return null;
  const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
  if (!Number.isFinite(at)) return null;
  const message = isRecord(row.message) ? row.message : null;
  const usage = message !== null && isRecord(message.usage) ? message.usage : null;
  if (usage === null) return null;
  // Cache reads are weighted differently from fresh input and nobody has said how, so every token is
  // counted the same. One more reason this number is a guess and is labelled one.
  const fields = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
  let tokens = 0;
  for (const f of fields) {
    const v = usage[f];
    if (typeof v === "number" && Number.isFinite(v)) tokens += v;
  }
  return tokens === 0 ? null : { at, tokens };
}

/** A round, readable token count: "2.1M", "830k". */
function humanTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

export interface TranscriptEstimateOptions {
  now?: () => number;
}

/**
 * The fallback: count the tokens in this account's own transcripts.
 *
 * **It is a guess and it says so on every reading it produces.** Three things it structurally cannot
 * know, all of them named in the note it attaches: usage from any other device, when the real window
 * actually began (the 5-hour window rolls from the first prompt, not from five hours ago), and the
 * limit it is being measured against. It exists so the meters degrade to *something honest* when the
 * endpoint is gone — not so the product can pretend nothing happened.
 */
export class TranscriptEstimateAdapter implements UsageAdapter {
  readonly name = "local-transcripts";
  private readonly now: () => number;

  constructor(opts: TranscriptEstimateOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  async read(account: UsageAccount): Promise<UsageReading> {
    const now = this.now();
    let fiveHour = 0;
    let sevenDay = 0;
    let lines = 0;

    for (const { file, mtimeMs } of transcriptFiles(account.configDir)) {
      // A file untouched for longer than the widest window cannot contain a line inside it.
      if (mtimeMs < now - SEVEN_DAYS_MS) continue;
      let text: string;
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        if (line === "") continue;
        const row = tokensOfLine(line);
        if (row === null) continue;
        lines++;
        if (row.at >= now - SEVEN_DAYS_MS) sevenDay += row.tokens;
        if (row.at >= now - FIVE_HOURS_MS) fiveHour += row.tokens;
      }
    }

    const window = (key: string, label: string, tokens: number, spanMs: number): UsageWindow => ({
      key,
      label,
      utilization: Math.max(0, Math.min(100, (tokens / ESTIMATE_BUDGET_TOKENS[key]!) * 100)),
      // The window's *end* as this adapter can best place it: it does not know when the real one
      // began, so it reports the rolling one it actually measured. Marked approximate like everything
      // else here.
      resetsAt: new Date(now + spanMs).toISOString(),
      detail: `≈${humanTokens(tokens)} tokens on this machine`,
    });

    return {
      source: "estimate",
      approximate: true,
      windows: [
        window("five_hour", "5-hour (estimated)", fiveHour, FIVE_HOURS_MS),
        window("seven_day", "Weekly (estimated)", sevenDay, SEVEN_DAYS_MS),
      ],
      note: lines === 0
        ? "estimated from this machine's transcripts, and there are none for this account yet — "
          + "this is a floor, not a reading"
        : "estimated from this machine's transcripts against an assumed budget. It cannot see usage "
          + "from your other devices, it does not know when the real window began, and Anthropic "
          + "publishes no limit to measure against. Treat it as a direction, not a number.",
    };
  }
}

// ---- the second provider: what the codex CLI already recorded --------------------------------------

/**
 * Codex's limits, read out of the records its own CLI writes.
 *
 * **These are the provider's numbers, not ours.** Codex stores a `token_count` event on every turn
 * carrying a `rate_limits` object straight from the API — percentage used, window length, and when it
 * resets — in `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`. So this adapter does not ask anyone
 * anything: it reads the newest record and reports what the API last said. No network, no request to
 * be rate-limited for, and nothing estimated.
 *
 * What it costs instead is **freshness**, and that is reported rather than hidden: `readAt` is the
 * record's own timestamp, so a meter from yesterday's turn shows as a day old. Two consequences are
 * deliberate:
 *
 * - **A window whose `resets_at` has passed is dropped**, not shown. The recorded number was true
 *   before the window rolled; showing 96 % from a window that ended overnight would hold agents for
 *   a limit that no longer exists — and this reading, unlike a Claude one, cannot correct itself
 *   until the operator runs a turn.
 * - **An account that has never run a turn has no meters**, which is the truth: nothing has ever told
 *   us anything about it. It is not zero usage.
 *
 * Verified against `codex-cli 0.146.0` on 2026-08-05 — see `notes/codex-cli.md` for the captured
 * record this parser was written from.
 */
export class CodexUsageAdapter implements UsageAdapter {
  readonly name = "codex-session-records";

  constructor(private now: () => number = () => Date.now()) {}

  async read(account: UsageAccount): Promise<UsageReading> {
    const record = newestRateLimits(path.join(account.configDir, "sessions"));
    if (record === null) {
      throw new Error(
        "codex has recorded no limits for this account yet — its CLI writes them on every turn, so "
        + "one turn is all it takes",
      );
    }

    const nowSeconds = Math.floor(this.now() / 1000);
    const windows: UsageWindow[] = [];
    for (const [slot, raw] of [["primary", record.limits.primary], ["secondary", record.limits.secondary]] as const) {
      if (raw === null || raw === undefined || typeof raw.used_percent !== "number") continue;
      const resetsAt = typeof raw.resets_at === "number" ? raw.resets_at : null;
      // Rolled since it was recorded: the number is no longer about anything. Dropped rather than
      // shown, because a stale 96 % is what would hold an agent for a limit that has already lifted.
      if (resetsAt !== null && resetsAt <= nowSeconds) continue;
      windows.push({
        key: `codex_${slot}`,
        label: windowLabel(raw.window_minutes),
        utilization: raw.used_percent,
        resetsAt: resetsAt === null ? null : new Date(resetsAt * 1000).toISOString(),
        detail: null,
      });
    }

    const plan = typeof record.limits.plan_type === "string" ? record.limits.plan_type : null;
    const credits = record.limits.credits;
    const balance = credits?.balance;
    const worst = windows.reduce((most, w) => Math.max(most, w.utilization), 0);
    // A full window with credits behind it is not a stopped account — which is not a hypothetical:
    // a free plan reports 100 % and keeps working. So the percentage is *shown* and the decision is
    // taken from what the provider says about spending instead.
    const onCredits = credits?.has_credits === true;
    const blocked = record.limits.spend_control_reached === true
      || typeof record.limits.rate_limit_reached_type === "string"
      || (worst >= 100 && !onCredits);
    const notes = [
      `as recorded by codex at ${new Date(record.at * 1000).toISOString()}`,
      plan === null ? null : `plan: ${plan}`,
      balance === undefined ? null : `credits: ${balance}`,
      windows.length === 0 ? "every recorded window has since reset" : null,
      // The one line that explains a meter reading 100 % next to an agent that is still working.
      credits?.has_credits === true && windows.some((w) => w.utilization >= 100)
        ? "the plan window is full but credits are available, so this account is not held"
        : null,
    ].filter((n): n is string => n !== null);

    return {
      // The provider's own figure, not a guess of ours — the same standing as a reading from
      // Anthropic's endpoint, and marked as such so nothing downstream treats it as an estimate.
      source: "endpoint",
      approximate: false,
      windows,
      note: notes.join(" · "),
      readAt: record.at,
      blocked,
    };
  }
}

/** `window_minutes` in words. The three the CLI has been seen to use, then a general fallback. */
function windowLabel(minutes: unknown): string {
  if (minutes === 300) return "5-hour";
  if (minutes === 10080) return "weekly";
  if (minutes === 43200) return "monthly";
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) return "window";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

interface CodexRateLimits {
  primary?: { used_percent?: number; window_minutes?: unknown; resets_at?: number } | null;
  secondary?: { used_percent?: number; window_minutes?: unknown; resets_at?: number } | null;
  plan_type?: unknown;
  credits?: { balance?: string; has_credits?: boolean; unlimited?: boolean } | null;
  /** The provider refusing to spend more, whatever the windows say. */
  spend_control_reached?: boolean | null;
  /** Non-null when a limit has actually been hit, in the CLI's own words. */
  rate_limit_reached_type?: unknown;
}

/**
 * The newest `rate_limits` any recent session file holds, with the moment it was written.
 *
 * Newest-first by mtime and **only the few newest files**: a busy machine has hundreds of session
 * records, and reading all of them to answer a meter would make opening a popover an I/O event.
 * Every failure — no directory, an unreadable file, a line that will not parse — is a `null` or a
 * skip rather than a throw, because a broken record is not a broken account.
 */
function newestRateLimits(sessionsDir: string): { at: number; limits: CodexRateLimits } | null {
  let files: string[];
  try { files = jsonlFilesByNewest(sessionsDir).slice(0, 5); }
  catch { return null; }

  for (const file of files) {
    let lines: string[];
    try { lines = readFileSync(file, "utf8").split("\n"); }
    catch { continue; }
    // From the end: the last record in a file is the newest thing that file knows.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes('"rate_limits"')) continue;
      try {
        const parsed = JSON.parse(line) as {
          timestamp?: string;
          payload?: { rate_limits?: CodexRateLimits };
        };
        const limits = parsed.payload?.rate_limits;
        if (limits === undefined || limits === null) continue;
        const at = parsed.timestamp === undefined ? NaN : Math.floor(Date.parse(parsed.timestamp) / 1000);
        return { at: Number.isFinite(at) ? at : Math.floor(statSync(file).mtimeMs / 1000), limits };
      } catch { /* a half-written line at the end of a live file is normal */ }
    }
  }
  return null;
}

/** Every `*.jsonl` under a directory tree, newest first. */
function jsonlFilesByNewest(dir: string): string[] {
  const found: { file: string; mtime: number }[] = [];
  const walk = (at: string, depth: number): void => {
    if (depth > 4) return;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith(".jsonl")) {
        try { found.push({ file: full, mtime: statSync(full).mtimeMs }); } catch { /* gone */ }
      }
    }
  };
  walk(dir, 0);
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.file);
}
