#!/bin/sh
# Unit test for entrypoint.sh: first boot, upgrade of an older master, and the
# per-service projection map. Runs against a temp dir on any POSIX sh — no
# Docker. Wired into `make test` by scripts/xtask/commands/test.ts.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

master="$work/master/.env.secrets"
root="$work/services"
run() { SECRETS_FILE="$master" SECRETS_PROJECTION_ROOT="$root" sh "$here/entrypoint.sh" >/dev/null; }

fail() { echo "FAIL: $*" >&2; exit 1; }
value() { grep -m1 "^$2=" "$1" | cut -d= -f2-; }
has() { grep -q "^$2=" "$1"; }
# Octal permission bits. GNU and busybox stat take -c %a; BSD/macOS stat
# rejects -c and spells it -f %Lp, and `make test` runs this on both.
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

# ── first boot
run
[ -f "$master" ] || fail "master not created"
[ "$(mode "$master")" = "600" ] || fail "master is $(mode "$master"), want 600"
for svc in api database setup-database object-store hbpe summary powersync tooling; do
  [ -f "$root/$svc/.env.secrets" ] || fail "no projection for $svc"
  [ "$(mode "$root/$svc/.env.secrets")" = "644" ] || fail "$svc projection is not 644"
done

# The api holds the signing secrets; nothing else does.
has "$root/api/.env.secrets" AUTH_TOKEN_SECRET || fail "api lacks AUTH_TOKEN_SECRET"
has "$root/api/.env.secrets" AUTH_FIELD_ENCRYPTION_KEY || fail "api lacks AUTH_FIELD_ENCRYPTION_KEY"
for svc in database setup-database object-store hbpe summary powersync tooling; do
  if grep -q "^AUTH_" "$root/$svc/.env.secrets"; then fail "$svc projection carries an AUTH_* secret"; fi
done

# The sidecars get their role and the shared bearer, not the object store.
has "$root/hbpe/.env.secrets" SIDECAR_AUTH_SECRET || fail "hbpe lacks SIDECAR_AUTH_SECRET"
has "$root/hbpe/.env.secrets" DATABASE_PASSWORD || fail "hbpe lacks DATABASE_PASSWORD"
has "$root/summary/.env.secrets" SIDECAR_AUTH_SECRET || fail "summary lacks SIDECAR_AUTH_SECRET"
if has "$root/hbpe/.env.secrets" OBJECT_STORE_PASSWORD; then fail "hbpe can read the object store"; fi

# Postgres sees only the superuser; the object store only its own pair.
[ "$(grep -c '^[A-Z_]*=' "$root/database/.env.secrets")" = "3" ] || fail "database projection is not exactly the 3 admin keys"
[ "$(grep -c '^[A-Z_]*=' "$root/object-store/.env.secrets")" = "2" ] || fail "object-store projection is not exactly its 2 keys"
if has "$root/database/.env.secrets" DATABASE_PASSWORD; then fail "database can read the app role password"; fi

# Values are copied verbatim.
[ "$(value "$root/api/.env.secrets" DATABASE_PASSWORD)" = "$(value "$master" DATABASE_PASSWORD)" ] || fail "api DATABASE_PASSWORD differs from master"
[ "$(value "$root/powersync/.env.secrets" POWERSYNC_JWT_SECRET)" = "$(value "$master" POWERSYNC_JWT_SECRET)" ] || fail "powersync JWT secret differs from master"

# ── upgrade: an older master (no SIDECAR_AUTH_SECRET, 0644) keeps its values,
# gains the key, tightens to 0600, and is re-projected.
before=$(value "$master" AUTH_TOKEN_SECRET)
grep -v '^SIDECAR_AUTH_SECRET=' "$master" > "$master.old" && mv "$master.old" "$master"
chmod 644 "$master"
rm -rf "$root"
run
[ "$(value "$master" AUTH_TOKEN_SECRET)" = "$before" ] || fail "upgrade rewrote AUTH_TOKEN_SECRET"
has "$master" SIDECAR_AUTH_SECRET || fail "upgrade did not add SIDECAR_AUTH_SECRET"
[ "$(mode "$master")" = "600" ] || fail "upgrade left the master at $(mode "$master")"
[ "$(value "$root/hbpe/.env.secrets" SIDECAR_AUTH_SECRET)" = "$(value "$master" SIDECAR_AUTH_SECRET)" ] || fail "hbpe projection missed the added key"

# ── an operator-added key reaches exactly the services mapped to it.
printf 'LLM_API_KEY=sk-test\n' >> "$master"
run
[ "$(value "$root/summary/.env.secrets" LLM_API_KEY)" = "sk-test" ] || fail "summary did not receive LLM_API_KEY"
if has "$root/hbpe/.env.secrets" LLM_API_KEY; then fail "hbpe received LLM_API_KEY"; fi

echo "setup-secrets: ok"
