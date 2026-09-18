# Monty + gimbal active scanning — build plan

**Status: the spike runs, and two of its three headline claims did not survive verification. Do not build any CI-Server file until the kill criterion in §2 passes on real hardware.**

Spike lives at `/private/tmp/claude-501/-Users-liam-devel-ci-CI-Server--claude-worktrees-nervous-jackson-7a51b2/682d7c23-0552-4733-9677-37258a1ac115/scratchpad/gimbal-spike/`. Nothing in CI-Server has been touched; no `uv.lock` change, no migration.

---

## 1. Where the spike stands

### What genuinely runs

```
RIG_BACKEND=synthetic GIMBAL_FAKE=1 .venv/bin/python scan.py   # exit 0, no hardware
```

The closed loop is live and re-verified independently: `rig.capture(yaw,pitch)` → `extract_patch` → `DepthTo3DLocations` → `CameraSM` → `EvidenceGraphLM` → `list[Action]` → `step_gimbal` → back. 131 TRAIN poses, `update_ltm()`, 122-node graph, EVAL reaches `terminal_state=match` in 9 steps with a real MLH (`mlh_id=489`, evidence 12.99). `rig.py` `patch.py` `gimbal.py` `driver.py` each self-test standalone.

Settled facts worth keeping: Monty v0.50.0 runs headless with no habitat and no simulator; locations are **metres** (×1000 → mm); `monty._match_criterion` must be assigned post-construction; `tolerances` must be non-empty and keyed by `sensor_module_id`; an object larger than `max_graph_size` is **silently dropped** (needs ≥2.25× diameter, and `assert lm.get_all_known_object_ids()` after `update_ltm()`); `record3d 1.4.1` imports clean in `.venv` and its depth→metric back-projection is arithmetically exact.

### Refuted — claim 1: the "measurement" is largely a readout of the operator's guess

`scan.py:137` prints *"that estimate sizes the sweep only. It never enters a measurement."* **That line is false.** The reported extent is `min..max` over the anchors the sweep actually visited, and the sweep is sized from `SCAN_SIZE_MM` × `SCAN_COVERAGE` (default 0.8). Holding the true object fixed at a 100 mm sphere and varying only the guess:

| `SCAN_SIZE_MM` guess | 60 | 80 | 100 | 120 | 150 |
|---|---|---|---|---|---|
| reported width (mm) | 43.74 | 58.98 | **75.00** | 92.92 | 82.80 |

Even with a perfect guess the report is 25% low: `75.00 mm` for a `100.00 mm` sphere, and that is the number the WRITEBACK block proposes for `ci.objects.width_mm`. The `METRIC CHAIN: PASS` verdict cannot catch this — it compares against the *swept-pose* ground-truth extent (74.99 mm), i.e. it is a self-consistency check of the raycast against itself. On real hardware the guess is wrong by definition, which is circular, and the tape-measure test will **not** catch it if the operator sizes the sweep from the tape.

The same run already prints the correct answer one line lower: `whole visible surface (dense raycast) x=99.18 mm` — 0.8% from truth. **Dimensions must come from the confidence-gated dense depth cloud, not from Monty's anchor graph.** Monty's job is identity and pose, not measurement. This is the single largest design change the spike forces.

### Refuted — claim 2: instance separation is zero at shipped defaults

Two TRAIN episodes on one `MontyDriver`, `x_percent_threshold=20.0`, `object_evidence_threshold=1.0`:

| pair | `len(graph_memory)` | merged extent (mm) |
|---|---|---|
| sphere 100 + sphere 120 | **1** | x=97.52 y=88.73 — belongs to neither |
| sphere 100 + **cube** 100 | **1** | x=75.00 y=116.59 — a chimera |
| sphere 100 + sphere 100 | 1 | correct by accident |

A cube is indistinguishable from a sphere. Episode 2 reports `terminal_state=match` every time, so **the merge is silent and it corrupts the headline number**. Root cause: `tolerances={'principal_curvatures_log': np.ones(2)}` — the log-curvature gap between a 50 mm and a 60 mm radius is 0.182 against a tolerance of 1.0, 5.5× too loose.

