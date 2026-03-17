# l1_staleness.py

## Purpose
Nightly staleness sweep for L1 clusters. Marks `is_active=FALSE` on any L1
cluster whose `last_active_at` is older than `settings.cluster_staleness_days`
(default 90 days). Deactivated clusters stay in the DB but are excluded from
routing — token corpus historical integrity is preserved.

## Components

### `L1Staleness`
- **Does**: Stateless; exposes `run(user_id) -> int`

### `L1Staleness.run`
- **Does**: Delegates to `_deactivate_stale_clusters(user_id, settings.cluster_staleness_days)`

### `_deactivate_stale_clusters`
- **Does**: Single UPDATE on `ci.l1_clusters` with `RETURNING cluster_id`; logs count; returns rowcount

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `nightly_runner.py` | `L1Staleness().run(user_id)` callable as Temporal activity step | Constructor, signature |

## Notes
- Implements the L1 half of T5.2 (CI-Server-cs0)
- Threshold: `settings.cluster_staleness_days` (default 90) — env-configurable
- Only deactivates when `last_active_at IS NOT NULL` (never-routed clusters are left untouched)
