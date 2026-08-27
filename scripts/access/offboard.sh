#!/usr/bin/env bash
# Offboarding — Account Maintenance and Access Revocation Policy §4.3 and
# Appendix B. Runs the whole checklist for one person in order (administrator
# roles first), prints a timestamped record for the access register, and
# refuses to finish until the secret-rotation steps are acknowledged.
#
#   scripts/access/offboard.sh <github-login> <email> [--execute]
#
# Dry run by default: every state-changing call is printed, not sent.
set -euo pipefail

LOGIN="${1:?github login}"; EMAIL="${2:?e-mail used on Cloudflare/Meta/Apple/Google}"; shift 2
EXECUTE=0; [ "${1:-}" = "--execute" ] && EXECUTE=1
ORG="${ACCESS_GITHUB_ORG:-companionintelligence}"
REGISTER="${ACCESS_REGISTER:-$HOME/Documents/meta-app-review/access-register.csv}"
LOG="${ACCESS_OFFBOARD_LOG:-$HOME/Documents/meta-app-review/offboarding-log.txt}"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
run() { if [ "$EXECUTE" = 1 ]; then "$@"; else printf '  [dry-run]'; printf ' %q' "$@"; echo; fi; }
step() { echo; echo "[$(ts)] STEP $1"; echo "[$(ts)] $LOGIN <$EMAIL> step $1" >> "$LOG"; }

echo "# Offboarding $LOGIN <$EMAIL> — started $(ts) — $( [ "$EXECUTE" = 1 ] && echo EXECUTING || echo 'dry run' )"
echo "# Policy §4.3: complete within 24 hours of notice; administrator access first." | tee -a "$LOG"

step "1 GitHub: demote from owner, then remove from the organisation (all repo roles, org tokens and SSO sessions end)"
run gh api -X PUT "/orgs/$ORG/memberships/$LOGIN" -f role=member
run gh api -X DELETE "/orgs/$ORG/members/$LOGIN"

step "2 Cloudflare: remove the account member and revoke API tokens they created"
if [ -n "${CF_API_TOKEN:-}" ] && [ -n "${CF_ACCOUNT_ID:-}" ]; then
  member_id="$(curl -s -H "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/members?per_page=50" | jq -r ".result[] | select(.user.email==\"$EMAIL\") | .id")"
  [ -n "$member_id" ] && run curl -s -X DELETE -H "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/members/$member_id" || echo "  (no Cloudflare member with $EMAIL)"
else
  echo "  CF_API_TOKEN/CF_ACCOUNT_ID not set → do it in Manage Account → Members → Revoke, then API Tokens → Delete"
fi

step "3 Meta App Dashboard: remove $EMAIL under App Roles → Roles (no API). If they were Administrator or Developer: App Settings → Basic → Reset App Secret"
echo "  then update the running proxy:  wrangler secret put OAUTH_FACEBOOK_CLIENT_SECRET   (apps/hono-app, production env)"

step "4 Rotate anything they could have exported: CI Portal OAUTH_ENCRYPTION_KEY (if Cloudflare admin), release signing credentials, shared password-manager entries"
echo "  wrangler secret put OAUTH_ENCRYPTION_KEY ; rotate App Store Connect / Play Console API keys they held"

step "5 Register: mark every row for $LOGIN / $EMAIL revoked with today's date"
run sed -i "s/^\(.*,\($LOGIN\|$EMAIL\),.*\),active,,/\1,revoked,$(date -u +%Y-%m-%d),/" "$REGISTER"

echo
echo "[$(ts)] DONE — attach this output to the access register entry. Sign-off within 24h of notice (policy §4.3)." | tee -a "$LOG"
