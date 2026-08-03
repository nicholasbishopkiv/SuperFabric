# SuperFabric — agent context

Self-hosted visual orchestrator for multi-account Claude Code agent teams: a 3D factory
in the browser (react-three-fiber), rooms-as-folders, agents = Claude Code sessions
(TS Agent SDK, streaming input), an MCP bus between departments, an orchestrator agent,
and a subscription limit monitor with auto-pause/resume.

## Read before any work

1. `docs/superpowers/specs/2026-08-03-fabrica-design.md` — canonical design spec.
2. `docs/ARCHITECTURE.md` — components and flows.
3. `docs/ROADMAP.md` — which milestone (M0–M5) we are on.
4. `docs/RESEARCH.md` — facts about Claude Code / limits / prior art; don't rediscover.

## Invariants (do not violate)

- The SQLite event log is the source of truth; WebSocket is a lossy tail with
  `afterSeq` replay.
- Room = folder; without SuperFabric the project remains an ordinary repository.
- One `CLAUDE_CONFIG_DIR` = one account; never share across accounts.
- Message delivery to agents is push (inject a turn into the input stream), not polling.
- No account pooling/rotation to evade limits (hard ToS line) — only monitoring, pause,
  and resume of the user's own accounts.
- The server is a local privileged tool: bind 127.0.0.1 only, allow-list browser `Origin`s on
  the WebSocket handshake (`src/origin.ts`), and never trust a client-supplied session id for
  anything the log records (see `SessionManager.approve`).
- Autonomy is **per session**, persisted in `sessions.autonomy`, and re-applied on resume: a
  `bypass` agent comes back as `bypass`, an `attended` one as `attended`. A session's SDK
  permission mode is always set explicitly, so the operator's own Claude Code default can never
  decide what a factory agent may do.
- The **model is per session** in exactly the same way (`sessions.model`, NULL = the CLI's own
  default), re-applied on resume, and changed by restarting the session's executor with `resume` —
  so the stored model and the model actually in force can never disagree. Model *ids* are Anthropic's
  release schedule, not our protocol: the wire takes any non-empty string, `AGENT_MODELS` in
  `packages/shared` is a shortlist for the UI, and a free-text field covers everything else. Never
  hard-code an id you are not sure of — a wrong one is a 404 mid-turn.
- **A room is never taken from tool input.** The room an agent speaks for comes from its session
  row, and `busTools` bakes it into the closures — an agent cannot send a bus message *as* another
  department, whatever it puts in the arguments. A roomless session gets no bus tools at all.
- **The factory's own bus tools are never gated.** `canUseTool` auto-allows tool names belonging
  to this session's own in-process (`type: "sdk"`) MCP servers — for a room, `mcp__factory__*` —
  in every autonomy mode, and still appends a `tool_use` event so the log records the call.
  Everything else keeps going through the operator. See
  `docs/decisions/0002-factory-tools-are-not-gated.md`.
- **The bus persists before it delivers, and delivers only at a turn boundary.** A message is a
  row before anyone is told about it, and an agent mid-turn is never interrupted: its queue drains
  one message per `turn_complete`.
- **Everything the operator looks at is scoped to one project, and the active project belongs to
  the socket.** Rooms, sessions, tasks and messages all carry a `project_id`; every listing takes
  one, and every broadcast is addressed by the asking socket's own scope. A second tab watching
  another factory must never see this one's rooms, board or belts — cross-project leakage is the
  bug to be most afraid of in this area, and the store-level tests exist to catch it. Room *names*
  are unique per project, not per server, so anything resolving a name (`busTools`) must scope it.

## Autonomy (per-agent permission mode)

Three modes, in our own vocabulary (`AutonomyMode` in `packages/shared/src/protocol.ts`):

| Mode | Meaning | SDK `permissionMode` |
|---|---|---|
| `attended` | every gated tool call raises an approval card | `"default"` |
| `auto` | **default** — the CLI's classifier decides; cards become rare, not impossible | `"auto"` |
| `bypass` | nothing is gated at all; explicit per-agent opt-in | `"bypassPermissions"` |

