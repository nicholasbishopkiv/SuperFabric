# 0001 — Bun for the server runtime; keep Vite for the web; no Rsbuild

Date: 2026-08-03 · Status: accepted

## Context

The toolchain was chosen before any code existed: Node 22+, pnpm, `tsc`, Vite + vitest,
`better-sqlite3`. Two workarounds accumulated almost immediately:

- `node --experimental-strip-types` cannot resolve NodeNext `./foo.js` specifiers back to
  sibling `.ts` files, so `dev` needed `tsx` and `start` needed `tsc && node dist`.
- `better-sqlite3` is a native N-API module: every contributor and every CI run either
  downloads a prebuilt or compiles it.

With ~40 files and 150 tests, switching runtimes is still cheap. It gets expensive later.

## Decision

**Adopt Bun as the server runtime, test runner and SQLite driver. Keep Vite + vitest for
the web package. Keep pnpm for installs. Do not adopt Rsbuild.**

## Evidence (measured, not assumed)

Every load-bearing dependency was probed under Bun 1.3.14 before deciding:

| Probe | Result |
|---|---|
| `@anthropic-ai/claude-agent-sdk` — a real turn, streaming input, session id, result | **works**, 3.7 s for a trivial prompt |
| Fastify + `ws` (health route + WebSocket echo through the same server) | **works** |
| `better-sqlite3` | **fails** — `ERR_DLOPEN_FAILED`, [oven-sh/bun#4290](https://github.com/oven-sh/bun/issues/4290) |
| `bun:sqlite` — `prepare/run/get/all`, `exec`, `transaction`, `PRAGMA` read and write | **works**, API compatible enough for a mechanical swap |
| `bun:test` — `describe/it/expect`, `arrayContaining`, `toMatchObject`, `toThrow`, `beforeEach`, `afterAll`, `it.skipIf`, `describe.skipIf` | **works** |
| `bun:test`'s `vi` shim | no `vi.waitFor` — replaced by a 5-line local helper |
| zod 4 and the workspace `@superfabric/shared` package under Bun | **works** |
| A real test file (`eventStore.test.ts`) under `bun test` with `bun:sqlite` | **passes in 13 ms** |

The SDK probe was the gate: it spawns the `claude` CLI as a subprocess and is the one
dependency this product cannot work around. It passing is what made the rest worth doing.

## Consequences

**Accepted:**
- The server runs under Bun only. For a self-hosted developer tool this is a fair trade
  for deleting the native-module build step, and Bun is a documented prerequisite.
- Two test runners in the monorepo: `bun test` for `packages/server`, vitest for
  `packages/shared` and `packages/web`. Each package has exactly one, and the root
  `test` script runs both.
- `db.ts` is the only file that touches the driver, so a Node fallback stays conceivable
  if `bun:sqlite` ever becomes a problem.

**Gained:** no native module; native TypeScript execution (both workarounds above are
deleted); markedly faster server tests.

## Rejected: Rsbuild

Rspack is faster than Vite on large bundles. We do not have one — the web bundle is
~200 KB today and roughly 800 KB once three.js lands, which Vite builds in under two
seconds. Meanwhile vitest is Vite-native, so replacing Vite means either running two
transform pipelines or porting the web tests as well: cost with no user-visible benefit.

Revisit if build or HMR time on the 3D scene actually starts to hurt. That is a
measurement, not a preference.

## Rejected: switching installs to `bun install`

One toolchain would be tidier, but rewriting the lockfile and the workspace layout is
churn with modest payoff and some risk around the web package's Vite/vitest resolution.
Bun runs happily against a pnpm-installed `node_modules` — proven by every probe above.
Revisit independently.
