# CLAUDE.md — CI-Server

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

## Platform role

**CI-Server** sits in the **Appliance** layer of the Companion Intelligence platform.

Architecture: `CI-Engineering/architecture/architecture.md`
Roadmap: `CI-Engineering/architecture/roadmap.md`
Issues: <https://github.com/companionintelligence/CI-Engineering/issues>

## What this repo does

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

## Key commands

```bash
# Install dependencies
yarn install

# Start development server / service
docker compose up -d && yarn dev

# Run tests
yarn test

# Build for production
yarn build
```

## Package manager

**yarn** — use exclusively; do not mix with npm/yarn/pnpm/bun unless the repo explicitly requires it.

## Cross-repo connections

- Consumed by: all clients via REST/GraphQL at ci-server.localhost
- Receives data from: CI-Browser-Extension, CI-Connect, CI-Import-Tools, CI-Applet
- Hub installs it alongside marketplace apps via CI-Hub
- HBPE sidecar reads ci.* and ci_search.* Postgres schemas
- CI-Portal will become its OIDC IdP (issue #8)

## Database migrations

SQL migration files in `backend/apps/api/db/postgres/migrations/` are hand-written and are the source of truth. Update the TypeORM entities to match.

**Never hand-write the timestamp prefix.** Create migration files with `yarn workspace @ci/be-api migrate:make <name>`, which stamps the real UTC time to the second. Hand-picked round timestamps (…120000) have collided across parallel branches; dbmate keys `schema_migrations` on the prefix, so a duplicate breaks `migrate` for everyone. Uniqueness is enforced by `scripts/check-migration-versions.ts` (runs in lint-staged and before `yarn migrate`).

## HBPE sidecar

Python container at port 8001. Reads the same Postgres instance. See `CI-Engineering/architecture/HBPE/` for design docs.

## Multi-agent safety

Multiple AI agents work these repos in parallel. Never use `git reset --hard`, `git clean -f`, or any destructive git command without explicit confirmation from the user.

## Confidentiality

Private & Confidential — Property of Lifescope Inc. Do not distribute.
