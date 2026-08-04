# `codex` CLI — what was measured

Verified by running `codex-cli 0.146.0` on 2026-08-05. **Trust this over memory**, the same way
`agent-sdk-api.md` is trusted for the Agent SDK: everything below was observed, not read about.

Two probe turns were spent doing it (a "say ok" and a "run echo"); the captured JSONL is in
`test/codexExecutor.test.ts` as `CAPTURED`, so a change in the CLI's output fails a test rather than
an operator's console.

## The shape of a session

`codex exec` is **one process per turn**. There is no long-lived streaming session as there is with
the Agent SDK's `query()`. A conversation is carried by a **thread id**:

```
codex exec --skip-git-repo-check --sandbox workspace-write -C <cwd> --json -                    # first turn
codex exec --skip-git-repo-check --sandbox workspace-write -C <cwd> resume <thread-id> --json - # after
```

`-` means "read the prompt from stdin", which is what `CodexExecutor` uses — a turn can be a whole
file's worth of text and argv length is an operating-system limit. **The stream must be closed**: a
process whose stdin stays open waits for the rest of the sentence forever. (This was a real bug for
about ten minutes; the tests now catch it.)

### Every flag goes **before** the subcommand

`codex exec resume` accepts a *narrower* option set than `codex exec` — `--sandbox` and `-C` are
refused outright:

```
$ codex exec resume <id> --json --sandbox workspace-write -
error: unexpected argument '--sandbox' found
```

So the working form puts them on `exec`:

```
codex exec --skip-git-repo-check --sandbox workspace-write -C <cwd> resume <thread-id> --json -
```

Measured the hard way: the first version of `CodexExecutor` put them after, every *first* turn
worked, and every *second* turn of every session died. `codexExecutor.test.ts` asserts the order.

## The event stream (`--json`)

JSONL on stdout, one object per line. What two probes produced, verbatim:

```json
{"type":"thread.started","thread_id":"019fce97-eca9-7be3-8535-fded2d83c455"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll run it."}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/usr/bin/bash -c 'echo hello'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"…","aggregated_output":"hello\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"done"}}
{"type":"turn.completed","usage":{"input_tokens":23644,"cached_input_tokens":16128,"cache_write_input_tokens":0,"output_tokens":92,"reasoning_output_tokens":16}}
```

Mapped to `SessionEvent` by `codexEvents()`:

| codex | SuperFabric |
|---|---|
| `thread.started` | not an event — the id is stored as `sessions.claude_session_id` |
| `turn.started` | `session_status: working` |
| `item.started` (`command_execution`) | `tool_use` (`toolName: "shell"`) |
| `item.completed` (`command_execution`) | `tool_result` (`isError` from `exit_code`) |
| `item.completed` (`agent_message`) | `agent_text` |
| `turn.completed` | `turn_complete` **with no `costUsd`**, then `session_status: idle` |
| `turn.failed` / `error` | `session_error`, then `session_status: idle` |

Two things whose obvious reading is wrong:

- **`turn.completed.usage` is tokens, not money.** There is no cost figure anywhere in the stream.
  `turn_complete.costUsd` is therefore absent for every Codex turn, and the cost rollup simply does
  not count them — inventing a figure would mean a pricing table, which this product does not have
  and must not grow (see `CostRollup` in the protocol).
- **Not every stdout line is JSON.** `Reading additional input from stdin...` and
  `Shell cwd was reset to …` are printed as plain text. A line that will not parse is logged, never
  turned into a `session_error`: a chatty CLI must not look like a failing one.

## Autonomy has no equivalent, so it becomes the sandbox

`codex exec` is non-interactive — there is no channel to ask an operator mid-turn, so SuperFabric's
approval cards cannot exist for this provider. `sandboxFor()` translates instead:

| autonomy | flag | what it means |
|---|---|---|
| `attended` | `--sandbox read-only` | cannot write or reach the network. An agent that cannot ask permission must not be able to take it. |
| `auto` | `--sandbox workspace-write` | may write in its room and run commands; network closed |
| `bypass` | `--dangerously-bypass-approvals-and-sandbox` | no sandbox at all |

The agent's own log says which of these it got, in words, at the start of the session.

## The account is `CODEX_HOME`

Exactly what `CLAUDE_CONFIG_DIR` is to Claude Code — which is why `ExecutorStartOptions.configDir` is
documented as a *directory* rather than as an account id. `~/.codex/auth.json` is the login marker
(`"auth_mode": "chatgpt"` for a subscription login), and `toolchain.ts` uses it to report whether
this CLI is signed in.

## Limits: codex records them, so nothing has to ask

Every turn writes an `event_msg` / `token_count` line into
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` carrying the API's own rate limits:

```json
{"timestamp":"2026-08-04T21:21:21.057Z","type":"event_msg","payload":{"type":"token_count",
 "info":{…},
 "rate_limits":{"limit_id":"codex","primary":{"used_percent":100.0,"window_minutes":43200,"resets_at":1788198101},
  "secondary":null,"credits":{"has_credits":true,"unlimited":false,"balance":"3918.36"},
  "plan_type":"free","spend_control_reached":null,"rate_limit_reached_type":null}}}
```

`CodexUsageAdapter` reads the newest few files and takes the last such line. Three things it does
with what it finds, each of which would be a bug the other way round:

- **`readAt` is the record's timestamp**, not the moment we read it. This meter is only as fresh as
  the operator's last turn, and it says so.
- **A window whose `resets_at` has passed is dropped.** The number was true before the window rolled;
  showing it would hold agents for a limit that has already lifted, and this reading cannot correct
  itself until another turn runs.
- **`used_percent: 100` is not "stopped".** A free plan reports exactly that while working on
  credits, so `UsageReading.blocked` comes from `spend_control_reached` / `rate_limit_reached_type` /
  a full window with no credits — never from the percentage alone. The meter still shows 100 %.

`window_minutes` seen so far: `300` (5-hour), `10080` (weekly), `43200` (monthly).

## What was looked at and not used

- `codex mcp-server` — runs codex *as* an MCP server (the other direction from what we need).
- `codex app-server` / `exec-server` — marked experimental in `--help`; a long-lived protocol server
  would be the way to get a streaming session and possibly approvals, and is the obvious next step if
  one-process-per-turn ever becomes a limitation.
- `codex mcp add` — how a Codex agent could be given the factory bus. It needs the bus as a *process*
  speaking MCP over stdio, and today `busTools` is an in-process object the Agent SDK takes directly.
  That bridge is not built, so a Codex agent cannot message other rooms; the picker says so.
