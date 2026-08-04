# Contributing to SuperFabric

Thanks for your interest! The project is young — right now the highest-value contributions
are running it on a real project and saying where it lies to you, and code against the
not-built list.

## Where we are

**M0 through M5 are complete** (2026-08-04) — see [docs/ROADMAP.md](docs/ROADMAP.md) for what
each milestone delivered and the acceptance evidence for it. Before starting anything sizable,
read **[what is not built](docs/ROADMAP.md#what-is-not-built)**: several things a reader
reasonably assumes are there (notifications off the tab, a folder picker, a second executor
provider, fifty role presets) are not, and each entry says why. Open an issue to discuss first.

## Ground rules

- **Read the docs first**: [CLAUDE.md](CLAUDE.md) (the invariants — start here),
  `docs/ARCHITECTURE.md` (components and flows), `docs/ROADMAP.md` (what shipped, and what did
  not). `docs/superpowers/specs/2026-08-03-fabrica-design.md` is the spec the product started
  from and is kept as history; where it disagrees with `CLAUDE.md`, `CLAUDE.md` is right.
- **Respect the invariants** listed in [CLAUDE.md](CLAUDE.md) — especially: no account
  pooling/rotation features (hard ToS line, PRs adding it will be rejected), one
  `CLAUDE_CONFIG_DIR` per account, event log as source of truth.
- **Licenses**: third-party libraries **that ship in a build artifact** must be
  MIT/Apache-2.0/BSD/ISC — no copyleft (GPL/AGPL/SSPL), and don't copy code from copyleft
  projects (e.g. claude-squad, AGPL). Build-time-only tooling is judged on whether its
  licence reaches users: unmodified MPL tools that ship nothing (`lightningcss`) are fine.
  The one deliberate exception is Anthropic's own `@anthropic-ai/claude-agent-sdk` and
  the `claude` CLI, which are proprietary and intrinsic to what SuperFabric does.
- **Language**: code, comments, commits, and docs in English. Russian doc originals live as
  `*.ru.md`; the ones under `docs/` are dated snapshots that say so at the top and point at the
  English file, which is authoritative. If you change an English doc, do **not** silently leave
  its Russian counterpart contradicting it — either update it or extend the note at its top.
- **AI-assisted contributions welcome** — this project is literally about orchestrating
  Claude Code. Point your agent at `CLAUDE.md` and review its output before submitting.

## Dev setup

```bash
pnpm install
pnpm dev        # server + web in watch mode
pnpm test
```

Node 22+, pnpm 9+, and [Bun](https://bun.sh) 1.3+ — `packages/server` runs and tests on Bun
(`bun test`), while `packages/shared` and `packages/web` stay on Node with Vite/vitest.
Installs are always `pnpm install`, never `bun install`. See
[docs/decisions/0001-bun-runtime-keep-vite.md](docs/decisions/0001-bun-runtime-keep-vite.md).

## Pull requests

1. Fork, branch from `main`.
2. Keep PRs focused; one concern per PR.
3. Add/adjust tests for behavior changes.
4. `pnpm build` and `pnpm test` must both pass from the root. **There is no `pnpm lint`** — an
   earlier version of this file asked for one and no such script exists; `pnpm build` is what
   type-checks (and for the server it is the *only* thing that does, since `bun test` does not).
5. Describe **why**, not only what.

## Reporting issues

Use GitHub issues. For anything involving accounts/limits, never include tokens or the
contents of `.credentials.json` in logs you attach.
