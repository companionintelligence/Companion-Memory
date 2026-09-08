# ANTIGRAVITY.md — CI-Server

## Context

**CI-Server** — **Appliance** layer of the Companion Intelligence platform (Lifescope Inc).

Architecture: `CI-Engineering/architecture/architecture.md`
Roadmap: `CI-Engineering/architecture/roadmap.md`

## Purpose

Personal database, REST/LLM API, RAG, and HBPE behavioral-prediction engine. The memory brain of the appliance.

## Stack

- NestJS 11 (backend)
- React 19 / Vite (frontend)
- Capacitor iOS + Android shells (`frontend/apps/ios`, `frontend/apps/android`)
- PostgreSQL 18 + pgvector + TimescaleDB + PostGIS
- Ollama (local LLM / embeddings)
- Two Python/FastAPI sidecars via uv: HBPE (ONNX INT8 + llama.cpp labeler, :8002) and Summary (:8001, parser on host :8003)
- PGBoss (background jobs; the only scheduler)
- Minio (object storage)
- Docker Compose

## Commands

```bash
make install   # yarn install + uv sync --all-packages
make dev       # full per-worktree stack: compose + migrations + Caddy + overmind
make lint      # both stacks (eslint/prettier + ruff/mypy/uv lock --check)
make test      # both stacks (yarn workspaces test + pytest)
make build     # Build images. ENV=local|staging|production GPU=cpu|cuda|rocm IMAGE=<one image> DRY_RUN=1
```

`build`, `dev` and `test` are one-line delegations to the TypeScript
program in `scripts/xtask/` (run via tsx) — change the logic there. (Two pieces stay in the Makefile on purpose: the
`distribute-license`/`clean-license` targets xtask calls back into, and the four wheel pins
`lib/gpu.ts` reads out of it by name.) `health`
stays shell on purpose: a prerequisite checker must not need the prerequisites.

## Rules

- Package manager: yarn for JS/TS, uv for Python. Do not switch or mix.
- `frontend/apps/{ios,android}` are outside the Yarn workspaces on purpose — install from inside each directory.
- CI is `workflow_dispatch`-only: an absent check means nobody ran it. `gh workflow run <file> --ref <ref>`.
- Destructive git operations (`reset --hard`, `clean -f`) require explicit user confirmation.
- Commits reference CI-Engineering issues.
- All content is **private and confidential** — Property of Lifescope Inc.
