# SuperFabric — Roadmap

> 🇷🇺 Русский оригинал: [ROADMAP.ru.md](ROADMAP.ru.md)

The project is too large for a single spec, so it is split into milestones. Each
milestone is a self-contained sub-project with its own "spec → plan → implementation"
cycle and a **working result at the end**. The order is chosen to burn down the biggest
risks first.

**All of M0–M5 are complete as of 2026-08-04.** Each section keeps the acceptance evidence
for that milestone as it was recorded at the time, including the test counts of that day —
those are deliberately not rewritten, because a milestone's record is a record. The current
count is at the end of M5. **[What is not built](#what-is-not-built) is at the bottom, and it
is the section to read before assuming a feature exists.**

## M0 — Core: one server-managed session ✅ **complete** (2026-08-03)

Removes the main technical risk: a steerable long-lived session.

- [x] pnpm monorepo: `server`, `web`, `shared`.
- [x] SessionManager on the Agent SDK (streaming input): start, event streaming,
      interrupt, graceful stop, resume after a server restart.
- [x] SQLite event log + WebSocket replay-then-tail with per-session `afterSeq`.
- [x] Minimal web UI: chat with an agent, approval cards (`canUseTool`), connection
      state, interrupt.
- [x] Single account (the current `~/.claude`).

**Acceptance run**: an agent was told a secret word, the server was SIGTERM'd
mid-session, restarted (`resumed sessions: …`), the browser client replayed the
transcript from the event log, and the agent answered the secret word correctly
afterwards — conversation context genuinely survived the restart. Event `seq` values were
contiguous. 44 tests green (+1 live-quota test, run manually).

## M1 — The floor: 3D factory, project block, rooms ✅ **complete**

**M1a is complete (2026-08-03)** — rooms as folders and the 3D floor:

- [x] 3D scene (react-three-fiber, isometric orthographic camera, low-poly): the project
      block as headquarters, workshop buildings on a ring, a bounded concrete shell,
      conveyor belts that enter loading bays, animated package meshes, status beacons and
      agent figures with hard hats and status vests.
- [x] Rooms are folders: creating one makes `<root>/<name>/` with a `CLAUDE.md` charter,
      and an agent in that room runs with the room's folder as its cwd.
- [x] 2D overlay: room panel (create, select, per-room agents, per-agent autonomy,
      unassigned sessions) and the M0 console as a collapsible drawer.
- [x] Live status: `SessionInfo` carries a server-derived `status` and `blocked`, broadcast
      to every client with a 250 ms debounce, so the floor is correct after a reload
      without replaying transcripts.
- [x] Drag a building to move its room; the position persists. Camera frames the factory
      into the strip the HUD panels leave uncovered, and yields to manual pan/zoom.
- [x] `frameloop="demand"`: an idle factory does zero `requestAnimationFrame` calls.

Still open for M1:

- [x] Task panel with manual task entry — delivered with M3a (auto-routing still needs the
      orchestrator, so a task with no room stays unassigned and the board says so).
- [x] Roles library v1: ~10 presets (role = prompt + skills/superpowers + plugins/MCP + model) —
      delivered with M1c below.
- [x] Onboarding agent for an empty project (interview → CLAUDE.md / README) — delivered with M1c
      below.

## M1b — Projects, folders, files and a real UI ✅ **complete** (2026-08-04)

Four capabilities the operator asked for once the floor existed. They are grouped because
they all reshape the same surface: what the browser is looking at, and how a human puts
things into it.

- [x] **Multiple projects, one SuperFabric.** Pick the project folder in the UI and switch
      between projects; each is its own factory floor with its own rooms, agents, tasks,
      messages and history. Everything scoped by `project_id` in one database (migration 5,
      which backfills an existing `.fabrica/fabrica.db` into a one-project world), so a switch
      is instant and does not restart the server. `SUPERFABRIC_PROJECT` becomes the default
      for the first project, not the only one there can be. The active project is **per
      socket**, so a second tab on another factory sees none of this one's traffic.
- [x] **Per-room working folder.** A room defaults to `<project>/<name>/`, but the folder is
      settable: a department may live in a separate repository. Adopting an existing folder
      must never overwrite its `CLAUDE.md` (the invariant already holds — keep it).
- [x] **Files in, paths out.** Paste from the clipboard, drop onto the window, or upload.
      The file is written into `<project or room folder>/attachments/` and the agent
      receives **the path**, not the bytes — a colleague handed a file on disk. Images
      pasted from the clipboard get a sensible generated name and extension. Transport is
      `POST /attachments` (multipart), behind the *same* origin allow-list as the WebSocket;
      the saved paths are staged as chips in the composer and folded into the turn text when
      the operator sends. A new `notice` server message says where each file landed.
- [x] **A real UI.** The HUD is rebuilt on Tailwind v4 and Radix primitives vendored into
      `packages/web/src/ui/`, in one pass, so it is consistent rather than half-migrated.
      Choice and reasoning: `docs/decisions/0003-ui-library.md`. Dark, translucent and
      blurred over the floor; every colour that *means* something is read from
      `scene/palette.ts` through `hud/tokens.ts`, so a room's dot in a panel and its beacon
      on the roof cannot disagree. `hud/theme.ts` is gone.

**Acceptance run for the first two (2026-08-04, no agent prompted)**: two projects in one server
— `factory-a` (three rooms) and `Factory B` (two) — each with a room of the same name in the
database, its own board and its own queued bus message. Switching in the HUD re-framed the camera
and redrew the floor with only that project's buildings, board and belts; a room created in one
tab's factory never appeared in a second tab watching the other. A room created with an explicit
folder outside the project root adopted an existing repository without touching its `CLAUDE.md`,
and the agent started there recorded that folder as its `cwd`. Re-pointing that room left the
running agent's `cwd` alone across a server restart, which is what the panel warns about.
539 tests green (shared 39, server 297 + 1 skipped live-quota test, web 203).

**Acceptance run for attachments (2026-08-04, no agent prompted)**: dropping a file on the window
raised the drop target, saved it to `<project>/attachments/`, staged a chip and produced the green
notice carrying the absolute path; the explicit `📎 Attach` input did the same; a paste carrying an
image blob with no filename landed as `pasted-2026-08-03T23-23-08-592Z.png`. With a room selected
the next attachment went into that room's folder, and after re-pointing the room *outside* the
project root it went there instead — the notice for that re-point is now a `notice`, not an
`error`. Sending composed the turn as `have a look at this crash\n\nAttached file: …/bug-report.png`
and the event log recorded exactly that (read from the log; the executor was the FakeExecutor, so
no quota was spent and no real agent was prompted). A send with attachments and no text was
accepted. `curl` against the running server: a disallowed `Origin` got 403 with nothing written, a
non-browser request with no `Origin` was accepted, a 30 MB file got 413, and a repeated name
uniquified to `uploaded-spec-2.md`. 637 tests green (shared 46, server 360 + 1 skipped live-quota
test, web 231).

**Acceptance run for the shadcn/ui rebuild (2026-08-04, no agent prompted)**: a throwaway factory
of six rooms, six agents, nine tasks and two bus messages, seeded over the socket and — for the
agents, the transcript, the pending approval and the queued message — straight into the throwaway
database, because `create_session` would spawn a real CLI. The whole HUD is dark, translucent and
blurred over the floor; the room list's status dots, the approval card's amber, the `ungated`
magenta and the selection cyan are the same constants the beacons and figures read. All three
panels collapse with the same chevron-on-the-inner-edge control and keep reporting their size
(320/520/261 px open, 81/81/42 collapsed, restored exactly on re-open), so the camera re-frames
into the strip that is actually free. Radix's select and popover portal cleanly over the WebGL
canvas. `elementFromPoint` over the floor, over the free top row and in the gap beside the board
still hits the canvas, and a synthesised drag panned the camera. `requestAnimationFrame` fired 0
times in 3 s with every agent idle — the demand frameloop is intact. Bundle: 1,260 kB → 1,402 kB of
JS plus 33 kB of CSS (gzip 355 → 409 kB). 637 tests green (shared 46, server 360 + 1 skipped
live-quota test, web 231) — unchanged and untouched, since the web suite is store and pure-logic
tests.

## M1c — The roles library and the onboarding agent ✅ **complete** (2026-08-04)

The two things that make the factory usable by someone who does not know Claude Code's configuration
surface: pick "architect" and the agent arrives already configured, or point the factory at an
undocumented folder and an agent interviews you about it.

- [x] **A role is a file, not a row** (`roleLibrary.ts`, `RoleSpec` in the protocol): `roles/*.yaml`
      at the repo root, `<data dir>/roles/*.yaml` overriding by `id`, an edited file picked up
      without a restart, and a malformed one **reported next to the list** rather than dropped from
      it. `RoleSpec` is `.strict()`, so `skill:` for `skills:` fails the file by name instead of
      silently shipping a preset whose whole point never arrives.
- [x] **Ten presets worth shipping** — architect, backend, data, designer, devops, frontend,
      generalist, qa, security, tech-writer. Each 550–750 characters, each stating a boundary
      ("You do not implement", "Do not fix the code you are testing"), Opus reserved for the two
      roles whose mistakes are expensive to reverse, and **no invented skill names**:
      `shippedRoles.test.ts` holds a verified list and adding a reference means adding an entry.
- [x] **Applying a role** (`sessionManager.ts`, migration 12): `sessions.role_id` is the fourth
      member of the `autonomy`/`model`/`account_id` family — persisted, re-applied on resume,
      changed by restarting the executor. An explicit operator model always beats the preset's; the
      factory bus can never be unplugged by a role's `mcpServers`; skills are copied into
      `<room>/.claude/skills/` and a directory already there is never touched.
- [x] **Detection is a file**: a project is un-onboarded when there is no `CLAUDE.md` at its root
      (`PROJECT_CHARTER_FILE`). No folder-contents heuristic — a guess would offer to interview
      someone about a repository they documented last year.
- [x] **The onboarder is an ordinary session with a role and a one-shot job** (`onboarding.ts`),
      exactly as the orchestrator is: `roles/onboarding.yaml` carries the charter (which says
      **one question per turn** in as many words), `start_onboarding` creates the session in the
      project room and sends it one turn. It writes `CLAUDE.md` and `README.md` with its own file
      tools — there is no special write path.
- [x] **The rooms are a proposal** (migration 13, `factory_suggest_rooms`): the tool records a list
      and creates nothing; the UI shows an accept/edit list; approving calls the ordinary
      `RoomManager.createRoom`, so name safety, containment and never-overwriting-a-charter hold
      because it is the same code path. One refused name does not sink the rest.
- [x] **UI**: the role picker (`RoleSelect.tsx`) on the room panel's "New agents arrive as" line and
      on every agent row; `Onboarding.tsx` over the floor, prominent only while the project is
      un-onboarded, plus the proposal list, which outranks everything because the interview writes
      the docs *before* it proposes rooms.

**Acceptance run (live, one interview, 8 agent turns, $0.44 total)**: a throwaway server on port
4733 pointed at an empty folder called `expense-tracker`. The floor showed one card — "This project
has no `CLAUDE.md`" — and "Start onboarding" produced an agent in the project room that asked, one
per turn and waiting each time:

1. "Empty folder, so we're starting from scratch. What is expense-tracker for — who's going to use
   it, and what's the core problem it solves for them?"
2. "What's it built with, or are you deciding that with me now — any language/framework/database
   preference, or a blank slate?"
3. "How do you want to run and test it day to day — e.g. `uvicorn` + `pytest` locally, a
   docker-compose file, any CI, and does the SQLite data live in a mounted volume?"
4. "Since it's shared between two people, is there any login/auth, or is it just open on the local
   network with no accounts at all?"
5. "What does the core workflow look like — are you two manually entering each expense, or
   importing CSV exports from the bank, and do you need to split/categorize by person?"
6. "Good. Any conventions or constraints you want enforced — style/linting tools (ruff, black,
   mypy), commit message style, or anything you explicitly don't want (no ORM, no migrations
   framework, etc.)?"
