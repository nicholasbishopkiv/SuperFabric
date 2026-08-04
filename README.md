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

Requires Node 22+, [pnpm](https://pnpm.io) 9+, [Bun](https://bun.sh) 1.3+ (the server runs
and tests on Bun; installs and the web toolchain stay on Node/pnpm), and a working `claude`
login (M0 uses your current `~/.claude` account; multi-account arrives in M2). See
[docs/ROADMAP.md](docs/ROADMAP.md) and
[docs/decisions/0001-bun-runtime-keep-vite.md](docs/decisions/0001-bun-runtime-keep-vite.md).

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
- **The attachment upload endpoint is gated by the same allow-list.** `POST /attachments`
  writes files into your repository, so it is exactly as strict as the WebSocket handshake:
  the same origins, 403 for anything else, checked before the body is read. Filenames from
  the browser are folded to a single safe path segment, the resolved path is verified to be
  inside the destination folder, nothing is ever overwritten (a taken name becomes
  `shot-2.png`), and a file over 25 MB is refused.
- **There is no authentication.** Anyone who can run code on the machine — or on any host you
  add to `SUPERFABRIC_ALLOWED_ORIGINS` — can drive your agents and approve their tool calls.
  Don't run SuperFabric on a shared host, and don't expose the port through a tunnel.
- **Agents default to `auto` autonomy**: Claude Code's own classifier decides on each gated tool
  call, so an approval card is the exception rather than the rule. Switch an agent to `attended`
  and every gated action asks you first. `bypass` disables gating entirely — the agent runs any
  command without asking — and is a deliberate per-agent opt-in. Autonomy is stored per session
  and survives a server restart.
- **`bypass` means something different in each runtime, and the UI says which.** On a **host**
  room an ungated agent *is you*: your whole filesystem, every credential on the machine, the
  open internet. The badge reads `ungated · uncontained` and it is telling the truth. In a
  **container** room the same agent can reach one folder, one account's credentials, two CPUs
  and Anthropic — so the badge reads just `ungated`, and the blast radius is a thing you chose
  the size of. Nothing about an agent you already configured was changed when this arrived:
  `bypass` on a host room is still available, still yours to pick, and now honestly labelled.
- **A room can run its agents in a container** (`host` is the default; the picker is on the room
  panel). What a contained agent gets, and nothing else:
  | | |
  |---|---|
  | that room's folder | read-write — it is what the agent is for |
  | that account's `CLAUDE_CONFIG_DIR` | read-write; the CLI rewrites its refresh token in place |
  | the runner socket's directory | read-only |
  | CPU / memory / processes | 2 cores, 2 GiB, 512 pids (`SUPERFABRIC_CONTAINER_*` to change) |
  | the filesystem it boots from | read-only, with `/tmp` and `$HOME` as tmpfs |
  | the network | default-deny; Anthropic's API and auth hosts only |
  | the user it runs as | non-root (uid 1000) |

  Never your `~/.claude`, never another account's directory, never the docker socket, and never
  the project root when the room lives somewhere else. A container room **needs an account of its
  own** — the ambient `~/.claude` is not mounted into a sandbox, so an unbound container room
  refuses to start rather than quietly handing over your home directory.
- **Containers reach the server over a unix socket, not a port.** The socket lives in a directory
  of its own under the data directory, bind-mounted into each container read-only, `0600`. No new
  network listener exists: the server still binds `127.0.0.1` and nothing else, and the
  container's own egress allow-list needs no hole back to the host. Each container is additionally
  given a random 256-bit token that the server checks on attach, so one container cannot claim
  another's session even though they share the socket. (A TCP fallback exists for a Docker daemon
  that does not share this filesystem — `SUPERFABRIC_RUNNER_TCP_PORT`. It *is* a network listener
  reachable from every container on the machine, and on a host running `ufw` it also needs
  `sudo ufw allow in on docker0 from 172.17.0.0/16 to any port <port> proto tcp`. Prefer the
  socket.)

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

TypeScript · pnpm workspaces · Bun (server runtime, test runner and `bun:sqlite`) · Node 22+
(web toolchain) · Fastify + WebSocket · zod ·
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
