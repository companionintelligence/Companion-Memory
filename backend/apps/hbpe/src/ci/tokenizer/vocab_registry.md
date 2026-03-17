# vocab_registry.py

## Purpose
DB CRUD layer for the living L1 and L2 label vocabularies. In the Qwen architecture, clusters are label strings rather than HDBSCAN centroids. This module provides atomic get-or-create operations that transparently add new labels to `ci.l1_clusters` / `ci.l2_clusters` on first encounter.

## Components

### `normalise_l0(raw)`
- **Does**: Maps raw model output to a valid L0 class string; defaults to UNKNOWN

### `get_l1_vocab(user_id, l0_class)`
- **Does**: Returns active L1 cluster labels for a user+L0 pair, ordered by popularity
- **Interacts with**: `ci.l1_clusters`

### `get_l2_vocab(user_id, l0_class, l1_cluster_id)`
- **Does**: Returns active L2 cluster labels under a specific L1 cluster
- **Interacts with**: `ci.l2_clusters`

### `get_or_create_l1(user_id, l0_class, label) → (cluster_id, is_new)`
- **Does**: SELECT first; INSERT if absent (race-safe with try/except re-fetch)
- **Interacts with**: `ci.l1_clusters`
- **Rationale**: is_new=True → nightly runner schedules HMT retrain

### `get_or_create_l2(user_id, l0_class, l1_cluster_id, label) → (cluster_id, is_new)`
- **Does**: Same pattern for L2 clusters; centroid stored as NULL
- **Interacts with**: `ci.l2_clusters`

### `write_event_label(event_id, user_id, l0_class, l1_cluster_id)`
- **Does**: Upserts `ci.l1_event_cluster` with similarity=1.0; bumps cluster member_count
- **Interacts with**: `ci.l1_event_cluster`, `ci.l1_clusters`

### `write_content_label(content_id, user_id, l0_class, l1_cluster_id, l2_cluster_id)`
- **Does**: Upserts `ci.l2_content_cluster` + `ci.content_context`; bumps L2 cluster member_count
- **Interacts with**: `ci.l2_content_cluster`, `ci.content_context`, `ci.l2_clusters`

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `tokenizer/qwen_labeler.py` | All public functions as documented | Signature changes |
| `tokenizer/serializer.py` | `ci.l1_event_cluster.similarity` column exists (written as 1.0) | Schema change |
| `tokenizer/l1_staleness.py` | `ci.l1_clusters.last_active_at` updated by write_event_label | Column removal |

## Notes
- ON CONFLICT clauses assume unique constraints on: `l1_event_cluster(event_id)`, `l2_content_cluster(content_id)`, `content_context(content_id)` — matches what nightly runner queries assume
- centroid=NULL for new clusters; existing clusters from old pipeline retain their centroids
