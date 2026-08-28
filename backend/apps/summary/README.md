# CI-Summary: Temporal Summarization Service

**Hierarchical temporal summarization system for CompInt personal intelligence platform**

> "Temporal" here means *over time*. This service has nothing to do with
> Temporal.io, which was removed from the appliance on 2026-08-08 and replaced by
> pg-boss.

## Overview

CI-Summary is a Python sidecar that creates intelligent, multi-layered summaries of user activity across all CompInt data sources. It operates on four temporal scales:

- **Hourly Summaries**: Detailed hour-by-hour activity digests
- **Daily Summaries**: Day-level synthesis from hourly summaries
- **Weekly Summaries**: Week-level insights from daily summaries
- **Monthly Summaries**: Month-level rollups from the weekly layer

The hourly user dossier, insights and feed actions run on the same machinery.
All summaries are stored in `ci.summaries` with a vector embedding for semantic
search.

## Architecture

The NestJS API is the only scheduler. `PythonFunctionCrons` fans out one pg-boss
job per user onto the `py-fn-summary` queue, a dispatch listener POSTs it to this
service's `/functions/run`, and the runner completes the deferred pg-boss job
through an authenticated callback webhook. **There is no worker process and no
polling loop in this service** — the former Temporal workflows are now plain
async functions in `functions.py`.

```
NestJS API (pg-boss crons) → py-fn-summary queue → POST /functions/run
                                                    ↓
                    [Data Aggregation] → Measurements, Position, Communications,
                                         Activities, Events, Messages, Files,
                                         API Logs, Browser Activity, Screen Captures
                                            ↓
                    [LLM Summarization] → Local OpenAI-compatible endpoint
                                            ↓
                    [Storage] → ci.summaries (period_type hourly|daily|weekly|monthly,
                                content JSONB, summary_embedding vector(768))
                                            ↓
                    POST {API_URL}/function-runs/callback  → completes the pg-boss job
```

## Features

- ✅ **Function Runner**: `POST /functions/run` with a bounded worker pool and a signed completion callback
- ✅ **Multi-Source Aggregation**: Queries 10 data tables, schema-introspected rather than hardcoded
- ✅ **LLM Integration**: Uses local models via OpenAI-compatible API
- ✅ **Vector Embeddings**: Generates semantic embeddings for all summaries
- ✅ **Hierarchical Rollups**: hourly → daily → weekly → monthly
- ✅ **Dossier, Insights, Actions**: the same runner serves `dossier_refresh`, `insights_generation` and `actions_generation`
- ✅ **Document Parser**: a second FastAPI app (`parser.py`) backing CI-Server's `parsing` domain
- ✅ **Docker Ready**: Containerized for easy deployment

## Quick Start

### 1. Environment Setup

All configuration now lives in the root `.env` / `.env.default` files at the
repo root. Update those files (or export the same variables in your shell) so
the summary service picks up values for `DATABASE_URL` (if running standalone)
and the `LLM_*` settings. No separate `.env` file is required inside this app.

### 2. Configuration

Key environment variables:

```bash
# Database (assembled by entrypoint.sh from DATABASE_* when unset)
DATABASE_URL=postgresql://user:pass@database:5432/companion

# LLM (Ollama default)
LLM_API_BASE=http://host.docker.internal:11434/v1
# The chat model is normally injected by CI Hub as LLM_DEFAULT_CHAT_MODEL.
# SUMMARY_LLM_MODEL overrides it; LLM_MODEL is the legacy spelling. There is
# deliberately NO hardcoded fallback — when all three are unset the model is
# discovered from the endpoint at startup.
SUMMARY_LLM_MODEL=
EMBEDDING_MODEL=nomic-embed-text   # or LLM_DEFAULT_EMBEDDING_MODEL

# Function runner
FUNCTION_RUNNER_CONCURRENCY=2
API_URL=http://api:3030            # where run-completion callbacks POST
API_JWT_SECRET=                    # entrypoint.sh reads AUTH_TOKEN_SECRET
```

### 3. Run with Docker Compose

From the repo root, `make dev` brings the whole stack up; the summary service is
in the `local`, `staging` and `production` profiles. To drive it directly:

