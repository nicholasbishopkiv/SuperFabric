#!/usr/bin/env bash
#
# SuperFabric bootstrap: take a machine from "nothing installed" to "pnpm dev works".
#
# Everything here is **detect first, install second**, and every step reports what it actually did.
# A bootstrap that reinstalls what is already there is a bootstrap nobody runs twice, and one that
# says "done" after silently skipping half of itself is worse than no script at all — so the summary
# at the end lists each component as one of: already present, installed now, or still missing (with
# the reason and the command to fix it).
#
# It installs, in this order:
#   1. system packages   git, curl, unzip, plus a Node 22+ if the distro has one
#   2. runtimes          Node (22+), pnpm, Bun 1.3+            — what the workspace itself needs
#   3. the Claude CLI    @anthropic-ai/claude-code             — the engine every agent runs on
#   4. the toolkit       marketplaces, plugins and their MCP servers (superpowers, …)
#   5. this repo         pnpm install
#   6. optional          Docker check, and the agent-runner image for container rooms (--with-image)
#
# It never logs anyone in: `claude auth login` is the operator's own step and the summary says so.
#
# Usage:
#   scripts/setup.sh [--yes] [--no-sudo] [--skip-toolkit] [--skip-docker] [--with-image] [--dry-run]
#
set -uo pipefail

ASSUME_YES=0
USE_SUDO=1
SKIP_TOOLKIT=0
SKIP_DOCKER=0
WITH_IMAGE=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y)       ASSUME_YES=1 ;;
    --no-sudo)      USE_SUDO=0 ;;
    --skip-toolkit) SKIP_TOOLKIT=1 ;;
    --skip-docker)  SKIP_DOCKER=1 ;;
    --with-image)   WITH_IMAGE=1 ;;
    --dry-run)      DRY_RUN=1 ;;
    --help|-h)
      sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "unknown option: $arg (try --help)" >&2
      exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MIN_MAJOR=22
BUN_MIN_MINOR=3   # Bun 1.3+: `Bun.YAML.parse`, which the role library uses

# ---- output -------------------------------------------------------------------------------------

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; OFF=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$BOLD" "$OFF" "$BOLD" "$1" "$OFF"; }
info() { printf '    %s\n' "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$OFF"; }
warn() { printf '    %s!%s %s\n' "$YELLOW" "$OFF" "$1"; }
fail() { printf '    %sx%s %s\n' "$RED" "$OFF" "$1"; }

# The summary is built as it goes, so it can never disagree with what happened.
SUMMARY=()
record() { SUMMARY+=("$1|$2|$3"); }        # state | component | detail
present() { printf '    %s.%s %s\n' "$GREEN" "$OFF" "$2"; record present "$1" "$2"; }
installed() { printf '    %s+%s %s\n' "$GREEN" "$OFF" "$2"; record installed "$1" "$2"; }
missing() { fail "$2"; record missing "$1" "$2"; }

have() { command -v "$1" >/dev/null 2>&1; }

# Every command that changes the machine goes through here, so --dry-run is honest by construction
# rather than by each call site remembering to check.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    note "would run: $*"
    return 0
  fi
  "$@"
}

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || { warn "not a terminal and no --yes; skipping: $1"; return 1; }
  printf '    %s [y/N] ' "$1"
  read -r reply
  case "$reply" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# ---- the machine --------------------------------------------------------------------------------

OS="$(uname -s)"
PM=""
PM_INSTALL=""

detect_package_manager() {
  if [ "$OS" = "Darwin" ]; then
    if have brew; then PM="brew"; PM_INSTALL="brew install"; fi
    return
  fi
  if have pacman;  then PM="pacman";  PM_INSTALL="pacman -S --needed --noconfirm"; return; fi
  if have apt-get; then PM="apt";     PM_INSTALL="apt-get install -y";             return; fi
  if have dnf;     then PM="dnf";     PM_INSTALL="dnf install -y";                 return; fi
  if have zypper;  then PM="zypper";  PM_INSTALL="zypper --non-interactive install"; return; fi
  if have apk;     then PM="apk";     PM_INSTALL="apk add";                        return; fi
}

# `sudo` only where it is both needed and available. A container running as root needs none, and a
# machine without sudo should be told what to run rather than watch a command fail.
as_root() {
  if [ "$(id -u)" = "0" ]; then run "$@"; return $?; fi
  if [ "$USE_SUDO" = 1 ] && have sudo; then run sudo "$@"; return $?; fi
  warn "needs root: $*"
  return 1
}

pm_install() {
  [ -n "$PM" ] || { warn "no supported package manager found; install manually: $*"; return 1; }
  # brew must not run as root, every other one must.
  if [ "$PM" = "brew" ]; then run brew install "$@"; else as_root $PM_INSTALL "$@"; fi
}

# ---- 1. system packages -------------------------------------------------------------------------

detect_package_manager

step "System packages"
if [ -z "$PM" ]; then
  warn "no package manager detected (looked for pacman, apt, dnf, zypper, apk, brew)"
  note "the checks below still run; anything missing is listed at the end with what to install"
