# l2_staleness.py

## Purpose
Nightly staleness sweep for L2 clusters. Mirrors `l1_staleness.py` but operates
on `ci.l2_clusters`. Marks `is_active=FALSE` on clusters with no routing
activity in `settings.cluster_staleness_days` (default 90 days).

## Components

### `L2Staleness`
- **Does**: Stateless; exposes `run(user_id) -> int`

### `L2Staleness.run`
- **Does**: Delegates to `_deactivate_stale_clusters(user_id, settings.cluster_staleness_days)`

### `_deactivate_stale_clusters`
- **Does**: Single UPDATE on `ci.l2_clusters` with `RETURNING cluster_id`; logs count; returns rowcount

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `nightly_runner.py` | `L2Staleness().run(user_id)` callable as Temporal activity step | Constructor, signature |

## Notes
- Implements the L2 half of T5.2 (CI-Server-cs0)
- Threshold: `settings.cluster_staleness_days` (default 90)
- `last_active_at IS NOT NULL` guard prevents deactivating clusters that have never been routed to
