"""Fair test: fresh driver per EVAL, generous step budget, finer eval sweep."""

# ruff: noqa: E402 -- logging.basicConfig must run BEFORE tbp.monty is imported, or
# monty's import-time logging floods stdout. The imports below are deliberately late.

import logging

import numpy as np

logging.basicConfig(level=logging.ERROR)
from driver import MontyDriver, run_episode, serpentine_disc
from gimbal import GimbalClient, GimbalHead
from patch import patch_hfov_for_object
from rig import SyntheticObject, SyntheticRig
from tbp.monty.frameworks.experiments.mode import ExperimentMode


def make(k, mm):
    o = SyntheticObject(kind=k, size_m=mm / 1000.0, centre=np.array([0.0, 0.0, -0.5]))
    r = SyntheticRig(obj=o)
    r.connect()
    return r


hfov = patch_hfov_for_object(0.100, 0.5)
cl = GimbalClient(fake=True)
for tag, (XP, OET, MMD) in [
    ("DEFAULT", (20.0, 1.0, 0.01)),
    ("TUNED", (5.0, 5.0, 0.01)),
    ("STRICT", (1.0, 20.0, 0.002)),
]:
    for nyaw, npit, cov, lbl in [
        (7, 7, 0.55, "coarse eval (as shipped)"),
        (15, 13, 0.8, "dense eval (same as train)"),
    ]:
        d = MontyDriver(
            patch_hfov_deg=hfov,
            max_graph_size=0.3,
            head=GimbalHead(),
            x_percent_threshold=XP,
            object_evidence_threshold=OET,
            max_match_distance=MMD,
        )
        sp = make("sphere", 100.0)
        run_episode(
            d,
            sp,
            cl,
            serpentine_disc(sp.silhouette_half_angle_deg, 15, 13, 0.8),
            ExperimentMode.TRAIN,
            "s",
            max_steps=200,
            dwell_ms=0,
        )
        d.monty.update_ltm()
        p = serpentine_disc(sp.silhouette_half_angle_deg, nyaw, npit, cov)
        p = [(y + 0.37, q - 0.21) for y, q in p]
        r = run_episode(
            d, sp, cl, p, ExperimentMode.EVAL, "s", max_steps=len(p) + 50, dwell_ms=0
        )
        ev = (d.lm.current_mlh or {}).get("evidence")
        print(
            f"  {tag:8s} {lbl:26s} steps={r.steps:3d} terminal={r.terminal_state!s:9s} "
            f"matches={d.lm.get_possible_matches()} ev={ev}"
        )
