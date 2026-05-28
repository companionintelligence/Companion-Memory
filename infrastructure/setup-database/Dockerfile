FROM postgres:16-alpine

COPY LICENSE.md /LICENSE.md
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

# ──────────────────────────────────────────────────
# Environment Variables
#
# Bootstraps roles and databases for all services.
# Secrets are loaded from a shared secrets file or
# from environment variables set by Docker Compose.
#
# Required (no default — will not start without these):
#   ADMIN_PASSWORD             PostgreSQL superuser password
#   COMPANION_PASSWORD         Companion API role password
#   ORCHESTRATOR_PASSWORD      Temporal role password
#
# Optional:
#   ADMIN_HOST                 PostgreSQL host [database]
#   ADMIN_PORT                 PostgreSQL port [5432]
#   ADMIN_USERNAME             PostgreSQL superuser name [postgres]
#   COMPANION_DATABASE         Companion database name [companion]
#   COMPANION_USERNAME         Companion role name [companion]
#   ORCHESTRATOR_DATABASE      Temporal database name [temporal]
#   ORCHESTRATOR_USERNAME      Temporal role name [temporal]
#   SECRETS_FILE               Path to secrets file [/run/secrets/.env.secrets]
# ──────────────────────────────────────────────────

ENV DEFAULT_ADMIN_USERNAME=postgres \
    DEFAULT_HOST=database \
    DEFAULT_COMPANION_USERNAME=companion \
    DEFAULT_COMPANION_DATABASE=companion \
    DEFAULT_ORCHESTRATOR_USERNAME=temporal \
    DEFAULT_ORCHESTRATOR_DATABASE=temporal

ENTRYPOINT ["entrypoint.sh"]
