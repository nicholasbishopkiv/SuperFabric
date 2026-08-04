# 0002 — The factory's own bus tools are never gated

Date: 2026-08-03 · Status: accepted

## Context

M3a gives every agent in a room an in-process MCP server (`src/busTools.ts`) carrying four
tools: `factory_send`, `factory_inbox`, `factory_task_update`, `factory_report_status`. The
model sees them namespaced, as `mcp__factory__*`.

`ClaudeCodeExecutor` wires `canUseTool` in **every** autonomy mode, deliberately: `attended`
needs it for every gated call, and in `auto`/`bypass` a classifier-escalated call must still be
able to reach the operator. That is the right default for tools that touch the world — and it
was, until M3a, the only kind of tool an agent had.

It is the wrong default for the bus. With it in place:

- An `attended` agent that answers another department raises an approval card for
  *"tell the payments room I need a webhook"*. That is not a decision an operator can meaningfully
  make; it is noise in front of the decisions that matter.
- Worse, it deadlocks. An inter-room request is delivered as an injected turn; if the recipient's
  reply needs a card and the operator is away, the sender waits on an answer that cannot be sent.
  The factory stops working the moment nobody is watching it — the opposite of what the bus is for.
- The card is also mis-titled by construction: the operator is being asked to authorise the
  factory's own plumbing, not an effect on their machine.

## Decision

**Tool calls belonging to our own in-process MCP servers are allowed without consulting the
operator, in every autonomy mode. Everything else keeps going through `requestApproval` exactly as
it did.**

"Our own" is derived, not hard-coded: `inProcessToolPrefixes()` reads the `mcpServers` record this
session was actually started with and takes the `type: "sdk"` entries — servers whose code runs in
this process because we wrote it. For a room's session that yields exactly one prefix,
`mcp__factory__`. A `stdio`/`sse`/`http` MCP server is a third party reaching outside the process
and stays gated like any other outside-facing tool, and a roomless session (which gets no bus at
all) has no ungated prefix whatsoever.

**Not asked about is not the same as not visible.** The ungated call still appends a `tool_use`
event, so the transcript and the event log show it next to everything else the agent did. No new
event type: `tool_use` is already the record of "this tool ran", and the call is recorded exactly
once whichever path observes it first (the permission callback, or the assistant message's
`tool_use` block — they are de-duplicated by the tool-use id).

## What stays gated

Everything with an effect outside the factory's own state:

- `Bash`, `Write`, `Edit`, `NotebookEdit` and every other CLI-native tool.
- `WebFetch` / `WebSearch` and anything else that reaches the network.
- Any MCP server that is not one of ours in-process — including one an operator adds to a room's
  own project settings.

The three autonomy modes are unchanged in what they mean for those: `attended` raises a card on
every gated call, `auto` lets the CLI's classifier decide, `bypass` gates nothing at all.

## Consequences

**Accepted:**
- An agent can message another department, move a task on the board and report its status without
  the operator's involvement. That is the intended behaviour: those are effects *inside* the
  factory, and the operator's view of them is the event log and the task board, not a modal.
- A prompt-injected agent can therefore send bus messages and update tasks unattended. The blast
  radius is bounded by what the tools can do: the sending room is taken from the session row and
  never from tool input (an agent cannot speak *as* another department), a message is text
  delivered to another agent, and a task update changes a row the operator can see and undo. It
  cannot write files, run commands or reach the network without a card.
- The gate is now derived from the session's own server list, so adding a second in-process server
  later silently makes it ungated too. That is the intended rule, but it is a rule to remember
  when adding one: an in-process MCP server is by definition trusted code, and anything that is
  not should not be one.

**Rejected: an allow-list of the four tool names.** It would have to be kept in step with
`busTools.ts` by hand, and the interesting property is not "these four names" but "code we run in
this process".

**Rejected: gating only `factory_send`.** Sending is the one that reaches another agent, so it
looks like the risky one — but it is also the one whose card deadlocks the factory, and the other
three are then gated for no reason at all.
