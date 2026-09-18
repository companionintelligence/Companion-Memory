"""scan.py -- the entrypoint. Learn one object over a gimbal sweep, then re-identify it.

    RIG_BACKEND=synthetic GIMBAL_FAKE=1 .venv/bin/python scan.py

Two episodes over the same physical object:

    TRAIN  a serpentine sweep across the object's silhouette. Monty matches for a
           few steps, finds nothing (memory is empty), switches to exploration, and
           accumulates observations. `update_ltm()` commits them to a graph.
    EVAL   a SECOND, DIFFERENT sweep -- rotated 45 deg and coarser, so the poses are
           not the ones that were learned from. Monty matches against the graph.

The second pass is deliberately not a replay. Re-running the identical pose list
would show only that the pipeline is deterministic, which we already know.

WHAT THIS RIG CAN AND CANNOT MEASURE
------------------------------------
The gimbal rotates IN PLACE. The camera never translates, so it sees ONE SIDE of the
object and one side only, and the learned model is a front surface cap rather than a
closed object. Concretely:

    the two lateral extents  -- measurable, and this script checks them against ground
                                truth in synthetic mode
    the depth-axis extent    -- a LOWER BOUND. It is how far the visible cap recedes,
                                not how deep the object is. Reported as `>=`, never as
                                a dimension.

So a rotation-only rig can honestly fill two of `ci.objects`' three dimension columns
and must leave the third NULL. `NULL` there means unmeasured; writing a cap depth into
`length_mm` would be writing a number that is not the thing the column claims to hold.
Closing the third axis needs either a second viewpoint (move the tripod) or a shape
prior, and a prior is an estimate, not a measurement.
"""

from __future__ import annotations

import logging
import os
import sys

import numpy as np
from driver import MontyDriver, run_episode, serpentine_disc
from gimbal import GimbalClient, GimbalHead
from patch import patch_hfov_for_object
from rig import RigError, SyntheticObject, SyntheticRig, make_rig
from tbp.monty.frameworks.experiments.mode import ExperimentMode


