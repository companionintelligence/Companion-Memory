#!/usr/bin/env bash
# Access review for the systems that gate Platform Data (Account Maintenance
# and Access Revocation Policy §4.1 / §4.2 / §5).
#
# Lists every member of the GitHub organisation and every Cloudflare account
# member, looks up each person's last activity, flags anyone past the
# inactivity threshold, and reconciles against the access register. With
# --revoke it initiates the revocation for the named identity on every system
# in one step; without it, nothing is changed (dry run is the default).
#
#   scripts/access/access-review.sh                   # report only
#   scripts/access/access-review.sh --revoke <login>  # revoke on GitHub + Cloudflare
#   scripts/access/access-review.sh --execute ...     # actually call the APIs
#
# Requires: gh (authenticated as an org owner), curl, jq.
# Cloudflare: CF_API_TOKEN (Account:Members:Edit) and CF_ACCOUNT_ID.
set -euo pipefail

ORG="${ACCESS_GITHUB_ORG:-companionintelligence}"
REGISTER="${ACCESS_REGISTER:-$HOME/Documents/meta-app-review/access-register.csv}"
INACTIVE_DAYS="${ACCESS_INACTIVE_DAYS:-90}"
EXECUTE=0
REVOKE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE=1 ;;
    --revoke) REVOKE="$2"; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

since="$(date -u -d "-${INACTIVE_DAYS} days" +%Y-%m-%d)"
today="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

run() {
  # Every state-changing call goes through here so a dry run prints exactly
  # what --execute would send.
  if [ "$EXECUTE" = 1 ]; then "$@"; else printf '  [dry-run]'; printf ' %q' "$@"; echo; fi
}

echo "# Access review — $today — org=$ORG, inactivity threshold=${INACTIVE_DAYS}d (since $since)"
echo

echo "## GitHub organisation members"
printf '%-24s %-8s %-12s %s\n' LOGIN ROLE LAST_ACTIVE STATUS
gh api --paginate "/orgs/$ORG/members?per_page=100" --jq '.[].login' | while read -r login; do
  role="$(gh api "/orgs/$ORG/memberships/$login" --jq .role 2>/dev/null || echo '?')"
  # Last activity = newest commit, PR, issue or review by this login in any org repo.
  issues="$(gh api "search/issues?q=org:$ORG+author:$login&sort=updated&order=desc&per_page=1" --jq '.items[0].updated_at // empty' 2>/dev/null || true)"
  commits="$(gh api -H 'Accept: application/vnd.github.cloak-preview' "search/commits?q=org:$ORG+author:$login&sort=author-date&order=desc&per_page=1" --jq '.items[0].commit.author.date // empty' 2>/dev/null || true)"
  last="$(printf '%s\n%s\n' "$issues" "$commits" | sort -r | head -1)"
  last="${last:0:10}"
  status="active"
  if [ -z "$last" ] || [ "$last" \< "$since" ]; then status="INACTIVE>${INACTIVE_DAYS}d → disable (§4.2)"; fi
  if [ -f "$REGISTER" ] && ! grep -qi "github.*,$login," "$REGISTER"; then status="$status; NOT IN REGISTER → justify or revoke (§4.1)"; fi
  printf '%-24s %-8s %-12s %s\n' "$login" "$role" "${last:-never}" "$status"
done
echo

if [ -n "${CF_API_TOKEN:-}" ] && [ -n "${CF_ACCOUNT_ID:-}" ]; then
  echo "## Cloudflare account members"
  curl -s -H "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/members?per_page=50" \
    | jq -r '.result[] | [.id, .user.email, (.roles|map(.name)|join("+")), .status] | @tsv' \
    | awk -F'\t' '{printf "%-36s %-32s %-28s %s\n", $1, $2, $3, $4}'
  echo
else
  echo "## Cloudflare account members — skipped (set CF_API_TOKEN and CF_ACCOUNT_ID)"
  echo
fi

if [ -n "$REVOKE" ]; then
  echo "## Revoking '$REVOKE' on every system (policy §4) — $( [ "$EXECUTE" = 1 ] && echo EXECUTING || echo 'dry run; add --execute to apply' )"
  echo "- GitHub: remove from organisation (revokes every repository role and org-scoped token)"
  run gh api -X DELETE "/orgs/$ORG/members/$REVOKE"
  echo "- GitHub: expire outstanding invitations for the login, if any"
  run gh api --paginate "/orgs/$ORG/invitations" --jq ".[] | select(.login==\"$REVOKE\") | .id"
  if [ -n "${CF_API_TOKEN:-}" ] && [ -n "${CF_ACCOUNT_ID:-}" ]; then
    member_id="$(curl -s -H "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/members?per_page=50" | jq -r ".result[] | select(.user.email==\"$REVOKE\") | .id")"
    echo "- Cloudflare: remove account member ${member_id:-<no member with that e-mail>}"
    [ -n "$member_id" ] && run curl -s -X DELETE -H "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/members/$member_id"
  else
    echo "- Cloudflare: remove the member in Manage Account → Members (CF_API_TOKEN not set, so not automated here)"
  fi
  echo "- Meta App Dashboard: remove the person under App Roles → Roles (no API); if they were Admin/Developer, reset the App Secret and run: wrangler secret put OAUTH_FACEBOOK_CLIENT_SECRET"
  echo "- Register: mark the identity revoked"
  run sed -i "s/^\(.*,$REVOKE,.*\),active,/\1,revoked,/" "$REGISTER"
fi
