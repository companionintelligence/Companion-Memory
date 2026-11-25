#!/bin/sh
# Unit test for entrypoint.sh: the trusted-proxies block it writes from
# TRUSTED_PROXY_CIDRS. Runs on any POSIX sh, no Docker; the final `exec` is
# pointed at `true`. Wired into `make test` by scripts/xtask/commands/test.ts.
#
# Also reads nginx.conf for its request-body limits, what /static/ may reach and
# its upstreams (the sections below): static checks, since no nginx runs here.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
conf="$work/trusted-proxies.conf"

fail() { echo "FAIL: $*" >&2; exit 1; }
run() { TRUSTED_PROXIES_CONF="$conf" ALLOWED_HOSTS_CONF="$work/allowed-hosts.conf" TRUSTED_PROXY_CIDRS="${1-}" sh "$here/entrypoint.sh" true 2>"$work/stderr"; }

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
# Comment-only lines are left out, so prose naming a directive satisfies nothing.
blocks=$(awk '
  /^    location / { name = $0; body = ""; inside = 1; next }
  inside && /^    }$/ { print name " |" body; inside = 0; next }
  inside && /^[[:space:]]*#/ { next }
  inside { body = body " " $0 }
' "$nginx_conf")

grep -q '^    client_max_body_size 1m;$' "$nginx_conf" || fail "server block lost its 1m body limit"

# The location that serves signed object links, /static/<bucket>/<uuid>.
static_link='    location ~ "^/static/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" {'

# Only the object-store passthrough may still take gigabytes.
big=$(printf '%s\n' "$blocks" | grep -E 'client_max_body_size [0-9]+[gG];' | grep -vF "$static_link |" || true)
[ -z "$big" ] || fail "a location other than the /static/ object links allows a body in gigabytes: $big"

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

# ── nginx.conf: /static/ reaches the object store only for a signed object link,
# /static/<bucket>/<uuid> (what FileService.signFile signs). Every other path under
# /static/ answers 404, so the store's own endpoints stay internal.
store=$(printf '%s\n' "$blocks" | grep -F 'proxy_pass http://object_store' || true)
store_names=$(printf '%s\n' "$store" | sed 's/ |.*//')
[ "$(printf '%s\n' "$store" | grep -c .)" = "1" ] \
  || fail "expected exactly one location to reach the object store, found: ${store_names:-none}"
case "$store" in
  "$static_link |"*) ;;
  *) fail "the object store is reached from ${store%% |*}, not the signed-link location" ;;
esac
fallback=$(printf '%s\n' "$blocks" | grep -F '    location /static/ { |' || true)
[ "$(printf '%s\n' "$fallback" | grep -c .)" = "1" ] || fail "expected one 'location /static/' block"
case "$fallback" in *"return 404;"*) ;; *) fail "location /static/ does not answer 404" ;; esac
case "$fallback" in *proxy_pass*) fail "location /static/ passes requests on instead of answering 404" ;; esac

# The regex itself, on the shapes it must admit and refuse (nginx matches the
# decoded, normalized path, without the query).
static_re=$(printf '%s\n' "$static_link" | sed -n 's/^    location ~ "\(.*\)" {$/\1/p')
[ -n "$static_re" ] || fail "could not read the signed-link regex"
for path in /static/companion/b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d \
            /static/ci-files/B3F1C2D4-5E6F-4A7B-8C9D-0E1F2A3B4C5D; do
  printf '%s' "$path" | LC_ALL=C grep -Eq "$static_re" || fail "$path is a signed-link shape but would answer 404"
done
for path in /static/ /static/health /static/minio/health/live /static/rustfs/rpc/x /static/companion \
            /static/companion/ /static/companion/not-a-uuid \
            /static/companion/b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/x; do
  if printf '%s' "$path" | LC_ALL=C grep -Eq "$static_re"; then fail "$path would reach the object store"; fi
done

# ── nginx.conf: a stopped upstream answers fast. Every upstream is on the same
# network, so a connect that takes seconds means it is gone; at nginx's 60s
# default a sign-in sat on a dead api address for about 40s. The server block
# sets it once and no location may set its own, so a new one cannot miss it.
grep -q '^    proxy_connect_timeout 5s;$' "$nginx_conf" || fail "server block lost its 5s connect timeout"
own=$(printf '%s\n' "$blocks" | grep -F 'proxy_connect_timeout' || true)
[ -z "$own" ] || fail "a location sets its own connect timeout instead of the server's 5s: ${own%% |*}"

# ── nginx.conf: upstream names are looked up again, not once at start. A
# container recreated on a new address (an update, a crash and `up -d`) was
# unreachable until the gateway restarted. Every upstream server carries
# `resolve` (which needs a `zone`), the resolver overrides Docker's 600s TTL,
# and every proxy_pass names one of those upstreams, never a host of its own,
# which nginx would resolve once.
grep -Eq '^  resolver 127\.0\.0\.11 valid=[0-9]+s ' "$nginx_conf" || fail "resolver lost its valid= override of Docker's TTL"
upstreams=$(awk '
  /^  upstream / { name = $2; body = ""; inside = 1; next }
  inside && /^  }$/ { print name " |" body; inside = 0; next }
  inside && /^[[:space:]]*#/ { next }
  inside { body = body " " $0 }
