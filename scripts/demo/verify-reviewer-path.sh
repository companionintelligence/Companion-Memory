#!/usr/bin/env bash
#
# Assert that an origin is actually usable by an App Store / Play reviewer.
#
# The trap this exists to catch: a Memory Server can be perfectly healthy and still
# be unreviewable. `app.ci.computer` is a real CI-Server, up and serving, and every
# path answers from Cloudflare's EDGE because a Zero Trust Access policy sits in
# front — a reviewer hits a login wall and never reaches the product. "The box is up"
# and "a reviewer can use it" are different facts, and only the second one ships.
#
# So this checks the reviewer's path from the OUTSIDE, over the public internet, with
# no credentials and no tailnet:
#
#   1. public DNS resolves
#   2. TLS is valid (a cert error is a hard stop on both platforms)
#   3. GET  /api/health   answers 200 FROM THE APP, not from an edge/interstitial
#   4. POST /api/graphql  speaks GraphQL          <- CompanionAPI needs this
#   5. POST /api/llm/generate exists (401/403 ok) <- CompanionAPI needs this too
#   6. no access gate anywhere in front of it
#   7. GET  /           serves the SPA
#
# Usage:  scripts/demo/verify-reviewer-path.sh https://demo.ci.computer
# Exit:   0 = a reviewer can use this origin.  1 = they cannot.
#
# Run it from a network that is NOT the tailnet/LAN the server lives on. Passing from
# inside the perimeter proves nothing about what Apple and Google will see.

set -uo pipefail

ORIGIN="${1:-}"

if [ -z "$ORIGIN" ]; then
  echo "usage: $0 https://demo.ci.computer" >&2
  exit 2
fi

ORIGIN="${ORIGIN%/}"
HOST="$(printf '%s' "$ORIGIN" | sed -E 's#^https?://##; s#[:/].*$##')"
CURL=(curl --silent --show-error --max-time 20)

PASS=0
FAIL=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
note() { printf '    %s\n' "$1"; }

printf '\nReviewer-path check for %s\n\n' "$ORIGIN"

# --- 1. scheme + DNS ---------------------------------------------------------
case "$ORIGIN" in
  https://*) ok "origin is https (no cleartext on the reviewer path)" ;;
  *)         bad "origin is not https — the reviewer path must be TLS"
             note "an http demo undercuts the store 'encrypted in transit' answer" ;;
esac

if RESOLVED="$(dig +short "$HOST" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')" && [ -n "$RESOLVED" ]; then
  ok "public DNS resolves ($RESOLVED)"
else
  bad "public DNS does NOT resolve for $HOST"
  note "a reviewer's device cannot look this up; nothing below can pass"
fi

# --- 2. TLS ------------------------------------------------------------------
if "${CURL[@]}" -o /dev/null "$ORIGIN/api/health" 2>/dev/null; then
  ok "TLS certificate validates"
else
  TLS_ERR="$("${CURL[@]}" -o /dev/null "$ORIGIN/api/health" 2>&1 | head -1)"
  case "$TLS_ERR" in
    *certificate*|*SSL*|*TLS*) bad "TLS certificate does NOT validate: $TLS_ERR" ;;
    *)                         ok  "TLS certificate validates" ;;
  esac
fi

# --- 3. health, and WHO answered it ------------------------------------------
HEALTH_BODY="$(mktemp)"
HEALTH_HDRS="$(mktemp)"
HEALTH_CODE="$("${CURL[@]}" -o "$HEALTH_BODY" -D "$HEALTH_HDRS" -w '%{http_code}' "$ORIGIN/api/health" 2>/dev/null)"

if [ "$HEALTH_CODE" = "200" ]; then
  ok "GET /api/health → 200"
else
  bad "GET /api/health → ${HEALTH_CODE:-no response}"
fi

# A health check that returns HTML is not a health check. The app answers JSON/text;
# an HTML body means something in front of the app replied instead.
if grep -qi '<!doctype html\|<html' "$HEALTH_BODY" 2>/dev/null; then
  bad "/api/health returned an HTML page — an edge/interstitial answered, not the app"
  TITLE="$(grep -io '<title>[^<]*</title>' "$HEALTH_BODY" | head -1)"
  [ -n "$TITLE" ] && note "page title: $TITLE"
else
  ok "/api/health was answered by the application, not an edge page"
fi

# --- 4. access gate ----------------------------------------------------------
# Detecting this needs care, because a gate does not announce itself. Cloudflare
# Access in front of app.ci.computer answers /api/health with a 404 HTML page and
# other paths with a bare 401 — no `cf-mitigated`, no redirect to a login form. What
# gives it away is the SHAPE: a non-2xx served by an edge (`server: cloudflare`)
# with an HTML body, on API paths that answer JSON when the app itself is reached.
GATED=0
GATE_WHY=""

