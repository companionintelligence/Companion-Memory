# HBPE Test Scripts

Progressive smoke tests — each step depends on the previous.

```
backend/apps/hbpe/
└── scripts/
    ├── test_step1_l0.py       No DB, no GPU
    ├── test_step2_features.py DB + seed events
    ├── test_step3_discovery.py DB + Step 2 artifacts
    ├── test_step4_router.py   DB + Step 3 artifacts
    └── test_step5_validate.py DB + Steps 2-4 complete
```

## Setup

```bash
cd backend/apps/hbpe
pip install -e ".[dev]"   # or: uv pip install -r pyproject.toml
export PYTHONPATH=src
export DATABASE_URL=postgresql://user:pass@localhost:5432/compint
export MODELS_DIR=/tmp/hbpe_models
export TOKEN_CORPUS_DIR=/tmp/hbpe_corpus
USER_ID=<uuid from ci.users>
```

## Step 1 — L0 Classifier (no DB needed)
```bash
python scripts/test_step1_l0.py
```
Proves keyword + embedding classification works.

## Step 2 — Feature Extractor (DB required)
```bash
python scripts/test_step2_features.py $USER_ID
```
Fits `scalar_scaler.pkl`. Checks 391-dim output and unit-normalised embeddings.

## Step 3 — L1 Discovery (needs Step 2)
```bash
python scripts/test_step3_discovery.py $USER_ID
```
Runs UMAP+HDBSCAN per L0 class. Checks clusters in DB with 391-dim centroids.
Saves `umap_l1_{l0_class}.pkl` per class.

## Step 4 — L1 Router (needs Step 3)
```bash
python scripts/test_step4_router.py $USER_ID
```
Routes a sample of events. Checks similarity scores look healthy (avg > 0.5).

## Step 5 — Serialize + Validate (needs Steps 2–4)
```bash
python scripts/test_step5_validate.py $USER_ID
# or with explicit date range:
python scripts/test_step5_validate.py $USER_ID 2025-10-01 2025-11-30
```
Emits `.parquet` token corpus. Runs PipelineValidator against spec §7.1 criteria.
This is the Phase 1 acceptance test.

## Notes
- Steps 2–5 need migrations `20260227000001` and `20260227000002` applied.
- Phi-3 (GPU) is NOT needed for any of these tests — the TF-IDF naming path
  handles cluster naming without it. Cluster `display_name` may show
  `{L0_CLASS}_CLUSTER_0` initially until the naming cascade runs.
- L2 pipeline (context assigner → L2 discovery → L2 router) is not covered
  here; it requires `ci.content` rows with non-null `embedding` columns.
