# Spike: Monty sensorimotor object scanning (gimbal + iPhone RGBD)

> Research spike, NOT production code. Nothing here is imported by the app, nothing is
> in the Yarn or uv workspaces, and nothing writes to the database. It has its own
> throwaway venv and must never touch the repo's shared `uv.lock` — `tbp.monty` pulls
> `torch-sparse`/`torch-scatter`, which are sdist-only and `import torch` at build time,
> so adding it to the workspace breaks `make install`, `make lint`, `make build` and CI
> at once. Install with `--no-deps`; nothing in Monty's source imports either package.
>
> Write-up and staged plan: `docs/spikes/monty-sensorimotor-object-scanning.md`
> Why this option and not the other four: `docs/spikes/monty-integration-options.md`
>
> `$OSMO_BLE_DIR` below is wherever the `osmo-ble` gimbal backend repo is cloned.


Can a DJI Osmo gimbal plus an iPhone teach Monty the shape of a physical object, well
enough to write a real dimension into `ci.objects`?

This is the harness that answers it. It runs today with no hardware at all, and the
hardware path is written, import-clean, and fails with the exact step a human has to do.

```bash
# one-time: a venv OUTSIDE the repo, monty installed --no-deps
uv venv --python 3.11 /tmp/monty-spike-venv
/tmp/monty-spike-venv/bin/pip install --no-deps -e <path-to>/tbp.monty
/tmp/monty-spike-venv/bin/pip install numpy scipy scikit-learn scikit-image sympy \
  pandas pillow tqdm numpy-quaternion torch torch-geometric opencv-python-headless \
  hydra-core omegaconf pydantic typing_extensions eval_type_backport matplotlib wandb record3d

cd scripts/spikes/monty-gimbal
RIG_BACKEND=synthetic GIMBAL_FAKE=1 /tmp/monty-spike-venv/bin/python scan.py
```

That learns a 100 mm sphere over 131 gimbal poses, checks the measured extent against
analytic ground truth (PASS: worst lateral error 0.005 mm), then attempts to re-identify
it from a different sweep. At the default strict thresholds that attempt REPORTS NO --
deliberately, and the next section is why.

---

## THE HEADLINE RESULT: discrimination and re-identification trade off

The single most important thing this spike found, and it is reproducible in two commands:

```bash
RIG_BACKEND=synthetic GIMBAL_FAKE=1 python scan.py                    # strict (default)
RIG_BACKEND=synthetic GIMBAL_FAKE=1 MONTY_PERMISSIVE=1 python scan.py # monty's shipped values
```

