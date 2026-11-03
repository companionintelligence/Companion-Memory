#!/bin/sh
# Unit test for entrypoint.sh: the service starts in its place and the `compact`
# loop beside it stays out of its way. No Docker; `node` and `sleep` are stubs on
# PATH, so nothing waits out a real interval. Wired into `make test` by
# scripts/xtask/commands/test.ts.
#
# A real service, a real compact and real container stops are not covered here.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
real_sleep=$(command -v sleep)
service_pid=""
# A section that failed leaves its service up. Give the loop a moment to end with
# it while the stubs still exist, or it would fall back on the real `sleep`.
cleanup() {
  if [ -n "$service_pid" ]; then
    kill -9 "$service_pid" 2>/dev/null || true
    tries=0
    while [ ! -e "$work/gone" ] && [ "$tries" -lt 100 ]; do
      tries=$((tries + 1))
      "$real_sleep" 0.05
    done
  fi
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  sed 's/^/  stderr: /' "$work/stderr" >&2 2>/dev/null || true
  exit 1
}

mkdir "$work/bin"

# The stub service stays up until it is signalled, like the real one. It exits 0
# on SIGTERM. The stub compact does what the file `compact-does` says.
cat > "$work/bin/node" <<EOF
#!/bin/sh
case "\$*" in
  *" start -r unified")
    echo "\$\$" > "$work/service.pid"
    env > "$work/service.env"
    trap 'exit 0' TERM
    while :; do "$real_sleep" 0.05; done
    ;;
  *" compact")
    env > "$work/compact.env.tmp"
    mv -f "$work/compact.env.tmp" "$work/compact.env"
    echo run >> "$work/compact.runs"
    case "\$(cat "$work/compact-does" 2>/dev/null)" in
      fail) echo "compact: could not reach storage" >&2; exit 7 ;;
      hang) exec "$real_sleep" 600 ;;
    esac
    ;;
  *) echo "stub node: unexpected arguments: \$*" >&2; exit 64 ;;
esac
EOF

# Records every wait the loop asks for, then waits a moment instead. The wait for
# a hung compact is `timeout`'s own and does not come through here. The file
# `sleep-dies` makes one wait fail, the way a `sleep` the OOM killer took does.
cat > "$work/bin/sleep" <<EOF
#!/bin/sh
echo "\$1" >> "$work/sleeps"
if [ -e "$work/sleep-dies" ]; then rm -f "$work/sleep-dies"; exit 137; fi
exec "$real_sleep" 0.05
EOF
chmod +x "$work/bin/node" "$work/bin/sleep"

# macOS has no `timeout`. Everything but the hung-compact section works without
# the real one, so stand in for it there and skip that section.
if ! command -v timeout >/dev/null 2>&1; then
  no_timeout=1
  cat > "$work/bin/timeout" <<'EOF'
#!/bin/sh
shift 3
exec "$@"
EOF
  chmod +x "$work/bin/timeout"
else
  no_timeout=0
fi

# Starts entrypoint.sh in the background and leaves its pid in $service_pid. It
# and everything it starts inherit fd 9, the write end of a pipe, so `gone` appears
# only when the last of them has exited.
start() {
  rm -f "$work/service.pid" "$work/service.env" "$work/compact.env" "$work/compact.runs" "$work/sleeps" \
    "$work/stderr" "$work/gone" "$work/alive"
  mkfifo "$work/alive"
  (cat "$work/alive" >/dev/null; : > "$work/gone") 2>/dev/null &
  PATH="$work/bin:$PATH" \
    POWERSYNC_DATABASE_USERNAME=powersync POWERSYNC_DATABASE_PASSWORD=replication-secret \
    DATABASE_USERNAME=companion DATABASE_PASSWORD=storage-secret DATABASE_NAME=companion \
    POWERSYNC_JWT_SECRET=shared-secret POWERSYNC_CONFIG_PATH=/tmp/from-the-listing.yaml \
    sh "$here/entrypoint.sh" 2>"$work/stderr" >/dev/null 9>"$work/alive" &
  service_pid=$!
  wait_for "the service to start" test -s "$work/service.env"
}

# Polls for up to 10 seconds, on the real clock: the stubbed `sleep` is only on
# the entrypoint's PATH.
wait_for() {
  what=$1
  shift
  tries=0
  until "$@"; do
    tries=$((tries + 1))
    [ "$tries" -lt 200 ] || fail "timed out waiting for $what"
    "$real_sleep" 0.05
  done
}

runs() { if [ -f "$work/compact.runs" ]; then wc -l < "$work/compact.runs" | tr -d ' '; else echo 0; fi; }
ran_at_least() { [ "$(runs)" -ge "$1" ]; }
stderr_has() { grep -q "$1" "$work/stderr"; }

# Stops the service the way a container stop does and requires that it exits 0
# and that nothing it left behind is still running afterwards.
stop() {
  kill -TERM "$service_pid"
  status=0
  wait "$service_pid" || status=$?
  service_pid=""
  [ "$status" -eq 0 ] || fail "stopping the service exited $status, want 0"
  wait_for "the compact loop to end with the service" test -e "$work/gone"
}

# ── default schedule: soon after start, then hourly
rm -f "$work/compact-does"
start
wait_for "two compact runs" ran_at_least 2
[ "$(sed -n 1p "$work/sleeps")" = "300" ] || fail "first wait is $(sed -n 1p "$work/sleeps"), want 300"
[ "$(sed -n 2p "$work/sleeps")" = "3600" ] || fail "wait after a run is $(sed -n 2p "$work/sleeps"), want 3600"