It is tunable. `x_percent=1.0, object_evidence_threshold=20.0, max_match_distance=0.002` gives correct 3-way separation, correctly keeps two identical spheres as one, and correctly returns `no_match` for an unlearned object — but at that config the shipped 29-pose EVAL sweep never reaches terminal (evidence 7.76). A denser EVAL sweep reaches `match` in 14 steps at evidence 20.02. **The two halves of the demo were never satisfiable at the same configuration as shipped.**

### Stubbed

- **`record3d` backend** — import-clean, fails with `No Record3D device at index 0 (0 found)`. Depth-map orientation (portrait cradle vs ARKit landscape) and pose handedness are flagged unverified in its docstring.
- **`mono` backend** — model leg works (Depth-Anything-V2-Metric-Indoor on MPS, 146–422 ms/frame); camera leg blocked by process-level TCC. Its published error is 0.32–0.66 m at a 0.3–1 m range — **several times the size of the objects**. Never label its output "measured".
- **Real gimbal** — `GIMBAL_FAKE=1` everywhere. No physical sweep has been verified since the 2026-08-24 ignore-mask fix, and before that fix every command was accepted and moved nothing.
- Fix already applied: `rig.py` (~L346, ~L375) told the operator record3d lives in `.venv-depth` and to install it there. It is in `.venv`. That text would have misdirected step 1 of bringup. Re-ran after the edit: unchanged output.

---

## 2. Your next physical steps

Budget: ~4 days to a first real scan. Steps 1–2 are the only ones I cannot do any part of.

