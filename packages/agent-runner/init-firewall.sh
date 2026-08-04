#!/bin/bash
#
# SuperFabric: default-deny egress for a contained agent.
#
# Adapted from Anthropic's reference devcontainer script
# (https://github.com/anthropics/claude-code/blob/main/.devcontainer/init-firewall.sh, read
# 2026-08-04). The structure is theirs: preserve Docker's embedded DNS, allow DNS and loopback,
# build an ipset of resolved allow-listed addresses, set the default policies to DROP, allow
# ESTABLISHED/RELATED, allow the ipset, REJECT the rest for immediate feedback, then verify.
#
# The **domain list is not theirs**, and that is deliberate. The reference script has not been
# touched since 2025-08 and has drifted from Anthropic's own network requirements
# (https://code.claude.com/docs/en/network-config, "Network access requirements"): it allow-lists
# `sentry.io` and `statsig.*`, which the docs no longer list at all, and it omits
# `platform.claude.com` — the host OAuth token *refresh* goes to. Omitting that would break every
# session on this image a few days after it was built, with nothing in any log to explain it, which
# is the exact failure mode SuperFabric's one-directory-one-account invariant exists to avoid. So
# the list below comes from the docs, and is cut down to what an agent in a factory room actually
# needs.
#
# Other deliberate differences from the reference:
#
#  - **Telemetry is disabled rather than allow-listed.** The image sets
#    `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, which the docs say turns off both Datadog intake
#    hosts, so neither has to be opened. Not sending it beats permitting it.
#  - **GitHub is opt-in** (`SUPERFABRIC_FIREWALL_GITHUB=1`), not always on. A room that needs to
#    push asks for it; a room that does not should not be able to reach github.com.
#  - **The host is reachable at the gateway address only**, not across its whole /24. The runner has
#    exactly one reason to talk to the host — the SuperFabric server — and the reference's /24 hands
#    the container the operator's entire LAN segment. `SUPERFABRIC_FIREWALL_HOST_NETWORK=1` restores
#    the wider rule for anyone who needs it.
#  - **IPv6 is denied too.** The reference is IPv4-only, so on any host with IPv6 in the container
#    its allow-list is decoration. Here v6 is dropped outright: nothing we allow needs it.
#  - **`ipset add -exist`**, because two allow-listed names routinely resolve to one address and the
#    reference exits 1 when they do (anthropics/claude-code#15611).
#
# Known limitation, inherited and worth stating: addresses are resolved **once, here**. Anthropic's
# hosts sit behind CDNs whose addresses rotate, so a long-lived container can lose access to
# something that is still on the list. Restarting the container re-resolves. A DNS-proxy firewall
# would fix it properly and is out of scope for M4.
#
# Requires: NET_ADMIN and NET_RAW. Run as root (the image gives the `bun` user one passwordless
# sudo rule, for this file and nothing else).

set -euo pipefail
IFS=$'\n\t'

log() { echo "[init-firewall] $*"; }

# The hosts a factory agent needs, and why. Anything not here is refused.
DOMAINS=(
  "api.anthropic.com"     # inference, the WebFetch domain safety check, feature flags
  "claude.ai"             # claude.ai account authentication
  "claude.com"            # sign-in starts here and redirects to claude.ai
  "platform.claude.com"   # OAuth token exchange, refresh and revocation — see the note above
)

# The operator's own additions, comma- or space-separated. A room that legitimately needs
# `registry.npmjs.org` or `code.claude.com` says so rather than everyone getting them.
if [ -n "${SUPERFABRIC_FIREWALL_EXTRA_DOMAINS:-}" ]; then
  IFS=', ' read -r -a EXTRA <<< "${SUPERFABRIC_FIREWALL_EXTRA_DOMAINS}"
  IFS=$'\n\t'
  for d in "${EXTRA[@]}"; do [ -n "$d" ] && DOMAINS+=("$d"); done
fi

# ---------------------------------------------------------------------------
# 1. Keep Docker's embedded DNS working across the flush
# ---------------------------------------------------------------------------
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true

if [ -n "$DOCKER_DNS_RULES" ]; then
  log "restoring Docker DNS rules"
  iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
  iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
  echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
else
  log "no Docker DNS rules to restore"
fi

