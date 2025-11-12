# CI-Memory: Temporal Summarization Agent

**Hierarchical temporal summarization system for CompInt personal intelligence platform**

## Overview

CI-Memory is an autonomous agent that creates intelligent, multi-layered summaries of user activity across all CompInt data sources. It operates on three temporal scales:

- **Hourly Summaries**: Detailed hour-by-hour activity digests
- **Daily Summaries**: Day-level synthesis from hourly summaries
- **Weekly Summaries**: Week-level insights from daily summaries

All summaries are stored as entities in the knowledge graph with full vector embeddings for semantic search.

## Architecture

```
CI-Server Backend → agent_messages table → CI-Memory Agent
                                            ↓
                    [Data Aggregation] → Measurements, Position, Communications,
                                         Activities, Events, Messages, Files, API Logs
                                            ↓
                    [LLM Summarization] → Local OpenAI-compatible endpoint
                                            ↓
                    [Graph Storage] → entities (HourlySummary, DailySummary, WeeklySummary)
                                     → relationships (SUMMARIZED_BY)
```

## Features

- ✅ **Agent Registration**: Self-registers in CI-Server agents table
- ✅ **Message Queue Listener**: Polls agent_messages for tasks
- ✅ **Multi-Source Aggregation**: Queries 8+ data tables
- ✅ **LLM Integration**: Uses local models via OpenAI-compatible API
- ✅ **Vector Embeddings**: Generates semantic embeddings for all summaries
- ✅ **Knowledge Graph Storage**: Stores summaries as graph entities
- ✅ **Hierarchical Relationships**: Links hourly→daily→weekly
- ✅ **Performance Metrics**: Tracks success rates and execution times
- ✅ **Docker Ready**: Containerized for easy deployment

## Quick Start

### 1. Environment Setup

All configuration now lives in the root `.env` / `.env.default` files at the
repo root. Update those files (or export the same variables in your shell) so
the memory service picks up values for `DATABASE_URL` (if running standalone)
and the `LLM_*` settings. No separate `.env` file is required inside this app.

### 2. Configuration

Key environment variables:

```bash
# Database (only needed if you run the worker outside docker-compose)
DATABASE_URL=postgresql://user:pass@postgres:5432/compint

# LLM (Ollama default)
LLM_API_BASE=http://localhost:11434/v1
LLM_MODEL=qwen2.5:32b  # Or llama3.1:70b, mistral, etc.
EMBEDDING_MODEL=nomic-embed-text

# Agent
AGENT_CHECK_INTERVAL_SECONDS=30  # Configurable via root .env if needed
```

### 3. Run with Docker Compose

```bash
docker-compose up --build
```

### 4. Run Locally (Development)

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python -m src.main
```

## Usage

### Scheduled Tasks from CI-Server

The CI-Server API now enqueues PgBoss jobs onto the `memory-summaries` queue. Each
payload contains the owner, time window, and cadence:

```json
{
  "userId": "<uuid>",
  "periodType": "hourly|daily|weekly",
  "periodStart": "2025-11-03T10:00:00Z",
  "periodEnd": "2025-11-03T11:00:00Z",
  "timezone": "UTC"
}
```

The memory service polls this queue, runs the corresponding aggregation + LLM
routine, stores the results, and acknowledges the job. Monthly / seasonal / yearly
cadences are scheduled but currently stubbed until their aggregation pipeline is in
place.

### Checking Results

Query the `entities` table to retrieve summaries:

```sql
SELECT 
    entity_id, 
    entity_type,
    name,
    properties->>'summary_text' as summary,
    properties->>'activity_counts' as counts
FROM entities
WHERE entity_type IN ('HourlySummary', 'DailySummary', 'WeeklySummary')
  AND owner_user_id = '<user_uuid>'
ORDER BY created_at DESC;
```

### Manual Browser History Processing

You can now summarize ad-hoc browser history exports without going through the queue/listener.

#### CLI

```bash
# Generate hourly and daily summaries from data/history.csv
python -m src.history_cli --input data/history.csv --output data/history_summaries.csv

# Skip LLM inference if you're offline
python -m src.history_cli --input data/history.csv --disable-llm
```

The CLI emits a combined CSV containing all hourly rows followed by daily rows, along with the computed stats and LLM-written summary for each bucket. Use `--disable-llm` when you just want the deterministic fallback text.

#### API Endpoint

```bash
uvicorn src.api:app --reload

# Upload an export directly
curl -X POST \
  -F "file=@data/history.csv" \
  http://localhost:8000/history/process-file

