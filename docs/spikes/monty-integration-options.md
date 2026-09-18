All claims verified against the live appliance and the pinned Monty clone. Here is the spec.

---

# Monty × CI-Server — buildable specification

**Status:** the 14-week "Monty object-instance memory" proposal does **not** survive verification as written. What follows is the corrected, staged version. Every number below was measured, not cited.

---

## 1. The honest verdict

### Where the proposal was wrong

Measured just now against the running appliance (`ci-server-…-database-1`, db `companion`):

| Table | Rows | Populated |
|---|---|---|
| `ci.objects` | **2,006** | `length_mm` 0 · `width_mm` 0 · `height_mm` 0 · `mass_g` 0 · `acquisition_receipt_id` 0 · `identity_method` 0 (NULL on all 2,006) · `last_seen_place_entity_id` 0 |
| `ci.object_observations` | **1,875** | `embedding` 0 · `resolved_object_id` 0 · all `source_kind='manual'` · all `resolution_method='none'` |

So two popular framings are both false:

- **"An LLM hallucinates your object dimensions."** It never has. `ThingVisionListener.ts:66` asks for `"Rough size as LxWxH WITH A UNIT"` and the prompt continues "Omit any field you cannot see rather than guessing — a wrong measurement is worse than none"; `:456` parses through `physicalPropertiesOf(..., { requireUnit: true })`, which discards a unit-less answer. It is a guarded estimator that in practice emits nothing. The columns are **empty, not wrong**.
- **"The 768-d crop embedding already does 90% of this."** Zero of 1,875 observations carry an embedding. `object_observations_embedding_hnsw_idx` indexes an empty column. Rung 2 of `ObjectResolutionService` has never resolved a sighting.

The incumbent is not a hallucinating model. **The incumbent is an empty column and the manual `ThingModal` form.** That changes the comparison class entirely.

### What is actually missing

`ObjectResolutionService.ts:113` documents its own ladder: `identifier → embedding → place_prior → label → none`, with `IDENTIFIER_CONFIDENCE = 0.95`, `PLACE_PRIOR_CONFIDENCE = 0.6`, `LABEL_CONFIDENCE = 0.45`, gated at `AUTO_RESOLVE_CONFIDENCE_THRESHOLD = 0.8`. **No rung knows shape.** And there is no geometry to give one: a repo-wide grep over `frontend/apps/ios`, `frontend/apps/android` and `frontend/packages` for `arkit|sceneDepth|ARFrame` returns **zero hits**. `ci.position.relative_coordinates` / `relative_orientation` have a migration, a zod schema, a DTO and an entity mapping, and **zero producers**.

### The verdict in three parts

1. **The depth+pose capture path is worth building on its own merits.** It is also the entire cost centre — no proposal priced it honestly.
2. **Measured extents into `ci.objects.length_mm/width_mm/height_mm` need no Monty, no sidecar, no torch, and no Python.** Unproject `sceneDepth` with the frame intrinsics, PCA-align, take the extent. That is arithmetic in TypeScript in the NestJS API. It lands one of the three headline user-visible wins by itself, and it is *more* attractive now that the columns are 0/2,006 populated, not less.
3. **Monty is a candidate for the matcher, not the plan.** Its real competitor — which no proposal mentioned — is classical registration: **Open3D FPFH + RANSAC + ICP**, which gives metric extents, instance identity and 6-DoF pose on CPU, with a natively `[0,1]` inlier `fitness` that drops into `resolution_confidence` with no invented mapping, no `torch-sparse`, and no v0.x API churn. Monty's genuine edge is narrow but real: it builds the reference model *out of the sightings*, incrementally, unsupervised, with no mesh to register against. Decide it with a measurement, not an argument.

### What Monty will NOT do for you

- **Not your memory corpus.** `cmp.py:195-213` asserts `location.shape == (3,)` and `morphological_features["pose_vectors"].shape == (3,3)` on every feature-bearing message, and `hypotheses_updater.py:357-376` seeds hypotheses by aligning stored to sensed pose vectors. Projecting a 768-d embedding into 3-D to satisfy the assert produces coordinates in which "displacement" has no predictive meaning — that *breaks* the evidence update, it does not degrade it. Emails, documents, GPS: permanently out of scope.
- **Not two identical mugs.** 2.14 objects per graph on `ycb_unsupervised.csv`'s similar-object row, and the docs concede that total merging would score 100%. "Your two black mugs became one row in `ci.objects`" is a data-corruption bug, not a metric artifact.
- **Not your photo library.** Nothing in the 19,657 imported Google Photos has depth or camera pose. Forward-looking, deliberate scans only.
- **Not segmentation.** Multi-object real images score 25.00%; "where does an object begin and end" is an open question in their own tree.
- **Not a label.** Monty's own real-world RGBD numbers: 66.67% clean, 29.17% dark, 37.50% bright, 43.75% with a hand in frame. The output is a hypothesis with a confidence.
- **Not a receipt link.** `ObjectPromoteStage.ts:324` states `acquisition_receipt_id` / `acquisition_line_item_id` stay NULL, and the corpus confirms 0/2,006. Geometry establishes *instance identity*; joining that instance to a receipt line-item is a separate one-time manual association nobody has budgeted.
- **Not free CPU.** Zero `cuda` hits under `src/tbp/monty/frameworks/` — GPU-free is true. "Does not contend with chat" is false: HBPE's measured 11,230 s nightly and the llama.cpp GGUF labeler already saturate CPU on the reference box.
- **Not anything bigger than a shoebox, by default.** `evidence_matching/learning_module.py:255-257` sets `max_graph_size=0.3  # 30cm` with `num_model_voxels_per_dim=50  # -> voxel size = 6mm3`, and `object_model.py:587-605` raises `GridTooSmallError` below 90% containment. A chair is 4–5× over, and raising `max_size` coarsens voxels 1:1.
- **Not stable.** v0.50.0 (commit `f55675b`), major-version-zero, explicitly unstable API, already drifted from its own docs: `State` → `Message`, `EmbodiedEnvironment` → bare Protocols, `MontyBase.step` now takes a `RuntimeContext`.

