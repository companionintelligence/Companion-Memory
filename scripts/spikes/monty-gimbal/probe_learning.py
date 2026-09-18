"""Adversarial probe: is the learning real or vacuous?"""

# ruff: noqa: E402 -- logging.basicConfig must run BEFORE tbp.monty is imported, or
# monty's import-time logging floods stdout. The imports below are deliberately late.

import logging

import numpy as np

logging.basicConfig(level=logging.ERROR)

import enum

from driver import MontyDriver, run_episode, serpentine_disc
from gimbal import GimbalClient, GimbalHead
from patch import patch_hfov_for_object
from rig import SyntheticObject, SyntheticRig
from tbp.monty.frameworks.experiments.mode import ExperimentMode

print("=== 1. ExperimentMode type ===")
print("  type(ExperimentMode.TRAIN) :", type(ExperimentMode.TRAIN))
print("  is Enum member             :", isinstance(ExperimentMode.TRAIN, enum.Enum))
print("  is a str                   :", isinstance(ExperimentMode.TRAIN, str))
print("  TRAIN == 'train'           :", ExperimentMode.TRAIN == "train")
print("  members                    :", list(ExperimentMode))

obj = SyntheticObject(kind="sphere", size_m=0.100, centre=np.array([0.0, 0.0, -0.5]))
rig = SyntheticRig(obj=obj)
rig.connect()
hfov = patch_hfov_for_object(0.100, 0.5)
plan = serpentine_disc(
    rig.silhouette_half_angle_deg, n_yaw=15, n_pitch=13, coverage=0.8
)

print("\n=== 2. NEGATIVE CONTROL: same episode, update_ltm() NOT called ===")
head = GimbalHead()
d = MontyDriver(patch_hfov_deg=hfov, max_graph_size=0.3, head=head)
r = run_episode(
    d,
    rig,
    GimbalClient(fake=True),
    plan,
    ExperimentMode.TRAIN,
    "t",
    max_steps=len(plan) + 5,
    dwell_ms=0,
)
print("  steps:", r.steps, " buffer obs:", r.n_observations)
print("  graph memory BEFORE update_ltm :", list(d.lm.get_all_known_object_ids()))
print("  current_mlh BEFORE             :", d.lm.current_mlh)
d.monty.update_ltm()
ids = list(d.lm.get_all_known_object_ids())
print("  graph memory AFTER  update_ltm :", ids)

print("\n=== 3. Is the graph a REAL object model? ===")
gm = d.lm.graph_memory
model = gm.get_graph(ids[0], "patch")
print("  type(model)      :", type(model).__module__ + "." + type(model).__name__)
print("  model.pos.shape  :", np.asarray(model.pos).shape)
print("  model.pos dtype  :", np.asarray(model.pos).dtype)
print("  has norm feature :", hasattr(model, "norm"))
try:
    print("  feature names    :", list(model.feature_mapping.get("patch", {}).keys()))
except Exception as e:
    print("  feature_mapping  :", e)
pts = np.asarray(model.pos, float)
print("  first 3 nodes (m):", np.round(pts[:3], 5).tolist())
print("  node count       :", len(pts))
print("  unique nodes     :", len(np.unique(np.round(pts, 9), axis=0)))
print("  pos std (mm)     :", np.round(pts.std(axis=0) * 1000, 3).tolist())

print("\n=== 4. Independent extent arithmetic (first principles, no spike code) ===")
R, D = 0.050, 0.500
half = np.degrees(np.arcsin(R / D))
lim = half * 0.8
th = np.radians(lim)
t = D * np.cos(th) - np.sqrt(R**2 - (D * np.sin(th)) ** 2)
x = t * np.sin(th)
print(f"  silhouette half-angle  : {half:.4f} deg   (spike says 5.74)")
print(f"  swept limit (cov 0.8)  : {lim:.4f} deg")
print(f"  hand-derived extent    : {2 * x * 1000:.3f} mm   <- ray-sphere, done by hand")
print(f"  spike reported extent  : {d.learned_extent_mm(ids[0])[0]:.3f} mm")
print(f"  TRUE OBJECT DIAMETER   : {2 * R * 1000:.1f} mm")
print(
    f"  reported / true        : {d.learned_extent_mm(ids[0])[0] / (2 * R * 1000):.4f}"
)