```bash
docker compose build summary-service
docker compose --profile local up summary-service
```

`entrypoint.sh` starts **two** uvicorn apps in one container:

| App | Container port | Host port (local) |
| --- | --- | --- |
| `ci.summary.api` — manual triggers + `/functions/run` | 8001 | `SUMMARY_HOST_PORT`, default **8001** |
| `ci.summary.parser` — document parser | 8002 | `PARSER_HOST_PORT`, default **8003** |

### 4. Run Locally (Development)

Python dependencies resolve through the single `uv.lock` at the repo root; this
app is a `[tool.uv.workspace]` member and has no lockfile or `requirements.txt`
of its own.

```bash
uv sync --all-packages                    # from the repo root
uv run uvicorn ci.summary.api:app --reload --port 8001
```

## Usage

### Scheduled Tasks from CI-Server

`PythonFunctionCrons` in the NestJS API enqueues one pg-boss job per onboarded
user onto the `py-fn-summary` queue, deduplicated by the singleton key
`fn:<function>:<userId>:<windowKey>`. `PythonFunctionDispatchListener` POSTs each
job here:

```jsonc
// POST /functions/run  → 202 { run_id, status, function }
{
  "function": "hourly_summary",
  "args": { "user_id": "<uuid>" },
  "job_id": "<pg-boss job id>",   // completion is reported back for it
  "queue": "py-fn-summary"
}
```

The runner accepts the run into a bounded worker pool
(`FUNCTION_RUNNER_CONCURRENCY`, default 2), returns immediately, and POSTs the
outcome to `{API_URL}/function-runs/callback` with a self-signed service JWT.
If the runner dies mid-run, the queue's `expireInSeconds` (30 minutes for
summary) elapses and pg-boss retries — that is the durability story.

`GET /functions` lists the registry; `GET /runs/{run_id}` reports one run.

The registry (`FUNCTIONS` in `functions.py`) must stay in sync with
`PYTHON_FUNCTIONS.summary` in the NestJS `python-functions` domain:

| Function | Cron (UTC) |
| --- | --- |
| `hourly_summary` | `0 5 * * * *` |
| `daily_summary` | `0 10 0 * * *` |
| `weekly_summary` | `0 15 0 * * 1` |
| `monthly_summary` | `0 20 0 1 * *` |
| `dossier_refresh` | `0 12 * * * *` |
| `insights_generation` | `0 30 */3 * * *` |
| `actions_generation` | `0 45 * * * *` |

### Checking Results

Summaries land in `ci.summaries`, not in the entity graph:

```sql
SELECT
    summary_id,
    period_type,
    period_start,
    period_end,
    content->>'summary_text' AS summary,
    content->'activity_counts' AS counts
FROM ci.summaries
WHERE user_id = '<user_uuid>'
ORDER BY created_at DESC;
```

### Manual Summary Trigger (Testing & Debugging)

For testing and debugging, you can run a function inline — no pg-boss job, no
callback — through the API's own endpoints. All of them are on port **8001**.

```bash
# Trigger a summary (defaults to the last hour)
curl -X POST http://localhost:8001/summary/manual-trigger \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "<user-uuid>",
    "period_type": "hourly"
  }'

# Trigger with a custom time range
curl -X POST http://localhost:8001/summary/manual-trigger \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "<user-uuid>",
    "period_type": "daily",
    "start_time": "2025-11-12T00:00:00Z",
    "end_time": "2025-11-12T23:59:59Z",
    "timezone": "America/Los_Angeles"
  }'
```

The full inline surface:

| Route | Does |
| --- | --- |
| `POST /summary/manual-trigger` | `hourly` / `daily` / `weekly` / `monthly` / `dossier` |
| `POST /dossier/refresh` · `POST /dossier/get` | Rebuild or read the dossier |
| `POST /insights/generate` · `POST /insights/force-generate` | Insight generation, with and without the new-data gate |
| `POST /actions/generate` | Feed actions |
| `GET /summary/aggregate` | The aggregation step alone, no LLM |

These bypass the queue and execute the same code the runner does, which makes
them useful for debugging a specific window, backfilling a period, or working
offline from the scheduler.

