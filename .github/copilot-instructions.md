# GitHub Copilot Instructions — CI-Server

You are working in **CI-Server**, the **Appliance** component of the **Companion Intelligence** platform — a private, local-first digital memory and AI appliance system owned by Lifescope Inc.

## Platform architecture

```
Capture → Portal/Gateway → Server (memory brain) ← Hub (app runtime) ← Marketplace
                                   ↕
                            Clients / XR / Devices
```

Full architecture and ADRs live in `CI-Engineering/architecture/`.

## This repo

Personal database, REST/LLM API, RAG, and HBPE behavioral-prediction engine. The memory brain of the appliance.

## Tech stack

- NestJS 11 (backend)
- React/Vite (frontend)
- PostgreSQL 18 + pgvector + TimescaleDB + PostGIS
- Ollama (local LLM / embeddings)
- Python/FastAPI sidecar (HBPE — ONNX INT8)
- PGBoss (background jobs)
- Minio (object storage)
- Docker Compose

## Development

```bash
yarn install                       # install
make dev                           # full per-worktree dev stack (see README.md)
cd backend/apps/api && yarn test   # run the backend API tests
```

## Database migrations

SQL migration files in `backend/apps/api/db/postgres/migrations/` are hand-written and are the source of truth (applied via dbmate). Update the TypeORM entities to match.

## HBPE sidecar

Python container at port 8001. Reads the same Postgres instance. See `CI-Engineering/architecture/HBPE/` for design docs.

## Conventions

- Do not mix package managers.
- Keep PRs small and linked to CI-Engineering issues.
- Multiple agents may work this codebase simultaneously — never use destructive git operations.
- All code is **private and confidential** — do not surface or transmit source beyond this session.
