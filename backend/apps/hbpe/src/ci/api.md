# api.py

## Purpose
FastAPI application for HBPE. Exposes the `/histogram` endpoint consumed by
the CI frontend and a `/health` probe. Full histogram logic lands in Phase 4 (T4.4).

## Components

### `app`
- **Does**: FastAPI instance; started by `entrypoint.sh` via uvicorn
- **Interacts with**: `ci.pipeline.histogram_api` (Phase 4)

### `health`
- **Does**: Returns `{"status": "ok"}` — used by Docker health checks

### `histogram`
- **Does**: Stub that returns 503 until Phase 4 is implemented
- **Interacts with**: Will call `ci.pipeline.histogram_api` in Phase 4

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| CI frontend | `GET /histogram?horizon=24h` → 48-bucket JSON | Response schema |
| docker-compose healthcheck | `GET /health` → 200 | Path |

## Notes
- Port 8002 (set in `entrypoint.sh` and `docker-compose.yml`)
