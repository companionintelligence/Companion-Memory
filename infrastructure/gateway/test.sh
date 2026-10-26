#!/bin/sh
# Unit test for entrypoint.sh: the trusted-proxies block it writes from
# TRUSTED_PROXY_CIDRS. Runs on any POSIX sh, no Docker; the final `exec` is
# pointed at `true`. Wired into `make test` by scripts/xtask/commands/test.ts.
#
# Also reads nginx.conf for its request-body limits (the last section below):
# a static check, since no nginx runs here.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
conf="$work/trusted-proxies.conf"

fail() { echo "FAIL: $*" >&2; exit 1; }
run() { TRUSTED_PROXIES_CONF="$conf" TRUSTED_PROXY_CIDRS="${1-}" sh "$here/entrypoint.sh" true 2>"$work/stderr"; }

# ── unset: an empty block, so nginx trusts nothing
run ""
grep -q "set_real_ip_from" "$conf" && fail "empty value produced a trust line"
grep -q "real_ip_header" "$conf" && fail "empty value enabled real_ip"

# ── the Hub's shape: Traefik as a /32 plus the edge subnet
run "172.19.0.7/32,10.255.254.0/29"
grep -q "^set_real_ip_from 172.19.0.7/32;$" "$conf" || fail "missing Traefik /32"
grep -q "^set_real_ip_from 10.255.254.0/29;$" "$conf" || fail "missing edge subnet"
grep -q "^real_ip_header X-Forwarded-For;$" "$conf" || fail "real_ip_header not set"
grep -q "^real_ip_recursive on;$" "$conf" || fail "real_ip_recursive not set"

# ── separators: spaces work as well as commas; a bare address is fine
run "172.19.0.7 fd00:1::/64"
grep -q "^set_real_ip_from 172.19.0.7;$" "$conf" || fail "bare IPv4 rejected"
grep -q "^set_real_ip_from fd00:1::/64;$" "$conf" || fail "IPv6 CIDR rejected"

# ── junk never becomes a directive
run "172.19.0.7,traefik;include /etc/passwd,10.0.0.0/8"
grep -q "^set_real_ip_from 172.19.0.7;$" "$conf" || fail "valid entry dropped alongside junk"
grep -q "^set_real_ip_from 10.0.0.0/8;$" "$conf" || fail "valid entry after junk dropped"
grep -q "include" "$conf" && fail "junk token reached the config"
grep -q "traefik" "$conf" && fail "hostname token reached the config"
grep -q "ignoring invalid" "$work/stderr" || fail "junk was not reported"
[ "$(grep -c '^set_real_ip_from' "$conf")" = "2" ] || fail "expected exactly two trust lines"

# ── nginx.conf: request bodies are small unless a location streams them
nginx_conf="$here/nginx.conf"

# Each `location` block, flattened to one line: "<location line> | <body>".
blocks=$(awk '
  /^    location / { name = $0; body = ""; inside = 1; next }
  inside && /^    }$/ { print name " |" body; inside = 0; next }
  inside { body = body " " $0 }
' "$nginx_conf")

grep -q '^    client_max_body_size 1m;$' "$nginx_conf" || fail "server block lost its 1m body limit"

# Only the object-store passthrough may still take gigabytes.
big=$(printf '%s\n' "$blocks" | grep -E 'client_max_body_size [0-9]+[gG];' | grep -v '^    location /static/ ' || true)
[ -z "$big" ] || fail "a location other than /static/ allows a body in gigabytes: $big"

# A location that lifts the limit must stream the body to the API, which
# checks the caller first; buffered, nginx would store it before anyone did.
unlimited=$(printf '%s\n' "$blocks" | grep 'client_max_body_size 0;' || true)
[ -n "$unlimited" ] || fail "no location takes large uploads"
printf '%s\n' "$unlimited" | while IFS= read -r block; do
  case "$block" in
    *"proxy_request_buffering off;"*) ;;
    *) fail "unlimited body without proxy_request_buffering off: ${block%% |*}" ;;
  esac
done

# Every route that takes big bodies must reach one of those locations.
set -f  # the patterns hold `?`; keep the shell from globbing them
for path in /api/import/uploads /api/files/upload /api/account/import/stream \
            /api/v1/files /api/v1/communications /api/v1/positions \
            /v1/files /v1/contents /v1/things /v1/browser-activity; do
  matched=no
  for pattern in $(printf '%s\n' "$unlimited" | sed -n 's/^    location ~ \([^ ]*\) {.*/\1/p'); do
    if printf '%s' "$path" | grep -Eq "$pattern"; then matched=yes; fi
  done
  [ "$matched" = yes ] || fail "$path would be capped at the default body size"
done
set +f

# GraphQL and the rest of /v1 keep the API's own 10mb.
printf '%s\n' "$blocks" | grep -F 'location ~ ^/api/graphql/?$ {' | grep -q 'client_max_body_size 10m;' \
  || fail "GraphQL lost its 10m limit"
printf '%s\n' "$blocks" | grep -F 'location /v1/ {' | grep -q 'client_max_body_size 10m;' \
  || fail "/v1/ lost its 10m limit"

# ── nginx.conf: a stopped api answers fast. The api is on the same network, so a
# connect that takes seconds means it is gone; 60s left a sign-in spinning a minute.
slow=$(printf '%s\n' "$blocks" | grep -F 'proxy_pass http://api;' | grep -v 'proxy_connect_timeout 5s;' || true)
[ -z "$slow" ] || fail "an api location waits longer than 5s to connect: ${slow%% |*}"

echo "gateway: ok"
