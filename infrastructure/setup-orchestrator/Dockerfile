FROM temporalio/admin-tools:1.26.2

COPY LICENSE /LICENSE
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

# ──────────────────────────────────────────────────
# Environment Variables
#
# Runs Temporal schema migrations. Secrets are loaded
# from a shared secrets file or from environment variables.
#
# Required (no default — will not start without these):
#   DATABASE_PASSWORD          PostgreSQL password for Temporal
#
# Optional:
#   DATABASE_HOST              PostgreSQL host [database]
#   DATABASE_NAME              Temporal database name [temporal]
#   DATABASE_USERNAME          PostgreSQL username [temporal]
#   SECRETS_FILE               Path to secrets file [/run/secrets/.env.secrets]
#   SKIP_SCHEMA_SETUP          Skip migration entirely [false]
# ──────────────────────────────────────────────────

ENV DEFAULT_DATABASE_USERNAME=temporal \
    DEFAULT_DATABASE_NAME=temporal \
    DEFAULT_DATABASE_HOST=database

ENTRYPOINT ["entrypoint.sh"]