# ── the service is this process, so it takes the container's signals itself
[ "$(cat "$work/service.pid")" = "$service_pid" ] || fail "service runs as pid $(cat "$work/service.pid"), the entrypoint was $service_pid: not exec'd"

# ── compact sees what the service sees: the derived URIs, the JWT key and the
# config path the Marketplace listing overrides
for key in PS_REPLICATION_URI PS_STORAGE_URI PS_JWT_SECRET_B64URL POWERSYNC_CONFIG_PATH; do
  [ "$(grep "^$key=" "$work/compact.env")" = "$(grep "^$key=" "$work/service.env")" ] || fail "compact and the service disagree on $key"
done
grep -q '^PS_STORAGE_URI=postgresql://companion:storage-secret@database:5432/companion$' "$work/compact.env" || fail "compact has the wrong storage URI"
grep -q '^POWERSYNC_CONFIG_PATH=/tmp/from-the-listing.yaml$' "$work/compact.env" || fail "compact lost the overridden config path"

stop

# ── a failing compact is logged with its status and the service keeps running
echo fail > "$work/compact-does"
start
wait_for "a failed compact to be logged" stderr_has "compact failed (exit 7); trying again in 3600s"
wait_for "the next try" ran_at_least 3
kill -0 "$service_pid" 2>/dev/null || fail "a failing compact took the service down"
stderr_has "could not reach storage" || fail "compact's own error did not reach the log"
stop

# ── a clean run is not logged as a failure
rm -f "$work/compact-does"
start
wait_for "a run" ran_at_least 2
if stderr_has "compact failed"; then fail "a clean run logged a failure"; fi
stop

# ── a wait that dies does not end the loop
start
wait_for "a run" ran_at_least 1
: > "$work/sleep-dies"
wait_for "the failed wait" test ! -e "$work/sleep-dies"
seen=$(runs)
wait_for "a run after the failed wait" ran_at_least "$((seen + 2))"
stop

# ── the interval can be shortened and the first wait follows it down
POWERSYNC_COMPACT_INTERVAL_SECONDS=20
export POWERSYNC_COMPACT_INTERVAL_SECONDS
start
wait_for "two runs" ran_at_least 2
[ "$(sed -n 1p "$work/sleeps")" = "20" ] || fail "first wait with a 20s interval is $(sed -n 1p "$work/sleeps")"
[ "$(sed -n 2p "$work/sleeps")" = "20" ] || fail "wait after a run with a 20s interval is $(sed -n 2p "$work/sleeps")"
stop

# ── a longer interval keeps the soon-after-start run
POWERSYNC_COMPACT_INTERVAL_SECONDS=7200
start
wait_for "two runs" ran_at_least 2
[ "$(sed -n 1p "$work/sleeps")" = "300" ] || fail "first wait with a 2h interval is $(sed -n 1p "$work/sleeps")"
[ "$(sed -n 2p "$work/sleeps")" = "7200" ] || fail "wait after a run with a 2h interval is $(sed -n 2p "$work/sleeps")"
stop

# ── empty means the default, quietly: docker-compose.yml passes it empty
POWERSYNC_COMPACT_INTERVAL_SECONDS=
start
wait_for "two runs" ran_at_least 2
[ "$(sed -n 2p "$work/sleeps")" = "3600" ] || fail "an empty interval waits $(sed -n 2p "$work/sleeps")"
if stderr_has "POWERSYNC_COMPACT_INTERVAL_SECONDS"; then fail "an empty interval was reported as wrong"; fi
stop

# ── a value `sleep` would choke on or spin on, or one too long for the shell's
# arithmetic, falls back and says so. Left alone it would end the loop for good.
for bad in 0 00 010 abc 1h -5 1.5 99999999999999999999 1234567890; do
  POWERSYNC_COMPACT_INTERVAL_SECONDS=$bad
  start
  wait_for "two runs with interval '$bad'" ran_at_least 2
  [ "$(sed -n 2p "$work/sleeps")" = "3600" ] || fail "interval '$bad' waits $(sed -n 2p "$work/sleeps")"
  stderr_has "POWERSYNC_COMPACT_INTERVAL_SECONDS=$bad is not" || fail "interval '$bad' was not reported"
  stop
done
unset POWERSYNC_COMPACT_INTERVAL_SECONDS

# ── a compact that never returns is killed and logged, or one stuck run would end
# compaction with nothing to show for it. A real clock: 6 x 1s.
if [ "$no_timeout" = 0 ]; then
  echo hang > "$work/compact-does"
  POWERSYNC_COMPACT_INTERVAL_SECONDS=1
  export POWERSYNC_COMPACT_INTERVAL_SECONDS
  start
  wait_for "the hung run to be killed" stderr_has "compact failed (exit 124)"
  kill -0 "$service_pid" 2>/dev/null || fail "a hung compact took the service down"
  rm -f "$work/compact-does"
  stop
  unset POWERSYNC_COMPACT_INTERVAL_SECONDS
fi

# ── compose runs this file, so there is no second copy of these steps to drift
# (a static check, since no Docker runs here). The service starts from one place.
compose="$here/../../docker-compose.yml"
grep -q 'entrypoint: \["/bin/sh", "/config/entrypoint.sh"\]' "$compose" || fail "docker-compose.yml does not run entrypoint.sh"
if grep -q 'entry.js start' "$compose"; then fail "docker-compose.yml starts the service itself, so it would miss the compact loop"; fi
grep -q 'powersync-entrypoint.sh' "$here/Dockerfile" || fail "the image does not run entrypoint.sh"

echo "powersync entrypoint: ok"
