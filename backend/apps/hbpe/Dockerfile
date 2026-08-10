# Built from the repository root, not this directory: ci-hbpe installs
# ci-telemetry from backend/packages/telemetry, which a context rooted here
# could not reach. See the `build` target in the Makefile for the context.

# The uv version comes from required-version in the root pyproject.toml;
# `make build` extracts it and passes it as UV_VERSION. There is no default
# on purpose: a bare `docker build` fails at the FROM below rather than
# building with a uv the rest of the toolchain is not pinned to.
ARG UV_VERSION
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

FROM python:3.11-slim-bookworm

# System dependencies — cmake required for the llama-cpp-python build
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client \
    build-essential \
    cmake \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /usr/local/bin/uv

WORKDIR /app

# Putting the venv on PATH is what lets the entrypoint invoke `uvicorn` and
# `python` directly. PYTHONPATH is deliberately not set: the service is an
# installed distribution now, not a directory on the import path.
ENV VIRTUAL_ENV=/app/.venv \
    PATH=/app/.venv/bin:$PATH \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    MODELS_DIR=/app/models \
    HF_HOME=/app/models/hf_cache

RUN useradd -m -u 1000 hbpe

# ── Locked dependencies ───────────────────────────────────────────────────────
# Only the manifests and the lock, so this layer stays cached until a
# dependency actually changes rather than on every source edit.
#
# Only the manifests this image resolves are copied: the root pair, this
# service, and the workspace members it depends on. Unrelated members stay
# out, so their manifest edits do not invalidate this layer.
COPY pyproject.toml uv.lock .python-version ./
COPY backend/apps/hbpe/pyproject.toml ./backend/apps/hbpe/pyproject.toml
COPY backend/packages/telemetry/pyproject.toml ./backend/packages/telemetry/pyproject.toml
COPY backend/packages/prompt-taxonomy/pyproject.toml ./backend/packages/prompt-taxonomy/pyproject.toml

# --frozen installs exactly what uv.lock records without validating the
# lock against the manifests, which is what allows the partial copy above:
# validation would demand every member's pyproject.toml. Lock freshness is
# still enforced, one level up, where the whole workspace exists: `make
# build` runs `uv lock --check` before building any image, and CI runs
# `uv sync --all-packages --locked`.
#
# torch comes straight from the lock: on Linux it resolves from the PyTorch
# CPU index (see [tool.uv.sources] in ci-hbpe's pyproject.toml), so this
# image gets the CPU wheel with none of the NVIDIA/Triton dependency stack
# that PyPI's torch drags in. Only the CUDA/ROCm Dockerfiles exclude torch
# and overwrite it from their hardware indexes.
#
# onnxruntime needs no special handling any more: the marker in ci-hbpe's
# pyproject.toml selects the GPU build on linux-x86_64 and the portable one
# everywhere else, replacing the `sed -i 's/onnxruntime-gpu/onnxruntime/'`
# that used to rewrite the manifest mid-build.
#
# --no-install-workspace, not --no-install-project: this service depends on
# the ci-telemetry workspace member, whose source has not been copied yet.
# Skipping only the project would make uv try to build it from an empty
# directory.
RUN uv sync --frozen --package ci-hbpe --no-install-workspace --no-dev

# ── Packages built outside the lock ───────────────────────────────────────────
# These must come after `uv sync`, not before it. Sync makes the environment
# match the lock exactly, which means it removes anything the lock does not
# mention — including everything installed here.

# llama-cpp-python (JamePeng fork — required for Qwen3.5 support).
#
# The official abetlen/llama-cpp-python on PyPI is frozen at llama.cpp Aug 2025
# and cannot load Qwen3.5 GGUFs (architecture added in llama.cpp b7990, Feb 2026).
# JamePeng's fork tracks llama.cpp HEAD and has confirmed Qwen3.5 support.
#
# This cannot move into pyproject.toml and the lock: it needs a per-package
# build environment variable, which uv has no way to express. All three HBPE
# images build the same fork commit — pinned by LLAMA_CPP_PYTHON_REF in the
# Makefile, passed as a build arg — with hardware-specific CMake flags, so
# every hardware variant runs the same inference stack. The ${VAR:?} guard
# fails the build if the arg is missing rather than tracking the fork's HEAD.
#
# There are no pre-built Linux aarch64 wheels — must build from source.
# GGML_NATIVE=OFF disables -mcpu=native which probes for CPU features (DOTPROD,
# FP16, SVE) that the Docker aarch64 VM doesn't expose — without it the build
# enables those extensions but the assembler rejects them at compile time.
# For native macOS dev (outside Docker) install with Metal instead, at the
# same commit the Makefile pins:
#   CMAKE_ARGS="-DGGML_METAL=ON" FORCE_CMAKE=1 uv pip install \
#     "llama-cpp-python @ git+https://github.com/JamePeng/llama-cpp-python.git@<ref>"
ARG LLAMA_CPP_PYTHON_REF
RUN CMAKE_ARGS="-DGGML_NATIVE=OFF" FORCE_CMAKE=1 \
    uv pip install --no-cache \
      "llama-cpp-python @ git+https://github.com/JamePeng/llama-cpp-python.git@${LLAMA_CPP_PYTHON_REF:?set by make build}"

COPY LICENSE.md /LICENSE.md

# ── Application code ──────────────────────────────────────────────────────────
COPY backend/apps/hbpe/src ./backend/apps/hbpe/src
COPY backend/packages/telemetry/src ./backend/packages/telemetry/src
COPY backend/packages/prompt-taxonomy/src ./backend/packages/prompt-taxonomy/src
COPY backend/apps/hbpe/scripts ./scripts
COPY --chmod=755 backend/apps/hbpe/entrypoint.sh ./entrypoint.sh

# `uv pip install`, not a second `uv sync`, because sync would prune the
# hardware-specific packages installed above. --no-deps because the
# dependencies are already installed from the lock.
RUN uv pip install --no-cache --no-deps ./backend/packages/telemetry ./backend/packages/prompt-taxonomy ./backend/apps/hbpe

# Persistent volumes for model artifacts and token corpus
RUN mkdir -p /app/models/qwen \
             /app/data/token_corpus \
             /app/data/artifacts

RUN chown -R hbpe:hbpe /app

USER hbpe

# HBPE histogram API
EXPOSE 8002

CMD ["./entrypoint.sh"]
