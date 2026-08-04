# SuperFabric — Roadmap

> 🇷🇺 Русский оригинал: [ROADMAP.ru.md](ROADMAP.ru.md)

The project is too large for a single spec, so it is split into milestones. Each
milestone is a self-contained sub-project with its own "spec → plan → implementation"
cycle and a **working result at the end**. The order is chosen to burn down the biggest
risks first.

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

## M1 — The floor: 3D factory, project block, rooms

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
- [ ] Roles library v1: ~10 presets (role = prompt + skills/superpowers + plugins/MCP + model).
- [ ] Onboarding agent for an empty project (interview → CLAUDE.md / README).

## M1b — Projects, folders, files and a real UI

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

## M2 — Multi-account and the limit monitor

**Accounts and login are complete (2026-08-04)**; the monitor and the scheduler are not.

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
- [ ] LimitMonitor: polling the OAuth usage endpoint per account, 5h/weekly/per-model
      meters in the UI, catching 429s.
- [ ] Scheduler: warn agents at 80%, pause at 95%, auto-resume at `resets_at`.

**Done when**: 2+ accounts run in parallel; limit pause/resume needs no human.

**Acceptance so far**: two accounts on two throwaway config dirs, a room bound to one, an agent
inheriting it — asserted from the real executor's recorded `Options` (each `CLAUDE_CONFIG_DIR` its
own, `PATH` and `HOME` intact) in `test/accountIsolation.test.ts`, and confirmed in a live browser
run where the spawned CLI wrote its `.claude.json` and `sessions/` into the bound account's folder
rather than into `~/.claude`. 877 tests green (shared 63, server 561 + 1 skipped live-quota test,
web 253).

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

## M4 — Containerization

- `agent-runner` image (Node + SDK + claude), dockerode management.
- One container per room; account profile and workspace mounts; egress firewall per
  Anthropic's reference; resource limits.
- `--dangerously-skip-permissions` inside the sandbox + per-room auto-approval rules.

## M5 — Polish and the "living factory"

- Small animated agent characters in the workshops (glTF, reflecting real session
  activity), living-factory details (smoke, lights, movement).
- Direct chat with any agent from the UI (partially in M0 already), notifications
  (phone push desirable), event history/search.
- Roles library expansion (50+ presets, user-defined presets).
- Metrics: per-account burn rate, cost-equivalent analytics (ccusage math).
- Factory export/import (multi-project moved up to M1b).

## Planned after v1

- **Multi-provider executors**: Codex / ChatGPT agents, Antigravity (Gemini), and
  others behind the `Executor` interface (which exists from M0) — assign different
  providers/strengths to different tasks and rooms.

## Out of scope for v1
- Multi-tenancy, cloud deployment, team access.
- Automatic account rotation to dodge limits — deliberately NOT doing this (ToS risk);
  only pause/resume of your own accounts.
