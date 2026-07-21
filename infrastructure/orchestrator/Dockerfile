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

# Connection pool sizing.
#
# Upstream defaults maxIdleConns equal to maxConns (20 for the default store,
# 10 for visibility). Because the pool never trims below maxIdleConns, and the
# single-container server runs four service roles (frontend, history, matching,
# worker) that each open both pools, Temporal steadily pins ~76 connections
# open and holds them for maxConnLifetime. On a shared Postgres that starves
# every other client — the API surfaces it as SQLSTATE 53300.
#
# The appliance is a single host with one task-queue partition (see
# dynamicconfig.yaml), so it needs nowhere near that. Capping maxConns bounds
# the peak; setting maxIdleConns well below it lets the pool actually shrink
# back down when the workflow load is idle, which is most of the time.
ENV SQL_MAX_CONNS=10 \
    SQL_MAX_IDLE_CONNS=3 \
    SQL_VIS_MAX_CONNS=4 \
    SQL_VIS_MAX_IDLE_CONNS=1

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