else
  info "package manager: $PM"
fi

# `unzip -v` and friends do not all answer `--version`, so a version we could not read is simply not
# printed — a component line reading "unzip ()" says less than "unzip".
version_of() { "$1" --version 2>/dev/null | head -1; }

for tool in git curl unzip; do
  if have "$tool"; then
    v="$(version_of "$tool")"
    present "$tool" "$tool${v:+ ($v)}"
  elif pm_install "$tool"; then
    installed "$tool" "$tool"
  else
    missing "$tool" "$tool — install it with your package manager"
  fi
done

# ---- 2. runtimes --------------------------------------------------------------------------------

node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

step "Node $NODE_MIN_MAJOR+"
if have node && [ "$(node_major)" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null; then
  present node "node $(node -v)"
else
  if have node; then warn "node $(node -v) is older than $NODE_MIN_MAJOR"; fi
  case "$PM" in
    pacman) pm_install nodejs npm ;;
    apt)    as_root apt-get update >/dev/null 2>&1; pm_install nodejs npm ;;
    dnf)    pm_install nodejs npm ;;
    zypper) pm_install nodejs npm ;;
    apk)    pm_install nodejs npm ;;
    brew)   pm_install node ;;
    *)      : ;;
  esac
  if have node && [ "$(node_major)" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null; then
    installed node "node $(node -v)"
  else
    # Deliberately not reaching for nvm/fnm here: putting a second version manager on someone's
    # machine is a bigger decision than this script gets to make on its own.
    missing node "Node $NODE_MIN_MAJOR+ — your distro's package is too old; install it from https://nodejs.org or with nvm/fnm"
  fi
fi

step "pnpm"
if have pnpm; then
  present pnpm "pnpm $(pnpm -v)"
elif have corepack && run corepack enable pnpm >/dev/null 2>&1 && have pnpm; then
  # Corepack ships with Node, so this is the install that adds nothing to the machine.
  installed pnpm "pnpm $(pnpm -v) (via corepack)"
elif have npm && run npm install -g pnpm >/dev/null 2>&1 && have pnpm; then
  installed pnpm "pnpm $(pnpm -v) (via npm -g)"
else
  missing pnpm "pnpm — install with: corepack enable pnpm"
fi

step "Bun 1.$BUN_MIN_MINOR+"
bun_minor() { bun -v 2>/dev/null | cut -d. -f2; }
if have bun && [ "$(bun_minor)" -ge "$BUN_MIN_MINOR" ] 2>/dev/null; then
  present bun "bun $(bun -v)"
else
  if have bun; then
    warn "bun $(bun -v) predates Bun.YAML, which the role library uses — upgrading"
    run bun upgrade >/dev/null 2>&1
  else
    info "installing bun from https://bun.sh/install"
    if [ "$DRY_RUN" = 1 ]; then note "would run: curl -fsSL https://bun.sh/install | bash"
    else curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1; fi
    # The installer writes to ~/.bun and edits a shell rc that this process has already read.
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"
  fi
  if have bun && [ "$(bun_minor)" -ge "$BUN_MIN_MINOR" ] 2>/dev/null; then
    installed bun "bun $(bun -v)"
    note "add to your shell rc if it is not there: export PATH=\"\$HOME/.bun/bin:\$PATH\""
  else
    missing bun "Bun 1.$BUN_MIN_MINOR+ — install with: curl -fsSL https://bun.sh/install | bash"
  fi
fi

# ---- 3. the Claude CLI --------------------------------------------------------------------------

step "Claude Code CLI"
if have claude; then
  present claude "claude $(claude --version 2>/dev/null | head -1)"
else
  info "installing from https://claude.ai/install.sh"
  if [ "$DRY_RUN" = 1 ]; then
    note "would run: curl -fsSL https://claude.ai/install.sh | bash"
  else
    curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1
    export PATH="$HOME/.local/bin:$PATH"
    # The native installer is the documented route; npm is the fallback for a machine where it did
    # not land on PATH (and the package is the same CLI the Agent SDK drives).
    have claude || run npm install -g @anthropic-ai/claude-code >/dev/null 2>&1
  fi
  if have claude; then
    installed claude "claude $(claude --version 2>/dev/null | head -1)"
  else
    missing claude "the Claude Code CLI — install with: curl -fsSL https://claude.ai/install.sh | bash"
  fi
fi

# Whether this machine has a subscription logged in. SuperFabric adopts `~/.claude` as an account on
# boot when it does, so this is exactly what decides whether the accounts list opens populated.
CLAUDE_LOGGED_IN=0
if [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" ]; then CLAUDE_LOGGED_IN=1; fi

# ---- 4. the toolkit: marketplaces, plugins, MCP servers -----------------------------------------
#
# The plugins are the skills an agent in this factory can be given (`roles/*.yaml` resolves skill
# names against this machine), plus the MCP servers those plugins bring with them. Each entry is
# `plugin@marketplace`, which is what `claude plugin install` takes.

MARKETPLACES=(
  "anthropics/claude-plugins-official"
  "https://github.com/jordanrendric/claude-video-vision.git"
)
PLUGINS=(
  "superpowers@claude-plugins-official"        # brainstorming, TDD, systematic debugging, plans
  "chrome-devtools-mcp@claude-plugins-official" # a real browser for front-end work
  "claude-video-vision@claude-video-vision"    # watching a screen recording of a bug
)

step "Claude toolkit (skills and MCP servers)"
if [ "$SKIP_TOOLKIT" = 1 ]; then
  note "skipped (--skip-toolkit)"
elif ! have claude; then
  missing toolkit "plugins — needs the Claude CLI, which is not installed"
else
  installed_marketplaces="$(claude plugin marketplace list 2>/dev/null || true)"
  for source in "${MARKETPLACES[@]}"; do
    name="$(basename "$source" .git)"
    if printf '%s' "$installed_marketplaces" | grep -qi -- "$name"; then
      present "marketplace:$name" "marketplace $name"
    elif run claude plugin marketplace add "$source" >/dev/null 2>&1; then
      installed "marketplace:$name" "marketplace $name"
    else
      missing "marketplace:$name" "marketplace $name — add it with: claude plugin marketplace add $source"
    fi
  done

  installed_plugins="$(claude plugin list 2>/dev/null || true)"
  for plugin in "${PLUGINS[@]}"; do
    short="${plugin%@*}"
    if printf '%s' "$installed_plugins" | grep -q -- "$short@"; then
      present "plugin:$short" "plugin $short"
    elif run claude plugin install "$plugin" >/dev/null 2>&1; then
      installed "plugin:$short" "plugin $short"
    else
      missing "plugin:$short" "plugin $short — install it with: claude plugin install $plugin"
    fi
  done
  note "plugins bring their own MCP servers; \`claude mcp list\` shows what is wired"
  note "SuperFabric agents get the factory bus and their role's servers only — never these (strictMcpConfig)"
fi

# ---- 5. this repository -------------------------------------------------------------------------

step "Workspace"
if have pnpm; then
  info "pnpm install (this is always pnpm, never bun install — see docs/decisions/0001)"
  if run env -C "$REPO_ROOT" pnpm install; then
    installed workspace "dependencies installed"
  else
    missing workspace "pnpm install failed — run it by hand in $REPO_ROOT"
  fi
else
  missing workspace "pnpm install — pnpm is not available"
fi

# ---- 6. Docker and the container image ----------------------------------------------------------

step "Docker (only needed for container rooms)"
if [ "$SKIP_DOCKER" = 1 ]; then
  note "skipped (--skip-docker)"
elif have docker && docker info >/dev/null 2>&1; then
  present docker "docker $(docker -v | sed 's/,.*//')"
  if [ "$WITH_IMAGE" = 1 ]; then
    info "building the agent-runner image (several minutes)"
    if run env -C "$REPO_ROOT" pnpm -F @superfabric/agent-runner image; then
      installed image "agent-runner image"
    else
      missing image "agent-runner image — build it with: pnpm -F @superfabric/agent-runner image"
    fi
  else
    note "container rooms also need the image: pnpm -F @superfabric/agent-runner image (or re-run with --with-image)"
  fi
elif have docker; then
  warn "docker is installed but the daemon is not reachable"
  record missing docker "docker daemon — start it (systemctl start docker) and add yourself to the docker group"
else
  # Deliberately not installed unattended: Docker is a daemon, a group membership and a security
  # decision on someone's machine, and every room defaults to `host` without it.
  note "not installed — every room runs on the host, which is the default. Install Docker only if you want sandboxed rooms."
  record missing docker "docker — optional; install it if you want container rooms"
fi

# ---- summary ------------------------------------------------------------------------------------

printf '\n%s==> Summary%s\n' "$BOLD" "$OFF"
for row in "${SUMMARY[@]}"; do
  state="${row%%|*}"; rest="${row#*|}"; detail="${rest#*|}"
  case "$state" in
    present)   printf '    %s.%s %s\n' "$GREEN" "$OFF" "$detail" ;;
    installed) printf '    %s+%s %s\n' "$GREEN" "$OFF" "$detail" ;;
    missing)   printf '    %sx%s %s\n' "$RED" "$OFF" "$detail" ;;
  esac
done

printf '\n%s==> Next%s\n' "$BOLD" "$OFF"
if [ "$CLAUDE_LOGGED_IN" = 1 ]; then
  info "this machine is logged in — SuperFabric will show that subscription as an account on first boot"
else
  info "log in:  claude auth login        (or add an account from the UI once the server is up)"
fi
info "start:   pnpm dev                  (server on 127.0.0.1:4620, UI on http://localhost:5173)"
info "then:    open the UI and point it at a project folder — nothing is created until you do"

# Missing things are worth an exit code: a CI or a provisioning run has to be able to tell.
for row in "${SUMMARY[@]}"; do
  case "${row%%|*}" in missing) exit 1 ;; esac
done
exit 0
