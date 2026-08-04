# `@superfabric/agent-runner`

The program that runs **inside a container** and hosts one SuperFabric session.

It is the far side of the `Executor` seam that has existed since M0. `ClaudeCodeExecutor` hosts the
SDK's `query()` in the server's own process; this hosts the same `query()` somewhere the agent
cannot reach the operator's home directory, their other accounts' credentials, or the internet at
large — and streams back exactly the same `SessionEvent`s. From `SessionManager`'s point of view the
two must be indistinguishable, and everything here is in service of that.

## The protocol

Declared once, in `packages/shared/src/runner.ts`, and validated by both ends.

| | |
|---|---|
| runner → server | `hello` · `frame {seq, body}` · `approval_request` · `bye` |
| server → runner | `attached {ackedSeq}` · `ack {seq}` · `approval_response` · `prompt` · `interrupt` · `stop` · `fatal` |

Three properties are worth stating outright, because they are the reasons this package exists
rather than being a thin pipe:

- **The query outlives the socket.** Events go into a numbered outbox and are held until the server
  acknowledges them. A reconnect is `hello` → `attached {ackedSeq}` → resend the tail. Nothing is
  lost (the runner still holds it); nothing is duplicated (the server applies frames by
  `seq > lastApplied`). Restarting the server must never cost the operator a working agent.
- **The buffer is bounded** — `RUNNER_OUTBOX_LIMIT`, 2000 frames. The runner lives in a
  memory-capped container, so an unbounded buffer would turn a forgotten server restart into an OOM
  kill: losing the agent by the back door. When it fills, the **oldest** events are dropped and the
  gap is replaced in place by a `session_error` counting them, so the record has a hole that says it
  is a hole. The frame carrying the provider session id is pinned and never dropped — without it the
  session is not resumable.
- **Approvals are re-asked, not timed out.** A `canUseTool` becomes an `approval_request` keyed by
  a `requestId`, re-sent on every attach until answered. There is no timeout: an approval card
  nobody has looked at yet is not an error, and the host path waits indefinitely too. ADR 0002 still
  holds — the factory's own tools are never gated, and are still recorded.

Configuration comes from the environment (`RUNNER_ENV` in the shared protocol); a container gets no
argv a human would type. SIGTERM closes the query so the provider session stays resumable, flushes
what it can, says `bye`, and exits.

## Building the image

```bash
pnpm -F @superfabric/agent-runner image     # → superfabric/agent-runner:0.0.1
```

That runs `scripts/build-image.sh`, which does three things in order:

1. builds `@superfabric/shared`;
2. bundles the runner into **one file** (`bun build --target=bun`, with the Agent SDK left
   external);
3. `docker build`, passing the SDK version the workspace actually resolved and tagging the image
   with `RUNNER_IMAGE_TAG` — read out of `@superfabric/shared` rather than typed into the script, so
   the tag the build produces and the tag the server looks for are one string.

**How `@superfabric/shared` gets into the image: it is bundled in.** Not vendored, not installed as
a workspace package. The runner is one JS file with the shared protocol and zod inlined, which means
the image contains no workspace, no pnpm, no lockfile and no `node_modules` beyond the Agent SDK
itself — and the protocol inside the image is compiled from the same source tree as the server's, so
the two cannot be built from different code. The SDK is deliberately *not* bundled: it ships and
spawns its own `claude` binary out of its own package directory, so it has to exist on disk as a
real package.

The image runs as the non-root `bun` user (uid 1000). The only thing that ever runs as root is the
firewall script, through a single passwordless sudo rule that names that one file.

## The firewall