### Units, and the error that nothing catches

**Monty is metres.** `object_model.py:377` "maximum size of the object in meters"; `:386` `self._max_size = max_size  # 1=1meter`. Only the stale docs page says centimetres. This is load-bearing: `objects_length_mm_check` is `length_mm > 0 AND length_mm <= 10000000`, so a 10.5 cm mug written as 1050 mm violates nothing. That is exactly the "plausible magnitudes, no CHECK catches it" failure the proposal cited against CI-Spatial's fabricated `extras.dimensions`. **Assert every extent against a physical ruler before a number goes near `ci.objects`.**

### Staged plan (not 14 weeks committed up front)

| Stage | What | Cost | Gate |
|---|---|---|---|
| **0** | Offline replay spike + instance-separation check | **2 days** | Binding kill criterion (§5) |
| **0b** | `torch-sparse`/`torch-scatter` build proof in a standalone container | **1 day**, parallel | Blocks Stage 3 only |
| **1** | `capacitor-rgbd-scan` plugin + measured extents into `ci.objects` — **no sidecar, no Monty** | ~4 weeks | Ships value alone |
| **2** | Bake-off on the Stage-1 corpus: Open3D ICP vs Monty | ~2 weeks | Picks the backend |
| **3** | `geometry` sidecar + the `geometry` rung | ~3 weeks | Only if a backend won |

---

## 2. The job

**Call the target `geometry`, not `monty`.** The sidecar plumbing, queue, migrations, read path and UI are identical whichever matcher wins Stage 2, and naming it after one candidate would force a rename or a lie. The backend is `GEOMETRY_BACKEND=monty|open3d` in the sidecar's `config.py`.

**Target:** `geometry`, added to `PYTHON_FUNCTION_TARGETS` in `backend/apps/api/src/domains/python-functions/types.ts` (today: `['summary', 'hbpe']`).

**Queue:** `py-fn-geometry`, options `{ policy: 'short', expireInSeconds: 2 * 60 * 60, retryLimit: 2, retryDelay: 120 }`.
`policy: 'short'` is mandatory — it is the only policy whose dedup index enforces a `singletonKey`; on the default `standard` a key is stored and silently ignored. Every send here carries a key, which is also required: the index `COALESCE`s a missing key to `''` and keyless sends collapse into each other.

**Functions** in `ci.geometry.functions.FUNCTIONS`, mirrored exactly in `PYTHON_FUNCTIONS.geometry` and in the `SIDECAR_REGISTRIES` table of `pythonFunctionRegistryDrift.test.ts` (which asserts set equality in both directions by parsing the `.py` file — omit it and the test silently checks nothing):

1. `learn_object(user_id, scan_id, object_id)` — arrival-triggered. Replays the frame bundle, builds/updates one model, writes the `.ply`/`.pt` to MinIO and the projection row to `ci.object_geometry_models`, updates the object's measured extents. Singleton `fn:learn_object:<userId>:<scanId>`.
2. `identify_scan(user_id, scan_id)` — arrival-triggered. Replays against that user's model library, returns the best hypothesis. Singleton `fn:identify_scan:<userId>:<scanId>`.
3. `rebuild_models(user_id)` — nightly. Rebuilds any object whose scan set changed or whose `backend_version` is behind the pin. Singleton `fn:rebuild_models:<userId>:<dayKey>`.

**Runtime budget — corrected.** The winner claimed "60–180 s for 150 frames at ~37 steps/sec". 37.4 steps/sec is 374 match steps ÷ a 10 s episode (`benchmarks/montymeetsworld.csv`); 150 steps at that rate is **~4 s**. Real cost is dominated by the MinIO fetch and unprojection, not the match loop. Budget **seconds to low minutes**; the 2 h expiry is headroom for `rebuild_models` over a full library, sized per the rule that expiry must exceed the *longest* legitimate run (the mistake HBPE made when its expiry equalled only the label budget).

**Triggers.**
- *Arrival:* a new `capture.rgbd.scan.completed` event declared with `defineEvent` **plus** the `declare module '@ci/domains/events/registry'` merge, consumed by `RgbdScanListener`, which calls `PythonFunctionService.dispatch('geometry', …)`. Producer and consumer ship in the **same PR** — 16 event names are already orphaned for breaking that rule.
- *Nightly:* `@Cron('35 50 4 * * *', { name: 'PythonFunctionCrons.geometryRebuild' })` imported from `@ci/common/schedule` (raw `@nestjs/schedule` is an eslint error outside the wrapper). 04:50 clears `hbpeNightly` (02:30), `hbpeBootstrapSweep` (03:00), `JobMetricsCollector.purge` (04:25) and `DerivationCron` (04:40); second 35 rather than 0 because twelve schedules already fire on second 0 into one event loop and one 25-connection pool.

