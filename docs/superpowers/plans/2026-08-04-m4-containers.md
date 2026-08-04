# M4 — Containers: a sandbox per room

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** A room can run its agents inside a container instead of on the host — with only that account's credentials mounted, only its own workspace visible, capped CPU/memory/processes, and default-deny egress. That is what makes `bypass` autonomy genuinely safe rather than held back by a warning label in the UI.

**Architecture:** The `Executor` interface, which has existed since M0 for exactly this, gets a second implementation. `ContainerExecutor` creates a container via dockerode and starts an `agent-runner` inside it; the runner hosts the SDK `query()` for one session and streams the same events back over a WebSocket. The server keeps every other responsibility — the event log, approvals, the bus, limits — unchanged. A room chooses `host` (today's behaviour, the default) or `container`.

**Probed before planning, on this machine:**
- Docker 29.6.2, user in the `docker` group, daemon reachable.
- `dockerode` works under Bun (pure JS over the unix socket) — `d.info()` returned the live server version.
- The SDK's bundled Linux binary runs inside an `oven/bun:1.3.14` container: `claude --version` → `2.1.220 (Claude Code)`. The image builds in a few minutes.

**Conventions:** server tests `bun test`, web/shared vitest, installs pnpm. **Never set `SUPERFABRIC_LIVE_TEST=1`; never prompt a real agent** except in the acceptance task. Commit per task.

---

### Task 1: The agent-runner

- [ ] New package `packages/agent-runner`: a Bun program taking a session id, a server URL and a token from the environment, opening a WebSocket to the server, and hosting exactly one SDK `query()`.
- [ ] It speaks the **same `SessionEvent` vocabulary** the local executor emits — reuse `@superfabric/shared`, do not invent a second event language. Approvals travel the same way: `canUseTool` becomes a request over the socket and waits for the answer.
- [ ] It must survive the server going away: if the socket drops, keep the query alive, buffer events, and re-attach on reconnect. Losing a running agent because the operator restarted the server would be worse than the host path we already have.
- [ ] Tests: the runner's protocol handling with a fake socket and the injected `query` seam (the same technique `claudeExecutor.test.ts` uses). No container needed for these.

### Task 2: The image

- [ ] `packages/agent-runner/Dockerfile` on `oven/bun`, with git, ripgrep and ca-certificates, the SDK, and the runner. Non-root user.
- [ ] A build step the server can invoke (or a documented `docker build`), and a tag the server looks for. Building on demand at first run is acceptable if the wait is visible in the UI; a silent five-minute stall is not.
- [ ] `init-firewall.sh` adapted from Anthropic's reference devcontainer: default-deny egress with an allowlist for the Anthropic API and auth domains. **Verify the allowlist actually permits a session to start and blocks something else** — an untested firewall is decoration.

### Task 3: ContainerExecutor

- [ ] `ContainerExecutor implements Executor` using dockerode. Per session: create, start, wait for the runner to attach, then behave exactly like the local executor from `SessionManager`'s point of view. `stop()` must leave the provider session resumable and remove the container.
- [ ] **Mounts, minimally:** the room's workspace (rw), that account's `CLAUDE_CONFIG_DIR` (rw — tokens refresh in place) and nothing else. Never the host's `~/.claude`, never the project root when the room lives elsewhere, never the docker socket.
- [ ] **Limits:** `Memory`, `NanoCpus`, `PidsLimit`, and a read-only rootfs with writable tmpfs where the runtime needs it if that does not fight the CLI.
- [ ] **Auth for the runner→server socket:** a per-container token the server generates and checks. The WebSocket origin allow-list does not cover a non-browser client, so this is a new surface — treat it with the same seriousness as `origin.ts` (which is the worked example) and test that a wrong token is refused.
- [ ] Container→host networking: on Linux the runner reaches the server via the bridge gateway (`--add-host=host.docker.internal:host-gateway`). Verify it rather than assuming.
- [ ] Tests: the executor's contract against a fake dockerode (create/start/attach/stop ordering, mounts and limits as passed, a failed start reported as `session_error` not a crash); the token check.

### Task 4: Rooms choose their runtime

- [ ] `rooms.runtime` (`host` | `container`), default `host`; migration. Per-room, chosen in the room panel, with the trade-off stated in one line rather than a paragraph.
- [ ] `SessionManager` picks the executor from the room's runtime. Everything downstream — the log, approvals, the bus, limits, resume — must work identically. That equivalence is the point of the seam; test it rather than assuming it.
- [ ] The floor shows which rooms are sandboxed.
- [ ] **`bypass` autonomy**: keep it available on host rooms (it is the operator's machine and their choice) but make the UI say plainly that it is only *contained* in a container room. Do not silently change what the operator already chose.

### Task 5: Acceptance

- [ ] A container room and a host room side by side. **One live turn in the container room**: give it a trivial task that writes a file, and confirm the file appears in the room's workspace on the host, the event log looks identical to a host session's, and an approval card still round-trips.
- [ ] Kill the server mid-session and restart: the container survives and the session resumes.
- [ ] Prove the isolation: from inside the container, the host home directory and other accounts' config dirs are not reachable, and egress to a non-allowlisted host fails.
- [ ] Update `docs/ROADMAP.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`, and the README's security section (this changes what "bypass" means).

---

## Self-review notes

- **Covers** the last infrastructural item in the vision: a container per room with the firewall and resource caps, which is the stated precondition for routine `bypass`.
- **Deferred to M5**: glTF agent characters, burn-rate metrics, factory export/import.
- **Biggest risk** is not Docker — that is probed — but the runner's reconnect behaviour, which is where a bug loses a running agent. Task 1 makes it explicit rather than incidental.
- **Second risk** is the new auth surface (runner→server). It is called out as a first-class task item rather than a detail, because a token check nobody tested is the kind of thing that quietly admits anything.