| Thresholds | Re-identify same object, different sweep | Tell a cube from a sphere |
| --- | --- | --- |
| **Permissive** (monty ships these: `x_percent=20.0`, `object_evidence=1.0`, `max_match_distance=0.01`) | YES — `match`, evidence **+12.92** | **NO** — `len(graph_memory)==1`; a cube matches a memory holding only a sphere |
| **Strict** (this spike's default: `1.0` / `20.0` / `0.002`) | **NO** — `no_match`, evidence **-0.07** | YES — sphere/sphere120/cube separate into 3 graphs; two scans of the *same* sphere still merge to 1 |

**At synthetic-rig fidelity, Monty does not do both at once.** That is not a tuning nit — it is
the question the hardware test has to answer. Real LiDAR returns carry far richer curvature
signal than a ray-cast sphere, so the honest hypothesis is that the strict configuration
becomes viable on real data. If it does not, the geometry rung cannot both identify a thing
and avoid merging it with a lookalike, and that is a reason to stop.

Why this matters for a writeback: when two objects merge, the merged graph's extent belongs to
**neither** — a 100 mm + 120 mm sphere pair merged to `x=97.52 y=88.73 z=35.30 mm`. That
chimeric number is exactly what would land in `ci.objects.width_mm`.

Reproduce the separation test directly:

```bash
python probe_instances.py
# SUMMARY: A(sph100,sph120)=2  B(sph100,cube100)=2  C(sph100,sph100)=1
```

### A bug worth knowing about, now fixed

`scan.py` computed its verdict as `"match" in str(terminal_state)`. Python says
`"match" in "no_match"` is **True**, so every *failed* re-identification printed
`RE-IDENTIFIED: YES`. It now compares exactly and requires positive evidence. If you copy this
harness anywhere, copy the fixed check — on real hardware the silent version would have
reported success for a scan that recognised nothing.


---

## The one thing to understand first

**The gimbal rotates in place.** It pans and tilts; it never translates. Two
consequences shape every decision here:

1. **No parallax, so no structure-from-motion.** Every 3D point must come from a
   per-frame depth *measurement*. Without a depth sensor this approach is not
   degraded, it is blocked — Monty path-integrates over 3D locations and there are
   none to integrate.
2. **Only one side of the object is ever visible.** The learned model is a front
   surface cap, not a closed object. Two of three dimensions are measurable; the
   third is a lower bound, and `scan.py` reports it as `NULL` with a `>=`.

Monty is a good fit for the rest, because it is a *sensorimotor* model: it wants
(3D location, surface normal, curvature) plus proprioception, which is exactly what a
pan/tilt head carrying a depth camera produces.

---

## Files

| File | What it is |
|---|---|
| `rig.py` | Capture abstraction. Three backends behind one `Frame`. |
| `patch.py` | Carves Monty's square 64×64 patch out of a full frame. |
| `gimbal.py` | Osmo BLE backend client + Monty `Action` → (yaw, pitch). |
| `driver.py` | The Monty model, the motor system, the per-step loop. |
| `scan.py` | Entrypoint: TRAIN, measure, EVAL, report. |
| `monty_min*.py` | The API-survey scripts this was built from. Kept as reference. |

Each of `rig.py`, `patch.py`, `gimbal.py`, `driver.py` runs standalone as its own
self-test (`.venv/bin/python rig.py`, etc.).

---

## Backends

Selected by `RIG_BACKEND`.

### `synthetic` — works today, no hardware

Ray-casts a known sphere or cube through the real camera model, with the camera at a
fixed point and only its rotation changing — the rig's actual geometry, not a
convenient fiction. Ground truth is analytic, so `scan.py` can falsify itself.

```bash
RIG_BACKEND=synthetic GIMBAL_FAKE=1 .venv/bin/python scan.py
```

| Env var | Default | |
|---|---|---|
| `SCAN_OBJECT` | `sphere` | `sphere` or `cube` |
| `SCAN_SIZE_MM` | `100` | sphere diameter / cube edge |
| `SCAN_RANGE_M` | `0.5` | camera-to-object distance |
| `SCAN_DEPTH_NOISE_MM` | `0` | per-pixel Gaussian depth noise |
| `SCAN_N_YAW` / `SCAN_N_PITCH` | `15` / `13` | sweep density |
| `SCAN_COVERAGE` | `0.8` | fraction of the silhouette to sweep |
| `SCAN_VERBOSE` | off | per-step trace |

### `record3d` — the recommended real path

iPhone Pro LiDAR over USB, via the Record3D app: ARKit RGB + `sceneDepth` (float32
**metres**, 256×192) + intrinsics + 6-DoF pose, all from one call site.

```bash
RIG_BACKEND=record3d .venv/bin/python scan.py
```

Three human steps, none of which an agent session can do:

1. **Buy and install Record3D** on a LiDAR iPhone. ~$6 basic tier — USB streaming is
   included; the WiFi / RGBD-export extension pack is **not** needed.
2. In the app: **Settings → enable "USB Streaming mode"**, then press record. Plug in
   by USB-C. `Record3DStream.get_connected_devices()` returns 0 until all of that is
   done; the backend says so by name if it is not.
3. Start the gimbal backend (below).

Chosen over monocular depth for one reason: at the 0.3–1 m working range iPhone LiDAR
is ~5 mm / ±1 cm, while monocular metric depth carries 0.32–0.66 m mean error — the
error is several times the size of the object. Only LiDAR can support "a measured
dimension, not a guessed one".

Two things are **unverified on hardware** and must be checked on the first real run —
both are called out in `Record3DRig`'s docstring:

- **Depth-map orientation.** ARKit streams in the native landscape sensor orientation.
  A phone cradled in portrait may map rows/columns to camera X/Y differently than
  assumed. Symptom: the reconstructed cloud is transposed or mirrored.
- **Pose handedness.** ARKit camera space should be +X right, +Y up, −Z forward, which
  matches Monty. Confirm by commanding a known +45° yaw and checking the ARKit pose
  agrees with the gimbal.

### `mono` — fallback, **estimated, never measured**

`ffmpeg`/avfoundation RGB + Depth-Anything-V2-Metric-Indoor. The model loads and runs
in this venv (verified). The camera does not: macOS camera permission for this process
is `notDetermined` and **cannot be self-granted from a headless shell** —
`AVCaptureDevice.requestAccess` returns `granted=false` and leaves the status at 0, so
`ffmpeg` hangs forever at session start. This affects the built-in FaceTime camera too;
it is a process-level TCC gate, not a device problem.

A human must run one capture from a **real interactive Terminal** and approve the
prompt (note the explicit `-framerate 30` — the device rejects ffmpeg's 29.97 default):

```bash
ffmpeg -f avfoundation -framerate 30 -video_size 1920x1440 -i "2" -frames:v 1 -y frames/test.jpg
```

This does **not** block `record3d`, which streams from the phone over USB and never
touches the Mac's camera TCC.

---

## The gimbal

`gimbal.py` talks to `server/backend.mjs` on `:8788` over plain HTTP — the same route
the `gimbal_move_to` MCP tool uses, so Python and an agent drive the hardware
identically. The MCP server holds no BLE of its own.

**Offline** (default for the synthetic run):

```bash
GIMBAL_FAKE=1 .venv/bin/python gimbal.py
```

**Real**, in a **real interactive Terminal** — macOS will not show the Bluetooth
permission prompt to a windowless process, and a headless launch hangs on the first
BLE call instead of prompting:

```bash
cd $OSMO_BLE_DIR && npm run backend
```

then, once per backend process — **nothing is persisted, so this is required after
every restart**:

```bash
curl -s -XPOST localhost:8788/api/scan    -H 'content-type: application/json' -d '{"timeoutMs":5000}'
curl -s -XPOST localhost:8788/api/connect -H 'content-type: application/json' -d '{"deviceId":"<id from scan>"}'
curl -s -XPOST localhost:8788/api/pair    -H 'content-type: application/json' -d '{"pin":"<PIN on the gimbal screen>"}'
```

### Pose of record is ARKit's, not the gimbal's

The gimbal's BLE quaternion is used **only** as a did-it-move / has-it-settled signal
and a coarse cross-check. It is not used to register depth. Four reasons:

1. The camera is the phone, and the rigid transform from gimbal head to phone camera
   depends on clamp position and orientation and **has never been measured**.
2. The quaternion's component order and reference frame are **assumed, not measured** —
   `osmo-ble`'s own `web/orientation.mjs` says so in its comments and labels its Euler
   readout "approx".
3. The gimbal actively stabilises: in follow/lock mode its attitude is not a simple
   function of the commanded setpoint.
4. Depth and pose must share a clock and a frame, and ARKit depth already ships
   co-registered with ARKit pose.

Two calibrations, one session each, would retire reasons 1 and 2: command yaw=+45/
pitch=0 then yaw=0/pitch=+30 and read the telemetry to name the quaternion's axes;
and measure the head→camera extrinsic.

---

## What the harness actually does

```
rig.capture(yaw, pitch)     a real depth frame
  → extract_patch()         Monty's square patch, resampled onto its own frustum
  → DepthTo3DLocations      metric 3D per pixel, world frame
  → CameraSM                surface normal + curvature AT THE ANCHOR PIXEL
  → EvidenceGraphLM         evidence over hypotheses; builds the graph
  → list[Action]            TurnLeft / TurnRight / LookUp / LookDown
  → step_gimbal()           folded into ONE absolute move of the head
  → back to rig.capture()
```

**The learned graph is one node per accepted observation, at the patch's anchor
pixel** — not a fusion of the patch point clouds. The other 4095 pixels only estimate
the normal and curvature at that one point. So the **motor plan** decides what geometry
gets measured; patch size and depth resolution do not. A sweep that never points at the
top of the object learns an object with no top, and says nothing about it.

The motor system emits real Monty `Action`s rather than moving the head directly, so
the sign conventions, the ±160°/±60° envelope clamp and the truncation reporting are
exercised on every step. It also computes each delta from where the head **actually**
is after clamping, not from where the plan says it should be — integrating the
requested delta instead of the achieved one silently desyncs Monty's pose from reality
the moment the head hits a stop.

---

## Gotchas that cost real time

Five things in the Monty construction are load-bearing and each fails in a way that
does not look like its cause. All are commented at the point of use in `driver.py`.

1. **`monty._match_criterion` is not a constructor argument.** `MontyExperiment`
   injects it after construction. Omit it → `AttributeError` on the first matching step.
2. **`tolerances` must be non-empty and keyed by the sensor module id.** The key is the
   input channel name == `Message.sender_id` == `sensor_module_id`. `tolerances={}`
   raises `KeyError: 'patch'` at `graph_matching.py:1055` — nowhere near where you would
   look. Keying it `"patch_0"` while the SM is `"patch"` raises the identical error.
   `feature_weights={}` **is** safe.
3. **`max_graph_size` silently discards an oversized object.** `GridTooSmallError` is
   caught and only logged at INFO, so you get "building graph for patch" followed by an
   empty memory and no exception. The voxel grid is centred on the **first observation**,
   not the centroid, so it needs ~2.25× the object diameter. `driver.learn()` asserts the
   graph is non-empty for exactly this reason.
4. **`update_ltm()` must be called explicitly.** Only `MontyExperiment.post_episode`
   calls it, and this harness does not use `MontyExperiment`.
5. **`fixme_set_ground_truth()` must be called per episode** or `stepwise_target_object`
   is never initialised.

Two more from this rig:

- **A naive crop is not a valid Monty patch.** Monty's camera model is a *symmetric*
  frustum about the optical axis. A crop taken away from the principal point has skewed
  rays, so every point lands in the wrong place with nothing raised. `patch.py` resamples
  onto the patch's own symmetric frustum and hands Monty the relating rotation in
  `SensorState.rotation`. Verified: an off-axis anchor at +3° and the gimbal physically
  rotated to −3° agree to **0.009 mm**.
- **Never interpolate depth across a silhouette.** Blending 0.45 m of object with 1.0 m
  of background invents a surface at 0.7 m that nothing occupies. `patch.py` interpolates
  only where all four source neighbours are valid.

---

## Measured results (synthetic)

Verdict is on the two **lateral** axes, because those are the only two this rig reports
as dimensions.

| Object | Noise | Lateral extent error | Depth-axis error | Verdict |
|---|---|---|---|---|
| 100 mm sphere @ 0.5 m | 0 | +0.005 mm | +0.26 mm | PASS |
| 40 mm sphere @ 0.5 m | 0 | +0.002 mm | −0.06 mm | PASS |
| 400 mm sphere @ 0.6 m | 0 | +0.017 mm | +0.64 mm | PASS |
| 100 mm cube @ 0.5 m | 0 | +0.000 mm | +0.000 mm | PASS |
| 100 mm sphere @ 0.5 m | 2 mm | +0.34 mm | **+6.8 mm** | PASS |
| 100 mm sphere @ 0.5 m | 5 mm | +0.84 mm | **+19.2 mm** | PASS |

Two results worth keeping:

- **The lateral extents survive depth noise; the depth axis does not.** Lateral extents
  are set by pose geometry × range, so 5 mm of per-pixel noise moved them 0.84 mm. The
  depth extent *is* a min-to-max over the noisy axis, so the same noise inflated a
  16.9 mm cap depth to 36.1 mm. That axis was already going to be written `NULL` because
  the far side is invisible; this is a second, independent reason.
- **A percentile "robust extent" is a trap, and this harness prints it only to say so.**
  A serpentine disc sweep concentrates anchors in the middle, so p2..p98 cuts real
  geometry: on **noise-free** data it under-reads a 75 mm extent by 13 mm. It trades a
  noise bias for a larger sampling-geometry bias. `min..max` is the reported number.

The cube's depth-axis extent is exactly **0.00 mm** — correct, not a bug. A cube facing
the camera presents a flat front face perpendicular to the optical axis, so every anchor
lies in one plane.

---

## Writeback shape (nothing is written)

`scan.py` prints the row it *would* write. Three blockers stand between it and a real
insert:

- **`identity_method = 'geometry'` is not an allowed value.** `ci.objects`'
  `objects_identity_method_check` permits only `user|barcode|receipt|vision|import|
  inferred`; `ci.object_observations`' `resolution_method` check needs the matching
  widening. Both require a DROP/ADD by name in one migration, plus the two TypeScript
  unions (`ItemEntity.ts:24`, `ObjectObservationEntity.ts:5`) widened in lockstep.
- **`identity_confidence` must be well below 1.0.** The column's own COMMENT says 1.0
  reads as ground truth to HBPE and RAG.
- **There is nowhere to put the learned model.** No table in the live schema can hold a
  point array — the only float columns anywhere are `vector(768)` embeddings.

Units are **metres everywhere internally**, converted to millimetres only at the
print/write boundary — matching `ci.objects`' `NUMERIC(14,3)` millimetre columns.

---

## The venv

One venv, `.venv` (Python 3.11), runs all three backends: `tbp.monty` + `record3d` +
`torch`/`transformers`. `.venv-depth` is the API survey's separate depth venv and is now
redundant.

**`tbp.monty` must be installed with `--no-deps`.** `torch-sparse` and `torch-scatter`
are unconditional dependencies for python>=3.9, are sdist-only, and their `setup.py` does
`import torch` at build time, which fails under build isolation. Nothing in monty's `src/`
or `tests/` imports either (0 grep hits), so `--no-deps` plus hand-installed real deps is
clean.

```bash
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python --no-deps -e <path-to>/monty
uv pip install --python .venv/bin/python numpy scipy scikit-learn scikit-image sympy \
    pandas pillow tqdm numpy-quaternion torch torchvision torch-geometric \
    opencv-python-headless hydra-core omegaconf pydantic typing_extensions \
    eval_type_backport matplotlib wandb importlib_resources \
    record3d 'transformers>=4.48' accelerate
export WANDB_MODE=disabled
```

**Keep this venv separate forever.** It pulls numpy 2.4.6 / torch 2.14 and must never
touch CI-Server's `uv.lock`. This spike imports nothing from CI-Server.

---

## What is still unproven

- **Nothing has touched real hardware.** Every number above is synthetic. The Monty side
  is proven; the sensor chain is not.
- **The tape-measure test is mandatory before any "measured" claim.** Put a ruler or a
  known box at 0.5 m, run one scan, compare to the tape. Inside ~1 cm and the metric
  claim is real. The synthetic PASS proves the arithmetic, which is necessary and not
  sufficient.
- **Discrimination is untested.** Exactly one object has been learned and re-identified,
  so a "match" is a match against a memory of size one. Telling two similar objects apart
  is where `x_percent_threshold`, `object_evidence_threshold` and the curvature tolerances
  start to matter.
- **No physical gimbal sweep has been verified** since the 2026-08-24 ignore-mask fix in
  `buildGimbalAbsoluteAngle`. Before it, every command was well-formed, accepted by the
  device, and moved nothing. Confirm `moved: true` on a single `move_to` before trusting a
  multi-step scan.
- **ARKit's ~0.26 m minimum range** sits only 4 cm below the stated 0.3 m near end. Bias
  the scan distance to 0.5–0.8 m.
- **Monty finds no surface beyond 1.0 m.** `get_surface_from_depth` clamps depth to 1.0
  and returns an all-False mask when every pixel reaches it. `rig.assert_working_range()`
  makes that loud rather than silent.