**Audience query:** follow `PythonFunctionCrons.listUsersWithStaleDossier` (`:232-330`), **not** the unbounded `SELECT id FROM ci.users WHERE onboarded = true` fan-out that nine existing crons use. Select only users with a scan newer than its model's `built_at`. Both halves fail open. On an appliance with no scans this enqueues nothing and costs one query a night.

**Completion:** copy HBPE's deferred pattern exactly — `autoAcknowledge: false`, POST `{function, args, job_id, queue}` to `${baseUrl}/functions/run` with a 30 s accept timeout, then `ack.defer()` to release the worker slot. The sidecar self-signs an HS256 JWT with `sub = args["user_id"]` (injected by `PythonFunctionService.dispatch`) and POSTs to `/function-runs/callback`. **Copy `backend/apps/hbpe/entrypoint.sh`, not Summary's** — HBPE hard-fails on a missing `AUTH_TOKEN_SECRET`; Summary's variant only warns and then posts the callback unauthenticated, so every job silently waits out its expiry.

**Outputs.**
- `ci.object_geometry_models` (new) — the queryable projection.
- `ci.object_observations` — new rows, `source_kind='live_camera'` (**already a CHECK member; no migration needed**), `resolution_method='geometry'` (new member).
- `ci.objects` — `length_mm/width_mm/height_mm`, `identity_method='geometry'` (new member), `identity_confidence`, `last_seen_at`, `last_seen_place_entity_id`.
- MinIO via `ci.files` for the model blob. `FilesController` has no mime allowlist, so this stores fine and `MediaDimensionsService` ignores it.

**Confidence mapping — a declared number, honestly labelled.** `object_observations_resolution_confidence_check` bounds the column to `[0,1]` and the ladder gates at 0.8. Monty evidence is an *unbounded* accumulation governed by `past_weight`/`present_weight`, so a hand-chosen evidence→confidence map is unavoidable — which reinstates exactly the declared-ness the geometry rung claims to remove. Open3D's `fitness` is natively `[0,1]` and does not have this problem. **This is a point in Open3D's favour and should be weighed in Stage 2.** Either way, calibrate against held-out second scans and write the calibration down; do not ship a guess.

**Labels for the learning loop:** `ci.object_observations.confirmed_by_user` **already exists** (`BOOLEAN NOT NULL DEFAULT FALSE`, line 70 of the creating migration, and it participates in the unresolved-observations partial index). It is the scoring signal. No new column.

**Taxonomy entry required** in `backend/apps/api/src/domains/events/taxonomy.ts` in the same PR, or the job renders as "Unclassified job" on `/jobs` and is unreachable from the category filter. The queue itself appears automatically — `queueInventory()` is built from the live `@OnEvent` registry.

**Sharding from day one:** inference cost is linear in library size ("the number of evidence updates … scales linearly with the number of objects an LM has in its memory") and the largest published Monty memory is 77 objects. `ci.object_geometry_models` carries `shard_index` from the first migration; the sidecar holds one LM per shard of ~50.

---

## 3. Architecture

### Stage 1 — no sidecar at all

```
iPhone/Android (frontend/apps/{ios,android})
  └─ @ci/capacitor-rgbd-scan  ── user taps object, one raycast anchor, orbits ~15 s
       ARFrame.sceneDepth.depthMap (float32, metric)
       ARFrame.camera.transform    (4x4 world-tracked 6-DoF)
       ARFrame.camera.intrinsics   (fx, fy, cx, cy)
       downsampled RGB + anchor world position + 0.30 m sphere radius
          │  multipart → POST /files/upload  (frame bundle, one blob)
          │  NDJSON    → POST /v1/events  kind=capture.rgbd.scan.completed
          ▼
NestJS API — RgbdScanListener
  └─ unproject depth with intrinsics → point cloud in world frame
     keep points inside the anchor sphere
     PCA-align → oriented bounding extent
     WRITE ci.objects.length_mm/width_mm/height_mm  (first real writer, ever)
     WRITE ci.object_observations (source_kind='live_camera')
          ▼
GraphQL ObjectGeometryType → ThingsPage "Shape" panel
```

No Python. No torch. No third image across cpu/cuda/rocm. **One of the three headline wins lands here.**

### Stage 3 — the sidecar, if a backend won Stage 2

```
                      ┌──────────────────────────────────────────┐
PythonFunctionCrons ──┤ @Cron 04:50:35  geometryRebuild          │
RgbdScanListener   ───┤ arrival: capture.rgbd.scan.completed     │
                      └───────────────┬──────────────────────────┘
                                      │ PythonFunctionService.dispatch('geometry', …)
                                      ▼
                          pg-boss queue  py-fn-geometry
                          policy short · expire 2h · singletonKey
                                      │
                      PythonFunctionDispatchListener
                          POST /functions/run  (30 s accept) → ack.defer()
                                      ▼
                        geometry-service : container 8004 / host 8004
                          ci.geometry.runner    (verbatim copy of ci.hbpe.runner)
                          ci.geometry.arkit     frames → point cloud / Observations
                          ci.geometry.engine    backend = monty | open3d
                          ci.geometry.persistence
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
          Postgres (own creds)     MinIO blob      POST /function-runs/callback
          ci.object_geometry_models                 HS256 JWT, sub = user_id
          ci.object_observations                    → eventService.completeJob
          ci.objects
                    │
                    ▼
     ObjectResolutionService — new rung `geometry`, ABOVE `embedding`
     (declines when no model exists or evidence is below margin → today's behaviour)
                    │
                    ▼
     ObjectGeometryService → ObjectGeometryType → ThingsPage "Shape" panel
```