7. "Last one — what's the near-term roadmap? E.g. is CSV import for both banks working yet, or is
   this all still to be built from nothing?"

Answered honestly about a small imaginary household expense tracker (two people, home server, Python
+ FastAPI + SQLite + htmx, no login, ruff, no ORM, no JS build step). It then wrote both files
without being asked again. `CLAUDE.md` opened with a **Status** section nobody requested and which is
the most valuable thing in it — "The folder is empty as of 2026-08-04. Nothing has been built yet.
This file describes the plan agreed with the operator, not existing code." — followed by what it
does, the roadmap as a numbered list, the stack, "Running it" (`uvicorn app.main:app --reload`,
`pytest`, the compose file, `/data/expenses.db`, "No CI. No accounts/login — runs open on the home
LAN only"), and "Conventions and constraints" ("No ORM — plain SQL via `sqlite3`. Schema changes are
numbered `.sql` files applied on startup (no migration framework).", "No JavaScript build step,
ever."). `README.md` was the same project for a person, opening "Built because bank statements are
unreadable and it's hard to tell where the money went each month." **Nothing in either file was
invented**: every line traces to an answer.

Then five rooms, proposed and not created: `import` ("CSV import parsers for each bank's column
layout, plus manual cash entry"), `categorization` ("Keyword-based auto-categorization rules and
manual override handling"), `reporting` ("Monthly summary views, per-person split, recurring-payment
detection, and category budgets"), `storage` ("SQLite schema as numbered .sql files, plain SQL data
access, no ORM"), `app-shell` ("FastAPI app wiring, htmx server-rendered pages, Docker/compose
packaging for the home server"). They match what was described — named after the work rather than
the technology, and the split is one a person would defend. Approving all five created five folders,
each with the proposed line as the first thing in its charter, and the surface disappeared.

**Two honest findings from that run.** The agent's first `factory_suggest_rooms` call used
capitalised names (`Import`, `Categorization`); the MCP layer refused it against `RoomName` and it
retried correctly with lowercase in the same turn — self-corrected, but a tool description that said
"lowercase" in the schema's `describe` only, not in the tool's own text, cost a round trip. And the
"onboarding is under way" strip stayed on the floor after the interview finished, because an
onboarding session stays `active` forever; the surface now keys off the file instead, so it vanishes
the moment `CLAUDE.md` exists. 1,062 tests green (shared 79, server 701 + 1 skipped live-quota test,
web 282) — 1,030 before this milestone.

## M2 — Multi-account and the limit monitor ✅ **complete** (2026-08-04)

- [x] `AccountManager` (`accountManager.ts`): an account is a `CLAUDE_CONFIG_DIR` plus a row
      (migration 9). **Machine-wide, not per project** — a subscription is the operator's and serves
      every floor; the per-project choice is the binding. **One directory is one account**, refused
      by `create` *and* by a UNIQUE column, with the path canonicalised through `realpath` first so
      `/a/b`, `/a/b/` and a symlink are the one directory they are.
- [x] Per-session config dirs: `ExecutorStartOptions.configDir`, `sessions.account_id` resolved once
      at creation (explicit choice, else the room's default) and re-applied on resume;
      `set_session_account` restarts the executor exactly as `set_model` does, because
      `Options.env` is fixed for the lifetime of a `query()`. A session with no account uses the
      ambient `~/.claude`, unchanged.
- [x] Login, **and it is not the terminal the plan expected**. Probing found `claude auth login`
      needs no TTY at all: over plain pipes it prints its OAuth URL and reads the code from stdin.
      So the flow is a link and a text box, not an xterm — no `node-pty`, no `node-gyp`, no new
      dependency. `CredentialsWatcher` lights an account up when `.credentials.json` appears, which
      also covers an operator who logs in from their own terminal. Full probe results and the two
      rejected alternatives: `docs/decisions/0004-account-login-over-a-pipe.md`.
- [x] Protocol + UI: an account switcher beside the project switcher (a popover, not a fourth edge
      panel), the room's default account, and which account each agent runs on.
- [x] `LimitMonitor` (`limitMonitor.ts`) behind an adapter seam (`usageAdapters.ts`). The primary
      reads `GET https://api.anthropic.com/api/oauth/usage` with that account's bearer from
      `.credentials.json`, `anthropic-beta: oauth-2025-04-20` and a `claude-code/<version>`
      User-Agent, **no faster than 180 s per account** — the research's floor, because a monitor
      that earns a 429 causes the thing it watches for. Readings are persisted
      (`usage_snapshots`, migration 10) so a restart does not blank the meters, and a 429 from any
      live session marks that account immediately rather than waiting for the poller.
- [x] **The endpoint had already moved, and the adapter absorbed it.** Verified live on 2026-08-04:
      `seven_day_opus`/`seven_day_sonnet` are now *present and null*, and the per-model weekly
      figures live in a `limits[]` array of `{kind, group, percent, severity, resets_at, scope}`.
      Both shapes are recorded as fixtures and both parse; a body we only half recognise yields the
      meters we could read plus a note saying how many fields we could not.
- [x] Fallback: an estimate counted from the account's own JSONL transcripts, **marked approximate
      everywhere** — hatched bars, an "estimate" badge, a `≈` on every figure, and a note naming the
      three things it structurally cannot know. The scheduler will warn on one and will never pause
      on one.
- [x] `LimitScheduler` (`scheduler.ts`): warn at 80 % with a short system-style turn to that
      account's agents, pause at 95 % **at the next turn boundary** (persisted via
      `sessions.state='paused'` + `paused_at`/`paused_until`, migration 11), resume at `resets_at`
      through `options.resume` and tell the agent what happened to it. Each threshold fires once per
      window instance, not per poll.
- [x] UI: per-account meters in the accounts popover with countdowns and the warn/pause lines drawn
      from the server's own constants; `paused` as the fifth `FactoryStatus` on the floor, with a
      countdown on the agent's row.

**Done when**: 2+ accounts run in parallel; limit pause/resume needs no human. ✅

**Acceptance**:

- Two accounts on two throwaway config dirs, a room bound to each, agents inheriting them — asserted
  from the real executor's recorded `Options` (each `CLAUDE_CONFIG_DIR` its own, `PATH` and `HOME`
  intact) in `test/accountIsolation.test.ts` and `test/m2Acceptance.test.ts`, and confirmed in a live
  browser run where the spawned CLI wrote its `.claude.json` and `sessions/` into the bound account's
  folder rather than into `~/.claude`.
- **Real meters**: a browser run on throwaway ports with the operator's own `~/.claude` added as an
  account showed 5-hour 49 %, Weekly 88 % and a per-model weekly window at 100 %, each with its reset
  countdown — read from the live endpoint. A second account with a deliberately invalid token showed
  the fallback beside it: hatched bars, `≈34 %`, and the 401 quoted verbatim above the caveat. Two
  polls were taken 180 s apart, exactly the floor.
- **The thresholds were forced with a stubbed adapter on a fake clock — no real limit was
  approached.** 84 % produced one warning turn into the Alpha agent and none into Beta's; 97 % while
  mid-turn armed the pause and left the turn running; the pause landed on `turn_complete`
  (`state=paused`, `pausedUntil=2026-08-04T18:00:00Z`); at the reset the agent came back on its own
  with `resume="alpha-conversation"` on the same `CLAUDE_CONFIG_DIR` and was told it had been paused.
  Beta stayed `active` throughout — an exhausted subscription's agents wait for its window and are
  never moved to one with room.

937 tests green (shared 72, server 627 + 1 skipped live-quota test, web 268).

## M3 — Factory bus and the orchestrator ✅ **complete** (2026-08-04)

**M3a is complete (2026-08-04)** — the bus, tasks, and packages that mean something:

- [x] Factory Bus (`factoryBus.ts`): messages are rows first (migration 4), delivery second.
      Delivery is push — a turn injected into the recipient's input stream, never a poll — and
      only at a turn boundary, so a busy agent is never interrupted mid-turn. A message for a
      room with nobody free stays queued, survives a restart, and is flushed at the next boundary
      (one message per boundary, so a queue of N takes N boundaries).
- [x] The bus as in-process MCP tools (`busTools.ts`): `factory_send`, `factory_inbox`,
      `factory_task_update`, `factory_report_status`, built per session from that session's room.
      The sending room comes from the session row and never from tool input. The model sees them
      as `mcp__factory__*`, and they are **never gated** — see
      `docs/decisions/0002-factory-tools-are-not-gated.md`.
- [x] `TaskStore` (`taskStore.ts`) with room/assignee/`blockedOnMessageId`, a bottom-edge task
      board grouped by status, per-room task badges, and a "new task" form whose default is
      unassigned.
- [x] Packages ride real messages: a delivery becomes a box on the belt keyed by the message id,
      an undelivered message is a still grey crate stacked at its sender's door, and the two are
      the same object in two states.
- [x] Room charters tell an agent it is a department with a bus, and what its own room is called.

**Acceptance run (live, one operator prompt)**: two rooms with one `auto` agent each. The chat
agent was told once to ask payments for a webhook's method and path; it called
`mcp__factory__factory_send` with no approval card; the payments agent received the message as an
injected turn **nobody prompted**, investigated, called `factory_report_status`, and answered with
`factory_send`; the reply arrived in the chat agent's session the same way. Both directions
persisted, both broadcast, and a package rode the belt each way. Separately, with a fake executor:
a message sent to a room whose agent was mid-turn stayed `delivered_at = NULL` on disk across a
hard kill, and after the restart the boot flush carried exactly one, the second draining at the
next boundary. 474 tests green (shared 33, server 247 + 1 skipped live-quota test, web 194).

**M3b is complete (2026-08-04)** — the orchestrator, task auto-routing and the Chronicle:

- [x] **The orchestrator is a session with a role**, not a new runtime: an ordinary session in the
      project room with `sessions.is_orchestrator` (migration 7), at most one per project, its own
      system-prompt append and a larger tool surface. `ensure_orchestrator` is idempotent and
      argument-free — the room, the role prompt and the tools are the server's to decide.
- [x] `factory_ask_orchestrator(question, task_id?)` for every room, and two orchestrator-only
      tools (`factory_assign_task`, `factory_list_rooms`) that are **absent** from an ordinary
      agent's tool set *and* refused by their own handlers.
- [x] **Task auto-routing** (`router.ts`): a task with no room becomes a bus `request` to the
      project room describing it and every room's charter; the orchestrator's `factory_assign_task`
      moves the card and notifies the receiving room. No orchestrator ⇒ no message and no change —
      nothing fabricates an assignment.
- [x] **Chronicle v1** (`chronicle.ts`, migration 8): `factory_record_decision` writes an ADR file
      into the project's own `docs/decisions/` *and* a row indexing it, and `factory_search_history`
      is one FTS5 query over the decisions **and** what agents actually said. The operator gets the
      same index over the wire (`search_chronicle`) in a popover off the top strip.
- [x] **UI**: the orchestrator is marked on the floor (a standard on its figure, headquarters' slate
      helmet, the word on the building's label, a flag on the room row), created from the project
      room's detail, and an unassigned card carries a working "route it".

**Acceptance run (live, one operator click)**: a throwaway factory with a `payments` room ("all
money-handling code lives here") and a `docs` room ("no product code"), one `auto` agent each, plus
an orchestrator created from the room panel. One task with no room — *"Refunds: charge back a failed
webhook delivery and document the retry contract"* — routed by pressing "route it" on the board.
All six observations held: the orchestrator received the routing request as an injected turn nobody
prompted; it searched the chronicle first (as its charter tells it to), then called
`mcp__factory__factory_assign_task(task_id, room: "payments")`; the card moved to payments on the
board; the payments agent was notified as an injected turn and started work; and the orchestrator
recorded `0001-webhook-retry-behaviour-is-owned-by-payments-docs-publishes.md` — a real ADR on disk
with context, decision and rejected alternatives — which the HUD's chronicle search then found.
The factory then kept going on its own: docs and payments asked the orchestrator two rulings through
`factory_ask_orchestrator`, and five ADRs (0001–0005) were written by two different agents with no
numbering collision. Tool surface verified against the real CLI: the orchestrator's session is
offered **nine** `mcp__factory__*` tools, and ADR 0002's ungated rule holds for all of them — with
the orchestrator switched to `attended`, `factory_search_history` executed with no card while
`Write` in the same turn raised one. 760 tests green (shared 53, server 463 + 1 skipped live-quota
test, web 244).

## M4 — A sandbox per room ✅ **complete** (2026-08-04)

A room chooses `host` (the default, and what every room did before) or `container`. A contained
agent sees one folder, one account's credentials, two CPUs and Anthropic — and produces an event
log `SessionManager` cannot tell from a host session's, because it is the second implementation of
the `Executor` interface that has existed since M0 rather than a parallel runtime.

**Delivered**

- `packages/agent-runner` — the program inside the container: one SDK `query()`, the same
  `SessionEvent` vocabulary (`@superfabric/shared`, never re-declared), a numbered outbox that
  survives the socket going away, approvals as a request/answer pair re-asked rather than timed out.
- `superfabric/agent-runner:0.0.1` — `oven/bun` + git + ripgrep + the SDK, non-root, and
  `init-firewall.sh` adapted from Anthropic's reference devcontainer. The allow-list is **not**
  theirs: the reference has drifted from Anthropic's own network-access docs, and it omits
  `platform.claude.com`, which is where OAuth *refresh* goes — shipping that would have broken every
  contained session a few days after its token was last refreshed.
- `ContainerExecutor` + `RunnerHub` + `runnerListener` — three mounts and no more, `Memory` /
  `NanoCpus` / `PidsLimit`, a read-only rootfs, per-container tokens, and a failed start that is a
  `session_error` naming what to do about it.
- `rooms.runtime` (migration 14), the picker on the room panel, a shield on the room row, the word
  `sandboxed` on the building's label, and `SessionInfo.runtime` so every agent says which runtime
  it is *actually* in rather than which one its room now prefers.

**The transport is a unix socket, and that was the interesting decision.** The plan assumed
container→host over the bridge gateway. This machine — like any default Debian/Ubuntu/Arch host —
runs `ufw`, which drops `docker0`, so the gateway is unreachable and the fix is a rule only the
machine's operator may add. Probing first found that Bun's `WebSocket` dials `ws+unix://<path>:<p>`,
that `ws` serves it off a bare `node:http` server, and that a non-root container with a read-only
rootfs and the firewall up connects through a read-only bind mount of the socket's *directory*. So
the socket is the transport: no `ufw` rule, no new network listener in a product that binds loopback
on purpose, and no hole in the container's egress allow-list back to the host. TCP stays as an
opt-in fallback (`SUPERFABRIC_RUNNER_TCP_PORT`) whose failure message names the rule it needs.

**Acceptance, run on 2026-08-04** (throwaway server on 4711, throwaway data dir, Vite on 5199; the
operator's own 4620/5173 untouched):

- **A container room and a host room side by side.** `sandboxed` (container) and `onhost` (host),
  both bound to the same account, plus `sealed` (container) bound to a second account.
- **One live turn in the container room.** "Write a file called hello.txt … containing exactly the
  line: contained agent was here." → `hello.txt` appeared in the room's folder *on the host*, owned
  by the operator, containing exactly that line. The log was `session_status starting` ×3 (two of
  them the factory narrating the container) → `working` → `user_prompt` → `tool_use Write` →
  `tool_result` → `agent_text` → `turn_complete $0.198` → `idle`. The host room's turn produced the
  same shape.
- **An approval card round-trips.** An `attended` contained agent asked to write a file raised
  `approval_request Write {file_path: "/workspace/approved.txt"}`; allowing it produced
  `approval_resolved allow`, the tool ran *inside* the container, and `approved.txt` appeared on the
  host. (`id -un && pwd` inside the container answers `bun` / `/workspace` — non-root, in the mount.)
- **The server was killed mid-session and restarted.** `kill -9`, no graceful shutdown at all. The
  container stayed up; its runner logged six reconnect attempts into the void; the new server logged
  `resumed sessions: …` and `re-attaching to the container this agent was already running in
  (9bd9f0dc44d0)` — the *same* container id, and `docker ps -a` shows exactly one was ever created
  for that session. A **graceful** SIGTERM does the same thing by a different route (`detach`):
  `container: left container d88562519d52 running`, and the socket file is cleaned up.
- **Isolation, proved from inside the live container the product created:**
  - the host home directory: `ls /home/nikolos1999` → `No such file or directory`; a marker file
    planted there is unreadable.
  - another account's config dir: the container is bound to the "Other" account, `/config` holds
    that account's directory and nothing else; the "Work" account's directory
    (`/home/nikolos1999/.claude`) does not exist inside.
  - the other rooms' workspaces: `/workspace` holds only the sealed room's folder.
  - the docker socket: `/var/run/docker.sock` → `No such file or directory`.
  - egress: `example.com` refused in 6 ms, `pypi.org` in 2 ms, `github.com` in 5 ms (the REJECT, not
    a timeout); `POST https://api.anthropic.com/v1/messages` returned a real `401`; the host over
    the bridge (`172.17.0.1:4711`) timed out — the container has no route to us and needs none.
  - caps, as the daemon reports them: `2147483648 bytes / 2000000000 nanocpus / 512 pids /
    readonly=true / caps+=[NET_ADMIN NET_RAW] caps-=[MKNOD AUDIT_WRITE NET_BIND_SERVICE SYS_CHROOT]`,
    and from inside, `memory.max` 2147483648, `cpu.max` 200000/100000, `pids.max` 512.
  - the rootfs: `touch /usr/local/bin/evil` and `touch /app/evil` both refused; `/workspace`
    writable, as it must be; `rm /superfabric/runner.sock` refused (the mount is read-only, and a
    socket needs write permission on the *socket*, not on the directory).
  - the token: restarting an agent released its old attachment, and the outgoing container's runner
    reconnecting was refused live — `runner: refusing a runner: this server is not expecting that
    runner`.
- **Pause and resume are unchanged.** Mid-acceptance the account crossed 100 % of a weekly window
  and the M2 scheduler armed a pause on a contained agent at its turn boundary, applied it after
  `turn_complete`, and removed the container — the same sequence a host agent gets, from code that
  knows nothing about containers.

**Not run:** nothing was skipped, but the live turns were spent frugally — the operator's only
logged-in subscription was already at its weekly limit, so the acceptance used it for exactly three
turns and did the structural work (container lifecycle, restart survival, isolation) on a second
account with no inference at all.

**Deliberate deviations from the plan**

- **Transport**: unix socket rather than the bridge gateway (above). The per-container token is kept
  regardless, and a wrong one is refused — tested at the protocol level and observed live.
- **`ExecutorHandle.detach?()`** was added. `stop()` could not distinguish "this agent is done for
  now" from "the *server* is going away", which was fine for as long as every agent was a subprocess
  that died with us. Only `stopAll` calls it; only `ContainerExecutor` has one.
- **`ExecutorStartOptions.sessionKey`** was added: the one thing an out-of-process executor needs
  (to find its container again) and a local one ignores.
- **`SessionInfo.runtime`** was added. The plan asked for the floor to show which rooms are
  sandboxed; a room's runtime is a default for the *next* start, so a room switched to `container`
  while agents are working would have had the floor claiming an isolation not in force. Every agent
  now reports the runtime it is actually in.
- **`reapOrphans` at boot**, required by `RestartPolicy: unless-stopped` — the policy that makes a
  container survive a machine reboot is also what would resurrect an abandoned one forever.

**One bug the acceptance run itself found, and it was the important kind.** A container left
running by a graceful shutdown was stopped four minutes later, with nothing running that could have
asked for it — traced through `docker events` (`container kill signal=15`) to `reapOrphans` being
**machine-wide**: `test/wsOrigin.test.ts` spawns a real server with an empty data directory, that
server boots, sees no active sessions of its own, and destroys every contained agent on the machine.
The same would happen to an operator running two factories from two data directories. Containers now
carry a `superfabric.instance` label — the data directory, canonicalised, because that *is* what a
server instance is — and both the orphan sweep and the re-attach lookup are scoped to it. Verified
end to end afterwards: with a second server's containers running, the full suite (which spawns that
real server) leaves them untouched.

1092 → **1159 tests green** (shared 82, server 762 + 1 skipped live-quota test, web 285,
agent-runner 30).

## M5 — The living factory, metrics and portability ✅ **complete** (2026-08-04)

The last milestone. The floor stops looking like a diagram that updates and starts looking
like a place where work happens; plus the two remaining utilities.

**A deliberate change from this roadmap's own earlier text.** M5 was going to buy glTF
characters. It ships **procedural motion tied to real state** instead. The value the operator
asked for is in the *doing*, animation driven by the event log is both more informative and
more impressive than a static purchased mesh, and it avoids sourcing and licensing
third-party character assets into an MIT repository. The figures already had legs, a torso,
arms and a hard hat; this milestone made them act.

- [x] **Agents that do something.** A package arriving on a belt sends a free agent in that
      room from its post to the loading bay the belt enters and back, carrying the crate at
      its side, turned to face the direction of travel. **A room with nobody free visibly
      piles up** at its bay — which is information, not a missing feature. An agent blocked
      on an approval faces the operator's camera and stands still, distinct from idle. The
      scheduling and the path are pure functions (`scene/errands.ts`) and are tested as
      such — nothing mounts a `<Canvas>` in jsdom.
- [x] **A factory that looks inhabited.** Chimney plumes while a room works (instanced,
      fading out after it stops — which is what needs frames *after* the work ends), windows
      lit only when a room has a live agent, belt slats crawling only while a package is on
      that belt, per-room props that reflect the work, and a thought bubble over a working
      figure carrying the same one-line tool summary the console shows (one summariser, so
      the two cannot disagree). All of it loses to the status beacons, the packages and the
      belts in the reading order; `hasMotion` accounts for every one of them, and an idle
      factory still does **zero** `requestAnimationFrame` calls.
- [x] **Burn-rate metrics** (`metricsStore.ts`, `hud/BurnRate.tsx`). The number an operator
      acts on is a duration: *"at this rate you have about two hours"*, taken from the
      least-squares slope of the utilisation history M2 has been persisting, projected to the
      95 % line the scheduler acts on, for whichever window runs out **soonest**. A window
      that rolled breaks the series rather than flattening it. **A projection nobody can make
      says "unknown" and says why** — under two readings, under fifteen minutes of span, or a
      window that is not filling. Cost sits beside it as a *cost-equivalent*, marked
      approximate, per account and per room and separately for the ambient `~/.claude`.
      **There is no pricing table anywhere in SuperFabric**: the figure is the CLI's own.
- [x] **Export and import a factory** (`factoryPortability.ts`, `hud/FactoryTransfer.tsx`).
      One JSON file: rooms with their positions, runtimes and account bindings **by label**,
      the agents that staffed them, the board, and the decision index. **No credentials, no
      config-dir contents, and no absolute path at all.** Import goes through the ordinary
      `createRoom`, so every invariant still applies because it is the same code path, and it
      **reports what it could not do** rather than skipping it.
- [x] **This documentation pass.** Every document read end to end against the code for the
      first time since M0, and the list below written.

**Acceptance, run on 2026-08-04** (throwaway server on 4733, throwaway data dir, Vite on
5199; the operator's own ports untouched; **no agent was prompted and no quota was spent** —
sessions, costed turns and the snapshot history were written straight into a throwaway
SQLite, exactly as M1b's and M2's acceptance runs did, because `create_session` would spawn a
real CLI):

- **A populated floor**: four buildings (`proj`, `backend` sandboxed, `docs`, `payments`),
  six agents, three tasks, two accounts on throwaway config dirs.
- **The metrics, beside the meters.** The `work` account showed hatched (estimated) bars at
  `≈59 %` / `≈29 %` and, under them, *"at this **estimated** rate · **about 3 h** · 5-hour
  (estimated) · ≈12 pts/h"* with `cost-equivalent ≈$1.93 / 24 h  ≈$2.73 / 7 d`. Checked
  against the arithmetic: 31 readings spanning 90 minutes at 12.33 points/hour ending at
  58.5 %, so (95 − 58.5) / 12.33 = 2.96 h. The cost reconstruction was checked the same way —
  one seeded agent reported the cumulative series 0.08 → 0.19 → 0.05 → 0.14 (a restarted
  executor in the middle of it) and was counted as **$0.33**, not the $0.46 a naive sum gives.
- **The unknown case, in the same place the figure would have been.** The second account had
  one reading, and read *"Time left: unknown — only 1 reading of 5-hour (estimated) so far —
  a rate needs two"*.
- **"This factory's spend, by room"**: payments `≈$1.05 / 24 h`, backend `≈$0.88`, docs
  `≈$0.11`, most expensive first, with rooms that cost nothing absent — plus a line for the
  $0.09 spent by an agent on the ambient `~/.claude`, which has no account row to hang it on.
- **A round trip through the UI.** `Export this factory` downloaded
  `proj-factory-2026-08-04.json`; grepping those bytes for `sk-ant-`, `whsec_`,
  `.credentials.json`, `/home/` and `/tmp/` found **nothing**, and the file refers to both
  accounts only as `"work"` and `"other"`. Importing it into an empty folder created the
  project, three rooms with their positions and `backend`'s `container` runtime, three tasks
  with the assigned ones in the right rooms, and reported *"5 agent(s) were described in the
  file and none were started"*. No session row was created.
- **A collision, reported.** Importing the same file into the same root a second time
  answered `0 rooms · 3 tasks · 0 decisions indexed` with three amber lines — `room "backend"
  was not created: room "backend" already exists`, and the same for `docs` and `payments` —
  and **no error frame**, because a reported collision is an outcome rather than a failure.
- **The frameloop gate is intact**: `requestAnimationFrame` fired **0** times in 3 s with
  every agent idle.

1159 → **1344 tests green** (shared 88, server 807 + 1 skipped live-quota test, web 419,
agent-runner 30).

## What is not built

Stated here rather than left as an absence a reader has to discover. Everything in this list
is a deliberate stop, not an oversight — but none of it exists, and the docs above are written
so that nothing implies otherwise.

- **Phone push notifications.** Named as "desirable" in the original M5 sketch and never
  built. There is no notification surface at all beyond the browser tab: no push, no email, no
  webhook, no desktop notification. An operator who closes the tab learns nothing until they
  open it again. The pieces a later milestone would need are all present (the event log is the
  source of truth, and `usage`/`sessions` broadcasts already carry every state change worth
  telling someone about) — what is missing is a transport and the operator's consent for it.
- **The roles library at 50+ presets.** **Eleven ship** (ten job roles plus `onboarding`).
  What M1c actually delivered is the *format* — plain YAML, `<data dir>/roles/` overriding by
  id, an edited file picked up without a restart, and a malformed one reported next to the
  list rather than dropped from it — and that is the extensible half. Eleven presets that each
  state a real boundary are worth more than fifty written to hit a number, but fifty is not
  what is here.
- **Multi-provider executors.** The `Executor` interface has existed since M0 and now has two
  implementations — `ClaudeCodeExecutor` and `ContainerExecutor` — and **both drive Claude
  Code.** There is no Codex, ChatGPT-agent, Antigravity or Gemini executor, and nothing has
  been probed about what one would need. Post-v1 by design; the seam is real, the second
  provider is not.
- **A folder picker.** Every place the operator names a directory — a project root, a room's
  folder, the root to import a factory into — is a text field wanting an absolute path, and
  each one says so. The browser cannot hand a server a real directory path: the File System
  Access API is Chromium-only and returns a handle rather than a path, so a real picker needs
  a server-side browse endpoint that does not exist.
- **Token counts per turn.** The event log records the provider's `costUsd` and **not** token
  counts, so there is no token-level analytics (the "ccusage math" the M5 sketch mentioned).
  Adding them means changing `sdkEvents.ts` and both hosts of a session, and the field they
  would come from has the same per-query-versus-per-turn ambiguity that `costUsd` did — it was
  not worth shipping a number that could not be verified. The burn rate does not need them:
  it is sourced from real utilisation readings instead, which is a better instrument.
- **Serialised OAuth refresh within one account.** One config directory is one account, which
  *is* enforced. Several sessions of the same account share one credentials file that the CLI
  rewrites in place, and SuperFabric does not serialise that. See the risk table in
  `ARCHITECTURE.md` §6 — the row used to claim a lock that was never written.
- **Any authentication.** The server binds `127.0.0.1`, allow-lists browser origins, and
  otherwise trusts whoever can reach it. That is the documented posture, not a gap to be
  filled quietly, but it does mean SuperFabric must not go on a shared host.
- **An eight-hour unattended run across three accounts.** The first of the v1 success criteria
  in `VISION.md`, and the only one nothing has demonstrated. Every part is built and tested;
  the run has never happened.
- **Editing a role from the UI, deleting a project, and removing a room.** Roles are edited by
  editing the file (which is the design). Projects and rooms are never deleted by the product
  — a delete that left sessions, tasks and history pointing at a missing row would be a worse
  state than any it fixed, and nothing yet does the cleanup properly.

## After v1

- **Multi-provider executors** behind the `Executor` interface (see the list above for exactly
  how far that seam has actually been taken).
- **Notifications off the tab**, which is what would make an eight-hour unattended run
  something an operator could walk away from.
- **A directory-browse endpoint**, so the path fields can become a picker.

## Out of scope for v1
- Multi-tenancy, cloud deployment, team access.
- Automatic account rotation to dodge limits — deliberately NOT doing this (ToS risk);
  only pause/resume of your own accounts. **This one is a line, not a backlog item**: a PR
  adding it would be rejected.
