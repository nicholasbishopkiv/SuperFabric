# Contributing to SuperFabric

Thanks for your interest! The project is young — right now the highest-value
contributions are ideas, review, and early code.

## Where we are

The project just left the design phase (see [docs/ROADMAP.md](docs/ROADMAP.md)).
Milestone **M0** (core session runner) is in progress. Check the issues and the roadmap
before starting anything sizable, and open an issue to discuss first.

## Ground rules

- **Read the docs first**: `docs/superpowers/specs/2026-08-03-fabrica-design.md`
  (canonical spec), `docs/ARCHITECTURE.md` (invariants), `docs/ROADMAP.md`.
- **Respect the invariants** listed in [CLAUDE.md](CLAUDE.md) — especially: no account
  pooling/rotation features (hard ToS line, PRs adding it will be rejected), one
  `CLAUDE_CONFIG_DIR` per account, event log as source of truth.
- **Licenses**: dependencies must be MIT/Apache-2.0/BSD/ISC. No AGPL. Don't copy code
  from AGPL projects (e.g. claude-squad).
- **Language**: code, comments, commits, and docs in English. (Russian doc originals
  live as `*.ru.md`.)
- **AI-assisted contributions welcome** — this project is literally about orchestrating
  Claude Code. Point your agent at `CLAUDE.md` and review its output before submitting.

## Dev setup (from M0 onward)

```bash
pnpm install
pnpm dev        # server + web in watch mode
pnpm test
```

Node 22+, pnpm 9+.

## Pull requests

1. Fork, branch from `main`.
2. Keep PRs focused; one concern per PR.
3. Add/adjust tests for behavior changes.
4. `pnpm test` and `pnpm lint` must pass.
5. Describe **why**, not only what.

## Reporting issues

Use GitHub issues. For anything involving accounts/limits, never include tokens or the
contents of `.credentials.json` in logs you attach.