**Where state lives.** Not in `.pt` blobs as a system of record. `torch.save` of a `GridObjectModel` is a pickle of live sparse torch tensors, loadable only with `weights_only=False` (arbitrary code execution) and only when the exact `tbp.monty` classes import at the same module paths. The blob is a sidecar-owned **cache** in MinIO; the **queryable projection** is `ci.object_geometry_models` in Postgres, and that is what gives the feature a read path in the same PR. If a `.pt` is ever reloaded, the three sparse tensors (`_observation_count`, `_feature_grid`, `_location_grid`) must be re-`.coalesce()`d — `EvidenceGraphMemory._add_graph_to_memory` does this with the comment "serialization seems to mess up the sparse tensors", and any custom load path that skips it gets a silently broken model.

**Object identity.** Monty names an unrecognized object `"new_object" + str(len(self.graph_memory))` — hardcoded inside `set_detected_object` (`evidence_matching/learning_module.py:597`), positionally, not a parameter. Two appliances produce the same name for different things. The sidecar mints or resolves a `ci.objects.object_id` via the existing `ObjectMintService` **first** and re-keys the graph to that UUID before persisting. Same class of defect as the per-appliance `gen_uuid_v7()` coupling already in this repo's memory.

**Grafted from the runners-up — human as the motor system.** The single biggest concession in the winning proposal is that passive replay discards the returned `list[Action]` and so forfeits the hypothesis-testing policy that produces Monty's best numbers (2.27° on 77 objects with a surface agent). `GraphGoalGenerator` (`goal_generation.py:805-825`) already emits a `Goal` carrying a target 3-D location plus a partially-specified pose. Transform it from object frame into the live ARKit world frame, project it into the current camera view, and draw it as an on-screen arrow: the user moves, the next frame streams, the arrow updates, and the scan ends on `lm.terminal_state == MATCH` rather than a 15-second timer. This recovers the policy with hardware the user is already holding, and makes the job *cheaper* — 3–5 directed looks instead of ~150 blind frames. **Stage 3 only, and only if the backend is Monty.**

