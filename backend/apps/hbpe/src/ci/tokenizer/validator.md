# validator.py

## Purpose
Runs acceptance-criteria checks against `ci.token_stream` and the cluster registry tables.
All checks are pure DB queries — no parquet files required.
Produces a `validation_report.json` and raises on hard failures.

## Components

### `ValidationError`
- **Does**: Raised when any hard acceptance criterion fails

### `PipelineValidator.validate`
- **Does**: Runs 5 checks against the DB → writes `validation_report.json` → raises `ValidationError` if hard criteria fail
- **Interacts with**: `_check_l0_coverage`, `_check_l0_balance`, `_check_l1_cluster_counts`, `_check_l2_cluster_total`, `_check_bucket_sanity`

### `_check_l0_coverage`
- **Does**: Queries `ci.token_stream` — L0 bucket coverage ratio ≥ 90%; hard fail

### `_check_l0_balance`
- **Does**: L0 class token counts from `ci.token_stream` — informational only, never fails

### `_check_l1_cluster_counts`
- **Does**: Per-class L1 cluster count in [1, 50]; UNKNOWN exempt from upper bound; hard fail on violation

### `_check_l2_cluster_total`
- **Does**: Total active L2 clusters ≥ 5; skipped (informational) when `ci.content` is empty

### `_check_bucket_sanity`
- **Does**: Flags days where all L0 tokens share one bucket — indicates start_time parsing bug; hard fail

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| CI bootstrap | `PipelineValidator().validate(user_id) -> dict` or raises | Signature |
| Spec §7.1 | L0 coverage ≥ 90%; L1 per class [1-50]; L2 ≥ 5 (when content exists) | Thresholds |

## Notes
- Implements T1.6 (CI-Server-o52)
- `validate(user_id, report_dir=None)` — report_dir defaults to CWD
- Class imbalance is expected per spec — informational check only
