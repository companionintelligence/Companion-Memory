# One-off PR testing against Hub production data

> **Operator runbook** — test a locally built CI-Server branch against real CI-Memory
> data on a CI-Hub appliance, without going through the full release pipeline.
> For the **supported production upgrade path**, see [Production updates](#production-updates-supported-path) below.

## When to use this

Use this workflow when you need to validate a PR (new API routes, migrations, frontend
onboarding flow, etc.) against **your actual production database and object store** on a
Hub-managed `ci-memory` install — typically on a developer appliance or staging box that
runs live data.

This is **not** the normal release process. It is a deliberate, one-off shortcut.

## What stays the same vs what changes

| Layer | One-off PR test | Normal Hub update |
|-------|-----------------|-------------------|
| **Data** (`APP_DATA_DIR/data/*`) | Unchanged — same bind mounts | Unchanged |
| **Secrets** | Unchanged (setup-secrets is idempotent) | Unchanged |
| **Images swapped** | `api` + `gateway` + `hbpe-service` + `summary-service` | All `companion/*` services from GHCR |
| **Migrations** | `migrate-database` runs pending SQL | Same |
| **Hub catalog version** | Still shows old pin (e.g. `2026.7.27.1`) | Updates to new catalog version |
| **Compose digest pins** | Bypassed via local override file | Honored from marketplace manifest |

The deploy script rebuilds and swaps **`api`**, **`gateway`**, **`hbpe-service`**,
and **`summary-service`**. Database and object-store keep the Hub-pinned images.
HBPE is in the swap set because forecast / kernel / HMM / D3 live in that Python
service — a stale `hbpe-service` with a new API will look like the landing never
shipped. Summary is in the swap set so a Temporal-era Hub pin cannot keep running
alongside a pg-boss API. Build with `GPU=cpu` (the script default): Hub compose
does not pass GPU devices.

## Prerequisites

- CI-Memory installed via CI-Hub (`ci-memory:ci-marketplace`)
- Docker socket access on the host (Hub manages compose via `ci-os-hub`)
- CI-Server checkout with your PR branch
- Hub container running (default name: `ci-os-hub`)

## Environment variables (critical)

Hub injects configuration through **two compose `--env-file` layers**, mirrored by the
deploy script:

1. **`app.env`** (required) — Hub-generated per install  
   Host path: `{ROOT_FOLDER_HOST}/app-data/ci-marketplace/ci-memory/app.env`  
   Inside Hub container: `/app-data/ci-marketplace/ci-memory/app.env`

   Contains everything compose variable substitution needs, including:
   - `APP_DATA_DIR`, `APP_PORT`, `APP_URL`, public hostname / OIDC URLs
   - `LLM_*`, `OIDC_ISSUER_URL`, `GOOGLE_MAPS_KEY`, forward-auth secrets
   - Hub device id / API key

2. **`user-config/app.env`** (optional overlay) — operator overrides  
   Host path: `{ROOT_FOLDER_HOST}/user-config/ci-marketplace/ci-memory/app.env`  
   Inside Hub container: `/data/user-config/ci-marketplace/ci-memory/app.env`

   If present, Hub (and our scripts) pass **both** files to `docker compose`, with the
   user file overriding duplicate keys.

Each service in `docker-compose.yml` also declares:

```yaml
env_file:
  - /app-data/ci-marketplace/ci-memory/app.env
```

Those paths are read by the **compose CLI inside the Hub container** (where `/app-data`
is mounted). Do not run compose from the bare host unless you rewrite those paths.

**Do not hand-edit `app.env` for image swaps** — the override file only changes image
tags; all runtime config continues to flow from Hub's env files.

## Scripts

| Script | Purpose |
|--------|---------|
| [`scripts/dev/hub-pr-test-deploy.sh`](../../scripts/dev/hub-pr-test-deploy.sh) | Build (optional), tag, migrate, swap `api` + `gateway` + `hbpe-service` + `summary-service` |
| [`scripts/dev/hub-pr-test-rollback.sh`](../../scripts/dev/hub-pr-test-rollback.sh) | Remove override, restore Hub-pinned images |

### Deploy

```bash
cd CI-Server

# Full build + deploy (compiles API, web frontend, builds all production images)
./scripts/dev/hub-pr-test-deploy.sh

# If you already ran make build ENV=production
./scripts/dev/hub-pr-test-deploy.sh --skip-build

# Re-swap images without re-running migrations
./scripts/dev/hub-pr-test-deploy.sh --skip-build --skip-migrate

# Chrome/CSS/JS-only change: rebuild just the web UI + gateway image, recreate
# gateway alone, skip migrate (implied by the flag)
./scripts/dev/hub-pr-test-deploy.sh --frontend
```

Environment overrides — `PR_TAG` (default `pr-onboarding-test`), `GPU` (default
`cpu`), `ROOT_FOLDER_HOST` (default `~/.local/share/companion-hub`) and
`HUB_CONTAINER` (default `ci-os-hub`):

```bash
PR_TAG=my-feature-test ROOT_FOLDER_HOST=~/.local/share/companion-hub ./scripts/dev/hub-pr-test-deploy.sh --skip-build
```

The deploy script:

1. Tags `ci/{api,gateway,hbpe-service,summary-service}:latest` as `ghcr.io/companionintelligence/companion/*:pr-onboarding-test` (or `PR_TAG`)
2. Writes `docker-compose.pr-test.yml` next to Hub's installed compose (image override only)
3. Runs `migrate-database` via `docker exec ci-os-hub sh -c 'docker compose …'`
4. Recreates **`api`**, **`gateway`**, **`hbpe-service`**, and **`summary-service`** (`--no-deps`)

### Rollback

```bash
./scripts/dev/hub-pr-test-rollback.sh
```

Removes `docker-compose.pr-test.yml` and recreates `api` + `gateway` + `hbpe-service`
+ `summary-service` from the digest-pinned images in Hub's canonical `docker-compose.yml`.

### Verify

```bash
docker ps --filter name=ci-memory_ci-marketplace --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker logs ci-memory_ci-marketplace-api-1 --tail 40
```

After deploy you should see `pr-onboarding-test` (or your `PR_TAG`) on api, gateway, hbpe-service, and summary-service.

## Backup first

Postgres data dirs are owned by uid 999 — a plain `tar` from the host may hit permission
errors. Use a root helper container:

```bash
docker run --rm \
  -v ~/.local/share/companion-hub/app-data/ci-marketplace/ci-memory/data:/data:ro \
  -v ~:/out \
  alpine tar czf /out/ci-memory-backup-$(date +%Y%m%d-%H%M%S).tar.gz -C /data .
```

Or use Hub's per-app backup before swapping.

## Production updates (supported path)

This is what end users and production appliances should use:

```text
Developer tags CI-Server (vYYYY.M.D)
  → GitHub Actions: multi-arch build → ghcr.io/companionintelligence/companion/*
  → :latest repointed (newest release tag only)
  → CI-Marketplace syncs ci-memory manifest to Portal store

User clicks "Update" in Hub (or update-all cron)
  → optional backup
  → docker compose pull (resolves :latest or pinned tag to new digest)
  → force-recreate all services
  → migrate-database → api starts
  → existing APP_DATA_DIR volumes unchanged
```

Key facts:

- **Marketplace compose uses `:latest`** on all companion images; installed copies may
  pin a version **and digest** (e.g. `2026.7.27.1@sha256:…`).
- **Data lives on the host** under `APP_DATA_DIR/data/{db,objects,secrets,hbpe-*}` —
  not inside containers.
- **Hub README:** "Updates never purge data" — only uninstall wipes volumes.
- **Release tags:** see root [README § Releasing & image tags](../../README.md#releasing--image-tags).

Cross-repo references:

- Marketplace manifest: `CI-Marketplace/apps/ci-memory/docker-compose.json`
- Hub update command: `ci-hub/.../update-app-command.ts`
- Migration workflow: [architecture/Database.md](../architecture/Database.md)

## Considerations and trepidations

### Do not click "Update" in Hub during a PR test

Hub Update pulls from GHCR and refreshes the installed compose from the marketplace.
That will **overwrite your local image override** and return to pinned production digests.

### Hub state vs reality

After a one-off swap, Hub still records the old catalog version (`APP_IMAGE_TAG` in
`app.env`). That is fine for a dev test but confusing in the UI — document what you did.

### Migrations are one-way

`migrate-database` applies additive SQL (e.g. `onboarding_progress` JSONB column).
Rolling back **images** does not undo schema changes. Additive migrations are safe;
destructive migrations require explicit operator planning.

### Already-onboarded users

If production users have `onboarded = true`, you will **not** see the new onboarding
wizard unless you:

- test with a fresh signup, or
- temporarily set `onboarded = false` on a test user (dev only).

### `migrate-database` may touch dependencies

Running `compose run migrate-database` can recreate `database`, `setup-secrets`, and
`fix-db-permissions` if compose decides they are stale. Expect a brief database
restart; data volume is preserved.

### Never push `:latest` from a dev laptop

Untagged local `make publish` produces `dev-<sha>` only. Overwriting `:latest` on GHCR
from an unrelease build would break other appliances. See README release policy.

### Secrets in `app.env`

The deploy scripts read paths only; do not commit or paste `app.env` contents into docs
or tickets.

## OAuth provider connections (Microsoft, Google, …)

Onboarding and **Connect** use the same OAuth path as production connections.

### Default: CI Cloud OAuth proxy

When a provider has **no** credentials on the box (no `MICROSOFT_CLIENT_ID` /
`MICROSOFT_CLIENT_SECRET` in env, no saved provider keys in the DB), CI-Memory routes
OAuth through **CI Portal** (`hub.ci.computer`):

1. User clicks Connect → api calls Portal `/api/oauth/authorize`
2. User signs in at Microsoft/Google → redirect to Portal `/api/oauth/callback`
3. Portal exchanges the code and redirects back to the box:
   `https://<your-host>/oauth/callback?connectionId=…&access_token=…`

**Redirect URIs for the proxy path** (configured on CI Portal's OAuth apps, not on your
box):

| Provider | Redirect URI on the provider's developer console |
|----------|-----------------------------------------------------|
| Microsoft | `https://hub.ci.computer/api/oauth/callback` |
| Google | `https://hub.ci.computer/api/oauth/callback` |

You do **not** need to add your appliance hostname to Portal's OAuth apps for the default
flow.

### Error: `invalid_client` / `AADSTS7000215: Invalid client secret`

If Microsoft login succeeds but the browser shows JSON like:

```json
{"error":"OAuth callback failed","message":"Token exchange failed: … invalid_client … AADSTS7000215 …"}
```

that response comes from **CI Portal's** callback handler — not from your box. Login and
redirect worked; **token exchange failed** because Portal's `OAUTH_MICROSOFT_CLIENT_SECRET`
is wrong (commonly the Azure **Secret ID** GUID was stored instead of the secret
**Value**, or the secret expired).

**Fix (Portal ops):** update the Cloudflare Worker secret `OAUTH_MICROSOFT_CLIENT_SECRET`
for production Portal with the Azure app secret **Value** (app
`79a99e1b-64d1-43cc-a2a7-09b7b0d292e4` is CI Portal's shared Microsoft registration).

Google proxy failures follow the same pattern — check `OAUTH_GOOGLE_CLIENT_SECRET` on Portal.

### Bypass: direct OAuth on this appliance

For dev appliances or when Portal credentials are unavailable, configure your **own**
Microsoft (or Google) app on the box via the **user-config overlay**:

Path: `{ROOT_FOLDER_HOST}/user-config/ci-marketplace/ci-memory/app.env`

```bash
# Microsoft — use your Azure app registration
MICROSOFT_CLIENT_ID=<application-client-id>
MICROSOFT_CLIENT_SECRET=<secret-value-not-secret-id>
OAUTH_CALLBACK_URL=https://<your-public-host>/oauth/callback
```

Register this redirect URI on **your** Azure app (not Portal's):

`https://<your-public-host>/oauth/callback`

Example for core3: `https://ci-memory-core3-bc.companionintelligence.com/oauth/callback`

Restart `api` (and `gateway` if swapped) after editing user-config. With env credentials
present, the box skips Portal and exchanges the code directly.

Provider keys saved in the UI (per-connection client id/secret) also force the direct
path for that provider.

## Testing onboarding on this appliance (2026-08-01)

This run applied:

- `20260730134728_add_api_key_capability.sql`
- `20260801181500_add_onboarding_progress_to_users.sql`

Images deployed: `ghcr.io/companionintelligence/companion/{api,gateway}:pr-onboarding-test`

Backup taken: `~/ci-memory-backup-20260801-183716.tar.gz` (~3.4 GB)

Rollback when finished:

```bash
./scripts/dev/hub-pr-test-rollback.sh
```

## Local copy with production data (appealing, underdeveloped)

**Goal:** develop against real-shaped data without risking the live stack.

### What works today

1. **One-off swap (this runbook)** — same data volume, new api/gateway/hbpe/summary images.
2. **Restic/tar backup restore to a second Hub app** — install a second `ci-memory`
   instance (different app slot) and restore backup into its `APP_DATA_DIR` (heavy).
3. **`make production` in CI-Server** — isolated named volumes; use `make seed-production`
   for synthetic data, not prod copies.

### Suggested improvements

| Improvement | Benefit |
|-------------|---------|
| **`hub-pr-test-deploy.sh --services`** | Opt-in rebuild list (api, gateway, summary, …) |
| **Hub "dev channel" tag** | Install compose pointing at `dev-<sha>` without override files |
| **Documented pg_dump / restore** | Smaller portable copy than 3 GB tar of PGDATA |
| **Read-only DB replica profile** | Point local api at restored snapshot; skip writes |
| **Pre-update backup hook** | Hub already supports backup-on-update; use it before one-off swaps |
| **Compose override in Hub UI** | First-class "local image override" for developer appliances |
| **Separate `APP_DATA_DIR` clone script** | `rsync` + `pg_resetwal` / pg_dump restore for safe sandbox |

The highest-value next step is probably a **`scripts/dev/clone-ci-memory-data.sh`**
that pg_dumps from the live volume, restores into a second compose project, and
documents port/URL separation — so PR testing never touches the running stack.

## Related

- [architecture/architecture.md §5–6](../architecture/architecture.md) — CI-Marketplace → Hub → CI-Server
- [Database.md § Migration workflow](../architecture/Database.md) — authoring migrations
- Root [README § Releasing & image tags](../../README.md#releasing--image-tags)