**Parked, deliberately:** shared catalog models arriving as `owner_user_id IS NULL` rows through CI-Marketplace (the only cure for a literal 100% cold start — `ci.product_models`' own migration comment already reserves the shape), and contributing the pose-tracked corpus upstream as a real-object RGBD benchmark for tbp.monty. Both are good; neither is on the critical path. The `owner_user_id` column is nullable from the first migration so the catalog is a later insert, not a later migration.

---

## 4. Files to create/edit

### Stage 1 — capture + measured extents (no sidecar)

**Plugin** — follows `@ci/capacitor-local-llm` / `@ci/capacitor-speech` / `@ci/capacitor-local-hub` exactly:
- `frontend/packages/capacitor-rgbd-scan/package.json`
- `frontend/packages/capacitor-rgbd-scan/src/{definitions,index,web}.ts`
- `frontend/packages/capacitor-rgbd-scan/ios/Plugin/*.swift` (ARKit `sceneDepth` + `camera.transform` + `intrinsics`)
- `frontend/packages/capacitor-rgbd-scan/android/` (ARCore Depth API)
- `frontend/apps/ios/package.json` and `frontend/apps/android/package.json` — add as a `portal:` dep. **Install and `cap sync` from INSIDE each app directory.** Both are deliberately excluded from the Yarn workspaces (`"!frontend/apps/ios"`, `"!frontend/apps/android"` in root `package.json`) because Capacitor, CocoaPods and Gradle walk a real `node_modules` tree that PnP does not produce; a root install will not materialize them and "fixing" the exclusion breaks the native builds.

**Server:**
- `backend/apps/api/src/domains/memory/events.ts` — `CaptureRgbdScanCompletedEvent` via `defineEvent` + the registry module merge
- `backend/apps/api/src/domains/events/taxonomy.ts` — descriptor for the new event
- `backend/apps/api/src/domains/memory/listeners/RgbdScanListener.ts` — new
- `backend/apps/api/src/domains/memory/services/ObjectExtentService.ts` — new; unprojection + PCA extent, in TS
- `backend/apps/api/src/domains/ingest/controllers/BulkIngestController.ts` — rgbd-scan destination alongside `'observations'`
- `backend/apps/api/src/domains/graphql/types/ObjectGeometryType.ts` + the Item/Object resolver
- `frontend/apps/web/src/pages/ThingsPage/` — scan flow + the "Shape" panel

### Stage 3 — the `geometry` sidecar

**New Python member** (`ci` is a PEP 420 namespace — **never** create `src/ci/__init__.py`; `scripts/check-ci-namespace.sh` enforces this):
- `backend/apps/geometry/pyproject.toml` — distribution `ci-geometry`, module `ci.geometry`, `namespace = true`, `uv_build` backend, `ci-telemetry` from workspace
- `backend/apps/geometry/src/ci/geometry/py.typed` — PEP 561; mypy refuses to look at a member without it, and a new member is **STRICT** (the `ignore_errors` quarantine names only `ci.hbpe.*` and `ci.summary.*`)
- `backend/apps/geometry/src/ci/geometry/api.py` — FastAPI, `init_telemetry('ci-server-geometry')`, `/health`, include runner router
- `backend/apps/geometry/src/ci/geometry/runner.py` — **verbatim copy** of `backend/apps/hbpe/src/ci/hbpe/runner.py`
- `backend/apps/geometry/src/ci/geometry/functions.py` — `FUNCTIONS = {'learn_object', 'identify_scan', 'rebuild_models'}`
- `backend/apps/geometry/src/ci/geometry/arkit.py` — frame bundle → point cloud; **square patch extraction** (see §5)
- `backend/apps/geometry/src/ci/geometry/engine_open3d.py` / `engine_monty.py` — one wins Stage 2
- `backend/apps/geometry/src/ci/geometry/persistence.py`
- `backend/apps/geometry/src/ci/geometry/{config,database}.py` — pydantic-settings; psycopg2 pool, HBPE's shape
- `backend/apps/geometry/Dockerfile` — **root build context** (installs `ci-telemetry`), `ARG UV_VERSION` with no default, two-stage `uv sync --frozen --package ci-geometry --no-install-workspace` then `--no-editable`, `opencv-python-headless` override for the pinned `opencv-python==4.13.0.92` libGL import, `WANDB_MODE=disabled`
- `backend/apps/geometry/entrypoint.sh` — copied from `backend/apps/hbpe/entrypoint.sh` (the hard-fail variant)
- `backend/apps/geometry/tests/`
- `pyproject.toml` — add `backend/apps/geometry` to `[tool.uv.workspace] members` and `ci.geometry` to `[tool.mypy] packages`
- `uv.lock` — regenerate with `uv lock`. **Never hand-resolve**; `scripts/merge-uv-lock.sh` is the registered merge driver

**Wiring:**
- `backend/apps/api/src/domains/python-functions/types.ts` — add `'geometry'` to all four `Record`s (tsc demands it)
- `backend/apps/api/src/domains/python-functions/listeners/PythonFunctionDispatchListener.ts` — the `@OnEvent` for `py-fn-geometry`, `autoAcknowledge: false`
- `backend/apps/api/src/domains/python-functions/cron/PythonFunctionCrons.ts` — `geometryRebuild` + the stale-model audience query
- `backend/apps/api/src/domains/python-functions/__tests__/pythonFunctionRegistryDrift.test.ts` — add `geometry` to `SIDECAR_REGISTRIES`
- `backend/apps/api/src/configuration.ts` — `services.geometry` zod, default `http://geometry-service:8004`
- `backend/apps/api/config/default.json` — `services.geometry.host`
- `backend/apps/api/config/custom-environment-variables.json` — `GEOMETRY_HOST`. Without it, every dispatch from the host-run API under `make dev` is `ENOTFOUND`.

**Migrations** — create with `yarn workspace @ci/be-api migrate:make <name>`; **never hand-write the timestamp prefix** (round timestamps have collided across parallel branches and a duplicate breaks `migrate` for everyone):
- `…_create_object_geometry_models.sql` — `model_id`, `user_id`, `owner_user_id` (nullable, for the future shared catalog), `object_id` FK `ci.objects`, `backend` text, `backend_version` text, `node_count`, `extent_mm` numeric[3], `volume_mm3`, `built_from_scan_ids uuid[]`, `model_file_id`, `shard_index`, `built_at`, `updated_at`
- `…_add_geometry_resolution_method.sql` — widen `object_observations_resolution_method_check` from `('identifier','embedding','place_prior','label','user','none')` and `objects_identity_method_check` from `('user','barcode','receipt','vision','import','inferred')` to include `'geometry'`. Needs a **PARTITION guard test, not a subset test** (repo rule: widening a status enum without one has bitten before).
- `backend/apps/api/src/domains/memory/entities/ObjectGeometryModelEntity.ts` — TypeORM entity matching the hand-written SQL (SQL is the source of truth; entities follow)
- `backend/apps/api/src/domains/memory/services/ObjectGeometryService.ts` — read path, **same PR as the writer**
- `backend/apps/api/src/domains/memory/services/ObjectResolutionService.ts` — insert the `geometry` rung above `embedding`; extend the ladder docblock at `:113`

**Build / compose / publish:**
- `docker-compose.yml` — `geometry-service`, `profiles: [local, staging, production]`, `depends_on` both `database: service_healthy` **and** `setup-database: service_completed_successfully`, python-urllib healthcheck (not curl), `mem_limit`
- `docker-compose.local.yml` — `${GEOMETRY_HOST_PORT:-8004}:8004`, `API_URL: http://host.docker.internal:${API_HOST_PORT:-3030}`, `API_JWT_SECRET`
- `scripts/dev-stack/index.ts` — `DEFAULTS.geometry = 8004` (`:98-105` already has `hbpe: 8002`, `summary: 8001`, `parser: 8003` — 8004 is the first free port), `allocPort`, `GEOMETRY_HOST_PORT` in the compose env, `GEOMETRY_HOST` in the overmind env, a row in the printed table
- `scripts/xtask/lib/images.ts` — `GEOMETRY_REPO` accessor + widen `sidecarStamp`'s `appDir` union
- `scripts/xtask/commands/build.ts` — `ImageKey`, `IMAGE_ORDER`, `defaultImageKeys`, a `buildStepFor` case copying `'summary'` verbatim (no GPU args)
- `Makefile` — `export GEOMETRY_REPO ?= ci/geometry-service`
- `scripts/publish/images.sh` + `scripts/publish/publish.sh` — index-aligned local/remote arrays and the compose-manifest block. An image missing from either is built but never pushed, or pushed but never installed by the Hub.
- `docs/jobs-system.md` — trigger table and the new queue's notes

---

## 5. The one-day spike

**No server code, no plugin, no sidecar, no migration, and — critically — no touching the shared `uv.lock`.**

### Step 1 — record two orbits of one real object

A plain white mug is the honest hard case: an RGB embedding of it is near-content-free, so shape is the only discriminating signal. Use any off-the-shelf iOS depth-capture app that dumps `sceneDepth` + `camera.transform` + `intrinsics` per frame. **Two separate orbits**, different lighting, different table.

### Step 2 — throwaway venv, `--no-deps`

`torch-sparse` and `torch-scatter` are **unconditional** deps of tbp.monty for `python>=3.9` and they are an install blocker: sdist-only, and `setup.py` does `import torch` at build time, which fails under the build isolation `uv sync --locked` uses. Nothing in Monty's `src/` imports either (0 grep hits; `deptry`'s DEP002 check is switched off, which is why nobody noticed). Install without them.