# ---------------------------------------------------------------------------
# 2. DNS and loopback, before anything is restricted
# ---------------------------------------------------------------------------
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A INPUT -p udp --sport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A INPUT -p tcp --sport 53 -m state --state ESTABLISHED -j ACCEPT
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# ---------------------------------------------------------------------------
# 3. Resolve the allow-list into an ipset
# ---------------------------------------------------------------------------
ipset create allowed-domains hash:net

for domain in "${DOMAINS[@]}"; do
  log "resolving $domain"
  ips=$(dig +short +time=5 +tries=2 A "$domain" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
  if [ -z "$ips" ]; then
    log "ERROR: failed to resolve $domain"
    exit 1
  fi
  while read -r ip; do
    [ -z "$ip" ] && continue
    log "  + $ip ($domain)"
    # -exist: two of these names routinely share an address, and a duplicate is not an error.
    ipset add -exist allowed-domains "$ip"
  done <<< "$ips"
done

if [ "${SUPERFABRIC_FIREWALL_GITHUB:-0}" = "1" ]; then
  log "adding GitHub IP ranges (SUPERFABRIC_FIREWALL_GITHUB=1)"
  gh_ranges=$(curl -fsS --connect-timeout 10 https://api.github.com/meta || true)
  if [ -z "$gh_ranges" ] || ! echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null 2>&1; then
    log "ERROR: could not fetch usable GitHub IP ranges"
    exit 1
  fi
  while read -r cidr; do
    [[ "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]] || continue
    ipset add -exist allowed-domains "$cidr"
  done <<< "$(echo "$gh_ranges" | jq -r '(.web + .api + .git)[]')"
fi

# ---------------------------------------------------------------------------
# 4. The host: the SuperFabric server, and nothing else by default
# ---------------------------------------------------------------------------
HOST_IP=$(ip route | grep '^default' | awk '{print $3}' | head -n1)
if [ -z "$HOST_IP" ]; then
  log "ERROR: failed to detect the gateway address"
  exit 1
fi
if [ "${SUPERFABRIC_FIREWALL_HOST_NETWORK:-0}" = "1" ]; then
  HOST_TARGET=$(echo "$HOST_IP" | sed "s/\.[0-9]*$/.0\/24/")
  log "host network opened wide: $HOST_TARGET (SUPERFABRIC_FIREWALL_HOST_NETWORK=1)"
else
  HOST_TARGET="$HOST_IP"
  log "host reachable at the gateway only: $HOST_TARGET"
fi
iptables -A INPUT -s "$HOST_TARGET" -j ACCEPT
iptables -A OUTPUT -d "$HOST_TARGET" -j ACCEPT

# ---------------------------------------------------------------------------
# 5. Default deny
# ---------------------------------------------------------------------------
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT
# REJECT rather than DROP: a blocked call fails in milliseconds instead of hanging for a minute,
# so an agent that hits the wall says so in its own log instead of looking stuck.
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

# IPv6: nothing on the allow-list needs it, and an unfiltered v6 stack would make the whole of the
# above decoration wherever the container has one.
if command -v ip6tables >/dev/null 2>&1 && ip6tables -L >/dev/null 2>&1; then
  ip6tables -F 2>/dev/null || true
  ip6tables -P INPUT DROP 2>/dev/null || true
  ip6tables -P FORWARD DROP 2>/dev/null || true
  ip6tables -P OUTPUT DROP 2>/dev/null || true
  ip6tables -A INPUT -i lo -j ACCEPT 2>/dev/null || true
  ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
  log "IPv6 egress denied"
else
  log "no usable ip6tables; IPv6 not configured in this container"
fi

# ---------------------------------------------------------------------------
# 6. Verify. An untested firewall is decoration.
# ---------------------------------------------------------------------------
if curl --connect-timeout 5 -sS https://example.com >/dev/null 2>&1; then
  log "ERROR: verification failed — https://example.com was reachable"
  exit 1
fi
log "verified: https://example.com is refused"

if ! curl --connect-timeout 5 -sS -o /dev/null https://api.anthropic.com/ 2>/dev/null; then
  log "ERROR: verification failed — https://api.anthropic.com is NOT reachable"
  exit 1
fi
log "verified: https://api.anthropic.com is reachable"

log "firewall up"