flag_gate() { GATED=1; GATE_WHY="$1"; }

grep -qi '^cf-mitigated:' "$HEALTH_HDRS" && flag_gate "cf-mitigated header"
grep -qi 'cloudflareaccess\.com' "$HEALTH_HDRS" "$HEALTH_BODY" 2>/dev/null &&
  flag_gate "Cloudflare Access login referenced in the response"
grep -qi '^set-cookie:.*CF_Authorization' "$HEALTH_HDRS" &&
  flag_gate "CF_Authorization cookie demanded"

# /api/health is unauthenticated BY DESIGN. Any 401/403/404 there, or an HTML body,
# means something in front answered instead of the app.
case "$HEALTH_CODE" in
  401|403) flag_gate "/api/health → $HEALTH_CODE, but it requires no auth" ;;
esac

if grep -qi '<!doctype html\|<html' "$HEALTH_BODY" 2>/dev/null &&
   grep -qi '^server: *cloudflare' "$HEALTH_HDRS" 2>/dev/null &&
   [ "$HEALTH_CODE" != "200" ]; then
  flag_gate "Cloudflare's edge served an HTML error for /api/health (HTTP $HEALTH_CODE)"
fi

REDIR="$("${CURL[@]}" -o /dev/null -w '%{url_effective}' -L "$ORIGIN/api/health" 2>/dev/null)"
case "$REDIR" in
  *cloudflareaccess.com*|*/cdn-cgi/access/*) flag_gate "redirected to an Access login" ;;
esac

if [ "$GATED" = "1" ]; then
  bad "an ACCESS GATE sits in front of this origin"
  note "evidence: $GATE_WHY"
  note "this is the app.ci.computer failure: healthy box, unreachable product"
  note "remove the Zero Trust Access policy for this hostname"
  case "$REDIR" in *cloudflareaccess.com*|*/cdn-cgi/access/*) note "followed to: $REDIR" ;; esac
else
  ok "no access gate in front of the origin"
fi

# --- 5. the two endpoints CompanionAPI actually calls -------------------------
GQL_BODY="$(mktemp)"
GQL_CODE="$("${CURL[@]}" -o "$GQL_BODY" -w '%{http_code}' -X POST "$ORIGIN/api/graphql" \
  -H 'content-type: application/json' -d '{"query":"{__typename}"}' 2>/dev/null)"

if grep -q '"data"\|"errors"' "$GQL_BODY" 2>/dev/null; then
  ok "POST /api/graphql speaks GraphQL (HTTP $GQL_CODE)"
elif [ "$GQL_CODE" = "401" ] || [ "$GQL_CODE" = "403" ]; then
  ok "POST /api/graphql → $GQL_CODE (endpoint present, auth required)"
else
  bad "POST /api/graphql → ${GQL_CODE:-no response}, and no GraphQL body"
  note "the native client's CompanionAPI calls this; a 404 here means this host is"
  note "not a Memory Server (hub.ci.computer answers 404 — it is the IdP, not the backend)"
fi

LLM_CODE="$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$ORIGIN/api/llm/generate" \
  -H 'content-type: application/json' -d '{}' 2>/dev/null)"
case "$LLM_CODE" in
  404|000) bad "POST /api/llm/generate → ${LLM_CODE:-no response} (endpoint missing)" ;;
  *)       ok "POST /api/llm/generate → $LLM_CODE (endpoint present)" ;;
esac

# --- 6. the SPA --------------------------------------------------------------
ROOT_BODY="$(mktemp)"
ROOT_CODE="$("${CURL[@]}" -o "$ROOT_BODY" -w '%{http_code}' "$ORIGIN/" 2>/dev/null)"

if [ "$ROOT_CODE" = "200" ] && grep -qi '<div id="root"\|<script' "$ROOT_BODY" 2>/dev/null; then
  ok "GET / serves the web app"
else
  bad "GET / → ${ROOT_CODE:-no response} and does not look like the web app"
fi

rm -f "$HEALTH_BODY" "$HEALTH_HDRS" "$GQL_BODY" "$ROOT_BODY"

printf '\n  %s passed, %s failed\n\n' "$PASS" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
  printf '\033[31mA reviewer CANNOT use %s as-is.\033[0m\n\n' "$ORIGIN"
  exit 1
fi

printf '\033[32m%s is reviewer-usable.\033[0m\n\n' "$ORIGIN"
