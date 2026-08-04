# SuperFabric — Research Findings (2026-08-03)

> 🇷🇺 Русский оригинал: [RESEARCH.ru.md](RESEARCH.ru.md)

Condensed digest of two research passes: Claude Code mechanics (official docs) and
prior art / stack selection (web research).

## 1. Claude Code mechanics we build on

- **Programmatic control**: `claude -p` is one-shot; interactive multi-turn steering
  comes only from the **Agent SDK** (`@anthropic-ai/claude-agent-sdk`): streaming input
  (AsyncIterable prompt), `interrupt()`, `setPermissionMode()`, the `canUseTool`
  callback, `options.resume` / `forkSession`, in-process MCP (`createSdkMcpServer`).
  CLI equivalent (Vibe Kanban's verified flags): `claude -p --output-format=stream-json
  --input-format=stream-json --include-partial-messages --permission-prompt-tool=stdio`.
- **Account isolation**: `CLAUDE_CONFIG_DIR` relocates the whole `~/.claude`
  (credentials + sessions). Linux: tokens in `.credentials.json` (0600). One directory =
  one account; never share across accounts (refresh tokens rewrite in place).
- **Login**: browser OAuth **cannot complete in a headless container** — log in on the
  host (hidden-PTY, the AgentsRoom/Maestro pattern) or use `claude setup-token`
  (~1-year `CLAUDE_CODE_OAUTH_TOKEN`, Pro/Max).
- **Sessions**: JSONL at `<config-dir>/projects/<encoded-cwd>/<session-id>.jsonl`;
  `--resume <id>` / SDK `resume` work after a process/container restart as long as the
  file survives. Forking: `forkSession: true`.
- **Per-agent configuration**: `--model`, `--append-system-prompt`,
  `--allowedTools/--disallowedTools`, `--permission-mode`, `--mcp-config`
  (+`--strict-mcp-config`), hooks, `.claude/agents/`. All mirrored in SDK options.
- **Containers**: the official reference is the devcontainer feature
  `ghcr.io/anthropics/devcontainer-features/claude-code` + `init-firewall.sh`
  (default-deny egress). `--dangerously-skip-permissions` is officially blessed
  precisely inside a sandbox.
- **MCP bus**: sessions are full MCP clients (stdio/HTTP/SSE/in-process). MCP has no
  server→agent push — but we don't need it: our server owns each session's input stream
  and "delivers" a message by injecting a new turn.

## 2. Subscription rate limits

- No official public API. **But there is an undocumented
  `GET https://api.anthropic.com/api/oauth/usage`** (Bearer from `.credentials.json`,
  header `anthropic-beta: oauth-2025-04-20`, User-Agent `claude-code/<ver>`, safe
  polling ~180s): returns `five_hour`, `seven_day`, `seven_day_opus`,
  `seven_day_sonnet` with `utilization` (0–100) and `resets_at`. Same authoritative,
  cross-device data behind `/usage` in Claude Code. Risk: may change any time → adapter
  + fallback.

  **Correction, measured 2026-08-04 — it already changed.** `five_hour` and `seven_day`
  are as described, but `seven_day_opus` / `seven_day_sonnet` now come back **`null`**;
  the per-model weekly figures moved into a `limits[]` array whose entries carry
  `kind` (`session` | `weekly_all` | `weekly_scoped`), `percent`, `severity`,
  `resets_at`, `is_active` and, for scoped ones, `scope.model.display_name`. The response
  also carries `extra_usage` and `spend` blocks. Our parser reads both shapes and both are
  recorded as fixtures. This is exactly the risk the adapter exists for, arriving within a
  day of the research — treat any field list here as a snapshot, not a contract.
- Estimating from local JSONL (ccusage, Claude-Code-Usage-Monitor) is inherently
  imprecise: limits are dynamic, cache tokens are weighted opaquely, other devices are
  invisible. Use only for cost analytics.
- The 5-hour window rolls from the first prompt; weekly caps (since Aug 2025) — an
  overall bucket plus a separate Opus bucket; Claude Code has **no** auto-resume after a
  limit reset — that's our scheduler's job.

## 3. Prior art — what we take

| Source | What we take | License |
|---|---|---|
| **Vibe Kanban** (sunset) | executor abstraction over CLIs, exact stream-json flags, MsgStore (replay-then-tail) | Apache-2.0 |
| **Crystal** (deprecated) | session-as-first-class-object, SQLite output-buffering schema | MIT |
| **CCManager** | busy/waiting/idle status detection | MIT |
| **Happy Coder** | relay design for remote/mobile access (future) | MIT |
| **AgentsRoom / Maestro** | multi-account: profile per `CLAUDE_CONFIG_DIR`, in-app OAuth via hidden PTY | — |
| **Sculptor** | container-per-agent UX + pairing mode | closed |
| **terragon-oss** | complete cloud-runner reference | open snapshot |

Not touching: claude-squad (AGPL), claude-flow (questionable reputation), tldraw
(license).

**Market takeaway**: Terragon shut down (Feb 2026), Vibe Kanban and Crystal wound down —
Anthropic ate the cloud-runner niche (Claude Code on the web, Agent Teams). The durable
niche is ours: self-hosted, multi-account, spatial UI.

## 4. Stack decisions

- **Canvas: react-three-fiber + drei (Three.js)** — by explicit product decision the UI
  must be a real 3D factory (workshop buildings, conveyors with package-messages, later
  animated agent characters), with 2D panels (task panel, limit meters, approvals) as a
  DOM layer above the WebGL canvas. All MIT. Research originally recommended
  @xyflow/react v12 (MIT, graph model) — superseded by the 3D directive; tldraw
  rejected (proprietary license, watermark).
- **Transport: WebSocket** (bidirectional: approvals/interrupt go up the same channel;
  N sessions multiplexed in one socket). The SQLite event log is the source of truth,
  the socket is a lossy tail.
- **Storage: better-sqlite3 (WAL)** — the unanimous choice of self-hosted prior art.
- **Docker: dockerode** + Anthropic's reference firewall (milestone M4).

## 5. Risks / ToS

- Anthropic does not allow third parties to "offer claude.ai login". SuperFabric is a
  personal self-hosted tool: the user logs into **their own** accounts themselves.
- The red line from the late-2025 crackdown: pooling/rotating accounts to evade limits
  (what ccflare does). We deliberately don't; monitoring + pause/resume only.
- The 429/limit error format in headless mode is undocumented — capture empirically
  in M0.
- Concurrent token-refresh behavior with several sessions on one account is
  undocumented — serialize refresh, monitor for invalidation.
