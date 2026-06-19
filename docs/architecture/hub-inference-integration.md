# CI-Server (Companion Memory) — Local-LLM Integration with CI Hub

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**
> Status: **Design / proposal.** Supersedes the earlier "Companion Memory, hermes,
> openclaw — Config & Secret Injection from CI Hub" draft, which assumed Companion
> Memory was an unknown third-party binary. **It is not: Companion Memory *is*
> CI-Server.** That single fact rewrites the plan.

---

## TL;DR decision

CI-Server (the memory brain = "Companion Memory") should get its local LLM **and
embedding** configuration from the CI Hub the **same way Hermes and OpenClaw do**:
by talking to the Hub's OpenAI-compatible inference proxy and letting the Hub own
Ollama model selection + downloading. We adopt the **Hermes `bootstrap.env`
pattern** as the transport, with a **hybrid model policy** (Hub picks the default;
CI-Server overrides specific roles — vision and embeddings — from its own config).

| Concern | Decision |
|---|---|
| Where inference comes from | Hub OpenAI proxy `http://ci-os-hub:3000/api/inference/v1` — **not** a host Ollama, **not** the Ollama sidecar directly |
| Config transport | **Mechanism B (Hermes):** boot-time `GET /api/inference/apps/<slug>/bootstrap.env`, source into env, fail-open |
| Model selection | **Hybrid:** Hub supplies the hardware-best default chat model; CI-Server overrides vision + embedding roles via its own config |
| Model downloading | Hub-owned (`ModelPullerService` + `firePrePull` on bootstrap). CI-Server never pulls. |
| Embeddings | Pin **`nomic-embed-text` (768-dim)** — CI-Server's pgvector schema is hard-coupled to 768 |
| App config file | **No `config.yaml` render.** CI-Server uses `node-config` JSON + `.env`; the bootstrap writes a sourced env file only |
| Wake webhook / `mcp_client` | **Not used for inference.** CI-Server self-schedules via internal cron |
| Marketplace packaging | **Already exists** (currently slug `companion` → **rename to `companion-memory`**, gateway `isMain` @ 8642). Extend `scripts/publish/`, don't recreate |