### Hourly User Dossier Refresh

`dossier_refresh` produces a compact **user dossier** every hour
(`PythonFunctionCrons.dossierRefresh`, `0 12 * * * *`), and the cron narrows its
audience to users who actually have daily summaries to fold in.

- Configure refresh behavior with:
  - `SUMMARY_DOSSIER_LOOKBACK_DAYS` (default `30`)
  - `SUMMARY_DOSSIER_MAX_CHARS` (default `4000`)
- The dossier is derived from the latest daily summaries plus the previously
  persisted dossier so that updates remain incremental. The result is stored in
  the `entities.dossier` JSONB column of the user's `Person` entity.
- If no daily summaries exist for the window, the refresh is skipped.

Manual trigger example:

```bash
curl -X POST http://localhost:8001/dossier/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "<user-uuid>",
    "timezone": "UTC"
  }'
```

`POST /dossier/get` returns the persisted entity ID and dossier payload so you
can inspect what was written.

Each `summary_text` is produced by the same OpenAI-compatible model that powers the rest of CI Memory, so you get intent-level insights ("researching GPU shortages", "planning travel", etc.) rather than raw counters.

## Data Sources

CI-Summary aggregates data from:

1. **measurements** - Sensor data (heart rate, steps, temperature, etc.)
2. **position** - GPS/location tracking
3. **communications** - Emails, SMS, calls
4. **activities** - Tracked life activities
5. **events** - Calendar events (title/description join back from `ci.entities` since the CTI conversion)
6. **messages** - Chat conversations
7. **files** - File activity (created, modified)
8. **api_logs** - API interactions
9. **browser_activity** - Page views
10. **screen_captures** - Screen capture rows (capped at 50 per window)

The table list lives in `TABLES` in `data_aggregator.py`. Columns are
introspected per table rather than hardcoded, and noisy ones (embeddings, blobs,
OCR text, screenshots) are excluded by pattern.

## Output Format

Each summary includes:

```json
{
  "summary_id": "uuid",
  "summary_type": "hourly|daily|weekly|monthly",
  "summary_text": "Natural language summary...",
  "key_insights": ["insight 1", "insight 2"],
  "activity_counts": {
    "measurements": 150,
    "positions": 60,
    "communications": 5,
    "activities": 3,
    "events": 2,
    "messages": 10,
    "files": 4,
    "api_logs": 20,
    "browser_activity": 31,
    "screen_captures": 0,
    "total": 285
  },
  "tokens_used": 1842
}
```

## Storage Schema

Summaries are rows in `ci.summaries`, not graph entities — there is no
`HourlySummary` entity type and no `SUMMARIZED_BY` edge. `store_summary_activity`
writes:

```
summary_id        uuid
user_id           uuid
period_start      timestamptz
period_end        timestamptz
period_type       hourly | daily | weekly | monthly
timezone          text
source_types      text[]      -- the activity_counts keys with a nonzero count
title             text        -- "Hourly Summary"
content           jsonb       -- summary_text, key_insights, activity_counts,
                              --   tokens_used, structured_data
summary_embedding vector(768)
seen              boolean
```

The hierarchy is expressed by the rollups reading their children back out of the
same table (`fetch_child_summaries_activity`), not by a stored relationship.

## Scheduled Execution