def env_float(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


def env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


def rule(title: str) -> None:
    print(f"\n{'=' * 78}\n{title}\n{'=' * 78}")


def build_rig():
    """Make the rig named by RIG_BACKEND, configuring the synthetic one from env."""
    backend = os.environ.get("RIG_BACKEND", "synthetic").lower()
    if backend != "synthetic":
        return make_rig(backend), None

    kind = os.environ.get("SCAN_OBJECT", "sphere").lower()
    size_m = env_float("SCAN_SIZE_MM", 100.0) / 1000.0
    range_m = env_float("SCAN_RANGE_M", 0.5)
    noise_mm = env_float("SCAN_DEPTH_NOISE_MM", 0.0)
    obj = SyntheticObject(
        kind=kind, size_m=size_m, centre=np.array([0.0, 0.0, -range_m])
    )
    rig = SyntheticRig(obj=obj, noise_m=noise_mm / 1000.0)
    return rig, obj


def ground_truth_anchors(rig: SyntheticRig, plan) -> np.ndarray:
    """The world points the CENTRE ray hits at each planned pose.

    This is exactly what Monty should learn: one node per on-object anchor. Comparing
    against it tests the whole metric chain -- patch resample, frustum, unprojection,
    pose composition -- rather than just the bounding box, which a systematic scale
    error can survive if it is isotropic.
    """
    pts = [rig.anchor_point(y, p) for y, p in plan]
    return np.array([p for p in pts if p is not None])


def nn_distances_mm(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """For every point in `a`, distance to the nearest point in `b`, in mm."""
    if len(a) == 0 or len(b) == 0:
        return np.zeros(0)
    d = np.linalg.norm(a[:, None, :] - b[None, :, :], axis=-1)
    return d.min(axis=1) * 1000.0


def main() -> int:
    logging.basicConfig(level=logging.ERROR)

    backend = os.environ.get("RIG_BACKEND", "synthetic").lower()
    fake = os.environ.get("GIMBAL_FAKE", "0") not in ("", "0", "false", "no")

    rule("RIG")
    try:
        rig, _obj = build_rig()
        rig.connect()
    except RigError as exc:
        print(f"rig backend {backend!r} is unavailable:\n  {exc}")
        return 2

    client = GimbalClient(fake=fake)
    try:
        status = client.status()
    except Exception as exc:  # backend down in real mode: say so and stop
        print(f"gimbal backend unavailable:\n  {exc}")
        return 2

    print(f"  rig backend      : {backend}")
    print(
        f"  gimbal           : {'FAKE (offline)' if fake else 'REAL'}  "
        f"connected={status.get('connected')} paired={status.get('paired')}"
    )

    if isinstance(rig, SyntheticRig):
        size_m, range_m = rig.obj.size_m, rig.range_m
        half_angle = rig.silhouette_half_angle_deg
        print(
            f"  object           : {rig.obj.kind} {size_m * 1000:.1f} mm "
            f"at {range_m:.3f} m"
        )
        print(f"  silhouette       : +/-{half_angle:.2f} deg half-angle")
    else:
        # A real rig does not know how big the thing in front of it is, which is the
        # whole point of measuring. Take the operator's estimate for planning only --
        # it sizes the sweep and the patch, and never enters a reported dimension.
        size_m = env_float("SCAN_SIZE_MM", 100.0) / 1000.0
        range_m = env_float("SCAN_RANGE_M", 0.5)
        half_angle = float(np.degrees(np.arcsin(np.clip(size_m / 2 / range_m, -1, 1))))
        print(
            f"  planning estimate: ~{size_m * 1000:.0f} mm at {range_m:.2f} m "
            f"-> +/-{half_angle:.2f} deg sweep  (SCAN_SIZE_MM / SCAN_RANGE_M)"
        )
        print(
            "  NOTE: SCAN_SIZE_MM sizes the SWEEP. Because the reported extent is the\n        extent of what was actually swept, an under-guess under-reports the object.\n        In synthetic mode it therefore leaks into the number; on real LiDAR the depth\n        is measured, but COVERAGE still bounds the extent. See the caveat at the end."
        )

    patch_hfov = patch_hfov_for_object(size_m, range_m)
    # The voxel grid is centred on the FIRST observation, not the centroid, so it needs
    # roughly 2.25x the object diameter. Overshooting costs resolution; undershooting
    # drops the whole model with no error. Bias toward overshooting.
    max_graph_size = max(0.3, 2.5 * size_m)

    train_plan = serpentine_disc(
        half_angle,
        n_yaw=env_int("SCAN_N_YAW", 15),
        n_pitch=env_int("SCAN_N_PITCH", 13),
        coverage=env_float("SCAN_COVERAGE", 0.8),
    )
    # A genuinely different second pass: coarser, and phase-shifted so its poses do not
    # coincide with the learned ones.
    # EVAL coverage must be comparable to TRAIN's. The discrimination-tuned
    # thresholds in driver.py (max_match_distance=0.002) need enough OVERLAPPING
    # evidence to confirm a match; a much sparser/narrower eval sweep starves them
    # and a genuine repeat reads as no_match. The sweep is still DIFFERENT --
    # rotated and a different pose count -- which is the point of the test.
    eval_plan = serpentine_disc(
        half_angle,
        n_yaw=int(env_float("EVAL_N", 9)),
        n_pitch=int(env_float("EVAL_N", 9)),
        coverage=env_float("EVAL_COVERAGE", env_float("SCAN_COVERAGE", 0.8)),
    )
    eval_plan = [(y + 0.37, p - 0.21) for y, p in eval_plan]

    print(f"  patch            : 64x64 @ {patch_hfov:.2f} deg hfov")
    print(f"  max_graph_size   : {max_graph_size:.3f} m  (>= 2.25x object diameter)")
    print(
        f"  plan             : {len(train_plan)} TRAIN poses, {len(eval_plan)} EVAL poses"
    )

    head = GimbalHead()
    driver = MontyDriver(
        patch_hfov_deg=patch_hfov, max_graph_size=max_graph_size, head=head
    )

    dwell_ms = env_int("SCAN_DWELL_MS", 0 if fake else 900)

    # ---------------------------------------------------------------- TRAIN
    rule("TRAIN -- learn the object")
    tr = run_episode(
        driver,
        rig,
        client,
        train_plan,
        ExperimentMode.TRAIN,
        target_label=os.environ.get("SCAN_LABEL", "scan_target"),
        max_steps=len(train_plan) + 5,
        dwell_ms=dwell_ms,
        verbose=os.environ.get("SCAN_VERBOSE", "") not in ("", "0"),
    )
    print(f"  steps            : {tr.steps} (plan exhausted: {tr.plan_exhausted})")
    print(f"  anchor on-object : {tr.n_on_object} / {tr.n_on_object + tr.n_off_object}")
    print(f"  buffer           : {tr.n_observations} observations")
    print(f"  step_type        : {tr.step_type}   terminal_state: {tr.terminal_state}")
    print(
        f"  head truncations : {tr.n_truncated}   unsupported actions: {tr.n_unsupported}"
    )

    try:
        graph_ids = driver.learn()
    except Exception as exc:
        print(f"\nLEARNING FAILED:\n  {exc}")
        return 1
    print(f"  graph memory     : {graph_ids}")

    # ---------------------------------------------------------------- GEOMETRY
    rule("GEOMETRY -- what was measured, in MILLIMETRES")
    gid = graph_ids[0]
    pts_m = driver.graph_points_m(gid)
    extent = driver.learned_extent_mm(gid)  # min..max -- the measurement
    extent_p2 = driver.learned_extent_mm(
        gid, pct=2.0
    )  # p2..p98 -- a distribution probe
    print(f"  graph '{gid}': {len(pts_m)} nodes")
    print(
        f"  extent min..max  : x={extent[0]:7.2f}  y={extent[1]:7.2f}  "
        f"z={extent[2]:7.2f}  mm   <- the measurement"
    )
    print(
        f"  extent p2..p98   : x={extent_p2[0]:7.2f}  y={extent_p2[1]:7.2f}  "
        f"z={extent_p2[2]:7.2f}  mm"
    )
    print(
        "  NOT a robust estimator. A serpentine disc sweep puts most anchors near the"
    )
    print(
        "  middle, so trimming the tails cuts real geometry: on NOISE-FREE synthetic data"
    )
    print(
        "  p2..p98 under-reads the lateral extent by ~13 mm in 75 mm. It is printed only"
    )
    print("  as a readout of how the anchors are distributed, never as a dimension.")
    print(
        "  interpretation   : x,y are lateral extents of the VISIBLE CAP. Set by pose"
    )
    print(
        "                     geometry x range, so they survive depth noise -- 5 mm of"
    )
    print(
        "                     per-pixel noise moved them 0.84 mm in the synthetic sweep."
    )
    print("                     z is cap depth -- a LOWER BOUND on the object's third")
    print(
        "                     dimension, not a measurement of it. The gimbal cannot see"
    )
    print(
        "                     the far side. It is also the axis that absorbs ALL the depth"
    )
    print(
        "                     noise: that same 5 mm inflated a 16.9 mm cap to 36.1 mm."
    )
    print("                     Two reasons the same column stays NULL.")

    if isinstance(rig, SyntheticRig):
        from driver import extent_mm as _extent_mm

        gt = ground_truth_anchors(rig, train_plan)
        gt_extent = _extent_mm(gt)
        err = extent - gt_extent
        d = nn_distances_mm(pts_m, gt)
        print("\n  -- falsification against analytic ground truth (synthetic only) --")
        print(
            f"  true object          : {rig.obj.kind}, {rig.obj.size_m * 1000:.2f} mm, "
            f"at {rig.range_m:.3f} m"
        )
        print(
            f"  gt anchor extent     : x={gt_extent[0]:7.2f}  y={gt_extent[1]:7.2f}  "
            f"z={gt_extent[2]:7.2f}  mm   ({len(gt)} on-object poses)"
        )
        print(
            f"  extent error         : x={err[0]:+7.3f}  y={err[1]:+7.3f}  "
            f"z={err[2]:+7.3f}  mm"
        )
        print(
            f"  per-node error to gt : mean {d.mean():.3f} mm, "
            f"median {np.median(d):.3f} mm, max {d.max():.3f} mm"
        )

        # The verdict is on the two LATERAL axes, because those are the only two this
        # rig reports as dimensions. They are set by the pose geometry and the
        # unprojection, so an error there means the metric chain itself is broken.
        # The depth axis is judged separately and only advisorily: it is a cap depth
        # we already refuse to write, and it absorbs essentially all of the depth
        # noise, so holding it to a sub-millimetre tolerance would fail the build for
        # a number nobody consumes.
        lateral = float(np.abs(err[:2]).max())
        verdict = "PASS" if lateral < 1.0 else "FAIL"
        print(
            f"  METRIC CHAIN         : {verdict} (worst LATERAL extent error "
            f"{lateral:.3f} mm, tolerance 1.000 mm)"
        )
        print(
            f"  depth axis (advisory): {abs(err[2]):.3f} mm error on the cap depth. Not"
        )
        print("                         part of the verdict -- it is a bound, not a")
        print("                         dimension, and it carries the depth noise.")
        if verdict == "FAIL":
            print(
                "  The unprojection, the patch frustum or the pose composition is wrong."
            )
            print("  Do not trust any dimension from this build until it passes.")

        full = rig.visible_surface_extent_mm()
        print("\n  whole visible surface (dense raycast, wider than the sweep):")
        print(f"      x={full[0]:7.2f}  y={full[1]:7.2f}  z={full[2]:7.2f}  mm")
        print(
            "  The sweep is deliberately inside the silhouette (SCAN_COVERAGE), so the"
        )
        print(
            "  learned extent is smaller than this. Widening the sweep to the rim buys"
        )
        print("  extent at the cost of normals estimated on an edge-on surface.")

    # ---------------------------------------------------------------- EVAL
    rule("EVAL -- re-identify it from a different sweep")
    ev = run_episode(
        driver,
        rig,
        client,
        eval_plan,
        ExperimentMode.EVAL,
        target_label=os.environ.get("SCAN_LABEL", "scan_target"),
        max_steps=len(eval_plan) + 5,
        dwell_ms=dwell_ms,
        verbose=os.environ.get("SCAN_VERBOSE", "") not in ("", "0"),
    )
    print(f"  steps            : {ev.steps} (plan exhausted: {ev.plan_exhausted})")
    print(f"  terminal_state   : {ev.terminal_state}")
    print(f"  possible matches : {driver.lm.get_possible_matches()}")
    mlh = driver.mlh()
    print("  current_mlh      :")
    for k in ("graph_id", "mlh_id", "location", "rotation_deg", "scale", "evidence"):
        if k in mlh:
            print(f"      {k:<13}= {mlh[k]}")

    # EXACT comparison. `"match" in "no_match"` is True, so a substring test reports
    # every FAILED re-identification as a success -- including on real hardware.
    # Monty's terminal states are match / no_match / time_out; only the first counts,
    # and only with positive evidence behind it.
    _terminal = str(ev.terminal_state).strip().lower()
    _evidence = mlh.get("evidence")
    matched = _terminal == "match" and (_evidence is None or float(_evidence) > 0.0)
    print(f"\n  RE-IDENTIFIED    : {'YES' if matched else 'NO'}")
    if matched:
        print(
            "  Caveat: ONE object was learned, so a match is a match against a memory of"
        )
        print("  size one. This is not evidence of discrimination. Telling two similar")
        print(
            "  objects apart is where x_percent_threshold, object_evidence_threshold and"
        )
        print("  the curvature tolerances start to matter, and that is untested here.")

    # ---------------------------------------------------------------- WRITEBACK
    rule("WRITEBACK SHAPE -- what a CI-Server row would say (nothing is written)")
    sensor_kind = {
        "synthetic": "synthetic",
        "record3d": "lidar",
        "mono": "mono_depth",
    }.get(backend, backend)
    measured = backend == "record3d"
    print(f"  sensor_kind          : {sensor_kind}")
    print(f"  ci.objects.width_mm  : {extent[0]:.1f}")
    print(f"  ci.objects.height_mm : {extent[1]:.1f}")
    print(
        f"  ci.objects.length_mm : NULL   (cap depth >= {extent[2]:.1f} mm is a bound, "
        f"not a dimension)"
    )
    print("  identity_method      : 'geometry'  -- NOT in the CHECK constraint today;")
    print(
        "                         ci.objects allows only user|barcode|receipt|vision|"
    )
    print("                         import|inferred, so this needs a migration first.")
    print("  identity_confidence  : well below 1.0. The column's own COMMENT says 1.0")
    print("                         reads as ground truth to HBPE and RAG.")
    if not measured:
        print(
            f"  !! backend {backend!r} is NOT a metric measurement. On 'synthetic' these"
        )
        print("     numbers are a self-test of the arithmetic; on 'mono' they carry")
        print(
            "     0.32-0.66 m of depth error against a ~0.1 m object. Only 'record3d'"
        )
        print(
            "     (iPhone LiDAR) may ever be written to a field presented as measured."
        )

    rule("NEXT: what a human has to do to run this on real hardware")
    print(
        "  1. Record3D on a LiDAR iPhone (~$6 basic tier -- USB streaming is included;"
    )
    print(
        "     the WiFi/RGBD-export pack is NOT needed). Settings -> 'USB Streaming mode',"
    )
    print("     press record, USB-C to the Mac. Then:")
    print("       RIG_BACKEND=record3d .venv/bin/python scan.py")
    print("     (.venv has monty AND record3d AND transformers -- one venv, all three")
    print("      backends. No venv switching.)")
    print(
        "  2. In a REAL interactive Terminal (macOS will not show a headless process the"
    )
    print("     Bluetooth prompt):")
    print("       cd $OSMO_BLE_DIR && npm run backend")
    print(
        "     then scan -> connect -> pair with the PIN on the gimbal's screen. Nothing"
    )
    print("     is persisted, so this is required after EVERY backend restart.")
    print(
        "  3. THE TAPE-MEASURE TEST, before believing any number above. Put a ruler or a"
    )
    print(
        "     known box at 0.5 m, run one scan, compare the learned extent to the tape."
    )
    print(
        "     Agreement inside ~1 cm makes the metric claim real. Disagreement means the"
    )
    print(
        "     intrinsic rescale is wrong -- fix that before building anything on top."
    )
    print(
        "     The synthetic PASS above proves the arithmetic, which is necessary and not"
    )
    print("     sufficient: it cannot prove the sensor chain.")
    print(
        "  4. First real move: confirm `moved: true` on a SINGLE move_to before trusting"
    )
    print("     a multi-step scan. No physical sweep has been verified since the")
    print(
        "     2026-08-24 ignore-mask fix, and before it every command was accepted and"
    )
    print("     moved nothing.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