```bash
SCRATCH=/private/tmp/claude-501/-Users-liam-devel-ci-CI-Server--claude-worktrees-nervous-jackson-7a51b2/682d7c23-0552-4733-9677-37258a1ac115/scratchpad
MONTY=$SCRATCH/monty          # already cloned, commit f55675b

uv venv --python 3.11 $SCRATCH/spike/.venv
$SCRATCH/spike/.venv/bin/pip install --no-deps -e $MONTY
$SCRATCH/spike/.venv/bin/pip install \
  numpy scipy scikit-learn scikit-image sympy pandas pillow tqdm \
  numpy-quaternion torch torch-geometric opencv-python-headless \
  hydra-core omegaconf pydantic typing_extensions eval_type_backport matplotlib wandb

export WANDB_MODE=disabled
export MONTY_LOGS=$SCRATCH/spike/logs MONTY_MODELS=$SCRATCH/spike/models MONTY_DATA=$SCRATCH/spike/data

# no habitat, no display, no GPU:
$SCRATCH/spike/.venv/bin/python -c \
  "from tbp.monty.frameworks.models.evidence_matching.learning_module import EvidenceGraphLM; print('ok')"
```

### Step 3 — the five corrections that must be in the harness

Without these it fails for reasons that tell you nothing about Monty.

