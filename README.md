# SuperFabric

**A self-hosted 3D orchestrator for multi-account Claude Code agent teams.**

> 🇷🇺 Русская версия: [README.ru.md](README.ru.md) · Codename: *Fabrica / «Фабрика»*

SuperFabric turns your project into a living factory in the browser: an isometric 3D
scene where the main building is your project, workshop buildings are **rooms**
(departments — backend, frontend, devops, payments…), and conveyor belts carry
package-messages between them. Each room hosts one or more **agents** — real Claude Code
sessions bound to different Claude subscription accounts — supervised by an
**orchestrator** agent. A 2D overlay shows the task panel, per-account rate-limit
meters, approval cards, and direct chat with any agent.

## Why

- **Coordinated agent teams** — one project, many areas of responsibility, one shared
  direction. Rooms talk to each other through the factory message bus ("chat service
  asks payments service for webhooks" — and gets an answer when the work is done).
- **Multi-account** — run 2–3 Claude subscriptions (Pro/Max) in parallel. See exact
  5-hour and weekly utilization per account; agents get warned near the limit, pause at
  the threshold, and **auto-resume from the same spot** when the window resets.
- **Total visibility** — open tasks, who's working / idle / blocked, and message flows,
  all on one screen. Add a task without picking a department and the orchestrator will
  analyze it, choose the room and assignee, and dispatch it.
- **Roles library** — assign a role (architect, designer, QA, DevOps…) and get a ready
  bundle: role prompt + recommended skills + plugins/MCP servers + model. No expertise
  in Claude Code configuration required.
- **Decision chronicle** — every prompt, decision, and its reasoning is preserved and
  searchable (ADR files in the repo + full-text index). Agents consult it before
  reworking anything; you always know *why* the product is built the way it is.
- **Add accounts from the UI** — the "Add session" button opens an embedded terminal
  where you log into a Claude account; rooms and agents are bound to the account you
  choose. Claude Code first; other engines (Codex/ChatGPT agents, Antigravity, …) are
  planned post-v1 behind an executor abstraction.

## Status

🏗️ **Early development.** Milestone **M0 (core session runner) is complete**: a Claude Code
session is driven from the browser over a WebSocket, every event is persisted to an
append-only SQLite log, tool calls surface as approval cards, and a session survives a
server restart — verified by killing the server mid-session and having the agent still
recall the conversation afterwards.

Next up is **M1**: the 3D factory floor, rooms-as-folders, and the roles library. The
current web UI is a deliberately plain console that M1 replaces.

```bash
pnpm install
pnpm -F @superfabric/server dev   # 127.0.0.1:4620
pnpm -F @superfabric/web dev      # open the printed Vite URL
```

Requires Node 22+, pnpm 9+, and a working `claude` login (M0 uses your current
`~/.claude` account; multi-account arrives in M2). See [docs/ROADMAP.md](docs/ROADMAP.md).

## Security

SuperFabric drives agents that run commands on your machine with your Claude account. Treat
the server as a local privileged tool:

- **It binds to `127.0.0.1` only** — never to `0.0.0.0`. Nothing is reachable from the network.
- **Only allow-listed browser origins may open the WebSocket.** Browsers do not apply CORS to
  WebSockets, so without a check any website you visit could connect to the local server and
  drive your agent. The handshake accepts the server's own origin, the Vite dev origins
  (`localhost:5173` / `127.0.0.1:5173`) and anything in `SUPERFABRIC_ALLOWED_ORIGINS`
  (comma-separated); every other `Origin` is rejected with 403 and logged. Requests with **no**
  `Origin` header are allowed, because non-browser clients (CLI tools, scripts) send none while
  browsers always do.
- **There is no authentication.** Anyone who can run code on the machine — or on any host you
  add to `SUPERFABRIC_ALLOWED_ORIGINS` — can drive your agents and approve their tool calls.
  Don't run SuperFabric on a shared host, and don't expose the port through a tunnel.

## Documentation

| Document | Contents |
|---|---|
| [docs/VISION.md](docs/VISION.md) | Product vision, principles, v1 success criteria |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Technical architecture: components, data flows, stack |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones M0–M5 |
| [docs/RESEARCH.md](docs/RESEARCH.md) | Research findings: Claude Code mechanics, rate limits, prior art |
| [docs/superpowers/specs/2026-08-03-fabrica-design.md](docs/superpowers/specs/2026-08-03-fabrica-design.md) | Canonical design spec |

Russian originals: [VISION.ru.md](docs/VISION.ru.md) · [ROADMAP.ru.md](docs/ROADMAP.ru.md) · [RESEARCH.ru.md](docs/RESEARCH.ru.md)

## Planned stack

TypeScript · Node 22+ · pnpm workspaces · Fastify + WebSocket · better-sqlite3 · zod ·
[`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk/overview) ·
React 19 + Vite · react-three-fiber + drei (Three.js) · zustand · dockerode.

SuperFabric itself is MIT. Third-party libraries are MIT/Apache/BSD/ISC — with one
deliberate exception: `@anthropic-ai/claude-agent-sdk` and the `claude` CLI it drives are
Anthropic's proprietary software (© Anthropic PBC, governed by
[Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance)).
They are the engine this tool orchestrates, so installing SuperFabric means installing
them too.

## ⚠️ Important disclaimers

- SuperFabric is a **personal, self-hosted tool**: you log into **your own** Claude
  accounts on your own machine. It does not offer claude.ai login to third parties and
  it deliberately does **not** implement account pooling or rotation to evade rate
  limits — only monitoring, pause, and resume of your own accounts. Review Anthropic's
  Terms of Service yourself; you are responsible for how you use your accounts.
- The per-account usage meters rely on an **undocumented** endpoint (the one behind
  Claude Code's `/usage`); it may change at any time. A local-estimation fallback is
  part of the design.
- Not affiliated with or endorsed by Anthropic.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). While the project is in the design phase, the
most valuable contributions are design review, prior-art pointers, and feedback on the
[open questions in the spec](docs/superpowers/specs/2026-08-03-fabrica-design.md#6-open-questions-defaults-chosen-flag-if-wrong).

## License

[MIT](LICENSE)
