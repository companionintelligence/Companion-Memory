# Keep in step with the `powersync` service image in docker-compose.yml.
FROM journeyapps/powersync-service:1.23.0

COPY LICENSE.md /LICENSE.md
COPY powersync.yaml sync-rules.yaml /config/
COPY --chmod=755 entrypoint.sh /usr/local/bin/powersync-entrypoint.sh

# ──────────────────────────────────────────────────
# Environment Variables
#
# The PowerSync sync engine with this repo's config and sync rules baked in,
# for installs that cannot bind-mount infrastructure/powersync (Hub /
# Marketplace). Compose installs keep using the upstream image with the
# directory mounted; both run the same startup steps (entrypoint.sh).
#
# Read from /run/secrets/.env.secrets (setup-secrets' `powersync` projection):
#   POWERSYNC_DATABASE_USERNAME / _PASSWORD   Replication role
#   DATABASE_USERNAME / _PASSWORD / _NAME     App role, for bucket storage
#   POWERSYNC_JWT_SECRET                      Shared HS256 secret the API signs with
#
# Optional:
#   DATABASE_HOST           Postgres host [database]
#   PS_REPLICATION_URI, PS_STORAGE_URI, PS_JWT_SECRET_B64URL   Override the derived values
# ──────────────────────────────────────────────────

ENV POWERSYNC_CONFIG_PATH=/config/powersync.yaml

ENTRYPOINT ["powersync-entrypoint.sh"]
