#!/usr/bin/env bash
#
# Stand up the reviewer-facing Companion Memory demo instance.
#
# Run this ON the demo host, from a CI-Server checkout. It brings up an ordinary
# production stack through docker-compose.demo.yml (loopback-only, no GPU passthrough,
# OIDC wired to CI-Portal), seeds it with the John Smith sample memory data, and
# verifies the reviewer's endpoints locally.
#
# It does NOT create public ingress. That is one deliberate manual step in the
# Cloudflare dashboard — see docs/operations/reviewer-demo-server.md — because
# attaching a public hostname is the action that puts a personal-data app on the open
# internet, and because the one thing that must NOT happen is an Access policy
# silently landing in front of it (that is precisely what makes app.ci.computer
# unreviewable). After the tunnel exists, prove the outside view with:
#
#   scripts/demo/verify-reviewer-path.sh https://demo.ci.computer
#
# Required env:
#   DEMO_PUBLIC_ORIGIN   public origin the reviewer will use  (e.g. https://demo.ci.computer)
#   DEMO_ACCOUNT_EMAIL   email of the CI-Portal demo account   (e.g. demo@ci.computer)
#
# Optional env:
#   OIDC_ISSUER_URL      CI-Portal origin (default https://hub.ci.computer)
#   DEMO_GATEWAY_PORT    loopback port for the tunnel to target (default 8642)
#   LLM_API_BASE         OpenAI-compatible chat endpoint; unset means chat will error
#   SKIP_BUILD=1         reuse already-built ci/* images

set -euo pipefail

cd "$(dirname "$0")/../.."

DEMO_PUBLIC_ORIGIN="${DEMO_PUBLIC_ORIGIN:-}"
DEMO_ACCOUNT_EMAIL="${DEMO_ACCOUNT_EMAIL:-}"
OIDC_ISSUER_URL="${OIDC_ISSUER_URL:-https://hub.ci.computer}"
DEMO_GATEWAY_PORT="${DEMO_GATEWAY_PORT:-8642}"

die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

[ -n "$DEMO_PUBLIC_ORIGIN" ] || die "set DEMO_PUBLIC_ORIGIN, e.g. https://demo.ci.computer"
[ -n "$DEMO_ACCOUNT_EMAIL" ] || die "set DEMO_ACCOUNT_EMAIL, e.g. demo@ci.computer"

case "$DEMO_PUBLIC_ORIGIN" in
  https://*) ;;
  *) die "DEMO_PUBLIC_ORIGIN must be https — the reviewer path carries no cleartext" ;;
esac

command -v docker >/dev/null || die "docker is not installed"

# A distinct project name is what isolates this stack's volumes and containers from
# any other CI-Server stack on the same box. Do not remove it.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-ci-demo}"

COMPOSE=(docker compose
  -f docker-compose.yml
  -f docker-compose.production.yml
  -f docker-compose.demo.yml
  --profile production)

# `AUTH_DEFAULT_USER_EMAIL` is the hinge of the whole demo. The OIDC callback resolves
# the signed-in Portal identity with `userService.findByEmail(...)`, so the SEEDED
# user's email must equal the Portal demo account's email. Get this wrong and the
# reviewer signs in perfectly and lands in an empty app — which reads as a broken
# product, not a misconfiguration.
export AUTH_DEFAULT_USER_EMAIL="$DEMO_ACCOUNT_EMAIL"
export APP_BASE_URL="$DEMO_PUBLIC_ORIGIN"
export OIDC_ISSUER_URL
export DEMO_GATEWAY_PORT
export CI_CLOUD_URL="${CI_CLOUD_URL:-$OIDC_ISSUER_URL}"
export SENTRY_ENV="${SENTRY_ENV:-demo}"

step "Configuration"
cat <<CFG
  public origin     $DEMO_PUBLIC_ORIGIN
  portal (issuer)   $OIDC_ISSUER_URL
  demo account      $DEMO_ACCOUNT_EMAIL   (must exist in CI-Portal)
  compose project   $COMPOSE_PROJECT_NAME
  local bind        127.0.0.1:$DEMO_GATEWAY_PORT   (tunnel target)
  chat backend      ${LLM_API_BASE:-<unset — the chat screen will error for the reviewer>}
CFG

# Assert the overlay really did keep the gateway off every public interface. This is
# cheap and it guards a mistake with real consequences on a shared host.
step "Checking the gateway is loopback-only"
PORTS_JSON="$("${COMPOSE[@]}" config --format json 2>/dev/null || true)"
if [ -n "$PORTS_JSON" ]; then
  printf '%s' "$PORTS_JSON" | python3 -c '
import json, sys
ports = json.load(sys.stdin)["services"]["gateway"].get("ports", [])
bad = [p for p in ports if p.get("host_ip") not in ("127.0.0.1", "::1")]
if bad:
    print("  published on a non-loopback interface:", bad)
    sys.exit(1)
print(f"  ok — {len(ports)} published port(s), loopback only")
' || die "gateway would be published publicly; check the ports override in docker-compose.demo.yml"
else
  printf '  (skipped — compose config unavailable)\n'
fi

if [ "${SKIP_BUILD:-}" != "1" ]; then
  step "Building images"
  make build ENV=production
fi

step "Starting the stack"
# Services are named explicitly rather than taken from the profile: the profile also
# contains `powersync`, whose client half is unwired and which holds a Postgres
# replication slot for a reader that does not exist.
"${COMPOSE[@]}" up -d --remove-orphans \
  database object-store api gateway summary-service hbpe-service

step "Waiting for the API to report healthy"
for i in $(seq 1 60); do
  if curl -fsS --max-time 5 "http://127.0.0.1:${DEMO_GATEWAY_PORT}/api/health" >/dev/null 2>&1; then
    printf '  healthy after %ss\n' "$((i * 2))"
    break
  fi
  [ "$i" = 60 ] && die "API never became healthy — check: ${COMPOSE[*]} logs api"
  sleep 2
done

step "Seeding sample memory data"
# Seeds as $AUTH_DEFAULT_USER_EMAIL — see the note above.
make seed-production

step "Verifying the endpoints the native client calls (locally)"
LOCAL="http://127.0.0.1:${DEMO_GATEWAY_PORT}"
for probe in "/api/health" "/"; do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${LOCAL}${probe}")"
  printf '  GET  %-22s %s\n' "$probe" "$CODE"
done
GQL="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "${LOCAL}/api/graphql" \
  -H 'content-type: application/json' -d '{"query":"{__typename}"}')"
printf '  POST %-22s %s\n' "/api/graphql" "$GQL"
LLM="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "${LOCAL}/api/llm/generate" \
  -H 'content-type: application/json' -d '{}')"
printf '  POST %-22s %s\n' "/api/llm/generate" "$LLM"

cat <<NEXT

▸ Local stack is up. Two things remain, and neither is automatable from here:

  1. Public ingress. Point a Cloudflare tunnel at http://127.0.0.1:${DEMO_GATEWAY_PORT}
     and publish it as ${DEMO_PUBLIC_ORIGIN} with NO Access policy.
     Steps: docs/operations/reviewer-demo-server.md

  2. Prove the OUTSIDE view — from a network that is not this host's tailnet/LAN:

       scripts/demo/verify-reviewer-path.sh ${DEMO_PUBLIC_ORIGIN}

     Passing from inside the perimeter proves nothing about what Apple and Google see.

NEXT
