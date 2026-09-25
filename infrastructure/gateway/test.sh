#!/bin/sh
# Unit test for entrypoint.sh: the trusted-proxies block it writes from
# TRUSTED_PROXY_CIDRS. Runs on any POSIX sh, no Docker; the final `exec` is
# pointed at `true`. Wired into `make test` by scripts/xtask/commands/test.ts.
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

echo "gateway: ok"