The wire protocol never speaks SDK: the mapping lives in the executor
(`sdkPermissionMode()` in `src/executors/claudeCode.ts`), so an SDK rename touches one table.
`canUseTool` stays wired in every mode, so the attended mode and any classifier-escalated call
still reach the operator. `bypass` is only genuinely safe once sessions are sandboxed (M4).
`create_session` carries an optional `autonomy`; `set_autonomy` toggles a live agent (the SDK's
mode is fixed per `query()`, so the session's executor is restarted, resuming from the stored
`claude_session_id`).

## Model (per agent)

`create_session` carries an optional `model`; `set_model {sessionId, model}` switches a live agent,
with `null` handing it back to the CLI's default. It is the worked twin of `set_autonomy` —
`Options.model` is fixed per `query()`, so the executor is restarted and resumed from
`claude_session_id` rather than mutated (`Query.setModel()` exists, but a restart is what makes the
stored model, the running model and the model a reboot would use one thing). Stored in
`sessions.model`; NULL means "no choice was made", which is *not* the same fact as any particular id.

The picker's shortlist is `AGENT_MODELS` in `packages/shared/src/protocol.ts` and the wire type is a
plain non-empty string, so an id we have never heard of still works. `Query.supportedModels()` (see
`server/notes/agent-sdk-api.md`) is the authoritative list for the installed CLI and could populate
this dynamically later.

## Stack

pnpm workspaces (installs are always `pnpm`) · TypeScript · **Bun 1.3+ runs, tests and
stores for the server** (`bun src/index.ts`, `bun test`, `bun:sqlite` in WAL) · Fastify + ws ·
`@anthropic-ai/claude-agent-sdk` · zod 4 · **React 19 + Vite + vitest for the web** ·
react-three-fiber + drei · zustand · dockerode (M4). Node 22+ is still required — the web
toolchain and pnpm run on it.

Why two runtimes: `docs/decisions/0001-bun-runtime-keep-vite.md`. In short, Bun deletes the
native-module build step (`better-sqlite3`) and the `tsx`/`tsc && node dist` workarounds, while
Vite/vitest stay because vitest is Vite-native and the web bundle is small. Do not switch
installs to `bun install`, and do not introduce a second test runner inside a package: the
server package is `bun test`, `packages/shared` and `packages/web` are vitest.

