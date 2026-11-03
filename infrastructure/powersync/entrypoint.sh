#!/bin/sh
# Starts the PowerSync service with the appliance's generated secrets.
#
# The same steps as the `command:` wrapper on the `powersync` service in
# docker-compose.yml, baked in so an install that cannot mount this directory
# (a Hub/Marketplace install) runs the same thing. Change the two together.
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

exec node service/lib/entry.js start -r unified
