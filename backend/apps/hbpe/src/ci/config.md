# config.py

## Purpose
Central settings object for the HBPE service, loaded from environment variables. All tunable constants live here so they can be overridden without touching code.

## Components

### `Settings`
- **Does**: Pydantic-settings model; reads every config value from env at startup
- **Interacts with**: `pydantic_settings.BaseSettings`; consumed by every module in `ci/`

### `settings`
- **Does**: Module-level singleton; imported directly (`from ci.config import settings`)
- **Rationale**: Avoids repeated env-var parsing

## Key fields

| Field | Default | Purpose |
|-------|---------|---------|
| `database_url` | required env | PostgreSQL connection string |
| `temporal_address` | `localhost:7233` | Temporal server address |
| `models_dir` | `/app/models` | HMT checkpoint + LoRA adapters root |
| `qwen_model_name` | `Qwen/Qwen3.5-0.8B` | HuggingFace model ID for LLM labeler |
| `cluster_staleness_days` | `90` | Days before unused cluster is deactivated |
| `api_port` | `8002` | HBPE histogram API port |

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `inference/qwen.py` | `settings.qwen_model_name` str | Field rename |
| `pipeline/nightly_runner.py` | `settings.models_dir` | Field rename |
| `worker.py` | `settings.temporal_address`, `settings.task_queue` | Field rename |
| All DB modules | `settings.database_url` | Field removal |

## Notes
- `DATABASE_URL` is required; service fails at import time if absent.
- Old clustering threshold fields removed (phi3_model_path, l1/l2 similarity thresholds, tfidf thresholds, pending pool triggers) — clustering pipeline deleted.
