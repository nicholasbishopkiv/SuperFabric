# M2 — Multi-account and the limit monitor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Two or three Claude subscriptions run agents in parallel. Each account's real 5-hour and weekly utilisation is on screen with its reset time. Agents are warned before a limit, paused at it, and resumed automatically when the window rolls — without the operator being present.

**Architecture:** An account is a `CLAUDE_CONFIG_DIR` on disk plus a row. `ClaudeCodeExecutor` already knows how to point a session at one (`Options.env` with `process.env` spread — the mechanism is built and tested). `LimitMonitor` polls the undocumented OAuth usage endpoint per account behind an adapter, with a JSONL-estimation fallback. A `Scheduler` turns utilisation into actions: warn, pause, resume.

**Tech Stack:** unchanged. Server = Bun; web = Vite + shadcn; zod in shared.

**Conventions:** server tests `bun test`, web/shared vitest, installs pnpm. **Never set `SUPERFABRIC_LIVE_TEST=1`; never prompt a real agent** except where a task says so. Commit per task.

---

### Task 0: Fix three defects found in the M3b live run

Do these first — they are real and small.

- [ ] **`factory_record_decision` fails on large inputs.** The model's tool-input serialisation broke around 3 kB while our schema allows 8000 chars per field. Reproduce, then fix at the tool boundary: tighten the tool *description* to ask for a concise record, and make the handler tolerant (accept and truncate with a marker rather than rejecting, or accept a continuation). State which you chose. Test with a 4 kB context field.
- [ ] **A prompt sent during a session restart is silently dropped.** `setAutonomy`/`setModel` restart the executor asynchronously; a `prompt` landing in that window vanishes with no event and no error. Either queue it and deliver after the restart, or reject it with an `error` the UI shows. Queueing is better if it is honest — a dropped instruction is the worst outcome. Test the race explicitly.
- [ ] **Factory agents inherit the operator's personal MCP servers.** `settingSources: ["project","local"]` drops user *settings*, but the operator's `~/.claude` MCP servers still reach the agent (obsidian, figma, computer-control were observed in a factory agent's tool list). Decide and implement: the factory should give an agent the servers its room configures, not whatever the operator happens to run. Verify against the SDK notes how MCP servers are sourced, and if this cannot be closed from our side, say so plainly and record it as a known limitation with M4 as the real fix.

### Task 1: Accounts

- [ ] Migration: `accounts(id, label, config_dir, created_at, last_used_at)`; `sessions.account_id` (nullable — a session with none uses the ambient `~/.claude`, which is today's behaviour).
- [ ] `AccountManager`: `create({label, configDir})` (must be an absolute path; create the directory if absent), `list()`, `remove(id)` (refuse while sessions reference it), `credentialsPresent(id)` (does `<configDir>/.credentials.json` exist — that is how we know a login finished).
- [ ] Thread `configDir` per session: add it to `ExecutorStartOptions` (the executor already handles the env spread — do **not** re-derive that logic), persist `account_id` on the session, re-apply on resume. Rooms get a default account; an agent may override.
- [ ] **Never share one config dir between two accounts.** Refuse a duplicate `config_dir` — refresh tokens rewrite in place and two accounts on one directory corrupt each other. Test it.
- [ ] Protocol + UI: list accounts, create one, bind a room/agent to one, show which account each agent runs on.

### Task 2: Login — verify the mechanism before building UI on it

**Probe first, exactly like the Bun adoption did.** The intended flow is an embedded terminal (xterm.js in the browser ↔ a PTY on the server) running `claude` against a fresh profile dir. **`node-pty` is a native module and native modules do not work under Bun** (that is why `better-sqlite3` was replaced). Establish the truth before committing to a design:

- [ ] Does a PTY work under Bun at all (`node-pty`, or Bun's own spawn with a tty, or a `script`/`unbuffer` wrapper)? Report what you find.
- [ ] If a PTY is unavailable: the fallback is `claude setup-token`, the documented CI path producing a long-lived `CLAUDE_CODE_OAUTH_TOKEN`. It may be non-interactive enough to drive without a PTY. Try it against a throwaway config dir and report.
- [ ] Whatever works, build **that** — and if neither does, the honest answer is an out-of-band flow: the UI shows the exact command for the operator to run in their own terminal, watches the config dir, and lights up when `.credentials.json` appears. That is a legitimate product answer for a self-hosted tool; do not fake a terminal that does not work.

### Task 3: LimitMonitor

- [ ] Adapter interface with two implementations. Primary: `GET https://api.anthropic.com/api/oauth/usage` with the bearer from that account's `.credentials.json`, header `anthropic-beta: oauth-2025-04-20`, a `claude-code/<version>` User-Agent, polled no faster than ~180 s. Returns `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, each with `utilization` (0–100) and `resets_at`. **This endpoint is undocumented and may change** — the adapter exists so that is survivable.
- [ ] Fallback: estimate from the account's local JSONL transcripts (ccusage-style). Mark such readings **approximate** on the wire and in the UI — an estimate presented as fact is worse than an honest gap.
- [ ] Persist snapshots (`usage_snapshots`) so the UI has history and a restart does not blank the meters.
- [ ] Also treat a 429 / limit error from any session as a signal that account is at its limit, even if the poller has not caught up.
- [ ] Tests: parse a recorded fixture of each shape; a failing endpoint falls back and marks approximate; polling respects the interval; a 429 marks the account limited.

### Task 4: Scheduler

- [ ] At **80 %** of any window: inject a short system-style turn telling that account's agents a limit is near, so they can wrap up rather than be cut mid-thought.
- [ ] At **95 %**: pause that account's sessions — interrupt at a turn boundary, persist state, and surface a countdown to `resets_at`.
- [ ] At `resets_at`: resume automatically via `options.resume`, and tell the agents they were paused and may continue.
- [ ] Tests with a fake clock: each threshold fires once, not per poll; a pause is idempotent; resume restores exactly the sessions that were paused, and only when the window has actually rolled.

### Task 5: UI

- [ ] Per-account meters (5 h, weekly, per-model where present) with reset times, in the HUD without a fourth edge panel — a popover from the account switcher is enough. Approximate readings visibly marked.
- [ ] Paused agents read as paused on the floor (the palette already has a `paused` status).
- [ ] Binding a room or an agent to an account.

### Task 6: Acceptance

- [ ] Two accounts configured; agents in different rooms on different accounts; confirm from each session's recorded `env` that they genuinely used different config dirs.
- [ ] Meters show real numbers for both.
- [ ] Force the thresholds with a stubbed adapter (do **not** burn a real limit): warn, pause, and auto-resume all observed end to end.

---

## Self-review notes

- **Covers** the last headline feature in the vision: several subscriptions, honest limit visibility, and unattended pause/resume.
- **The ToS line stands**: this monitors and paces the operator's *own* accounts. No pooling, no rotation to evade a limit. Do not add "switch to the other account when this one runs out" — that is the thing we deliberately do not build.
- **Biggest risk** is Task 2 (login) and it is front-loaded as a probe rather than an assumption.
- **Second risk** is the undocumented endpoint; the adapter plus an honestly-labelled fallback is the mitigation.
