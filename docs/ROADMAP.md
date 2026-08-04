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

- AccountManager: profiles via `CLAUDE_CONFIG_DIR`; **"Add session" button** opening an
  embedded terminal (xterm.js ↔ node-pty) where the user logs in; binding rooms/agents
  to a chosen account at creation time.
- LimitMonitor: polling the OAuth usage endpoint per account, 5h/weekly/per-model
  meters in the UI, catching 429s.
- Scheduler: warn agents at 80%, pause at 95%, auto-resume at `resets_at`.

**Done when**: 2+ accounts run in parallel; limit pause/resume needs no human.

## M3 — Factory bus and the orchestrator

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

Still open for M3 (M3b):

- Orchestrator: dedicated session (Opus) with an overview of all rooms, task
  distribution, blocker resolution; orchestrator console in the UI, `factory_ask_orchestrator`.
- **Task auto-routing**: a task from the task panel with no department chosen goes to
  the orchestrator — it analyzes, assigns room and assignee, and dispatches. Until then such a
  task is shown as unassigned and nothing pretends otherwise.
- **Chronicle v1**: `factory_record_decision` + `factory_search_history` tools,
  ADR files in `docs/decisions/`, FTS5 search over decisions + prompt/event history,
  chronicle timeline in the UI.

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
