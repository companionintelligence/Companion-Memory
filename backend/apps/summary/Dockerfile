FROM python:3.11.12-slim-bookworm

WORKDIR /app

COPY LICENSE.md /LICENSE.md

RUN useradd -m -u 1000 memorizer

RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Install uv
COPY --from=ghcr.io/astral-sh/uv:0.5.18 /uv /usr/local/bin/uv

# Copy dependency files first for better caching
COPY pyproject.toml uv.lock ./

# Install dependencies from lock file (without project structure)
RUN uv pip install --system --no-cache -r pyproject.toml

# Copy application code
COPY src/ ./src/
COPY entrypoint.sh ./

# Make entrypoint executable and set ownership
RUN chmod +x entrypoint.sh && chown -R memorizer:memorizer /app

USER memorizer

# Expose API port
EXPOSE 8001

# ──────────────────────────────────────────────────
# Environment Variables
#
# Secrets are loaded from a shared secrets file or
# from environment variables set by Docker Compose.
# Non-secret config (models, etc.) lives in src/config.py.
#
# Required (no default — will not start without these):
#   DATABASE_PASSWORD          PostgreSQL password (if DATABASE_URL not set)
#
# Optional:
#   DATABASE_HOST              PostgreSQL host [database]
#   DATABASE_NAME              PostgreSQL database name [companion]
#   DATABASE_PORT              PostgreSQL port [5432]
#   DATABASE_URL               Full connection string (overrides individual DB vars)
#   DATABASE_USERNAME          PostgreSQL username [companion]
#   LLM_API_KEY                API key for remote LLM providers (not needed for Ollama)
#   SECRETS_FILE               Path to secrets file [/run/secrets/.env.secrets]
# ──────────────────────────────────────────────────

CMD ["./entrypoint.sh"]