Two **hard prerequisites** in CI-Hub block this today (see
[§7 Blockers](#7-hard-blockers--prerequisites)): the Hub has **no embedding model**
and its bootstrap embeddings picker is disabled; and the Hub speaks **only**
OpenAI `/v1`, while CI-Server's NestJS API currently uses the **native Ollama
client**.

---

## 1. The reframe: CI-Server *is* Companion Memory

Everything the prior draft listed as "open questions about the Companion Memory
binary" is answerable from this repo:

| Prior assumption | Reality |
|---|---|
| Renders `/data/config.yaml` | **No YAML.** `node-config` JSON layers (`backend/apps/api/config/*.json`) + repo-root `.env` (dotenv); secrets at `/run/secrets/.env.secrets`. |
| Main port `8080` | **3030** (API, `config/default.json`); marketplace **main port is the gateway: 8642** (`scripts/publish/manifest/config.json`). |
| Author a new `config.json`/`docker-compose.json` | **Already packaged** (currently slug `companion`, **renaming to `companion-memory`**) via `scripts/publish/publish.sh` (Runtipi v2; `gateway` service `isMain`, `internalPort: 8642`). |
| Needs `/hooks/hub-wake` + `mcp_client: true` | **No wake route exists**; inference is driven by `@Cron(EVERY_MINUTE)` in `domains/llm/cron/AnswerInferenceCron.ts`. CI-Server self-schedules. |
| pgvector sidecar vs shared Hub Postgres | **Neither** — CI-Server ships its own Postgres+pgvector image (`infrastructure/database/`); all embedding columns are `vector(768)`. |
| Unknown inference var names | CI-Server already has `HUB_*` awareness, but **only for cloud OAuth** (`ciPortal`: `HUB_DEVICE_ID`/`HUB_API_KEY` in `CloudOAuthProxyService`) — **not inference**. |

### CI-Server's two LLM paths today (both must be unified)

1. **NestJS API** — native `ollama` npm client against `OLLAMA_HOST`
   (default `http://host.docker.internal:11434`), with **hardcoded models**
   (`gemma3:1b` prompts, `qwen3:14b` text, `gemma3:27b` vision) in
   `domains/llm/services/OllamaService.ts`, and a **hardcoded** `nomic-embed-text`
   in `common/embeddings/services/EmbeddingGenerationService.ts`. It does **not**
   read the `LLM_*` env vars.
2. **Python summary-service** — already an **OpenAI-compatible** client
   (`apps/summary/src/llm_config.py`) reading `LLM_API_BASE` / `LLM_API_KEY` /
   `LLM_DEFAULT_CHAT_MODEL` / `LLM_DEFAULT_EMBEDDING_MODEL`
   (`apps/summary/src/config.py`).

The summary-service is already shaped correctly. The unification work is mostly
**bringing the NestJS API up to the same OpenAI-compatible contract** and pointing
both at the Hub.

---

## 2. The Hub inference contract (what we're unifying onto)

The Hub exposes an **OpenAI-compatible proxy** and owns all of Ollama.

- **Endpoint:** `http://ci-os-hub:3000/api/inference/v1`
  (`inference-router.service.ts → getInferenceEndpoint()`), routes in
  `inference.controller.ts`:
  - `POST v1/chat/completions` (SSE streaming supported)
  - `POST v1/embeddings`
  - `GET  v1/models` (+ richer `GET /api/inference/status`)
  - `POST v1/audio/*`, `POST v1/images/generations`
- **Ollama is a Hub sidecar**, `ci-hub-ollama:11434`, env override `OLLAMA_URL`
  (`backends/ollama.backend.ts`). Apps must **not** address it directly — going
  through the proxy is what gives us routing, model selection, and pull-on-demand.
- **Auth:** `Authorization: Bearer <HUB_API_KEY>` (== Hub `ciHubApiKey`) is
  honored by `AuthMiddleware`, **but the `v1/*` data-plane routes are currently
  unguarded** and bootstrap hands apps the dummy key `"ollama"`. (See
  [§7](#7-hard-blockers--prerequisites) — pick a deliberate auth posture.)
- **Model selection** is computed, not stored: `getRecommendedModelsForHardware()`
  returns a best-first list and **index 0** is the hardware-best model
  (`model-registry.service.ts`). **Model downloading** is Hub-owned:
  `ModelPullerService.pullModel()` streams Ollama's native `/api/pull`, and
  `AppBootstrapService.firePrePull()` auto-pulls the selected model when an app
  bootstraps (`app-bootstrap.service.ts`). **This is the answer to the standing
  "unify ollama model selection + downloading" TODO — it already lives in the Hub.**

### Two delivery mechanisms (we standardize on B)

| | A — config render (`openclaw-ci-entrypoint.sh`) | **B — `bootstrap.env` (Hermes)** ✅ |
|---|---|---|
| Trigger | Hub-injected entrypoint renders a config file | App curls `GET /api/inference/apps/<slug>/bootstrap.env` at boot |
| Model choice | App lists **all** `/v1/models` + synthetic `auto` | **Hub** picks one hardware-best model |
| Downloads | None (consumes what's advertised) | **Triggers Hub pre-pull** of the chosen model |
| Output | A rendered app config file | dotenv keys sourced into the process env |
| Fits | user-facing model pickers | **backend services (CI-Server)** |

Per-app key names live in a 2-entry table — `hermes-agent → HERMES_OPENAI_*`,
`openclaw → OPENAI_API_BASE/OPENAI_API_KEY` (`app-bootstrap.service.ts`,
`SUPPORTED_APP_SLUGS` + `APP_ENV_KEYS`). We add a third entry for CI-Server.

> Note: every app *also* gets `HUB_INFERENCE_URL` injected statically at install
> (`app.helpers.ts`). That's just the endpoint pointer; it carries **no model
> selection**. Bootstrap (B) is the source of truth for models.

---

## 3. The Hermes pattern (the template we copy)

`CI-Hermes/bootstrap-from-hub.sh`, run from `start-hermes.sh` before launch:

1. `GET ${CI_HUB_URL}/api/inference/apps/${HUB_APP_SLUG}/bootstrap.env`
   (`--max-time 5 --retry 1`); slug `hermes-agent`, `CI_HUB_URL` default
   `http://ci-os-hub:3000`.
2. **Fail-open:** unreachable / empty / error ⇒ log and `exit 0` so the container
   still starts and falls back to its own setup.
3. **Translate** the namespaced keys to what the runtime reads
   (`HERMES_OPENAI_BASE_URL → OPENAI_API_BASE`/`OPENAI_BASE_URL`,
   `HERMES_DEFAULT_MODEL → OPENAI_MODEL`, …) and **keep the originals**.
4. Write atomically to `${DATA_DIR}/.env.hub-bootstrap`, mode `600`, **idempotent**.
5. `set -a; source .env.hub-bootstrap; set +a` so children inherit it; launch.
6. The Hub picked the model and pre-pulled it; Hermes consumes `*_DEFAULT_MODEL`
   as-is. Provider config is **env only** — never written into `config.yaml`.

OpenClaw's variant (Mechanism A) renders `openclaw.json` and discovers all models
via `/v1/models`. We borrow **only** its `/v1/models` discovery for the *override*
path (vision/embedding role resolution), not as the primary transport.

---

## 4. Unified design for CI-Server

### 4a. Hub-side edits (CI-Hub)

In `packages/backend/src/modules/inference/app-bootstrap.service.ts`:

1. Add the slug to `SUPPORTED_APP_SLUGS` (must match the marketplace install slug —
   **`companion-memory`**, renamed from the current `companion`).
2. Add an `APP_ENV_KEYS` entry using CI-Server's existing `LLM_*` convention, so a
   single contract covers both CI-Server LLM paths:
   ```ts
   'companion-memory': {
     baseUrl:    'LLM_API_BASE',
     apiKey:     'LLM_API_KEY',
     model:      'LLM_DEFAULT_CHAT_MODEL',
     embeddings: 'LLM_DEFAULT_EMBEDDING_MODEL',
   },
   ```
3. **Re-enable the embeddings picker** (`const embeddings = null` at
   `app-bootstrap.service.ts` ~L120) and **add an embedding model to the catalog**
   (`catalog/curated-models.ts`) — `nomic-embed-text`, `modality: 'embedding'`,
   768-dim — so `LLM_DEFAULT_EMBEDDING_MODEL` is actually populated and pre-pulled.
4. Add a test mirroring `__tests__/app-bootstrap.service.test.ts` for the new slug.

No controller change is needed — `apps/:slug/bootstrap.env` is slug-generic.

### 4b. CI-Server-side edits

1. **Add a `bootstrap-from-hub.sh`** (copy the Hermes script's structure: fetch,
   fail-open, atomic write to `${APP_DATA_DIR}/data/.env.hub-bootstrap`, mode 600),
   invoked from the API entrypoint **before** `node dist/src/main.js`, and source
   it into the env. Respect the `X-Hub-Managed-Keys` response header so Hub-managed
   keys are treated as **defaults** that operator overrides can win over
   (precedence in [§5](#5-hybrid-model-policy)).
2. **Make the NestJS API speak OpenAI `/v1`.** Migrate `OllamaService` +
   `EmbeddingGenerationService` from the native `ollama` client to an
   OpenAI-compatible client reading `LLM_API_BASE` / `LLM_API_KEY` — the same
   contract the summary-service already uses. Surface `LLM_API_BASE`/`LLM_API_KEY`
   through `config/custom-environment-variables.json` + the Zod schema in
   `configuration.ts` (today only `OLLAMA_HOST` is mapped, and the API ignores
   `LLM_*`).
3. **Stop hardcoding models.** Replace the `OllamaService` constants and the
   `EmbeddingGenerationService` constant with the role-resolution policy in §5.
4. **Keep the provider config out of any committed file** — env only, exactly like
   Hermes. CI-Server's `node-config` JSON stays for non-secret app settings.

### 4c. Corrected boot sequence

1. Compose starts the `api` service; image `ENTRYPOINT` →
   `entrypoint.sh` (existing secrets loader: `/run/secrets/.env.secrets`).
2. Entrypoint runs **`bootstrap-from-hub.sh`**:
   - `GET http://ci-os-hub:3000/api/inference/apps/companion-memory/bootstrap.env`
   - fail-open on any error; write + `source` `.env.hub-bootstrap`.
3. Apply **operator/CI-Server overrides** on top (role pins — §5).
4. `exec docker-entrypoint.sh "$@"` → `node dist/src/main.js` (binds `0.0.0.0:3030`).
   Embedding/inference is then driven by CI-Server's existing internal cron.

> **No bare `exec "$@"`** — match CI-Server's current `exec docker-entrypoint.sh "$@"`
> (which preserves the image entrypoint). A bare `exec "$@"` would drop it.

---

## 5. Hybrid model policy

**Decision: Hub picks the default; CI-Server overrides specific roles.** CI-Server
runs role-specific models (prompt/text/**vision**/**embedding**) that a single Hub
default can't cover, so resolution is layered:

| Role | Source of truth | Resolution |
|---|---|---|
| Chat / prompt / text | **Hub default** | `LLM_DEFAULT_CHAT_MODEL` from bootstrap; operator may override |
| **Vision** | **CI-Server override** | `LLM_VISION_MODEL` (operator-set). Validate availability via `GET /v1/models` (modality includes image/vision). If unset/unavailable → degrade or disable vision, don't crash |
| **Embedding** | **Pinned, validated** | `nomic-embed-text` (768). Treat the Hub's `LLM_DEFAULT_EMBEDDING_MODEL` as advisory; **refuse to start embeddings if dim ≠ 768** — the pgvector schema is hard-coupled |

**Precedence:** source the Hub `bootstrap.env` **first** (defaults), then apply
CI-Server's own `.env`/config (wins) — the same "operator env overrides Hub-managed
keys" model Hermes implements via `X-Hub-Managed-Keys`. Concretely: only overwrite
a key if it's in `X-Hub-Managed-Keys` **and** not explicitly pinned by the operator.

**Downloads stay Hub-side** for every role. If CI-Server pins a model the Hub
hasn't pulled (e.g. a vision model), it should request it through the Hub's
`POST /api/inference/models/pull`, not pull locally.

---

## 6. What we drop from the original plan (and why)

- **`config.yaml` heredoc render (Path B):** CI-Server has no such file. Provider
  config is env-only; app config is `node-config` JSON.
- **`hub_integration.mcp_client: true` + `/hooks/hub-wake`:** not needed for
  inference. CI-Server self-schedules via cron, and the Hub's webhook registry is
  **in-memory and not rehydrated on Hub restart** (`agent-notify.service.ts`) — an
  unreliable basis for anything load-bearing. (CI-Server *does* expose an MCP
  server at `POST /mcp`, but that's CI-Server-as-a-tool, a separate concern.)
- **pgvector sidecar vs shared Postgres:** CI-Server ships its own; nothing to decide.
- **The `HUB_INFERENCE_URL → OPENAI_BASE_URL` "established precedent":** it doesn't
  exist anywhere. Real mappings use `OPENAI_API_BASE` (openclaw) /
  `HERMES_OPENAI_BASE_URL` (hermes). We standardize CI-Server on `LLM_*`.
- **The "Hermes recompile trap" cautionary tale:** misattributed — Hermes is in
  fact a clean runtime-injection design. The *principle* (never bake config/secrets
  into the image; inject at runtime) stays; the Hermes example is removed.
- **The "OpenClaw fallback safety net applies to us" assumption:** that bundled
  fallback is hard-gated to `appName === 'openclaw'` in `install-app-command.ts`,
  and `copyDataDir` skips when the data dir already exists. CI-Server bakes its
  bootstrap script into the **image**, sidestepping both.

---

## 7. Hard blockers / prerequisites

These gate the whole integration:

1. **Embeddings missing in the Hub.** No embedding model in `curated-models.ts`,
   and the bootstrap embeddings picker is disabled (`app-bootstrap.service.ts`
   ~L120). CI-Server is a *memory brain* — embeddings are its core function.
   **Must:** add `nomic-embed-text` (768) to the catalog + re-enable the picker +
   ensure the Hub pulls it. (CI-Server's `vector(768)` schema is duplicated across
   ~20 migrations; a different-dimension model breaks everything.)
2. **Protocol mismatch.** CI-Server's NestJS API uses the **native Ollama** client;
   the Hub proxy is **OpenAI `/v1` only** (no native Ollama passthrough). **Must:**
   migrate the API to an OpenAI-compatible client (the summary-service already is),
   or — explicitly not recommended — point the native client straight at
   `ci-hub-ollama:11434`, which bypasses the Hub router/selection/pull and is *not*
   the hermes/openclaw pattern.
3. **Vision role not in the bootstrap contract.** Bootstrap conveys one chat model
   (+ embedding once fixed). CI-Server's vision use-case relies on the §5 override
   path and on the Hub **advertising** a vision-capable model in `/v1/models`.
4. **Auth posture.** The `v1/*` routes are unguarded while bootstrap issues a dummy
   `"ollama"` key. Decide deliberately: either guard `v1/*` and have bootstrap emit
   the real `HUB_API_KEY`, or document local inference as intentionally
   unauthenticated on the Docker-internal network. CI-Server should send
   `Authorization: Bearer ${HUB_API_KEY}` either way.

---

## 8. Failure modes to avoid

- **Embedding-dimension drift:** accepting a non-768 embedding model silently
  corrupts the vector store. Validate dim at startup; refuse otherwise.
- **Bypassing the proxy:** talking to `ci-hub-ollama:11434` directly "works" but
  forfeits model selection, routing, and pull-on-demand — re-fragmenting exactly
  what we're unifying.
- **Hard-failing when the Hub is down:** bootstrap must fail-open (Hermes does);
  CI-Server should start and degrade, not crash, if `bootstrap.env` is unreachable.
- **Baking provider secrets into the image / committed config:** keep them in the
  sourced env file only.
- **Slug mismatch:** the bootstrap slug must equal the marketplace install slug
  (`companion-memory`) or the Hub returns 404 and CI-Server gets no model config.

---

## 9. Open questions / TODO

- [ ] **Rename the slug `companion` → `companion-memory`.** Update
      `scripts/publish/manifest/config.json` `id`, the Hub `SUPPORTED_APP_SLUGS` +
      `APP_ENV_KEYS`, and the bootstrap URL. Existing `companion` installs become a
      different app — plan a re-publish/migration (or carry an alias).
- [ ] **Hub:** add `nomic-embed-text` (768) to `curated-models.ts`; re-enable the
      embeddings picker; verify `firePrePull` pulls it.
- [ ] **Hub:** add the `companion-memory` entry to `APP_ENV_KEYS` +
      `SUPPORTED_APP_SLUGS` + test.
- [ ] **Hub:** decide whether to advertise a vision-capable model for the §5 vision
      override (and whether bootstrap should grow role-aware fields instead of a
      single `*_DEFAULT_MODEL`).
- [ ] **Hub:** resolve the `v1/*` auth posture (guard + real key, or documented
      open-internal).
- [ ] **CI-Server:** migrate `OllamaService` + `EmbeddingGenerationService` to an
      OpenAI-compatible client; wire `LLM_API_BASE`/`LLM_API_KEY` through
      `configuration.ts` + `custom-environment-variables.json`.
- [ ] **CI-Server:** add `bootstrap-from-hub.sh` (image-baked) + entrypoint hook +
      env precedence (operator overrides win).
- [ ] **CI-Server:** implement the §5 role policy (chat=Hub default, vision=pin,
      embedding=pin+validate-768).
- [ ] **Smoke test:** install via Hub → confirm `.env.hub-bootstrap` contains
      `LLM_API_BASE` + `LLM_DEFAULT_CHAT_MODEL` (+ `LLM_DEFAULT_EMBEDDING_MODEL`
      once fixed) → confirm CI-Server reaches the proxy and the Hub pre-pulls the
      models → confirm embeddings produce 768-dim vectors.

---

## Appendix — evidence map

| Claim | Source |
|---|---|
| Hub OpenAI proxy routes | `CI-Hub/packages/backend/src/modules/inference/inference.controller.ts` |
| Hub endpoint URL builder | `…/inference/inference-router.service.ts` (`getInferenceEndpoint`) |
| Ollama sidecar `ci-hub-ollama:11434`, `OLLAMA_URL` | `…/inference/backends/ollama.backend.ts` |
| Per-app env mapping + slugs | `…/inference/app-bootstrap.service.ts` (`SUPPORTED_APP_SLUGS`, `APP_ENV_KEYS`) |
| Model pick (index-0) + pre-pull | `…/inference/app-bootstrap.service.ts`, `…/model-registry.service.ts`, `…/model-puller.service.ts` |
| Embeddings disabled / no embed model | `…/inference/app-bootstrap.service.ts` (~L120), `…/inference/catalog/curated-models.ts` |
| `HUB_INFERENCE_URL` injected for all apps | `…/apps/app.helpers.ts` |
| `bootstrap.env` route | `…/inference/inference.controller.ts` (`apps/:slug/bootstrap.env`) |
| Hermes transport | `CI-Hermes/bootstrap-from-hub.sh`, `start-hermes.sh` |
| OpenClaw render + `/models` | `CI-Hub/packages/backend/src/modules/app-lifecycle/data/openclaw-ci-entrypoint.sh` |
| CI-Server API native Ollama client + hardcoded models | `CI-Server/backend/apps/api/src/domains/llm/services/OllamaService.ts` |
| CI-Server hardcoded embedding model | `CI-Server/backend/apps/api/src/common/embeddings/services/EmbeddingGenerationService.ts` |
| CI-Server summary OpenAI client + `LLM_*` | `CI-Server/backend/apps/summary/src/llm_config.py`, `…/config.py` |
| CI-Server config layering | `CI-Server/backend/apps/api/config/*.json`, `…/src/configuration.ts` |
| CI-Server marketplace packaging (slug `companion` → rename `companion-memory`, 8642) | `CI-Server/scripts/publish/manifest/config.json`, `…/publish.sh` |
| CI-Server cloud-OAuth-only Hub use | `CI-Server/backend/apps/api/src/domains/connections/services/CloudOAuthProxyService.ts` |
| CI-Server internal inference cron | `CI-Server/backend/apps/api/src/domains/llm/cron/AnswerInferenceCron.ts` |
