# 11 — Export & Portability

> **Status:** draft &nbsp;•&nbsp; **Phase:** P5
>
> A self-hosted twin is only trustworthy if the user can take it elsewhere. Add streaming export, encrypted backup, and an import path.

---

## 1. Summary

There is no export endpoint, no documented backup procedure beyond "the docker volume", and no path to move a twin between Hubs. A user must be able to dump everything (entities, relationships, files, embeddings, summaries, predictions, skills, policies, audit) and restore on another Hub with byte-identical fidelity.

## 2. Current state

- Data lives in `db-data` (Postgres volume) and `object-data` (MinIO).
- `make` targets exist for db destroy/clear/seed but nothing for export.
- No documented restore.

## 3. Target state

### 3.1 Export format

A **CI Twin Archive (CTA)** is a directory or `.tar.zst`:

```
twin-<user-id>-<timestamp>.cta/
├── manifest.json                 # version, hub id, user id, timestamps, contents hash
├── meta/
│   ├── users.jsonl
│   ├── actors.jsonl
│   ├── api_keys.jsonl            # hashed_key only, scopes preserved
│   └── policies.jsonl
├── graph/
│   ├── entities.jsonl            # one entity per line w/ memory_kind, provenance
│   ├── relationships.jsonl
│   └── facts.jsonl
├── timeseries/
│   ├── measurements.parquet      # hypertable → columnar
│   └── position.parquet
├── content/
│   ├── threads.jsonl
│   ├── messages.jsonl
│   └── summaries.jsonl
├── ingestion/
│   ├── ingest_runs.jsonl
│   └── raw/                      # raw provider payloads (etl tables)
├── files/
│   ├── index.jsonl               # file_id, sha256, mime, size, properties
│   └── objects/                  # actual file bytes, sharded by hash
├── embeddings/
│   ├── vectors.bin               # packed f32, with adjacent meta.jsonl
│   └── meta.jsonl
├── skills/
│   ├── definitions.jsonl
│   └── installs.jsonl
└── audit/
    ├── auth_denials.jsonl
    ├── tool_invocations.jsonl
    ├── skill_invocations.jsonl
    └── consent_receipts.jsonl
```

Versioned via `manifest.json.version = 1`. JSON Lines for streamability; Parquet for hypertables.

### 3.2 Encrypted archive

`.cta.age` — encrypted with `age` (passphrase or recipient key). Default flow: passphrase, with QR-code for transfer.

### 3.3 Endpoints

- `POST /api/v1/export` → kicks off Temporal workflow, returns `export_id`.
- `GET /api/v1/export/<id>/status`
- `GET /api/v1/export/<id>/download` (signed URL into MinIO)
- `POST /api/v1/import` (multipart upload + passphrase)
- `GET /api/v1/import/<id>/status`

Plus a `make export` / `make import` for offline use.

### 3.4 Import flow

```mermaid
sequenceDiagram
    participant U as User
    participant API as API
    participant T as Temporal
    participant W as Worker
    participant DB as Postgres
    participant OBJ as MinIO

    U->>API: POST /import with .cta.age + passphrase
    API->>OBJ: store archive
    API->>T: ImportWorkflow(archiveRef)
    T->>W: validate manifest, version match
    W->>DB: create empty target user (or merge)
    W->>DB: insert actors, policies
    W->>DB: insert entities, relationships, facts (preserve ids)
    W->>DB: copy measurements/position to hypertables (parquet → COPY)
    W->>OBJ: upload object files
    W->>DB: insert content (threads/messages/summaries)
    W->>DB: re-embed if model differs; otherwise import vectors as-is
    W->>API: ready
```

### 3.5 Selective export

Flags to scope what's included: `--no-files`, `--no-raw-ingestion`, `--from <date>`, `--exclude-pii-class health,financial`.

### 3.6 Backup automation

A Temporal cron writes encrypted exports nightly to a user-configured S3-compatible target (R2, B2, Wasabi, MinIO, NAS). Retention: 7 daily, 4 weekly, 12 monthly.

## 4. Branch disposition

None directly.

## 5. Phased steps

| # | Increment |
|---|---|
| 1 | `domains/export` module + manifest schema |
| 2 | Streaming exporter per entity type (JSONL) |
| 3 | Parquet exporter for hypertables |
| 4 | Object-store snapshot (hash-sharded) |
| 5 | `age` encryption wrapper |
| 6 | Import workflow with version migration |
| 7 | Selective export flags |
| 8 | Nightly cron + S3 target config |
| 9 | UI: Settings → Backup |

## 6. Risks

| Risk | Mitigation |
|---|---|
| Embedding model drift on restore | Manifest records embedding model; importer offers "use as-is" or "re-embed". |
| Huge archive sizes | Stream; sharded files; selective export; resumable upload/download. |
| Secrets in archive | Never export `users.password_hash` to an export archive; require re-auth on import. API keys: hashed only. |
| Ingest tables enormous | Optional `--no-raw-ingestion` flag; document the trade-off (re-fetch from providers vs. carry raw). |

## 7. Eval / acceptance

- Round-trip: export from Hub A → import to Hub B → diff (excluding timestamps and re-issued secrets) shows the same graph, summaries, files, and embeddings.
- An encrypted archive is unreadable without the passphrase (smoke test).
- A 30-day-only export drops everything older without touching newer rows.
- The nightly backup cron writes to the configured target and rotates old archives.