Scheduling is owned by the NestJS API. Do **not** add a pg_cron job or an
external scheduler for this service: see the cron table under
[Scheduled Tasks from CI-Server](#scheduled-tasks-from-ci-server), and
`backend/apps/api/src/domains/python-functions/cron/PythonFunctionCrons.ts`.

## Development

### Project Structure

```
backend/apps/summary/
├── src/ci/summary/
│   ├── api.py                  # FastAPI app (manual triggers + function runner)
│   ├── runner.py               # /functions/run worker pool + pg-boss callbacks
│   ├── functions.py            # Named background functions (summaries, insights, ...)
│   ├── activities.py           # Step functions the named functions compose
│   ├── summary_functions.py    # Window resolution + rollup helpers
│   ├── config.py               # Configuration management
│   ├── database.py             # Database connections (search_path=ci,public)
│   ├── data_aggregator.py      # Multi-table data aggregation
│   ├── insight_aggregator.py   # Context for insight generation
│   ├── action_aggregator.py    # Context for feed-action generation
│   ├── dossier_builder.py      # Incremental user dossier
│   ├── summarizer.py           # LLM-based summarization
│   ├── llm_config.py           # Model resolution / OpenAI-compatible client
│   ├── llm_endpoint_env.py     # LLM_* env plumbing shared with the API
│   ├── timezone_utils.py
│   └── parser.py               # Document-parser FastAPI app (port 8002)
├── entrypoint.sh
├── Dockerfile
├── pyproject.toml              # workspace member; no lockfile of its own
└── README.md
```

> No `src/ci/__init__.py` — `ci` is a PEP 420 namespace shared with `ci.hbpe`
> and the packages under `backend/packages/`. Adding one makes every other
> `ci.*` package unimportable. Enforced by `scripts/check-ci-namespace.sh`.

### Running Tests

```bash
uv run pytest backend/apps/summary/tests -v   # from the repo root
make test                                     # everything, JS and Python
```

## Monitoring

> The `agents` and `agent_messages` tables were dropped
> (migration `20260808065716_drop_agents_and_agent_messages.sql`). There is no
> agent registration and no message table to poll — everything below reads
> pg-boss and `ci.summaries`.

What the runner currently holds:

```bash
curl http://localhost:8001/functions            # registry + concurrency
curl http://localhost:8001/runs/<run_id>        # one run's status/result/error
```

Queue depth and recent runs, from the API side:

```sql
SELECT state, count(*)
  FROM pgboss.job
 WHERE name = 'py-fn-summary'
 GROUP BY state;
```

Recent summaries actually written:

```sql
SELECT period_type, count(*), max(created_at)
  FROM ci.summaries
 WHERE user_id = '<user_uuid>'
 GROUP BY period_type;
```

The web Jobs page (`/jobs`) shows the same queue with its dead letters.

## Troubleshooting

### Functions Not Running

1. Check the registry the service will accept:
   ```bash
   curl http://localhost:8001/functions
   ```
   A name missing here is a name `PYTHON_FUNCTIONS.summary` in the NestJS
   `python-functions` domain must not dispatch.

2. Check whether anything was enqueued at all (the crons only fan out to
   onboarded users):
   ```sql
   SELECT name, state, count(*) FROM pgboss.job
    WHERE name = 'py-fn-summary' GROUP BY name, state;
   ```

3. Check logs:
   ```bash
   docker compose logs -f summary-service
   ```

4. If runs start but never complete on the API side, the callback is failing —
   confirm `API_URL` is reachable from the container and `API_JWT_SECRET` matches
   the API's `AUTH_TOKEN_SECRET`. pg-boss recovers on its own after
   `expireInSeconds` (30 minutes).

### LLM Connection Issues

1. Verify LLM endpoint is accessible:
   ```bash
   curl http://localhost:11434/v1/models
   ```

2. Check model is available:
   ```bash
   ollama list  # For Ollama
   ```

3. Test embeddings:
   ```bash
   curl http://localhost:11434/v1/embeddings \
     -H "Content-Type: application/json" \
     -d '{"model":"nomic-embed-text","input":"test"}'
   ```

### Database Connection Issues

1. Verify DATABASE_URL in the repo root `.env`
2. Ensure postgres is accessible from container
3. Check network configuration in docker-compose.yml

## Performance Tuning

- **Token Usage**: Adjust `LLM_MAX_TOKENS` based on summary detail needs
- **Temperature**: Lower for more factual, higher for more creative
- **Concurrency**: `FUNCTION_RUNNER_CONCURRENCY` (default 2) bounds how many runs
  execute at once — this replaced the old per-priority task queues
- **Batch Size**: Modify `MAX_ITEMS_PER_CATEGORY` to control context size

## License

Part of the CompInt project - internal use only

## Contributing

Follow SOLID, DRY, KISS, and YAGNI principles as per CompInt standards.

---

Built with ❤️ for CompInt Personal Intelligence Platform
