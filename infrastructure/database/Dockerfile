# PostgreSQL with TimescaleDB, PostGIS, Apache AGE, and pgvector
# Pinned to 16.11-ts2.23.0 for stability; :pg16 tag is frequently updated,
# which leads to deletion of existing database and replacement with a new empty one.

# Build stage for compiling extensions
FROM timescale/timescaledb-ha:pg16.11-ts2.23.0 AS builder

USER root

# Install build dependencies (separate layer for caching)
RUN mkdir -p /var/lib/apt/lists/partial && \
    chown -R _apt:root /var/lib/apt/lists && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
    git \
    build-essential \
    postgresql-server-dev-16 \
    ca-certificates \
    flex \
    bison \
    libreadline-dev \
    libedit-dev \
    && rm -rf /var/lib/apt/lists/*

# Pin versions for reproducible builds and better caching
ARG PGVECTOR_VERSION=v0.6.0
ARG PG_UUIDV7_VERSION=v1.6.0

# Build pgvector
RUN cd /tmp && \
    git clone --branch ${PGVECTOR_VERSION} --depth 1 https://github.com/pgvector/pgvector.git && \
    cd pgvector && \
    make && \
    make install DESTDIR=/tmp/install

# Build pg_uuidv7
RUN cd /tmp && \
    git clone --branch ${PG_UUIDV7_VERSION} --depth 1 https://github.com/fboulnois/pg_uuidv7.git && \
    cd pg_uuidv7 && \
    make && \
    make install DESTDIR=/tmp/install

# Final stage - runtime image
FROM timescale/timescaledb-ha:pg16.11-ts2.23.0

USER root

# Install runtime dependencies only (rarely changes)
RUN mkdir -p /var/lib/apt/lists/partial && \
    chown -R _apt:root /var/lib/apt/lists && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
    postgresql-16-postgis-3 \
    postgresql-16-postgis-3-scripts \
    libyaml-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy compiled extensions from builder
COPY --from=builder /tmp/install/ /

COPY LICENSE /LICENSE

# Install secrets-aware entrypoint wrapper
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

# Switch back to postgres user
USER postgres

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

ENV PGDATA=/home/postgres/pgdata/data \
    DEFAULT_USERNAME=postgres \
    DEFAULT_DATABASE=postgres

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["postgres"]

# Expose PostgreSQL port
EXPOSE 5432