`init-firewall.sh` is adapted from [Anthropic's reference
devcontainer](https://github.com/anthropics/claude-code/blob/main/.devcontainer/init-firewall.sh)
(read 2026-08-04). The *structure* is theirs; the **domain list is not**, and the script's header
explains each departure. In short: the reference has not been touched since 2025-08 and has drifted
from Anthropic's own [network access
requirements](https://code.claude.com/docs/en/network-config) — it allow-lists `sentry.io` and
`statsig.*`, which the docs no longer mention, and omits `platform.claude.com`, which is where
**OAuth token refresh** goes. Shipping that omission would break every contained session a few days
after its token was last refreshed, with nothing in any log to explain it.

Allowed, by default, and nothing else:

| Host | Why |
|---|---|
| `api.anthropic.com` | inference, the WebFetch domain safety check, feature flags |
| `claude.ai` | claude.ai account authentication |
| `claude.com` | sign-in starts here and redirects to claude.ai |
| `platform.claude.com` | OAuth token exchange, **refresh** and revocation |
| the bridge gateway | only the TCP fallback needs it; the default transport is a unix socket (below) |
| DNS (53), loopback | — |

Telemetry hosts are *disabled* rather than allow-listed
(`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` in the image). IPv6 egress is denied outright. Levers,
all off by default: `SUPERFABRIC_FIREWALL_EXTRA_DOMAINS`, `SUPERFABRIC_FIREWALL_GITHUB=1`,
`SUPERFABRIC_FIREWALL_HOST_NETWORK=1` (the reference's whole-/24 rule), and `SUPERFABRIC_FIREWALL=0`
to skip the firewall entirely for an operator whose network controls live elsewhere.

Requires `--cap-add=NET_ADMIN --cap-add=NET_RAW`. The script verifies itself before it returns:
`example.com` must be refused and `api.anthropic.com` must be reachable, or it exits non-zero and
the container never starts an agent.

**Known limitation, inherited:** addresses are resolved once, at container start. Anthropic's hosts
sit behind CDNs whose addresses rotate, so a very long-lived container can lose access to something
still on the list; restarting re-resolves. A DNS-proxy firewall would fix it properly.

### Verified on this machine, 2026-08-04

```
$ docker run --rm --cap-add=NET_ADMIN --cap-add=NET_RAW superfabric/agent-runner:0.0.1 claude --version
[init-firewall] verified: https://example.com is refused
[init-firewall] verified: https://api.anthropic.com is reachable
[init-firewall] firewall up
2.1.220 (Claude Code)
```

- **Allowed works:** an unauthenticated `POST https://api.anthropic.com/v1/messages` from inside the
  firewalled container returned a real `401 authentication_error` with a `request_id` — a complete
  TLS round trip to Anthropic, with no prompt and no quota spent.
- **Blocked works:** `example.com`, `pypi.org` and `raw.githubusercontent.com` were all refused in
  2–6 ms (the `REJECT`, not a timeout).
- All four allow-listed names resolve to one anycast address on this network, which is exactly the
  case where the reference script's `ipset add` exits 1
  ([#15611](https://github.com/anthropics/claude-code/issues/15611)); `-exist` here handles it.

### How the runner reaches the server: a unix socket, not the bridge

The container *can* reach the bridge gateway through our own firewall — but the **host's `ufw` drops
traffic from `docker0`**, which is the default on Debian, Ubuntu and Arch, so
`http://host.docker.internal:<port>` times out even with `SUPERFABRIC_FIREWALL=0`. The fix for that
would be one rule the machine's operator has to add:

```bash
sudo ufw allow in on docker0 from 172.17.0.0/16 to any port <runner port> proto tcp
```

**So the server does not ask for it.** `ContainerExecutor` bind-mounts the directory holding a unix
socket into the container (read-only) and hands the runner `ws+unix:///superfabric/runner.sock:/runner`
in `SUPERFABRIC_SERVER_URL`. Bun's `WebSocket` client understands that form, which is why nothing in
this package needed changing for it: **the transport is entirely a property of the URL**. Verified on
this machine, 2026-08-04, with the firewall up, a read-only rootfs and the non-root user: the
connection opens and round-trips.

The gateway rule in `init-firewall.sh` (`host reachable at the gateway only`) therefore has nothing
to carry by default. It stays because the TCP fallback (`SUPERFABRIC_RUNNER_TCP_PORT` on the server)
still needs it — a Docker daemon that does not share this filesystem cannot use the socket — and
because it is narrower than the reference script's whole-/24 rule either way.