**Dependency license policy**: third-party libraries must be MIT/Apache-2.0/BSD/ISC —
no copyleft (GPL/AGPL/SSPL). One deliberate exception: Anthropic's own
`@anthropic-ai/claude-agent-sdk` (and the `claude` CLI it drives) are proprietary
("© Anthropic PBC, all rights reserved", governed by Anthropic's legal agreements). They
are the engine this product orchestrates, so the dependency is intrinsic; it is called
out in the README so users know what they're installing.

## Conventions

- Code, comments, commits, docs — English. Russian doc originals are `*.ru.md`.
- Spec-first: substantive design changes update the spec/architecture docs in the same
  PR as the code.

## Status

Design approved 2026-08-03. **M0 (core session runner)**, **M1a (rooms as folders and the 3D
floor)**, **M3a (the factory bus, tasks, and packages that ride real messages)** and the structural
half of **M1b (several projects in one server, settable room folders, attachments — files in, paths
out)** are complete — see
`docs/ROADMAP.md` for the acceptance evidence of each. Still open in M1b: the shadcn/ui rebuild of
the HUD (`docs/decisions/0003-ui-library.md`). Then
**M3b — the orchestrator and task auto-routing**, the rest of M1 (roles library, onboarding agent)
and M2 (multi-account and the limit monitor).

## Running it

```bash
pnpm install                      # pnpm, not bun install
pnpm -F @superfabric/server dev   # Fastify + ws on 127.0.0.1:4620 (bun --watch, no build step)
pnpm -F @superfabric/web dev      # Vite dev server, proxies /ws to the server
pnpm test                         # whole workspace (bun test for the server, vitest for the rest)
pnpm build                        # tsc everywhere + the web bundle; type-checks the server
SUPERFABRIC_LIVE_TEST=1 pnpm -F @superfabric/server test claudeExecutor.live  # real quota
```

`bun test` does not type-check, so `pnpm -F @superfabric/server build` (plain `tsc`) is what
catches type errors in the server — run it, not just the tests.

Server state lives in `.fabrica/fabrica.db` (override the directory with
`SUPERFABRIC_DATA`); port via `PORT`.

### Bun gotchas worth knowing before you write server code

- **A missing row is `null`, not `undefined`.** `bun:sqlite`'s `stmt.get()` returns `null`
  when nothing matched (`better-sqlite3` returned `undefined`). Test row presence with
  `== null` / `!= null`, and type the cast `as Row | null`. Public helpers that return "not
  found" (e.g. `RoomManager.getRoom`) keep speaking `undefined`, so only the code touching a
  statement directly has to care.
- **There is no `db.pragma()`.** Read with `db.query("PRAGMA user_version").get()` (a one-row
  result object), write with `db.exec("PRAGMA journal_mode = WAL")`.
- **`bun:test`'s `vi` shim has no `vi.waitFor`** — use `test/_waitFor.ts`.
- **Bun's `ws` compatibility shim drops the client `origin` option** and never emits
  `unexpected-response`. Anything that must send an `Origin` uses Bun's native `WebSocket`
  with `{ headers: { Origin } }`, and anything that must see the handshake's HTTP status
  writes the upgrade request by hand (see `test/wsOrigin.test.ts`).

## Layout

- `packages/shared` — zod protocol shared by server and web (`SessionEvent`,
  `ClientMessage`, `ServerMessage`).
- `packages/server` — `db.ts` (schema + `PRAGMA user_version` migrations; **the only file that
  names the SQLite driver** — everything else takes its `Db` type, so a driver swap stays a
  one-file change) · `origin.ts` (WebSocket
  origin allow-list) · `eventStore.ts` (append-only log + subscriptions)
  · `executor.ts` (provider seam) · `executors/claudeCode.ts` (Agent SDK, streaming input)
  · `executors/fake.ts` (scripted, for tests) · `projectManager.ts` (projects: the scope every
  listing is filtered by) · `roomManager.ts` (rooms as folders, charters, settable folders)
  · `sessionManager.ts` (sessions, approvals, resume/stopAll, per-session bus tools, flush at
  each turn boundary) · `factoryBus.ts` (durable inter-room messages, push delivery) ·
  `busTools.ts` (the bus as an in-process MCP server, one per session's room) ·
  `taskStore.ts` (the task board; announces its own changes) ·
  `attachmentStore.ts` (files in, paths out: filename sanitising, MIME→extension, containment
  against whichever root the file is going into, and never overwriting) ·
  `attachmentRoutes.ts` (`POST /attachments`, multipart, behind the **same** origin allow-list as
  the WebSocket handshake) · `wsHub.ts` (replay-then-tail plus
  debounced `sessions`/`rooms`/`tasks`/`messages` broadcasts, and `notice` for "it worked") ·
  `index.ts` (wiring only) ·
  `notes/agent-sdk-api.md` (verified SDK API reference — trust it over memory).
  Its tests run under `bun test` (`test/_waitFor.ts` replaces `vi.waitFor`); `packages/shared`
  and `packages/web` stay on vitest.
- `packages/web` — `store.ts` (zustand: dedupes replays, and turns the bus's message snapshot into
  packages and waiting crates) · `wsClient.ts` (reconnect + resubscribe from `lastSeq`) ·
  `attachments.ts` (upload over HTTP, stage the returned paths, and `composeTurn` — the pure
  function that decides what an agent is actually told about a file) ·
  `App.tsx` (the 3D floor plus three HUD edges) · `scene/*` (the floor) · `hud/*` (room panel,
  console drawer, task board, window-wide paste/drop target).