# Or send the data you already have in JSON form
curl -X POST http://localhost:8000/history/process-entries \
  -H "Content-Type: application/json" \
  -d '{"entries": [{"date": "11/9/2025", "time": "12:46:29", "title": "Example", "url": "https://example.com", "visitCount": 1, "transition": "typed"}]}'
```

Both endpoints return the generated hourly/daily summary objects plus the path to the CSV that was written under `data/` (or whatever output path you specify via `output_filename`).

Each `summary_text` is produced by the same OpenAI-compatible model that powers the rest of CI Memory, so you get intent-level insights ("researching GPU shortages", "planning travel", etc.) rather than raw counters.

## Data Sources

CI-Memory aggregates data from:

1. **measurements** - Sensor data (heart rate, steps, temperature, etc.)
2. **position** - GPS/location tracking
3. **communications** - Emails, SMS, calls
4. **activities** - Tracked life activities
5. **events** - Calendar events
6. **messages** - Chat conversations
7. **files** - File activity (created, modified)
8. **api_logs** - API interactions

## Output Format

Each summary includes:

```json
{
  "summary_entity_id": "uuid",
  "summary_type": "hourly|daily|weekly",
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
    "total": 254
  }
}
```

## Graph Storage Schema

### Entity Structure
```
entity_type: HourlySummary | DailySummary | WeeklySummary
name: "Hourly Summary: 2024-01-01 10:00"
properties: {
  start_time, end_time, summary_text, 
  activity_counts, key_insights, etc.
}
embedding: vector(768)
```

### Relationships
```
HourlySummary --[SUMMARIZED_BY]--> DailySummary
DailySummary --[SUMMARIZED_BY]--> WeeklySummary
```

## Scheduled Execution

For automated execution, use pg_cron or external scheduler:

```sql
-- Example: Hourly cron job
SELECT cron.schedule('hourly-summary', '0 * * * *', $$
  INSERT INTO agent_messages (user_id, agent_id, input_payload, status)
  SELECT 
    id,
    (SELECT agent_id FROM agents WHERE agent_name = 'memory-summarization-agent'),
    jsonb_build_object(
      'task_type', 'hourly_summary',
      'user_id', id::text,
      'start_time', (NOW() - INTERVAL '1 hour')::text,
      'end_time', NOW()::text
    ),
    'queued'
  FROM users WHERE is_active = true;
$$);
```

## Development

### Project Structure

```
CI-Memory/
├── src/
│   ├── main.py                 # Entry point
│   ├── config.py               # Configuration management
│   ├── database.py             # Database connections
│   ├── agent_registration.py   # Agent lifecycle
│   ├── message_listener.py     # Task queue processor
│   ├── data_aggregator.py      # Multi-table data aggregation
│   ├── summarizer.py           # LLM-based summarization
│   └── storage.py              # Graph storage
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
└── README.md
```

### Running Tests

```bash
pytest tests/ -v --cov=src
```

## Monitoring

Check agent status:

```sql
SELECT 
    agent_name,
    version,
    is_active,
    usage_count,
    success_rate,
    avg_execution_time_ms
FROM agents
WHERE agent_name = 'memory-summarization-agent';
```

Check recent executions:

```sql
SELECT 
    message_id,
    status,
    priority,
    started_at,
    completed_at,
    EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 as execution_ms
FROM agent_messages
WHERE agent_id = (SELECT agent_id FROM agents WHERE agent_name = 'memory-summarization-agent')
ORDER BY created_at DESC
LIMIT 10;
```

## Troubleshooting

### Agent Not Processing Messages

1. Check agent is registered and active:
   ```sql
   SELECT * FROM agents WHERE agent_name = 'memory-summarization-agent';
   ```

2. Check for queued messages:
   ```sql
   SELECT * FROM agent_messages 
   WHERE status = 'queued' 
   AND agent_id = (SELECT agent_id FROM agents WHERE agent_name = 'memory-summarization-agent');
   ```

3. Check logs:
   ```bash
   docker logs ci-memory-summarizer
   ```

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
- **Check Interval**: Adjust `AGENT_CHECK_INTERVAL_SECONDS` for responsiveness
- **Batch Size**: Modify `MAX_ITEMS_PER_CATEGORY` to control context size

## License

Part of the CompInt project - internal use only

## Contributing

Follow SOLID, DRY, KISS, and YAGNI principles as per CompInt standards.

---

Built with ❤️ for CompInt Personal Intelligence Platform
