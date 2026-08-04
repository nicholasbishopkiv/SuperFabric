# The sandbox a contained SuperFabric session runs in: one agent, one session, one socket home.
#
# Build it with `scripts/build-image.sh` (or `pnpm -F @superfabric/agent-runner image`) rather than
# by hand — the script builds `@superfabric/shared`, bundles the runner, and passes the SDK version
# the workspace actually resolved, so the image and the server can never be built from different
# code. See README.md in this directory.
#
# Single stage on purpose. The runner arrives as one already-bundled file, so there is nothing to
# compile here; a builder stage would only add a pnpm install of the whole workspace to every build.
ARG BUN_VERSION=1.3.14
FROM oven/bun:${BUN_VERSION}

# ca-certificates — TLS to api.anthropic.com, without which every session fails at the first call.
# git, ripgrep      — the agent's own tools; Claude Code shells out to both constantly.
# curl, dnsutils, jq, iproute2, iptables, ipset — the firewall and its self-check.
# sudo              — the single privileged action a non-root runner is allowed (see entrypoint.sh).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      ripgrep \
      curl \
      dnsutils \
      jq \
      iproute2 \
      iptables \
      ipset \
      sudo \
 && rm -rf /var/lib/apt/lists/*

# One rule, one file, no password: the `bun` user may run the firewall script and nothing else.
RUN echo 'bun ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh' > /etc/sudoers.d/superfabric-firewall \
 && chmod 0440 /etc/sudoers.d/superfabric-firewall

WORKDIR /app

# The Agent SDK stays a real dependency rather than being bundled: it ships and spawns its own
# `claude` binary out of its own package directory, so it has to exist on disk as a package.
# The version is passed in by the build script from the workspace's resolved version.
ARG SDK_VERSION=0.3.220
RUN printf '{"name":"superfabric-agent-runner-image","private":true,"dependencies":{"@anthropic-ai/claude-agent-sdk":"%s"}}\n' "${SDK_VERSION}" > package.json \
 && bun install \
 && ln -sf /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude /usr/local/bin/claude \
 && /usr/local/bin/claude --version

# The runner itself: one file, with `@superfabric/shared` and zod bundled in.
COPY dist/bundle/runner.js /app/runner.js
COPY init-firewall.sh /usr/local/bin/init-firewall.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/init-firewall.sh /usr/local/bin/entrypoint.sh

# The account's CLAUDE_CONFIG_DIR is mounted here (read-write: the CLI rewrites its refresh token in
# place), and the room's workspace here. Created up front and owned by the runtime user so a bind
# mount lands on a directory that already has the right owner.
ENV CLAUDE_CONFIG_DIR=/config
RUN mkdir -p /config /workspace && chown -R bun:bun /config /workspace /app

# Anthropic's docs say this switches off both optional telemetry destinations. Disabling them beats
# allow-listing them: two fewer hosts the sandbox has to trust.
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Non-root. The agent runs as `bun` (uid 1000, already in the base image); the only thing that ever
# runs as root is the firewall script, through the one sudo rule above.
USER bun
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
