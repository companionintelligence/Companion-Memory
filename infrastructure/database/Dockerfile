# PostgreSQL 18 with TimescaleDB, PostGIS, and pgvector.
#
# Based on the official postgres:18-bookworm image which already has
# the PGDG apt repository configured. We layer the Timescale apt
# repository on top so every extension is installed from an official
# upstream package.
#
# UUIDv7 generation uses PG18's native uuidv7() builtin, so no
# pg_uuidv7 extension is required.

FROM postgres:18.4-bookworm

# Add the Timescale apt repository, then install every extension from
# official upstream packages in a single layer.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gnupg \
    && install -d /etc/apt/keyrings \
    && curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey \
       | gpg --dearmor -o /etc/apt/keyrings/timescaledb.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/timescaledb.gpg] https://packagecloud.io/timescale/timescaledb/debian/ bookworm main" \
       > /etc/apt/sources.list.d/timescaledb.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      postgresql-18-postgis-3 \
      postgresql-18-pgvector \
      timescaledb-2-postgresql-18 \
    && apt-get purge -y curl gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY LICENSE.md /LICENSE.md

# Install secrets-aware entrypoint wrapper
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

# ──────────────────────────────────────────────────
# Environment Variables
#
# Secrets are loaded from a shared secrets file or
# from environment variables set by Docker Compose.
#
# Required (no default — will not start without these):
#   PASSWORD                   PostgreSQL superuser password
#
# Optional:
#   DATABASE                   Initial database name [postgres]
#   SECRETS_FILE               Path to secrets file [/run/secrets/.env.secrets]
#   USERNAME                   PostgreSQL superuser name [postgres]
# ──────────────────────────────────────────────────

ENV DEFAULT_USERNAME=postgres \
    DEFAULT_DATABASE=postgres

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# shared_preload_libraries is required for TimescaleDB. Passing it via
# the postgres CLI applies regardless of whether postgresql.conf has
# been previously initialised on the persistent volume.
CMD ["postgres", "-c", "shared_preload_libraries=timescaledb"]

EXPOSE 5432
