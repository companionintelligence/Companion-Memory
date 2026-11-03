#!/bin/sh
# Starts the PowerSync service with the appliance's generated secrets and runs
# PowerSync's `compact` command beside it.
#
# Every install runs this file: the companion/powersync image a Hub install uses
# has it baked in. The `powersync` service in docker-compose.yml runs it from the
# mounted directory.
#
# Reads /run/secrets/.env.secrets when present (setup-secrets' `powersync`
# projection), builds the replication and storage URIs from it, and derives the
# base64url JWKS key from the one shared JWT secret so the two cannot drift.
# Anything already exported wins, so PS_REPLICATION_URI / PS_STORAGE_URI /
# PS_JWT_SECRET_B64URL set explicitly still override.
set -eu

if [ -f /run/secrets/.env.secrets ]; then
  set -a
  . /run/secrets/.env.secrets
  set +a
fi

: "${DATABASE_HOST:=database}"
export PS_REPLICATION_URI="${PS_REPLICATION_URI:-postgresql://${POWERSYNC_DATABASE_USERNAME}:${POWERSYNC_DATABASE_PASSWORD}@${DATABASE_HOST}:5432/${DATABASE_NAME}}"
export PS_STORAGE_URI="${PS_STORAGE_URI:-postgresql://${DATABASE_USERNAME}:${DATABASE_PASSWORD}@${DATABASE_HOST}:5432/${DATABASE_NAME}}"

if [ -z "${PS_JWT_SECRET_B64URL:-}" ]; then
  PS_JWT_SECRET_B64URL=$(printf '%s' "${POWERSYNC_JWT_SECRET}" | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '=')
  export PS_JWT_SECRET_B64URL
fi

# Bucket storage only appends. The old text of an edited or deleted row stays in
# powersync.bucket_data until `compact` runs. Every new device downloads it until then.
# Nothing in the service schedules it and no HTTP route asks for it, so it runs
# from here. README.md, "Compacting", says why hourly. The ten-digit cap is for
# the shell's arithmetic below: a value that overflows it would end the loop.
compact_interval=${POWERSYNC_COMPACT_INTERVAL_SECONDS:-3600}
case $compact_interval in
  0* | *[!0-9]* | ??????????*)
    echo "[ci/powersync] POWERSYNC_COMPACT_INTERVAL_SECONDS=$compact_interval is not a whole number of seconds from 1 to 999999999; using 3600" >&2
    compact_interval=3600
    ;;
esac

# The first run comes soon after start, so a box that restarts more often than
# the interval still gets compacted. $$ stays this process across the exec below,
# so the loop ends with the service even where nothing else would end it (a
# container's other processes die with its PID 1 anyway, so this never delays a
# stop). A failed or hung run is logged and tried again next time: compact
# failing must never take sync down with it. `set +e` applies only to this
# background subshell, so no failing command ends the loop without a word.
compact_loop() {
  set +e
  sleep "$(( compact_interval < 300 ? compact_interval : 300 ))"
  while kill -0 "$$" 2>/dev/null; do
    timeout -k 30 "$(( compact_interval * 6 ))" node service/lib/entry.js compact
    status=$?
    if [ "$status" -ne 0 ]; then
      echo "[ci/powersync] compact failed (exit $status); trying again in ${compact_interval}s" >&2
    fi
    sleep "$compact_interval"
  done
}
compact_loop &

exec node service/lib/entry.js start -r unified
