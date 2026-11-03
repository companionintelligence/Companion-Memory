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

# Keep the project runtime isolated from the base image's system Python.
# The project pins Python in `.python-version`, which can differ from the
# interpreter shipped by the slim image. uv downloads the pinned interpreter
# into UV_PYTHON_INSTALL_DIR and the venv's `python` is a link to it, so that
# directory has to be reachable by the runtime user. uv's default is under
# root's home, which is mode 700, so memorizer couldn't run it. only-managed
# means a base image bump can't change which interpreter the service runs on.
# PATH lets the entrypoint invoke `uvicorn` and `python -m` without an
# activation step.
ENV UV_PROJECT_ENVIRONMENT=/app/.venv \
    VIRTUAL_ENV=/app/.venv \
    PATH="/app/.venv/bin:$PATH" \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_PYTHON_PREFERENCE=only-managed

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

# An image that can't run as its own user fails here in its own build, not on
# someone's Hub. 2026.11.1 got through every release gate and then exited 126 on
# every install, because its venv's python pointed somewhere memorizer can't
# read. This loads what entrypoint.sh starts, found through PATH the way it and
# the compose healthcheck find them: the uvicorn script, whose shebang is that
# python, then the two apps uvicorn is pointed at. _new_markitdown is called
# because only the parser's worker process loads MarkItDown. /health stays green
# when that breaks, so nothing else would notice. Importing the apps needs a
# database URL to exist, so that placeholder stays in this one command. There is no
# network and no model, the same as a Hub with no AI engine, where the service still
# has to start.
RUN --network=none test -x ./entrypoint.sh \
    && bash -n ./entrypoint.sh \
    && uvicorn --version \
    && DATABASE_URL=postgresql://build-check@localhost/build-check \
       python -c "from ci.summary.api import app; \
                  from ci.summary.parser import app; \
                  from ci.summary.parser_worker import _new_markitdown; \
                  _new_markitdown()"

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
