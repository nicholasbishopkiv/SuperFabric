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
  all on one screen. Add a task without picking a department and the orchestrator reads it,
  chooses the **room**, and tells that room it has work. (It assigns the department, not the
  individual agent; picking one of a room's agents is still yours.) With no orchestrator on
  the floor nothing is fabricated — the card stays visibly unassigned and says why.
- **Roles library** — assign a role and get a ready bundle: role prompt + recommended
  skills + MCP servers + model. **Eleven presets ship** (architect, backend, data,
  designer, devops, frontend, generalist, qa, security, tech-writer, plus the
  `onboarding` role the factory puts on an agent itself); they are plain YAML files in
  [`roles/`](roles/README.md) that you can fork, and `<data dir>/roles/` overrides any of
  them by id. No expertise in Claude Code configuration required.
- **Decision chronicle** — every prompt, decision, and its reasoning is preserved and
  searchable (ADR files in the repo + full-text index). Agents consult it before
  reworking anything; you always know *why* the product is built the way it is.
- **Burn rate, not a token total** — beside each account's meters, "at this rate you have
  about two hours": the slope of the real utilisation history, projected to the point the
  scheduler pauses agents. With too little history it says **unknown** rather than
  guessing. Plus a cost-equivalent per account and per room, marked approximate because it
  is one (no pricing table exists in this project — the figure is the CLI's own).
- **Move a factory** — export the floor (rooms, staffing, board, decision index) to one
  JSON file and rebuild it elsewhere. The file holds **no credentials**: accounts travel
  as the labels you gave them and you re-bind them on import, and the import reports
  everything it could not do rather than skipping it quietly.
- **Add accounts from the UI** — a link to open and a box for the code Claude gives back,
  against a `CLAUDE_CONFIG_DIR` of that account's own; rooms and agents are bound to the
  account you choose. (Not a terminal: `claude auth login` turns out to need no TTY —
  [decision 0004](docs/decisions/0004-account-login-over-a-pipe.md).) Claude Code is the
  only executor that ships; other engines (Codex/ChatGPT agents, Antigravity, …) are
  post-v1 behind an executor abstraction that exists but has one implementation.

## Status

**M0 through M5 are complete** (2026-08-04) — the milestones in
[docs/ROADMAP.md](docs/ROADMAP.md), each with the acceptance evidence for it recorded
there. In short: the 3D factory floor with rooms-as-folders and agents that walk, fetch
packages and work in smoking workshops; several projects in one server; a multi-account
limit monitor with warn/pause/auto-resume; the inter-room bus, the task board, the
orchestrator and the decision chronicle; the roles library and the onboarding interview;
an optional container per room; burn-rate metrics; and factory export/import.
**1,344 tests green** (shared 88, server 807 + 1 live-quota test run by hand, web 419,
agent-runner 30).

**It has not been used in anger by anyone but its author, and a list of what is
deliberately *not* built** — phone push notifications, a folder picker, multi-provider
executors, the 50-role expansion, and more — is at the end of
[docs/ROADMAP.md](docs/ROADMAP.md#what-is-not-built). Read it before assuming a feature
exists.

```bash
pnpm install
pnpm -F @superfabric/server dev   # 127.0.0.1:4620
pnpm -F @superfabric/web dev      # open the printed Vite URL
```

Requires Node 22+, [pnpm](https://pnpm.io) 9+, [Bun](https://bun.sh) 1.3+ (the server runs
and tests on Bun; installs and the web toolchain stay on Node/pnpm), and a `claude` login.
Agents run on your ambient `~/.claude` until you add an account, which is what every
session did before multi-account arrived and still is the default. Container rooms
additionally need the runner image, built once with
`pnpm -F @superfabric/agent-runner image`. See [docs/ROADMAP.md](docs/ROADMAP.md) and
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
- **An exported factory carries no credentials.** `Export this factory` writes rooms, their
  positions and runtimes, the staffing, the board and the decision index. It contains no
  token, nothing read from any `CLAUDE_CONFIG_DIR`, no account id, and no absolute path at
  all — accounts appear only as the labels you typed, and importing asks you to re-bind
  each one. This is asserted by a test that greps the exported bytes for the token shapes
  and for every configured config directory (`test/factoryPortability.test.ts`), because a
  promise in a README is not a test.
- **Nothing in SuperFabric refreshes an account's OAuth token itself** — the `claude` CLI
  does, in place, inside that account's directory. One directory is one account, which is
  enforced, so two *accounts* can never fight over one file. Several sessions of the *same*
  account do share one directory and one credentials file, and SuperFabric does not
  serialise their refreshes: the CLI's own behaviour there is undocumented and we have not
  observed a failure, but it is a real gap rather than something we handle.
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

Russian originals: [README.ru.md](README.ru.md) · [VISION.ru.md](docs/VISION.ru.md) ·
[ROADMAP.ru.md](docs/ROADMAP.ru.md) · [RESEARCH.ru.md](docs/RESEARCH.ru.md). **The three
under `docs/` are the documents these were translated from and have not been kept in step
since M1b** — each says so at the top and points here. The English files are authoritative;
`ARCHITECTURE.md` has never had a Russian counterpart.

## Stack

TypeScript · pnpm workspaces · Bun 1.3+ (server runtime, test runner and `bun:sqlite`) ·
Node 22+ (web toolchain) · Fastify + WebSocket (`ws`) · zod 4 ·
[`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk/overview) ·
React 19 + Vite + vitest · react-three-fiber + drei (Three.js) · zustand · Tailwind v4 ·
Radix primitives vendored as shadcn-style components · lucide-react · dockerode.

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
  Claude Code's `/usage`); it has already changed once under us and may again. A
  local-estimation fallback is part of the design, and every figure derived from it is
  marked as an estimate on screen — hatched bar, `≈`, and the reason in words.
- The **cost figures are cost-equivalents, not bills.** On a subscription no money changes
  hands per turn; the number is what the CLI reported the same work would cost through the
  API, reconstructed per turn from a counter that accumulates per session. SuperFabric has
  no pricing table anywhere and never multiplies tokens by a rate.
- Not affiliated with or endorsed by Anthropic.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The most valuable contributions now are running it
on a real project and saying where it lies to you, and anything on the
[not-built list](docs/ROADMAP.md#what-is-not-built).

## License

[MIT](LICENSE)
