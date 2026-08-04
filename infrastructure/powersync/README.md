# PowerSync — local-first sync (backend scaffold)

This directory scaffolds the **server side** of local-first sync for CI-Server: an
on-device SQLite database that syncs bidirectionally with Postgres via
[PowerSync](https://docs.powersync.com/). It is **infrastructure + config only** —
the client SDK integration (reading synced tables from local SQLite, the upload
connector) is a **separate, later** piece and is intentionally not included here.

> ⚠️ This scaffold has **not been run** against a live PowerSync service. Treat the
> YAML keys, image tag, and start command as a starting point to verify against the
> PowerSync release you deploy.

## Pieces

| Piece | Where |
|-------|-------|
| Postgres logical replication | `infrastructure/database/Dockerfile` (`wal_level=logical`) |
| PowerSync service | `docker-compose.yml` → `powersync` service |
| Service config | `powersync.yaml` (this dir) |
| Sync rules (what syncs per user) | `sync-rules.yaml` (this dir) |
| Client token endpoint | `GET /api/powersync/token` (`backend/.../domains/powersync`) |

## How it fits together

```
Postgres (wal_level=logical)
   │  logical replication (CDC)
   ▼
PowerSync service (docker)  ──  filtered per-user buckets (sync-rules.yaml)
   ▲  client JWT (validated via client_auth)
   │
Client SDK  ──fetchCredentials()──▶  CI-Server  GET /api/powersync/token
   │                                  (JWT-guarded; signs a PowerSync JWT, sub=userId)
   ▼
on-device SQLite   ──writes──▶  CI-Server API (preserves auth + domain logic)
```

The token's `sub` = the CI-Server user id; sync rules scope each bucket with
`request.user_id()`. **Writes must go through the existing NestJS/GraphQL mutations**
(so auth + validation + business logic are preserved) — do **not** let the sync
engine write Postgres directly. That write connector is part of the client phase.

## What syncs

Only small, `user_id`-scoped, read-mostly tables: `ci.notes`, `ci.files` (metadata
only — the binary stays in Minio), `ci_search.tags`. Large/server-computed/PII data
(events, communications, browser_activity, pgvector embeddings, the knowledge graph)
stays online via GraphQL. See `sync-rules.yaml` for the rationale and the TODO list
for tables that still need their exact names verified before being added.

## Configuration

Server env (read by `config.powersync`, see `backend/apps/api/config/`):

| Env | Purpose |
|-----|---------|
| `POWERSYNC_URL` | Public URL of the PowerSync service (returned to clients) |
| `POWERSYNC_JWT_SECRET` | Shared HS256 secret used to sign client tokens |
| `POWERSYNC_AUDIENCE` | Token audience (default `powersync`) |

> ⚠️ `POWERSYNC_AUDIENCE` must match `client_auth.audience` in `powersync.yaml` (the
> service config, which hard-codes `['powersync']`). If you override it on CI-Server,
> update the service config too, or PowerSync will reject the tokens as invalid.

With `POWERSYNC_URL` / `POWERSYNC_JWT_SECRET` unset, the feature is dormant and
`/api/powersync/token` returns **503** — safe to ship disabled.

PowerSync service env (set in `.env`, mapped in `docker-compose.yml`):

| `.env` | Container var | Example |
|--------|---------------|---------|
| `POWERSYNC_REPLICATION_URI` | `PS_REPLICATION_URI` | `postgresql://companion:<DATABASE_PASSWORD>@database:5432/companion` |
| `POWERSYNC_STORAGE_URI` | `PS_STORAGE_URI` | same Postgres (Postgres bucket storage, image ≥ 1.3.8) |
| `POWERSYNC_JWT_SECRET_B64URL` | `PS_JWT_SECRET_B64URL` | `base64url(POWERSYNC_JWT_SECRET)` — the symmetric JWKS key |

> ⚠️ The two columns differ on purpose. `powersync.yaml` pulls these through the
> `!env` tag, and the service **only substitutes names beginning with `PS_`** —
> referencing `POWERSYNC_REPLICATION_URI` directly makes it exit 150 at startup
> with `Variables must start with "PS_"`, before it reads any config. The `.env`
> side keeps the `POWERSYNC_` prefix so it reads consistently with the
> server-side vars above; `docker-compose.yml` bridges the two. Defaults for all
> three ship in `.env.default`. `POWERSYNC_CONFIG_PATH` is exempt — the runtime
> reads it directly rather than through `!env`.

Derive the JWKS key from the shared secret:

```bash
printf '%s' "$POWERSYNC_JWT_SECRET" | basenc --base64url | tr -d '='
```

The server signs HS256 with `POWERSYNC_JWT_SECRET` and `kid=ci-powersync-hs256`; the
service's `client_auth.jwks` trusts the matching symmetric key. **For production,
switch to asymmetric keys (RS256/EdDSA) via a JWKS endpoint** — see the commented
`jwks_uri` in `powersync.yaml`.

## Verify before relying on it

Items 1 and 2 are confirmed against the currently pinned `1.23.0` on a local
Postgres 18 stack: the service boots, runs its own storage migrations, activates
`postgresql` storage, and starts the replicator. Re-check both when bumping the tag.

1. Pin `journeyapps/powersync-service` to a tested tag (≥ 1.3.8 for Postgres storage)
   and confirm the `start -r unified` command + `POWERSYNC_CONFIG_PATH` for that tag.
2. Confirm the `powersync.yaml` keys (`replication`/`storage`/`client_auth`/`sync_rules`)
   and the `!env` substitution syntax against that release. Note `storage` needs its
   own `sslmode` — it does not inherit the one under `replication`.
3. Confirm `request.user_id()` is the correct sync-rules accessor for the token `sub`
   (older docs use `token_parameters.user_id`).
4. Check uuid↔text comparison of `user_id = bucket.user_id` in the replicated schema.

## Next (client phase, not in this scaffold)

- Add `@powersync/web` + `@powersync/react`; define the on-device schema for the
  synced tables; implement the connector (`fetchCredentials` → `/api/powersync/token`;
  `uploadData` → existing GraphQL mutations).
- Migrate a first collection's reads (notes) from Apollo to a PowerSync watched query.