```python
from tbp.monty.context import RuntimeContext
from tbp.monty.frameworks.experiments.mode import ExperimentMode          # (c)
from tbp.monty.frameworks.environment_utils.transforms import DepthTo3DLocations
from tbp.monty.frameworks.models.motor_system_state import (
    AgentState, SensorState, ProprioceptiveState)

# (b) SQUARE PATCH. ObservationProcessor.process does
#     obs_dim = int(np.sqrt(obs_3d.shape[0])); center_id = half + obs_dim*half
#     Every shipped resolution is 64x64. ARKit sceneDepth is 256x192:
#     int(sqrt(49152)) = 221 -> centre lands at (95,100), not (96,128).
#     Crop a 64x64 patch centred on the raycast anchor pixel. Do NOT pass the
#     full buffer. And `on_object = semantic_id > 0` is read from that ONE
#     centre pixel, so the anchor must stay centred each frame.
patch_rgb, patch_depth, patch_sem = crop64(frame, anchor_px)

# (a) get_all_points=True. sensor_frame_data is written ONLY inside
#     `if self.get_all_points:` (transforms.py:641-652) and
#     ObservationProcessor reads it unconditionally at sensor_modules.py:195.
#     Default is False; 11 of the 12 shipped transform configs set it true.
transform = DepthTo3DLocations(
    agent_id="agent_01", sensor_ids=["patch"], resolutions=[(64, 64)],
    hfov=degrees(2 * atan(cx / fx)),
    world_coord=True, get_all_points=True, use_semantic_sensor=True,
)
# NOTE: use_semantic_sensor is INERT for a distant agent (read only at
# transforms.py:585 inside `if self.depth_clip_sensors and ...`). The anchor
# mask is consumed because the key "semantic" is present. What lands in
# semantic_3d[:,3] is `surface_patch` from get_surface_from_depth — so the tap
# sphere is an INPUT to a depth-connectivity heuristic, not the segmentation.

proprio = ProprioceptiveState({"agent_01": AgentState(
    position=cam_translation, rotation=cam_quaternion,
    sensors={"patch": SensorState(position=[0,0,0], rotation=identity_quat)})})
# Sensor is rigid to the camera, so the relative transform is identity and
# there is nothing to invent. ARKit world tracking is what makes the
# displacement stream coherent — Monty computes displacement from the mean SM
# location across consecutive steps, so a jumpy pose silently poisons every
# hypothesis rather than erroring.

# assert the CMP invariants BEFORE stepping:
assert msg.location.shape == (3,)
assert msg.morphological_features["pose_vectors"].shape == (3, 3)
assert isinstance(msg.morphological_features["pose_fully_defined"], bool)  # np.bool_ FAILS

lm = EvidenceGraphLM(
    use_multithreading=False,        # an EvidenceGraphLM arg, NOT a Monty one
    max_graph_size=0.30,             # METRES. Set explicitly for the object
    ...,                             # class; the default rejects anything
)                                    # bigger than a shoebox via GridTooSmallError

# (d) MontyBase requires 8 more positional args. motor_system is mandatory
#     (monty_base.py:43-56), _step_motor_system runs on EVERY step (:333-345)
#     and reset() calls self.motor_system.reset() (:392). Supply one or subclass.
model = MontyForEvidenceGraphMatching(
    sensor_modules=[sm], learning_modules=[lm], motor_system=motor,
    sm_to_agent_dict=..., sm_to_lm_matrix=..., lm_to_lm_matrix=...,
    lm_to_lm_vote_matrix=..., min_eval_steps=..., min_train_steps=...,
    num_exploratory_steps=...,
)

model.set_experiment_mode(ExperimentMode.TRAIN)   # (c) NEVER the string "train":
# update_ltm_from_stm gates on `self.mode is ExperimentMode.TRAIN` (graph_matching.py:627),
# an identity check. A string assigns fine and silently disables learning.
model.reset()
for obs, prop in sequence_one:
    model.step(RuntimeContext(rng=np.random.RandomState(0)), obs, prop)

model.update_ltm()   # (e) MANDATORY. Called only from MontyExperiment
# (monty_experiment.py:570). Without it the loop writes no graph, ever —
# no error, no output.

model.set_experiment_mode(ExperimentMode.EVAL)
model.reset()
for obs, prop in sequence_two:
    model.step(ctx, obs, prop)
    print(lm.current_mlh)   # {graph_id, mlh_id, location, rotation, scale, evidence}
```

**Also note:** with `tolerances={}`, morphology-only matching **crashes, it does not degrade gracefully.** `_fill_feature_weights_with_default` iterates `self.tolerances.items()` and leaves `feature_weights == {}` (`learning_module.py:1183-1184`), then `hypotheses_displacer.py:380` does an unguarded `self.feature_weights[input_channel]['pose_vectors'][0]` → `KeyError`. The all-zeros path cited in the original proposal is the *feature* evidence path; the *pose* evidence path is separate and is the one that breaks. Supply pose tolerances.

### The kill criterion (binding)

**If Monty cannot re-identify your own mug from the second independent orbit — or if it does, but only from near-identical viewpoints and lighting, or the evidence margin never separates from noise — stop.** Nothing in §2–§4 Stage 3 gets built, and the finding is worth having by itself.

### Day two — instance separation

Ten objects including **two deliberate lookalikes**. After learning, check `len(lm.graph_memory)`. If the two lookalikes merged into one graph, the data-corruption risk is real and must be solved before any further weeks are spent. Monty's own `ycb_unsupervised.csv` shows 2.14 objects per graph on similar objects, and the docs concede the post-first-epoch accuracy is inflated by exactly that merging. **Do not accept Monty's headline accuracy as evidence here — write your own separation metric.**

### Run in parallel, as its own gate

```bash
docker run --rm -it python:3.11-slim bash -c \
  'pip install torch && pip install --no-build-isolation torch-sparse torch-scatter'
```

If that fails or takes 20 minutes, the Monty sidecar is dead regardless of what the replay shows — and it must be proven **before** `ci-geometry` is ever added to `[tool.uv.workspace].members`. Adding it re-resolves Monty's 30 core deps against CI-Server's constraints workspace-wide; one bad interaction breaks `make install`, `make lint`, `make build` and CI simultaneously, none of them near the change that caused it. (CI is `workflow_dispatch`-only and nothing gates a merge, so nobody will catch it for you: `gh workflow run ci.yml --ref <branch>`.)

### The free win if it all dies

Step 3 proves whether an ARKit orbit yields a clean metric point cloud of a household object. If it does, **Stage 1 stands alone** — real measured extents into `ci.objects.length_mm/width_mm/height_mm`, no Monty, no sidecar, no torch, no third image across three GPU variants — and one of the three headline user-visible results lands anyway.

---

## 6. Runner-up options

