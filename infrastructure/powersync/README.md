# PowerSync — local-first sync (backend scaffold)

This directory scaffolds the **server side** of local-first sync for CI-Server: an
on-device SQLite database that syncs bidirectionally with Postgres via
[PowerSync](https://docs.powersync.com/). It is **infrastructure + config only** —
the client SDK integration (reading synced tables from local SQLite, the upload
connector) is a **separate, later** piece and is intentionally not included here.

> ⚠️ **Partially verified.** Server-side replication works against
> `journeyapps/powersync-service:1.23.0`: the service boots, storage migrations run, the
> router listens on 8080, and the replicator takes an initial snapshot of the three
> replicated tables and then streams changes from the WAL. **The client path is still
> unverified** — no SDK has connected, so the sync rules, the token flow, and the
> on-device schema have not been exercised end to end. See "Verify before relying on it".

## Pieces

| Piece | Where |
|-------|-------|
| Postgres logical replication | `infrastructure/database/Dockerfile` (`wal_level=logical`) |
| Replication role + publication | `infrastructure/setup-database/entrypoint.sh` |
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

`/api/powersync/token` returns **503** unless *both* `POWERSYNC_URL` and
`POWERSYNC_JWT_SECRET` are set — safe to ship disabled. `.env.default` sets only
`POWERSYNC_JWT_SECRET` (a throwaway dev value the service needs a matching JWKS key
for), so the endpoint stays dormant until you also set `POWERSYNC_URL`.

PowerSync service env (in `docker-compose.yml`):

| Env | Example |
|-----|---------|
| `PS_REPLICATION_URI` | `postgresql://powersync:<POWERSYNC_DATABASE_PASSWORD>@database:5432/companion` |
| `PS_STORAGE_URI` | `postgresql://companion:<DATABASE_PASSWORD>@database:5432/companion` (Postgres bucket storage, image ≥ 1.3.8) |
| `PS_JWT_SECRET_B64URL` | `base64url(POWERSYNC_JWT_SECRET)` — the symmetric JWKS key |

> ⚠️ The `PS_` prefix is **required**, not stylistic. `powersync.yaml`'s `!env` tag
> refuses to substitute any variable whose name does not start with `PS_`, and the
> service treats that as a fatal startup error (exit 150, crash-loop). All three
> default in `docker-compose.yml` to the local `database` container, so only
> `PS_JWT_SECRET_B64URL` and `POWERSYNC_DATABASE_PASSWORD` must be supplied, and
> `.env.default` ships dev values for both. Note `POWERSYNC_CONFIG_PATH` is *not*
> substituted — the service reads it directly — so it keeps its name.

### The two URIs are different roles

`PS_REPLICATION_URI` connects as **`powersync`** and `PS_STORAGE_URI` as
**`companion`**. That split is deliberate, and swapping either one back breaks
something:

- **Replication** needs the `REPLICATION` role attribute to open a WAL sender
  (`PgError 42501: permission denied to start WAL sender` without it) plus `SELECT` on
  the replicated tables for the initial snapshot. `setup-database` creates `powersync`
  with exactly that and nothing else — no writes, and no read access to the tables
  `sync-rules.yaml` deliberately keeps off-device. Granting `REPLICATION` to
  `companion` instead would have been one line, but `companion` owns every table and is
  what the API writes with, so it would undo the least-privilege split that
  `setup-database` exists to maintain.
- **Storage** needs write access: the service creates and migrates its own `powersync`
  schema for bucket storage. The read-only replication role cannot do that.

`setup-database` also creates the **`powersync` publication** the replicator subscribes
to. The service does not create it and does not fall back: without it, replication
stops with `PSYNC_S1141 Publication 'powersync' does not exist`. That error suggests
`FOR ALL TABLES`, but this setup uses `FOR TABLE` with the three replicated tables and
the replicator is satisfied — `FOR ALL TABLES` would decode the WAL of every table,
including the hypertables and embeddings `sync-rules.yaml` keeps off-device. The
publication and the role's `SELECT` grants both come from one list, `POWERSYNC_TABLES`
in `infrastructure/setup-database/entrypoint.sh`.

> ⚠️ **Adding a table to `sync-rules.yaml` is a two-file change.** Add it to
> `POWERSYNC_TABLES` as well, or replication fails on that table with `permission
> denied`. Tables that do not exist yet are skipped with a log line — on a fresh
> cluster `setup-database` runs before the migrations, and the next `up` picks up the
> rest, since every run re-converges.

The password comes from `POWERSYNC_DATABASE_PASSWORD`: `setup-secrets` generates one
per deployment (and appends it to a pre-existing secrets file on upgrade), `.env.default`
ships a dev value. Unset, `setup-database` logs that it is skipping the role and
`powersync` cannot authenticate. Note that only `setup-database` reads the secrets
file — the third-party PowerSync image cannot — so a **production** deployment has to
supply the `PS_*` values through the environment itself.

Derive the JWKS key from the shared secret (`-w 0` matters — `basenc` otherwise wraps
the output at 76 columns and the wrapped value is not a usable key):

```bash
printf '%s' "$POWERSYNC_JWT_SECRET" | basenc --base64url -w 0 | tr -d '='
```

The server signs HS256 with `POWERSYNC_JWT_SECRET` and `kid=ci-powersync-hs256`; the
service's `client_auth.jwks` trusts the matching symmetric key. **For production,
switch to asymmetric keys (RS256/EdDSA) via a JWKS endpoint** — see the commented
`jwks_uri` in `powersync.yaml`.

## Verify before relying on it

Done (against 1.23.0):

1. ~~Pin the image to a tested tag and confirm `start -r unified` + `POWERSYNC_CONFIG_PATH`.~~
2. ~~Confirm the `powersync.yaml` keys and the `!env` substitution syntax.~~ Both hold;
   `!env` additionally requires the `PS_` prefix, and `storage.sslmode` must be set
   explicitly because it defaults to `verify-full` and ignores `?sslmode=` in the URI.
3. ~~Grant replication rights.~~ Resolved with a dedicated `powersync` role rather than
   `REPLICATION` on `companion` — see "The two URIs are different roles" above.
   `setup-database` provisions the role, its `SELECT` grants and the publication; the
   replicator snapshots `ci.notes`, `ci.files` and `ci_search.tags`, then streams WAL
   changes. Confirmed against a live local stack: the slot is active, a write to
   `ci.notes` is flushed by the replicator, and the role is refused `SELECT` on
   non-replicated tables (`ci.events`), any write, and DDL in either schema.

Still open:

4. Confirm `request.user_id()` is the correct sync-rules accessor for the token `sub`
   (older docs use `token_parameters.user_id`).
5. Check uuid↔text comparison of `user_id = bucket.user_id` in the replicated schema.

Items 4 and 5 need a real client: the replicator applies the sync rules' `SELECT`
lists, but nothing has requested a bucket, so the parameter query and the `user_id`
comparison are still untested.

## Next (client phase, not in this scaffold)

- Add `@powersync/web` + `@powersync/react`; define the on-device schema for the
  synced tables; implement the connector (`fetchCredentials` → `/api/powersync/token`;
  `uploadData` → existing GraphQL mutations).
- Migrate a first collection's reads (notes) from Apollo to a PowerSync watched query.
