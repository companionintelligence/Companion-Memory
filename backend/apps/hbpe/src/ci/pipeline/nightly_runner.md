# nightly_runner.py

## Purpose
Temporal workflow (`NightlyHBPEWorkflow`) that orchestrates the nightly HBPE pipeline per user. The labeling pipeline is replaced by a single `label_unlabeled` step using QwenLabeler.

## Job order
1. `label_unlabeled` — QwenLabeler on unlabeled events/content (≤10 min)
2. `l1_stale_sweep` — deactivate L1 clusters unused for 90 days
3. `l2_stale_sweep` — deactivate L2 clusters unused for 90 days
4. `lora_fine_tune` — per-user LoRA adapter update (skips gracefully if no base checkpoint)
5. `drift_detection` — Phase 5 stub
6. `cache_invalidation` — Phase 5 stub

## Components

### `NightlyHBPEWorkflow`
- **Does**: `@workflow.defn`; runs 6 activities in sequence with fail-continue semantics
- **Interacts with**: all `@activity.defn` functions below

### `label_unlabeled` (activity, step 1)
- **Does**: Queries events without `l1_event_cluster` rows and content without `l2_content_cluster` rows; calls `QwenLabeler.label_event` / `label_content` for each; returns counts + new_labels flag
- **Interacts with**: `QwenLabeler`, `ci.events`, `ci.content`

### `l1_stale_sweep`, `l2_stale_sweep` (activities, steps 2-3)
- **Does**: Deactivate clusters with `last_active_at` beyond staleness window
- **Interacts with**: `L1Staleness`, `L2Staleness`

### `lora_fine_tune` (activity, step 4)
- **Does**: Checks for base checkpoint; skips with log if absent (cold start); otherwise runs one epoch of LoRA fine-tuning
- **Interacts with**: `ci.model.nightly_finetune.fine_tune_nightly`

### `_safe_execute`
- **Does**: Awaits coroutine; returns `{status: ok, result}` or `{status: error, error}` — never re-raises

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `worker.py` | Activity names: `label_unlabeled`, `l1_stale_sweep`, `l2_stale_sweep`, `lora_fine_tune`, `drift_detection`, `cache_invalidation` | Activity name changes |
| CI infra | Workflow name `"NightlyHBPEWorkflow"`, input `user_id: str` | Workflow name, input type |

## Notes
- Removed: `retro_actual_fill`, `pending_pool_rediscovery` (replaced by `label_unlabeled`)
- All DB work runs in `run_in_executor(None, _run)` to avoid blocking the Temporal event loop
- `lora_fine_tune` now gracefully skips on cold start (base HMT checkpoint not yet trained)