1. **Clamp clearance, 5 minutes, do it first.** Cradle the 13 Pro Max in **portrait** and look at the back: the clamp arm must not cover the camera island or the LiDAR emitter. Osmo clamps routinely foul a Pro Max bump. If it occludes, flip the phone (island at the bottom, accept a 180° depth rotation) or use a spacer. Nothing downstream survives a covered emitter.
2. **Buy + install Record3D** (~$6 basic tier; USB streaming is included, the WiFi/RGBD pack is **not** needed). Settings → enable **USB Streaming mode** → press record.
3. **Tether over a real USB-C data cable.** Verified this session: no iPhone is on USB — the camera `ffmpeg` sees is a wireless Continuity Camera, which cannot carry Record3D. Then: `./.venv/bin/python -c "from record3d import Record3DStream; print(len(Record3DStream.get_connected_devices()))"` must print **1** (it prints 0 today). A 0 with the cable in is a charge-only cable or the USB toggle, not the code.
4. **Start the gimbal backend in a real interactive Terminal** (macOS will not show the Bluetooth prompt to a headless process; nothing is listening on :8788 today): `cd /Users/liam/devel/device-firmware-diag/osmo-ble && npm run backend`. Then `/api/scan` → `/api/connect` → `/api/pair` with the PIN on the gimbal's screen. **Nothing is persisted — repeat after every backend restart.** Confirm `/api/status` shows `connected:true, paired:true` and a non-null `lastQuaternion`.
5. **Prove the head moves, one command, before any scan.** `POST /api/test/command-probe {type:'absoluteAngle', params:{yawDeg:30,pitchDeg:0,durationSeconds:1.0}, waitMs:2000}` → require `"moved": true` and `delta` well above 0.02. Keep `durationSeconds >= 1.0`: it is truncated to an integer before being scaled into one byte, so 0.8 goes on the wire as 0.
6. **Baseline the zeros.** `gimbal_recenter`, settle, record the gimbal quaternion and one Record3D camera pose. Start the Record3D session with the phone already cradled and at rest.
7. **Single-frame sanity, no Monty.** Check three things: depth is `float32` metres in 0.3–1.0; `get_device_type() == 1` (LiDAR rear, not 0 = front TrueDepth); and orientation — point at a book standing on end and confirm the tall axis is tall in the depth array. ARKit streams native landscape into a portrait cradle; a transpose gives a scan that completes, passes every assertion, and reports x and y swapped.
8. **The tape-measure test.** Known box at 0.50 m, one frame, back-project with `min_conf=2`, compare the **dense-cloud** extent to a tape. This is the gate, not a demo.
9. **Calibration pass, one sitting** (see below). Two commanded moves name the quaternion axes and handedness; a 6-pose least-squares fit recovers the lever arm (60–120 mm for a phone in a cradle — 12–24% of a 500 mm working range).
10. **First real scan:** `RIG_BACKEND=record3d GIMBAL_FAKE=0 SCAN_DWELL_MS=900 ./.venv/bin/python scan.py`. Rigid matte object ~100 mm at **0.6–0.8 m** (not 0.3 m — ARKit's rear minimum is ~0.26 m). Yaw envelope capped at **±60°**, not ±160, to keep the cable from wrapping. Start at a **7×7 plan (49 poses, ~90 s)**, not 131 (~4 min of pure actuation).

**Pose rule, non-negotiable: ARKit drives `AgentState.rotation`, unconditionally.** Read the pose out of the same Record3D frame as the depth, never polled separately. The gimbal quaternion gets exactly three jobs — settle detector (`delta > 0.02`), per-frame sanity gate (drop the frame if the gimbal-predicted and ARKit-measured relative rotations disagree by >3°), and post-mortem diagnostic. **Never splice a gimbal pose in when ARKit relocalizes** — different origins, different drift; Monty path-integrates the error forward with no error raised. A scan with 15% of frames dropped is fine; a scan with one spliced pose is quietly wrong.

### Kill criterion (binding — failure means stop, do not build §4)

On a real object, at the strict config (`x_percent=1.0`, `object_evidence_threshold=20.0`, `max_match_distance=0.002`) with the widened EVAL sweep:

| Gate | Pass condition |
|---|---|
| **Metric** | Dense-cloud lateral extent of a known box at 0.5 m within **±10 mm** of a tape measure, with the sweep sized from a **deliberately wrong** `SCAN_SIZE_MM` (e.g. 150 for a 100 mm object) so the circularity in §1 cannot hide the error. |
| **Re-ID** | A second pass over the same object returns `terminal_state=match` against the **correct** `graph_id`. |
| **Separation** | A second, different real object learns as a **separate** graph (`len(graph_memory) == 2`), and EVAL of each returns `no_match` against the other. |

Any one of the three fails → stop. Not "iterate on thresholds and ship anyway": the failure modes here are all silent, and the merged-graph case writes a chimera dimension into `ci.objects` with `terminal_state=match` reading as success.

---

## 3. The job, once the spike passes

| | |
|---|---|
| **Name** | `scan_object` on a new python-functions target `geometry` |
| **Queue** | `py-fn-geometry` |
| **Queue options** | `{ policy: 'short', expireInSeconds: 20 * 60, retryLimit: 0, retryDelay: 0 }` |
| **Event** | existing `PythonFunctionRunEvent`; dispatch via `PythonFunctionService.dispatch('geometry', 'scan_object', args, { singletonKey })` |
| **Trigger** | **operator-initiated only.** No `@Cron`, ever — a cron swings a physical arm with nobody in the room. |
| **Inputs** | `{ user_id, rig_id, object_id?, range_m, expected_diameter_mm, plan: {yaw_deg, pitch_deg, rows, cols}, dwell_ms }` |
| **Outputs** | (a) confidence-gated point cloud + per-frame poses → object store, referenced by `ci.content`; (b) one `ci.object_geometry_models` row; (c) on pass, `ci.objects.{length,width,height}_mm` + `identity_method='geometry'` + `identity_confidence <= 0.6`; (d) one `ci.object_observations` row with `resolution_method='geometry'` |

**Hardware-safety properties — these are the load-bearing part, not boilerplate:**

- **`retryLimit: 0`.** Deliberate. `expireInSeconds` exists to recover a dead sidecar, but a retry here re-drives a physical gimbal unattended. Expiry must fail the job, not duplicate the motion.
- **`singletonKey: \`geometry:scan:${userId}:${rigId}\`.`** `policy: 'short'` is what makes pg-boss actually enforce it, and it COALESCEs a missing key to `''` queue-wide — a keyless send is a loud error via the enqueue-side guard. One scan per rig, period.
- **Concurrency cap 1** in `ci.job_settings` for `py-fn-geometry`. There is one physical rig.
- **`recenter` in `finally`.** Every exit path — success, exception, sidecar-side deadline — POSTs `absoluteAngle {yaw:0,pitch:0}` and verifies `moved`. The pg-boss deadline **abandons, it does not kill** (see `job-execution-deadline`), so the sidecar owns its own hard wall-clock budget (default 10 min) and recenters before returning.
- **Preflight refusal.** Before the first move: `GET /api/status` must show `connected && paired`; `get_connected_devices()` must be 1; `get_device_type()` must be 1. Fail fast, with the operator instruction in the error — not a scan that runs against a dead rig and reports a zero-extent graph.
- **Deadline sizing.** 49 poses × (1.0 s move + 0.9 s dwell) ≈ 95 s actuation; 131 poses ≈ 4 min; plus inference. 20 min expiry is ~4× the worst legitimate run, deliberately generous because the failure it guards is a wedged sidecar, not a slow one.

**Transport decision: the sidecar talks HTTP to `http://localhost:8788` directly. Do not route the gimbal through `McpClientManagerService`.** Three reasons: calling `callTool()` from a backend service silently bypasses the `approved_tools` gate that governs the assistant path; the `worker` container has no `extra_hosts` in `docker-compose.production.yml` (only `api` does) so it cannot reach a host-run backend at all; and the sidecar has to own the recenter-in-`finally` anyway. `GIMBAL_BACKEND_URL` env, and the geometry container gets `extra_hosts: host.docker.internal:host-gateway`.

---

## 4. File checklist for CI-Server, by stage

### Stage 0 — spike only, no CI-Server files (do this now)

- `.../gimbal-spike/scan.py` — delete the false `NOTE:` at L137; report the dense-cloud extent as **the** measurement and demote the anchor-graph `min..max` to a diagnostic; widen the EVAL sweep.
- `.../gimbal-spike/driver.py` (L285–287) — strict defaults `max_match_distance=0.002`, `x_percent_threshold=1.0`, `object_evidence_threshold=20.0`; tighten `tolerances['principal_curvatures_log']` below the 0.182 log-curvature gap.
- `.../gimbal-spike/gimbal.py` — write the measured quaternion axis/handedness mapping in after step 9.

### Stage 1 — only after the kill criterion passes

- `yarn workspace @ci/be-api migrate:make allow_geometry_identity_method` → drops and re-adds **by name** `objects_identity_method_check` and `object_observations_resolution_method_check` with `'geometry'` added. Never hand-write the timestamp.
- `backend/apps/api/src/domains/memory/entities/ItemEntity.ts:24` — widen `ObjectIdentityMethod`.
- `backend/apps/api/src/domains/memory/entities/ObjectObservationEntity.ts:5` — widen `ObservationResolutionMethod`. (`ObjectObservationService` hard-refuses `'user'` from callers; geometry must use `'geometry'`.)
- `yarn workspace @ci/be-api migrate:make create_object_geometry_models` — new `ci.object_geometry_models`, `ci.gen_uuid_v7()` PK, `user_id … ON DELETE CASCADE`, extents `numeric(14,3)` in mm with the same `> 0 AND <= 10000000` bound rule, and a **recomputable** natural key `(user_id, object_id, sensor_kind, learner, learner_version)` as a partial unique index — not a bare uuid, or no re-key migration can ever exist.
- `backend/apps/api/src/domains/memory/entities/ObjectGeometryModelEntity.ts` — new.
- `gh workflow run migration-integrity-check.yml --ref <branch>` — nothing gates a merge in this repo; an absent check means nobody dispatched it.

### Stage 2 — sidecar and queue

- `backend/apps/geometry/src/ci/geometry/{api.py,functions.py,runner.py,scan.py,rig.py,gimbal.py,driver.py}` — ports of the spike. PEP 420 namespace: **no** `src/ci/__init__.py`. Container port 8004 (8002 is HBPE, 8003 is the summary parser).
- `backend/apps/api/src/domains/python-functions/types.ts` — add `'geometry'` to `PYTHON_FUNCTION_TARGETS`, `PYTHON_FUNCTION_QUEUES`, `PYTHON_FUNCTION_QUEUE_OPTIONS`, `PYTHON_FUNCTIONS`.
- `backend/apps/api/src/domains/python-functions/listeners/PythonFunctionDispatchListener.ts` — one `@OnEvent` method, `autoAcknowledge: false`.
- `backend/apps/api/src/domains/python-functions/__tests__/pythonFunctionQueuePolicy.test.ts` and `pythonFunctionRegistryDrift.test.ts` — both hardcode the two-target list and will fail until updated.
- `backend/apps/api/config/default.json` + `config/custom-environment-variables.json` — `services.geometry.host` / `GEOMETRY_HOST`.
- `scripts/dev-stack/index.ts` (~485, ~556) — port allocation and `GEOMETRY_HOST=http://localhost:<port>`.
- `docker-compose.yml`, `docker-compose.production.yml` (`extra_hosts`), `scripts/xtask/lib/images.ts` + `Makefile` `IMAGE=geometry`.
- root `pyproject.toml` + `uv.lock` via `uv lock` — see §5.4.
- `backend/apps/api/src/domains/events/taxonomy.ts` — `JOB_TYPES_BY_QUEUE['python.function.run::py-fn-geometry']`, category `JOB_CATEGORIES.enrich`. **Same PR as the queue.** Omit it and the job renders but is forced to `'unclassified'`: no chip counts it, no filter selects it.
- `docs/jobs-system.md` — the queue/listener map.

`PythonFunctionCallbackController` needs **no** change: `CALLBACK_QUEUES` is derived from `Object.values(PYTHON_FUNCTION_QUEUES)`.

### Stage 3 — trigger surface

GraphQL mutation or REST under `domains/memory`, behind the existing guards, that dispatches with the singleton key and returns the pg-boss job id. Queue-level on/pause/off is already controllable from `/jobs` the day the queue ships.

---

## 5. Unresolved — needs your decision

1. **Does the Osmo clamp clear the LiDAR emitter on the 13 Pro Max in portrait?** I cannot check this, and it is the one failure nothing downstream survives. Also: which Osmo model? `gimbal.py` assumes ±160° yaw / ±60° pitch, the planner silently clamps to them, and a wrong limit shows up as a squashed object rather than an error.
2. **Is there a USB-C data cable to hand, and is the ~$6 Record3D purchase approved?** No substitute exists that does not cost 3–5 weeks of ARKit plugin work in `frontend/apps/ios`.
3. **Dimensions from the dense depth cloud, with Monty demoted to identity + pose only?** This is my recommendation and it is what the evidence supports (99.18 mm vs 75.00 mm on a 100 mm sphere). It changes the pitch from "Monty measures things" to "LiDAR measures, Monty recognises." Confirm before I write it into the sidecar.
4. **Does `backend/apps/geometry` join the root uv workspace?** Repo convention says one `uv.lock` — but that pulls torch 2.14 and numpy 2.4.6 into the lock shared with HBPE and Summary, and monty's `torch-sparse`/`torch-scatter` deps are sdist-only and `import torch` at build time (nothing in monty actually imports them). Cleanest path is a workspace member plus `[tool.uv] override-dependencies` to drop those two — unverified, and the alternative is a standalone image with its own lock, which breaks the one-lock convention.
5. **Adopt the strict thresholds before or after the first hardware scan?** I did not change `driver.py` defaults, because the correct values also require widening the EVAL sweep and that is your call, not a verifier's. My instinct: adopt them now so the first real scan is tested against the config that can actually discriminate.
6. **Writeback autonomy.** Does a passing scan write `ci.objects.{length,width,height}_mm` directly, or stage a proposal for human confirm? Related: `identity_confidence` is `NOT NULL DEFAULT 1.0` and 1.0 reads as ground truth to HBPE/RAG — geometry must write well below it. Pick the number.
7. **Depth-axis handling.** It stays `NULL` for two independent reasons — the far side is invisible, and 5 mm of per-pixel depth noise inflated a 16.9 mm cap depth to 36.1 mm. Confirm `length_mm` (documented as the *longest* dimension) may be NULL while width and height are populated. `volume_ml` means capacity, not bounding volume — it stays out of this entirely.
8. **Calibration as its own 30-minute session (step 9), or folded into the first scan?** Folding it in means the first failure is ambiguous between six causes.
9. **Where the point cloud lands** — object store + `ci.content` (recommended; a learned model is megabytes and nothing queries inside it) or a `jsonb` blob. Nothing in the live schema can hold a float array today: no numeric/float ARRAY columns exist in `ci`/`ci_search`/`ci_derived`/`hbpe`, and PostGIS is `geography(Point,4326)` — earth frame, wrong frame.