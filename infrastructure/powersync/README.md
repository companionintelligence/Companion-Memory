# PowerSync — local-first sync (server side)

This directory holds the **server side** of local-first sync for CI-Server: an
on-device SQLite database that syncs bidirectionally with Postgres via
[PowerSync](https://docs.powersync.com/). It is **infrastructure + config only** — the
client SDK integration lives in `frontend/apps/web/src/api/powersync/`.

> ⚠️ **Partially verified, and NOT running locally.**
>
> - Server-side replication works against `journeyapps/powersync-service:1.23.0`: the
>   service boots, storage migrations run, the router listens on 8080, and the
>   replicator snapshots the replicated tables and then streams changes from the WAL.
> - **The `powersync` service is opt-in under `make dev`** (see "Running it under
>   make dev" below). Without `POWERSYNC_URL` in `.env` it does not start,
>   `GET /api/powersync/token` returns 503 and the app falls back to GraphQL, so
>   nothing breaks — but the end-to-end path is then not exercised either.
> - The client phase **has shipped** (see below); what remains unverified is the two
>   sync-rule questions under "Verify before relying on it".

## Pieces

| Piece | Where |
|-------|-------|
| Postgres logical replication | `infrastructure/database/Dockerfile` (`wal_level=logical`) |
| Replication role + publication | `infrastructure/setup-database/entrypoint.sh` (`POWERSYNC_TABLES`) |
| PowerSync service | `docker-compose.yml` → `powersync` service (`staging`/`production`, plus the opt-in `powersync` profile `make dev` adds) |
| Service config | `powersync.yaml` (this dir) |
| Sync rules (what syncs per user) | `sync-rules.yaml` (this dir) |
| Client token endpoint | `GET /api/powersync/token` (`backend/.../domains/powersync`) |
| Client SDK integration | `frontend/apps/web/src/api/powersync/` — `PowerSyncProvider` (mounted in `App.tsx`), `connector.ts`, `schema.ts`, `webDatabase.ts` (WASQLite/IndexedDB), `nativeDatabase.ts` (Capacitor SQLite) |

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
engine write Postgres directly. `connector.ts`'s `uploadData()` implements exactly
that, and today only **notes** replay as full CRUD (`createNote`/`updateNote`/
`deleteNote`); tags and the entity_tag join are **read-only on device** because no
GraphQL mutation of the right shape exists to replay their local writes through, and
the search documents are a raw table the sync client writes directly.

## What syncs

Only small, `user_id`-scoped, read-mostly tables. `sync-rules.yaml` and
`POWERSYNC_TABLES` in `infrastructure/setup-database/entrypoint.sh` must agree; today
both list `ci.notes`, `ci_search.tags`, `ci_search.entity_tag` and
`ci_search.mobile_search_documents` — the device record (one row per indexed entity of
a device-shown type: title, snippet, own time, plus `related_id` and a small `detail`
JSON of display fields), over which the device builds an FTS5 index and answers the
header search when the appliance is unreachable. Until 2026-10-21 the list also carried
`ci.files`, `ci.threads`, `ci.messages`, `ci.events` and its `ci.entities` name rows;
they were replicated and never read, so they were dropped in favour of the one record
(sync-rules.yaml explains; the setup container now removes a table that leaves the
list from the publication). See
[`docs/architecture/mobile-local-search-plan.md`](../../docs/architecture/mobile-local-search-plan.md).
Full rows of large/server-computed data (events, communications, browser_activity,
file_chunks, pgvector embeddings, the knowledge graph) stay online via GraphQL; what
the phone has of each is its search document. See `sync-rules.yaml` for
the rationale and the TODO list for tables that still need their exact names verified
before being added.

## Running it under `make dev`

Put a loopback URL in the root `.env` and start the stack as usual:

```bash
POWERSYNC_URL=http://localhost:18080   # .env — the one switch
make dev
```

`scripts/dev-stack` then:

- adds `--profile powersync` to every compose `up` (the service otherwise stays off:
  an idle replicator holds a replication slot, and a slot nobody reads keeps WAL
  forever);
- allocates the host port the way it does every other service — 18080 when free,
  ephemeral when a sibling worktree holds it — publishes it on `127.0.0.1` through
  `docker-compose.local.yml`, and hands the api a `POWERSYNC_URL` on **that** port, so
  the credentials the api returns always name this stack's replicator;
- adds that origin to the Caddy route's `connect-src`, so a desktop browser on
  `https://<project>.localhost` can connect too.

Host 8080 is taken by the shared dev Caddy, which is why the default is 18080. There is
no `setup-secrets` in local, so `docker-compose.local.yml` passes the names the wrapper
command normally sources from `/run/secrets` (`POWERSYNC_DATABASE_PASSWORD`,
`POWERSYNC_JWT_SECRET`, the app role) straight from `.env`; `setup-database` creates the
replication role and the publication on every `up`.

**Phone:** the api returns `POWERSYNC_URL` verbatim, and `localhost` on the phone is the
phone. `yarn android` (`frontend/apps/android`) reads `POWERSYNC_URL` from the root
`.env` and applies `adb reverse tcp:<port> tcp:<port>` alongside the Vite port on every
run — the rule dies with every phone reboot, which looks like "the working set never
syncs" with nothing in the logs.

**Window:** the device window is held by `SyncWindowSweepCron` (worker role, daily
03:40). A dev stack that is rarely up overnight never runs it, so every imported event
row keeps its `sync_period` and the first sync downloads all of them; that is expected,
not a bug.

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
   replicator snapshots the `POWERSYNC_TABLES` list, then streams WAL changes.
   Confirmed against a live local stack: the slot is active, a write to `ci.notes` is
   flushed by the replicator, and the role is refused `SELECT` on non-replicated tables
   (`ci.events`), any write, and DDL in either schema.
4. ~~Client phase (`@powersync/web`, on-device schema, upload connector).~~ Shipped —
   `frontend/apps/web/src/api/powersync/` carries `PowerSyncProvider` (mounted in
   `App.tsx`), `schema.ts`, `connector.ts`, and the web/native database factories.

Still open:

5. Confirm `request.user_id()` is the correct sync-rules accessor for the token `sub`
   (older docs use `token_parameters.user_id`).
6. Check uuid↔text comparison of `user_id = bucket.user_id` in the replicated schema.

Items 5 and 6 still need a **connected** client against a running service. Because the
`powersync` container is out of the `local` profile, `make dev` does not provide one —
set `POWERSYNC_URL` and run the service under the `staging` profile to exercise them.

## Next

- Widen `uploadData()` beyond notes as the matching GraphQL mutations appear (a
  tag-by-id mutation, a thread CRUD mutation) — see the read-only rationale at the top
  of `connector.ts`.
- Decide whether `powersync` rejoins the `local` compose profile now that a client
  exists.
