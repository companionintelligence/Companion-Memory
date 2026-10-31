# Built from the repository root, not this directory: ci-summary installs
# ci-telemetry from backend/packages/telemetry, which a context rooted here
# could not reach. See the `build` target in the Makefile for the context.

# The uv version comes from required-version in the root pyproject.toml;
# `make build` extracts it and passes it as UV_VERSION. There is no default
# on purpose: a bare `docker build` fails at the FROM below rather than
# building with a uv the rest of the toolchain is not pinned to.
ARG UV_VERSION
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

FROM python:3.15.0-slim-bookworm

WORKDIR /app

COPY LICENSE.md /LICENSE.md

RUN useradd -m -u 1000 memorizer

RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /usr/local/bin/uv

# Install into the system interpreter rather than a virtualenv, so the
# entrypoint can invoke `uvicorn` and `python -m` directly with no
# activation step.
ENV UV_PROJECT_ENVIRONMENT=/usr/local \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

# Dependency layer. Only the manifests and the lock, so it stays cached
# until a dependency actually changes rather than on every source edit.
#
# Only the manifests this image resolves are copied: the root pair, this
# service, and the workspace members it depends on. Unrelated members stay
# out, so their manifest edits do not invalidate this layer.
COPY pyproject.toml uv.lock .python-version ./
COPY backend/apps/summary/pyproject.toml ./backend/apps/summary/pyproject.toml
COPY backend/packages/telemetry/pyproject.toml ./backend/packages/telemetry/pyproject.toml

# --frozen installs exactly what uv.lock records without validating the
# lock against the manifests, which is what allows the partial copy above:
# validation would demand every member's pyproject.toml. Lock freshness is
# still enforced, one level up, where the whole workspace exists: `make
# build` runs `uv lock --check` before building any image, and CI runs
# `uv sync --all-packages --locked`.
#
# --no-install-workspace, not --no-install-project: this service depends on
# the ci-telemetry workspace member, whose source has not been copied yet.
# Skipping only the project would make uv try to build it from an empty
# directory.
RUN uv sync --frozen --package ci-summary --no-install-workspace --no-dev

COPY backend/apps/summary/src ./backend/apps/summary/src
COPY backend/packages/telemetry/src ./backend/packages/telemetry/src

RUN uv sync --frozen --package ci-summary --no-dev --no-editable

COPY --chmod=755 backend/apps/summary/entrypoint.sh ./entrypoint.sh

RUN chown -R memorizer:memorizer /app

USER memorizer

# Expose API ports
EXPOSE 8001
EXPOSE 8002

# ──────────────────────────────────────────────────
# Environment Variables
#
# Secrets are loaded from a shared secrets file or
# from environment variables set by Docker Compose.
# Non-secret config (models, etc.) lives in
# src/ci/summary/config.py.
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
