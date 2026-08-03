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

## Stack

pnpm workspaces · TypeScript · Node 22+ · Fastify + ws · better-sqlite3 (WAL) ·
`@anthropic-ai/claude-agent-sdk` · zod 4 · React 19 + Vite · react-three-fiber + drei ·
zustand · dockerode (M4).

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

Design approved 2026-08-03. **M0 (core session runner) is complete** — see
`docs/ROADMAP.md` for the acceptance evidence. Next: **M1 — 3D factory floor, project
block, rooms, roles library v1**.

## Running it

```bash
pnpm install
pnpm -F @superfabric/server dev   # Fastify + ws on 127.0.0.1:4620 (tsx watch)
pnpm -F @superfabric/web dev      # Vite dev server, proxies /ws to the server
pnpm test                         # whole workspace
SUPERFABRIC_LIVE_TEST=1 pnpm -F @superfabric/server test claudeExecutor.live  # real quota
```

Server state lives in `.fabrica/fabrica.db` (override the directory with
`SUPERFABRIC_DATA`); port via `PORT`.

## Layout

- `packages/shared` — zod protocol shared by server and web (`SessionEvent`,
  `ClientMessage`, `ServerMessage`).
- `packages/server` — `db.ts` (schema) · `eventStore.ts` (append-only log + subscriptions)
  · `executor.ts` (provider seam) · `executors/claudeCode.ts` (Agent SDK, streaming input)
  · `executors/fake.ts` (scripted, for tests) · `sessionManager.ts` (sessions, approvals,
  resume/stopAll) · `wsHub.ts` (replay-then-tail) · `index.ts` (wiring only) ·
  `notes/agent-sdk-api.md` (verified SDK API reference — trust it over memory).
- `packages/web` — `store.ts` (zustand, dedupes replays) · `wsClient.ts` (reconnect +
  resubscribe from `lastSeq`) · `App.tsx` (M0 console; M1 replaces it with the 3D floor).
