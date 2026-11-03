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

## Hub / Marketplace installs

A Hub install cannot bind-mount this directory, so it runs `companion/powersync`, built
from the `Dockerfile` here: the upstream image with `powersync.yaml` and
`sync-rules.yaml` baked into `/config` and `entrypoint.sh` as its entrypoint (the file
the compose service runs from its mount). It reads setup-secrets' `powersync`
projection at `${APP_DATA_DIR}/data/secrets/services/powersync`; setup-database already
creates the replication role and publication from the same secrets. The api gets
`POWERSYNC_URL=${APP_BASE_URL}/powersync`, and the gateway image already proxies
`/powersync/`. `make build ENV=production` builds it; `scripts/publish/images.sh`
publishes it; `scripts/publish/publish.sh` puts it in the store bundle.

`POWERSYNC_URL` may also be a bare path (`/powersync`): the token endpoint then joins it
to the origin each request arrived on, which is right for an appliance reached through
several addresses.

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
both list `ci.notes`, `ci.saved_searches` (both written on the device and replayed up by
the connector), `ci_search.tags`, `ci_search.entity_tag` and
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
no `setup-secrets` in local, so `docker-compose.local.yml` passes the names `entrypoint.sh`
normally sources from `/run/secrets` (`POWERSYNC_DATABASE_PASSWORD`,
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

PowerSync service env (`entrypoint.sh` derives the first three):

| Env | Example |
|-----|---------|
| `PS_REPLICATION_URI` | `postgresql://powersync:<POWERSYNC_DATABASE_PASSWORD>@database:5432/companion` |
| `PS_STORAGE_URI` | `postgresql://companion:<DATABASE_PASSWORD>@database:5432/companion` (Postgres bucket storage, image ≥ 1.3.8) |
| `PS_JWT_SECRET_B64URL` | `base64url(POWERSYNC_JWT_SECRET)` — the symmetric JWKS key |
| `POWERSYNC_COMPACT_INTERVAL_SECONDS` | `3600`, the default. See "Compacting" |

> ⚠️ The `PS_` prefix is **required**, not stylistic. `powersync.yaml`'s `!env` tag
> refuses to substitute any variable whose name does not start with `PS_`, and the
> service treats that as a fatal startup error (exit 150, crash-loop). `entrypoint.sh`
> builds all three from the generated secrets, pointing at the local `database`
> container. To point the URIs elsewhere set them in `.env` (compose) or in the
> container's environment. `POWERSYNC_CONFIG_PATH` is *not* substituted (the service
> reads it directly) so it keeps its name. Neither is
> `POWERSYNC_COMPACT_INTERVAL_SECONDS`, which only `entrypoint.sh` reads.

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
`powersync` cannot authenticate.

Derive the JWKS key from the shared secret (`-w 0` matters — `basenc` otherwise wraps
the output at 76 columns and the wrapped value is not a usable key):

```bash
printf '%s' "$POWERSYNC_JWT_SECRET" | basenc --base64url -w 0 | tr -d '='
```

The server signs HS256 with `POWERSYNC_JWT_SECRET` and `kid=ci-powersync-hs256`; the
service's `client_auth.jwks` trusts the matching symmetric key. **For production,
switch to asymmetric keys (RS256/EdDSA) via a JWKS endpoint** — see the commented
`jwks_uri` in `powersync.yaml`.

## Compacting

`entrypoint.sh` runs PowerSync's `compact` command beside the service: 5 minutes after
the service starts, then an hour after each run ends. Nothing in the service schedules
it and no HTTP route asks for it (the admin routes are `execute-sql`, `diagnostics`,
`schema`, `reprocess` and `validate`), so it has to run in this container.

Bucket storage only appends. An edit or a delete adds an op to `powersync.bucket_data`
and leaves the old op with the row's old text in its `data`. A new device downloads
every op. `compact` turns each superseded op into a `MOVE` with no data and folds a run of
them at the start of a bucket into one `CLEAR`. Checksums are preserved, which is why a
connected device does not notice. It does not give the rows back: a `MOVE` in the middle
of a bucket stays, without its text, so a new device still downloads it and the table's
disk size holds rather than shrinks.

### Why hourly

Measured on 1.23.0 with one account holding 600,000 search documents, the size
`sync-rules.yaml` records for a real account:

| Run | Wall | Peak memory | WAL |
|---|---|---|---|
| One small bucket, for what starting the process costs | 4 s | 430 MB | |
| 600k rows, nothing to do | 18 to 22 s | 430 MB | 296 bytes |
| 1,000 rows updated and 50 deleted since the last run | 19 s | 430 MB | 11 MB |
| 100,000 rows updated and 10,000 deleted | 50 s | 630 MB | 1 GB |

Most of a run is reading every op in every bucket, so it costs about the same with
nothing to do. Running it every hour is 20 s of one core an hour on an account that
size. A connected device saw no difference while it ran: over 13 minutes with `compact`
every 60 s, a write reached it in a median of 243 ms during a run and 221 ms outside
one. Every 15 minutes would cost four times that, for a shorter wait on text only its
owner's devices can fetch. Daily would leave deleted text for a day. PowerSync's docs
also suggest hourly for self-hosted installs. `POWERSYNC_COMPACT_INTERVAL_SECONDS`
changes it. A Hub install runs the default.

The 5-minute start-up run is there because the wait restarts with the container: a box
restarted more often than the interval would otherwise never compact.

### How long text can stay

About an hour after an edit, a delete or an account purge. A little over at worst: a
row deleted just after a run starts waits for the next run to finish. While the service
is stopped nothing replicates or compacts, so the wait starts when it is running again.
The start-up run comes after 5 minutes.

This is the view through SQL and through sync. Postgres keeps the old bytes in its files
until vacuum and WAL recycling reach them, as it does for every deleted row in this
database, including the source tables.

### Account purge has no step of its own

`AccountPurgeService` deletes the synced rows with ordinary `DELETE`s. Replication
records them as `REMOVE` ops and removes the rows from `current_data`. The next `compact`
clears the text. The purge cannot do better:

- The api cannot run `compact`. It is another container with no route to this one.
- Clearing `powersync.bucket_data` from the purge cannot be relied on. The rows may not
  have replicated yet: purge while the service is down, delete from that table and the
  text arrives when replication catches up. It would also tie the purge to a schema
  PowerSync owns, whose bucket names already carry a storage-version prefix (`1#...`).
- `reprocess` would clear it but makes every device download everything again.

An ended account gets no new sync token. One issued before it ended can still download
the text for up to 5 minutes (`powersync.tokenTtl`). After that nobody can. See
[`docs/architecture/account-deletion.md`](../../docs/architecture/account-deletion.md).

### When it fails

A failed run logs its own error and
`[ci/powersync] compact failed (exit N); trying again in 3600s`. The service carries on.
A run that takes longer than six intervals is killed and logged the same way, so one
stuck run cannot end compaction. Nothing raises these beyond the container's log.

The loop ends with the container: `docker stop` takes as long as the service alone. A run
cut off part way loses at most its last batch, because each batch commits on its own and
leaves the bucket valid.

If the database goes away the service itself exits and restarts until it is back, with or
without this loop. That was already so.

One limit, read in PowerSync's source and not run: a run tracks each bucket's rows up to
1 GB of memory, about 240 bytes a row, so roughly 4 million rows in one bucket. Past that
the older ops of the rows it could not track keep their text.

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
