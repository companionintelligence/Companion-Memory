# ANTIGRAVITY.md — CI-Server

## Context

**CI-Server** — **Appliance** layer of the Companion Intelligence platform (Lifescope Inc).

Architecture: `CI-Engineering/architecture/architecture.md`
Roadmap: `CI-Engineering/architecture/roadmap.md`

## Purpose

Personal database, REST/LLM API, RAG, and HBPE behavioral-prediction engine. The memory brain of the appliance.

## Stack

- NestJS 10 (backend)
- React/Vite (frontend)
- PostgreSQL 18 + pgvector + TimescaleDB + PostGIS
- Ollama (local LLM / embeddings)
- Python/FastAPI sidecar (HBPE — ONNX INT8)
- PGBoss (background jobs)
- Minio (object storage)
- Docker Compose

## Commands

```bash
yarn install
docker compose up -d && yarn dev
yarn test
```

## Rules

- Package manager: do not switch or mix.
- Destructive git operations (`reset --hard`, `clean -f`) require explicit user confirmation.
- Commits reference CI-Engineering issues.
- All content is **private and confidential** — Property of Lifescope Inc.