' "$nginx_conf")
[ -n "$upstreams" ] || fail "no upstream blocks found"
printf '%s\n' "$upstreams" | while IFS= read -r block; do
  case "$block" in *" zone "*) ;; *) fail "upstream ${block%% |*} has no zone, which resolve needs" ;; esac
  servers=$(printf '%s\n' "$block" | grep -o 'server [^;]*;' || true)
  [ -n "$servers" ] || fail "upstream ${block%% |*} has no server"
  printf '%s\n' "$servers" | grep -v ' resolve' | grep -q . && fail "upstream ${block%% |*} has a server without resolve"
  true
done
names=$(printf '%s\n' "$upstreams" | sed 's/ |.*//')
grep -E '^[[:space:]]*proxy_pass ' "$nginx_conf" | sed -E 's#.*proxy_pass https?://([^/:;]+).*#\1#' | while IFS= read -r host; do
  printf '%s\n' "$names" | grep -qx "$host" \
    || fail "proxy_pass names $host, not one of the upstreams above (a name of its own is resolved once, at start)"
done

# ── nginx.conf: a Companion sign-in's credentials stay out of the access log.
# Its start and callback carry them in the query, and the access log writes the
# whole request line. /oauth/callback turns its own log off for the same reason.
grep -q '^  access_log /var/log/nginx/access.log combined if=$loggable_request;$' "$nginx_conf" \
  || fail "the access log no longer skips the sign-in routes"
grep -q '^  map $uri $loggable_request {$' "$nginx_conf" || fail "the sign-in log filter no longer reads the routed path"
grep -Fxq '    "~*^(?:/api)?/authenticate/oidc\b"   0;' "$nginx_conf" \
  || fail "the sign-in routes are logged again"
# A location's own access_log replaces the http-level one, `if=` and all, so
# only `access_log off;` may appear in one.
own_log=$(printf '%s\n' "$blocks" | grep -E 'access_log ' | grep -vE 'access_log off;' || true)
[ -z "$own_log" ] || fail "a location writes its own access log, sign-in routes included: ${own_log%% |*}"

# The error log too: an unreachable api makes nginx write the request line,
# query and all, at level "error". The sign-in routes keep only "crit".
printf '%s\n' "$blocks" | grep -F '    location /api/ {' | tr -s ' ' \
  | grep -Fq ' location ~* ^/api/authenticate/oidc(?:/|$) { error_log /var/log/nginx/error.log crit; proxy_pass http://api; rewrite ^/api/(.*)$ /$1 break; }' \
  || fail "the sign-in routes' request lines reach the error log"

# ── GATEWAY_ALLOWED_HOSTS: the DNS-rebinding guard (entrypoint.sh)
hosts="$work/allowed-hosts.conf"
run_hosts() { ALLOWED_HOSTS_CONF="$hosts" TRUSTED_PROXIES_CONF="$conf" GATEWAY_ALLOWED_HOSTS="${1-}" sh "$here/entrypoint.sh" true 2>"$work/stderr"; }

# unset: every Host passes, as before
run_hosts ""
grep -q '^map \$host \$gateway_host_allowed {$' "$hosts" || fail "no map when unset"
grep -q '^  default 1;$' "$hosts" || fail "unset list does not pass every Host"
grep -q ' 0;$' "$hosts" && fail "unset list refuses something"

# set: only the names, IP literals and localhost pass; everything else is refused
run_hosts "Memory.Example.org, box.tail1.ts.net"
grep -q '^  default 0;$' "$hosts" || fail "a set list still passes unknown Hosts"
grep -q '^  memory.example.org 1;$' "$hosts" || fail "listed name missing or not lowercased"
grep -q '^  box.tail1.ts.net 1;$' "$hosts" || fail "second listed name missing"
grep -q '^  localhost 1;$' "$hosts" || fail "localhost refused"
grep -Fq '"~^[0-9]{1,3}(\.[0-9]{1,3}){3}$" 1;' "$hosts" || fail "IPv4 literals refused"

# a name the built-in lines pass already, or one given twice, is written once at most:
# nginx refuses a map that names a key twice
run_hosts "localhost,box.localhost,dup.example,DUP.example"
[ "$(grep -c '^  localhost 1;$' "$hosts")" -eq 1 ] || fail "localhost written twice"
grep -q '^  box.localhost 1;$' "$hosts" && fail "a .localhost name written beside its pattern"
[ "$(grep -c '^  dup.example 1;$' "$hosts")" -eq 1 ] || fail "a repeated name written twice"

# junk never becomes a directive
run_hosts "ok.example,evil.example;include /etc/passwd,{}"
grep -q '^  ok.example 1;$' "$hosts" || fail "valid name dropped alongside junk"
grep -q "include" "$hosts" && fail "junk token reached the map"
grep -q "evil" "$hosts" && fail "a name with a semicolon reached the map"

# nginx.conf reads the map and refuses before any location
grep -q '^  include /etc/nginx/allowed-hosts.conf;$' "$here/nginx.conf" || fail "nginx.conf does not include the host map"
awk '/^    listen 8642;/{s=1} s&&/gateway_host_allowed = 0/{print NR; exit}' "$here/nginx.conf" > "$work/guard"
awk '/^    listen 8642;/{s=1} s&&/^    location /{print NR; exit}' "$here/nginx.conf" > "$work/first"
[ -s "$work/guard" ] || fail "no Host guard in the server block"
[ "$(cat "$work/guard")" -lt "$(cat "$work/first")" ] || fail "the Host guard comes after a location"

echo "gateway: ok"
