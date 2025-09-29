# PostgreSQL with TimescaleDB, PostGIS, Apache AGE, and pgvector
FROM timescale/timescaledb-ha:pg16

# Switch to root for installation
USER root

# Fix permissions and install extensions
RUN mkdir -p /var/lib/apt/lists/partial && \
    chown -R _apt:root /var/lib/apt/lists && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
    postgresql-16-postgis-3 \
    postgresql-16-postgis-3-scripts \
    git \
    build-essential \
    postgresql-server-dev-16 \
    ca-certificates \
    flex \
    bison \
    libreadline-dev \
    libedit-dev \
    libyaml-dev \
    && rm -rf /var/lib/apt/lists/*

# Install pgvector
RUN cd /tmp && \
    git clone --branch v0.6.0 https://github.com/pgvector/pgvector.git && \
    cd pgvector && \
    make && \
    make install && \
    rm -rf /tmp/pgvector

# Install pg_uuidv7
RUN cd /tmp && \
    git clone https://github.com/fboulnois/pg_uuidv7.git && \
    cd pg_uuidv7 && \
    make && \
    make install && \
    rm -rf /tmp/pg_uuidv7

# Switch back to postgres user
USER postgres

# Set environment variables
ENV POSTGRES_DB=companion_intel
ENV POSTGRES_USER=companion_intel
ENV POSTGRES_PASSWORD=comp4nion_1ntel_ftw!

# Expose PostgreSQL port
EXPOSE 5432