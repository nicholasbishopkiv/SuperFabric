#!/bin/sh
#
# Bring the egress allow-list up, then hand over.
#
# The firewall is the one thing in this container that needs root, and the image grants the `bun`
# user exactly one passwordless sudo rule to run it. Everything after this line — the runner, the
# CLI it spawns, the agent's tools — is unprivileged.
#
# `SUPERFABRIC_FIREWALL=0` skips it, for an operator whose network controls live elsewhere (the
# same escape hatch Anthropic's devcontainer documents) and for building the image itself. It is
# opt-*out* on purpose: a firewall you have to remember to switch on is not one.

set -e

if [ "${SUPERFABRIC_FIREWALL:-1}" = "1" ]; then
  sudo /usr/local/bin/init-firewall.sh
else
  echo "[entrypoint] firewall disabled by SUPERFABRIC_FIREWALL=0" >&2
fi

# An explicit command wins, which is how the image is inspected (`docker run <image> claude
# --version`) without starting a session. With no command, the container is what it is for: one
# agent, one session.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

exec bun /app/runner.js
