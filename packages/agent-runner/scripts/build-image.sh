#!/usr/bin/env bash
#
# Build the agent-runner container image.
#
#   pnpm -F @superfabric/agent-runner image
#
# Three steps, in this order and for this reason:
#
#  1. build `@superfabric/shared`, because the runner bundle inlines it;
#  2. bundle the runner into one file, so the image needs no workspace, no pnpm and no lockfile;
#  3. `docker build`, with the SDK version the workspace actually resolved and the tag the *server*
#     looks for — both read from the tree rather than typed here, so they cannot drift.
#
# Everything is idempotent; re-running it rebuilds the layers that changed and nothing else.

set -euo pipefail

pkg_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${pkg_dir}/../.." && pwd)"
cd "${pkg_dir}"

echo "==> building @superfabric/shared (the bundle inlines it)"
pnpm --dir "${repo_root}" -F @superfabric/shared build

echo "==> bundling the runner"
pnpm --dir "${pkg_dir}" run bundle

# The exact SDK version this workspace resolved. The image must run the same one the server was
# developed against: the CLI it spawns is the agent.
sdk_version="$(node -p "require('${pkg_dir}/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version")"

# The tag the server looks for, straight out of the shared protocol so there is one string.
tag="$(cd "${pkg_dir}" && node --input-type=module -e \
  'import { RUNNER_IMAGE_TAG } from "@superfabric/shared"; process.stdout.write(RUNNER_IMAGE_TAG);')"

echo "==> docker build ${tag} (agent SDK ${sdk_version})"
docker build \
  --build-arg "SDK_VERSION=${sdk_version}" \
  --tag "${tag}" \
  "$@" \
  "${pkg_dir}"

echo "==> built ${tag}"
docker run --rm --entrypoint /usr/local/bin/claude "${tag}" --version
