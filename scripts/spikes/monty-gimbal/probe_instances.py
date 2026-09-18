"""ADVERSARIAL: two similar-but-distinct objects. Does graph_memory reach 2, or merge to 1?"""

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


def make(kind, size_mm, rng_m=0.5):
    o = SyntheticObject(
        kind=kind, size_m=size_mm / 1000.0, centre=np.array([0.0, 0.0, -rng_m])
    )
    r = SyntheticRig(obj=o)
    r.connect()
    return r


def trial(name, specs, coverage=0.8):
    print(f"\n{'=' * 72}\n{name}\n{'=' * 72}")
    hfov = patch_hfov_for_object(0.100, 0.5)
    head = GimbalHead()
    d = MontyDriver(patch_hfov_deg=hfov, max_graph_size=0.3, head=head)
    client = GimbalClient(fake=True)
    for i, (kind, size_mm) in enumerate(specs):
        rig = make(kind, size_mm)
        plan = serpentine_disc(
            rig.silhouette_half_angle_deg, n_yaw=15, n_pitch=13, coverage=coverage
        )
        r = run_episode(
            d,
            rig,
            client,
            plan,
            ExperimentMode.TRAIN,
            f"obj_{kind}_{size_mm}",
            max_steps=len(plan) + 5,
            dwell_ms=0,
        )
        before = list(d.lm.get_all_known_object_ids())
        d.monty.update_ltm()
        after = list(d.lm.get_all_known_object_ids())
        mlh = d.lm.current_mlh or {}
        print(
            f"  ep{i} {kind} {size_mm}mm: steps={r.steps} "
            f"terminal={r.terminal_state} detected={r.detected_object}"
        )
        print(
            f"       memory {before} -> {after}   "
            f"mlh.graph_id={mlh.get('graph_id')} ev={mlh.get('evidence')}"
        )
    ids = list(d.lm.get_all_known_object_ids())
    print(f"  ** len(graph_memory) = {len(ids)}  ids={ids}")
    for gid in ids:
        p = np.asarray(d.lm.graph_memory.get_graph(gid, "patch").pos, float)
        e = (p.max(0) - p.min(0)) * 1000
        print(
            f"       {gid}: {len(p)} nodes  extent x={e[0]:.2f} y={e[1]:.2f} z={e[2]:.2f} mm"
        )
    return len(ids)


n1 = trial(
    "TRIAL A: sphere 100mm, then sphere 120mm (similar but distinct)",
    [("sphere", 100.0), ("sphere", 120.0)],
)
n2 = trial(
    "TRIAL B: sphere 100mm, then CUBE 100mm (grossly distinct)",
    [("sphere", 100.0), ("cube", 100.0)],
)
n3 = trial(
    "TRIAL C: sphere 100mm, then the IDENTICAL sphere 100mm (should merge -> 1)",
    [("sphere", 100.0), ("sphere", 100.0)],
)
print(
    f"\nSUMMARY: A(sph100,sph120)={n1}  B(sph100,cube100)={n2}  C(sph100,sph100)={n3}"
)
