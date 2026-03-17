# HbpeService.ts

## Purpose
HTTP client for the hbpe-service FastAPI container. Fetches the day-ahead forecast
histogram from `/histogram` and surfaces it to the GraphQL layer. Host is configured
via `config.services.hbpe.host` (default: `http://localhost:8002`; in staging/production:
`HBPE_HOST=http://hbpe-service:8002`).

## Components

### `HbpeService.getForecast(horizon?)`
- **Does**: GET `{hbpeHost}/histogram?horizon={horizon}`, returns `ForecastResponse`
- **Interacts with**: `configuration.ts` for host URL, native `fetch` with 10s timeout
- **Rationale**: Returns `ServiceUnavailableException` on any failure so the GraphQL
  resolver can return `null` gracefully rather than crashing the request

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `ForecastResolver` in `domains/graphql` | `getForecast()` returns `ForecastResponse` | Return shape |
