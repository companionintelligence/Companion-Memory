FROM temporalio/server:1.26.2

COPY LICENSE.md /LICENSE.md
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

# ──────────────────────────────────────────────────
# Environment Variables
#
# Secrets are loaded from a shared secrets file or
# from environment variables set by Docker Compose.
#
# Required (no default — will not start without these):
#   DATABASE_PASSWORD                PostgreSQL password for Temporal
#
# Optional:
#   DATABASE_HOST                    PostgreSQL host [database]
#   DATABASE_NAME                    Temporal database name [temporal]
#   DATABASE_USERNAME                PostgreSQL username [temporal]
#   DEFAULT_NAMESPACE                Temporal namespace to register [default]
#   DEFAULT_NAMESPACE_RETENTION      Workflow history retention [24h]
#   SECRETS_FILE                     Path to secrets file [/run/secrets/.env.secrets]
#   SKIP_DEFAULT_NAMESPACE_CREATION  Skip namespace auto-registration [false]
#   VISIBILITY_DATABASE_NAME         Visibility store database [{DATABASE_NAME}_visibility]
# ──────────────────────────────────────────────────

ENV DB=postgres12 \
    DB_PORT=5432 \
    BIND_ON_IP=0.0.0.0 \
    SKIP_DB_CREATE=true \
    SKIP_SCHEMA_SETUP=true \
    DEFAULT_DATABASE_USERNAME=temporal \
    DEFAULT_DATABASE_NAME=temporal \
    DEFAULT_DATABASE_HOST=database \
    DEFAULT_VISIBILITY_DATABASE_NAME=temporal_visibility

ENTRYPOINT ["entrypoint.sh"]