| # | Direction | Score | One-line verdict |
|---|---|---|---|
| 1 | **Phone RGBD orbit → object-instance memory** (the winner, as corrected here) | 3.7 | Right target, wrong cost estimate and a false problem statement; survives only as the staged plan above. |
| 2 | **Agent loop — gimbal motor policy, closed perception-action** | 3.0 | Best *use* of Monty (the next-best-view policy is the one thing nothing else gives you), killed by hardware: the gimbal MCP is BLE-attached to one developer's Mac, the appliance is a container, and there is still no depth source. Its goal-state idea is grafted into §3 as the on-screen arrow. |
| 3 | **GPS place-graph recognizer, bake-off inside the HBPE sidecar** | 2.7 | The only option needing no new hardware and no new sidecar, and the only one honest enough to ship a deletion criterion — but it discards rotation, which is most of the algorithm, and `heading_degrees` is populated only on the live-device path while most of the 63,043 fixes are 13-year-old Takeout. Measure the derivable-heading rate before writing a line. |
| 4 | **Scan-object recognizer over Companion Scan GLBs** | 2.7 | Architecturally the cleanest, and dead on input: zero `capture.scan` events, zero GLBs, and `memory_push.ts` narrows every detection to `{label, position}` in an un-registered scan-local frame. Building a consumer for a dead wire is the exact pattern this repo keeps deleting. |
| 5 | **Scan-geometry models as a measured-confidence rung** | 2.7 | Same input problem as #4, but it is the proposal that says the quiet part out loud: "the single most valuable step needs no Monty at all — the measured bounding box is ~30 lines." That sentence is why §1 recommends Stage 1 standalone. |

**Grafted into the spec:** #2's goal-state-as-UI, #3's bake-off-not-feature framing (→ Stage 2), #5's no-Monty-first ordering, and from the completeness critic the `owner_user_id IS NULL` shared-catalog column.
**Parked with reasons:** cross-modal multi-LM voting (Monty's vote is pose hypotheses matched by kd-tree in a shared metric frame and needs a supervised shared object-ID vocabulary — there is no metric frame in which a receipt line-item and a photo embedding have a displacement); Monty-as-index (a `GridObjectModel` is strictly worse than pgvector for anything not already 3-D geometry).

---

## 7. What would make this a bad idea

1. **The capture path is the whole project and it does not exist.** Zero hits for `arkit|sceneDepth|ARFrame` across `frontend/apps/ios`, `frontend/apps/android` and `frontend/packages`. `ci.position.relative_coordinates`/`relative_orientation` shipped with zero producers and have sat there since 2025. A native plugin streaming depth + intrinsics + 6-DoF pose from **both** iOS and Android is most of the cost, and non-LiDAR devices fall back to `estimatedDepth`, whose accuracy at object scale is unvalidated for this purpose. If Stage 1 stalls, everything downstream has nothing to read.
2. **The accuracy ceiling is Monty's own number, and it is low.** 66.67% clean / 29.17% dark / 25.00% multi-object. If our path lands near that, "which of my things is this" is wrong a third of the time in good light. **A wrong confident answer that links an object to someone else's receipt is worse for a memory appliance than no answer.** The geometry rung must decline aggressively — and if the decline rate has to exceed ~50% to keep precision acceptable, the sidecar is not worth its existence.
3. **Unsupervised merging is a user-visible correctness bug.** 2.14 objects per graph on lookalikes; the docs concede total merging would score 100% thereafter. "Your two black mugs became one row in `ci.objects`" is a bug report, not a metric artifact. Day two of the spike exists for this and there is no guarantee it passes.
4. **`torch-sparse` / `torch-scatter` are a verified install blocker.** Unconditional deps of tbp.monty, sdist-only, `import torch` at build time under build isolation, and the lock would resolve torch 2.13 against a `torch-sparse` that predates it by years. Prove them in a standalone container first or the sidecar is dead on arrival.
5. **Monty is major-version-zero with an explicitly unstable API and this clone has already drifted from its own docs.** Pin `f55675b`, own every upgrade by hand, and do not treat tbp.monty as a dependency you bump.
6. **Passive replay loses Monty's best mechanism.** Discarding the returned `list[Action]` because the user's hand chose the trajectory puts us closer to the distant-agent random walk than the surface agent whose 2.27° figure everyone quotes. The 80.00%/98.89% unsupervised number comes from `surf_agent_unsupervised_10distinctobj`, a closed-loop model-based policy inside Habitat — **a different design from this one.** The goal-state arrow in §3 is the mitigation, and it is unproven.
7. **The roadmap is explicitly anti-new-capability.** `docs/architecture/product-technology-roadmap-2026-09.md`: "surface what is already computed, gate the pipeline that produces it, and give the AI one spine — *before adding capability*", with "Intelligence producers with a rendered reader: 3 of 9" as a headline measure, and decision A20 arguing the Summary sidecar should be folded *into* Node. This adds a tenth producer and a third Python service. The `ThingsPage` read path shipping in the same PR is what keeps it from being the exact documented failure mode — **it is non-negotiable, not a nice-to-have.** The team deletes producerless subsystems on sight (`ci.user_snapshots`, `ci.event_analytics`, the `SEARCH_EMBED_ENTITY` path).
8. **Open3D may simply win.** FPFH + RANSAC + ICP: deterministic 6-DoF pose in milliseconds on CPU, a natively `[0,1]` `fitness` that fits `resolution_confidence` without an invented mapping, no torch-sparse, no v0.x churn. Monty's only structural advantage is building the reference model from the sightings themselves with no mesh to register against. If Stage 2 says ICP is better, build ICP and say so.
9. **Nothing gates a merge.** CI has been `workflow_dispatch`-only since 2026-09-17, `pr-gate.yml` is deleted, and branch protection requires no checks and no reviews. The Python lane (`uv sync --all-packages --locked`, ruff, mypy, pytest) must be started by hand. An absent check means nobody dispatched it, not that anything passed.