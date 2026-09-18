"""Minimal Monty: no simulator, no MontyExperiment, no habitat.

Synthesizes RGBD "patch" observations of a 10 cm sphere by ray-casting, pushes
them through the REAL DepthTo3DLocations -> CameraSM -> EvidenceGraphLM stack,
learns the object in TRAIN mode, then recognizes it in EVAL mode.
"""

from __future__ import annotations

import logging
import os

import numpy as np
import quaternion as qt
from tbp.monty.cmp import Goal, Message
from tbp.monty.context import RuntimeContext
from tbp.monty.experiment.match_criteria import AnyLMsMatch
from tbp.monty.frameworks.actions.actions import Action
from tbp.monty.frameworks.environment_utils.transforms import DepthTo3DLocations
from tbp.monty.frameworks.experiments.mode import ExperimentMode
from tbp.monty.frameworks.models.evidence_matching.learning_module import (
    EvidenceGraphLM,
)
from tbp.monty.frameworks.models.evidence_matching.model import (
    MontyForEvidenceGraphMatching,
)
from tbp.monty.frameworks.models.motor_system_state import (
    AgentState,
    ProprioceptiveState,
    SensorState,
)
from tbp.monty.frameworks.models.sensor_modules import CameraSM

logging.basicConfig(level=logging.WARNING)

AGENT_ID = "agent_id_0"
SM_ID = "patch"  # MUST equal the tolerances / feature_weights channel key
RES = 64  # ObservationProcessor: obs_dim = int(sqrt(N)) -> square only
HFOV = 11.0  # degrees, matches monty's stock res64hfov11 patch
# Sphere diameter in MILLIMETRES, overridable so the units claim can be re-checked
# at any scale: `SPHERE_MM=40 python monty_min.py`, `SPHERE_MM=400 ...`. Monty stores
# locations in METRES; a run prints the learned extent in mm and it should match
# SPHERE_MM. Verified at 40 / 100 / 400 mm.
#
# NOTE at 400mm: max_graph_size must also be raised. The voxel grid centres on the
# FIRST OBSERVATION, not the centroid, so it needs ~2.25x the object diameter --
# 0.6 still silently produced an empty graph, 0.9 worked. GridTooSmallError is
# caught and only logged, so an undersized grid yields NO model and NO exception.
SPHERE_MM = float(os.environ.get("SPHERE_MM", "100"))
SPHERE_R = SPHERE_MM / 2000.0  # mm diameter -> metre radius
CAM_DIST = SPHERE_R * 3.0  # camera stands off at 3x the radius
BACKGROUND_DEPTH = 1.0  # MissingToMaxDepth convention: >=1.0 reads as off-object


# --------------------------------------------------------------------------
# 1. The smallest motor system that MontyBase will accept.
# --------------------------------------------------------------------------
class StubMotorSystem:
    """Satisfies every motor-system call MontyBase makes.

    MontyBase touches exactly four things:
      * motor_system(ctx, observations, proprioceptive_state, percept, goals)
      * motor_system.reset()
      * motor_system.motor_only_step   (property, read in `is_motor_only_step`)
      * motor_system.state_dict()      (only from MontyBase.state_dict())
    We drive the camera externally, so __call__ returns no actions.
    """

    def __init__(self) -> None:
        self._motor_only_step = False

    def __call__(
        self,
        ctx: RuntimeContext,
        observations: dict,
        proprioceptive_state: ProprioceptiveState,
        percept: Message,
        goals: list[Goal],
    ) -> list[Action]:
        return []

    def reset(self) -> None:
        self._motor_only_step = False

    @property
    def motor_only_step(self) -> bool:
        return self._motor_only_step

    @motor_only_step.setter
    def motor_only_step(self, value: bool) -> None:
        self._motor_only_step = value

    def state_dict(self) -> dict:
        return {}


# --------------------------------------------------------------------------
# 2. Synthetic RGBD renderer: ray-cast a sphere through Monty's own camera model.
# --------------------------------------------------------------------------
def look_at_quaternion(cam_pos: np.ndarray, target: np.ndarray) -> qt.quaternion:
    """Camera-to-world rotation with the camera's -z axis pointing at `target`."""
    fwd = target - cam_pos
    fwd = fwd / np.linalg.norm(fwd)
    z_axis = -fwd  # camera looks down -z
    up = np.array([0.0, 1.0, 0.0])
    if abs(np.dot(up, z_axis)) > 0.99:
        up = np.array([0.0, 0.0, 1.0])
    x_axis = np.cross(up, z_axis)
    x_axis /= np.linalg.norm(x_axis)
    y_axis = np.cross(z_axis, x_axis)
    rot = np.stack([x_axis, y_axis, z_axis], axis=1)
    return qt.from_rotation_matrix(rot)


def render_sphere_depth(cam_pos, cam_quat, centre=None, radius=SPHERE_R):
    """Render a depth patch of a sphere using DepthTo3DLocations' exact camera model.

    DepthTo3DLocations unprojects pixel (x_ndc, y_ndc) at depth d to the
    camera-frame point d * (fx * x_ndc, fy * y_ndc, -1).  So `depth` is the
    ray parameter for that direction, NOT the euclidean range.  We invert
    exactly that, which is what makes the metre-scale round trip exact.
    """
    if centre is None:
        centre = np.zeros(3)
    hfov_rad = HFOV * np.pi / 180.0
    fx = np.tan(hfov_rad / 2.0)  # zoom = 1
    fy = fx  # square patch -> h/w == 1
    x, y = np.meshgrid(np.linspace(-1, 1, RES), np.linspace(1, -1, RES))
    dirs_cam = np.stack([fx * x, fy * y, -np.ones_like(x)], axis=-1)
    rot = qt.as_rotation_matrix(cam_quat)
    dirs_world = dirs_cam @ rot.T  # (H, W, 3)

    oc = cam_pos - centre
    a = np.einsum("ijk,ijk->ij", dirs_world, dirs_world)
    b = 2.0 * np.einsum("ijk,k->ij", dirs_world, oc)
    c = float(np.dot(oc, oc) - radius**2)
    disc = b * b - 4 * a * c
    depth = np.full((RES, RES), BACKGROUND_DEPTH, dtype=np.float64)
    hit = disc > 0
    d = (-b[hit] - np.sqrt(disc[hit])) / (2 * a[hit])
    d = np.where(d > 0, d, BACKGROUND_DEPTH)
    depth[hit] = np.minimum(d, BACKGROUND_DEPTH)
    return depth


def make_observation(cam_pos, cam_quat, transform):
    """Build the {agent: {sensor: obs}} dict Monty expects, post-transform."""
    depth = render_sphere_depth(cam_pos, cam_quat)
    rgba = np.zeros((RES, RES, 4), dtype=np.uint8)
    rgba[..., 3] = 255
    observations = {AGENT_ID: {SM_ID: {"depth": depth, "rgba": rgba}}}
    proprioceptive_state = ProprioceptiveState(
        {
            AGENT_ID: AgentState(
                sensors={
                    SM_ID: SensorState(
                        position=np.zeros(3), rotation=qt.quaternion(1, 0, 0, 0)
                    )
                },
                position=np.asarray(cam_pos, dtype=np.float64),
                rotation=cam_quat,
            )
        }
    )
    observations = transform.call(observations, state=proprioceptive_state)
    return observations, proprioceptive_state


def camera_poses(n_theta=13, n_phi=24):
    """A serpentine sweep of camera poses around the sphere (the gimbal analogue)."""
    poses = []
    for i, theta in enumerate(np.linspace(-1.4, 1.4, n_theta)):  # elevation, rad
        phis = np.linspace(-np.pi, np.pi, n_phi, endpoint=False)
        if i % 2:
            phis = phis[::-1]
        for phi in phis:  # azimuth, rad
            direction = np.array(
                [
                    np.cos(theta) * np.sin(phi),
                    np.sin(theta),
                    np.cos(theta) * np.cos(phi),
                ]
            )
            cam_pos = direction * CAM_DIST
            poses.append((cam_pos, look_at_quaternion(cam_pos, np.zeros(3))))
    return poses


# --------------------------------------------------------------------------
# 3. Construction.
# --------------------------------------------------------------------------
def build_monty():
    transform = DepthTo3DLocations(
        agent_id=AGENT_ID,
        sensor_ids=[SM_ID],
        resolutions=[(RES, RES)],
        world_coord=True,
        zooms=1.0,
        hfov=HFOV,
        get_all_points=True,  # REQUIRED: CameraSM reads "sensor_frame_data"
        use_semantic_sensor=False,
        depth_clip_sensors=[],  # [] == distant agent; [0] == surface agent
    )

    sm = CameraSM(
        sensor_module_id=SM_ID,
        features=[
            "pose_vectors",
            "pose_fully_defined",
            "on_object",
            "object_coverage",
            "principal_curvatures_log",
        ],
        save_raw_obs=False,
    )

    lm = EvidenceGraphLM(
        max_match_distance=0.01,
        # NOTE: keys are INPUT CHANNELS == sensor_module_id. An empty dict here
        # does NOT degrade gracefully -- see the tolerances trap probe below.
        tolerances={SM_ID: {"principal_curvatures_log": np.ones(2)}},
        feature_weights={},
        x_percent_threshold=20,
        object_evidence_threshold=1,
        max_graph_size=0.3,
        num_model_voxels_per_dim=50,
        graph_delta_thresholds={
            SM_ID: {
                "distance": 0.005,
                "pose_vectors": [np.pi / 8, np.pi * 2, np.pi * 2],
                "principal_curvatures_log": [1.0, 1.0],
            }
        },
        gsg=None,
        hypotheses_updater_args={"max_nneighbors": 5},
    )
    lm.learning_module_id = "LM_0"

    monty = MontyForEvidenceGraphMatching(
        sensor_modules=[sm],
        learning_modules=[lm],
        motor_system=StubMotorSystem(),
        sm_to_agent_dict={SM_ID: AGENT_ID},
        sm_to_lm_matrix=[[0]],
        lm_to_lm_matrix=None,
        lm_to_lm_vote_matrix=None,
        min_eval_steps=3,
        min_train_steps=3,
        num_exploratory_steps=1000,
    )
    # MontyExperiment injects this after construction; without it
    # check_terminal_conditions() raises AttributeError on step 1.
    monty._match_criterion = AnyLMsMatch(count=1)
    return monty, lm, transform


def run_episode(monty, transform, mode, poses, max_steps):
    monty.set_experiment_mode(mode)
    monty.reset()
    monty.fixme_set_ground_truth(
        primary_target={"object": "sphere_10cm", "quat_rotation": [1.0, 0.0, 0.0, 0.0]},
        semantic_id_to_label={},
    )
    ctx = RuntimeContext(rng=np.random.RandomState(42))
    steps = 0
    for cam_pos, cam_quat in poses[:max_steps]:
        obs, prop = make_observation(cam_pos, cam_quat, transform)
        monty.step(ctx, obs, prop)
        steps += 1
        if monty.is_done:
            break
    return steps


# --------------------------------------------------------------------------
# 4. The tolerances trap: an empty dict does NOT degrade gracefully.
# --------------------------------------------------------------------------
def probe_empty_tolerances():
    """Prove that tolerances={} blows up, and where."""
    import traceback

    transform = DepthTo3DLocations(
        agent_id=AGENT_ID,
        sensor_ids=[SM_ID],
        resolutions=[(RES, RES)],
        world_coord=True,
        zooms=1.0,
        hfov=HFOV,
        get_all_points=True,
        use_semantic_sensor=False,
        depth_clip_sensors=[],
    )
    sm = CameraSM(
        sensor_module_id=SM_ID,
        features=[
            "pose_vectors",
            "pose_fully_defined",
            "on_object",
            "object_coverage",
            "principal_curvatures_log",
        ],
    )
    lm = EvidenceGraphLM(
        max_match_distance=0.01,
        tolerances={},  # <-- the trap
        feature_weights={},
        object_evidence_threshold=1,
        gsg=None,
    )
    monty = MontyForEvidenceGraphMatching(
        sensor_modules=[sm],
        learning_modules=[lm],
        motor_system=StubMotorSystem(),
        sm_to_agent_dict={SM_ID: AGENT_ID},
        sm_to_lm_matrix=[[0]],
        lm_to_lm_matrix=None,
        lm_to_lm_vote_matrix=None,
        min_eval_steps=3,
        min_train_steps=3,
        num_exploratory_steps=20,
    )
    monty._match_criterion = AnyLMsMatch(count=1)
    poses = camera_poses(n_theta=3, n_phi=6)
    try:
        run_episode(monty, transform, ExperimentMode.TRAIN, poses, max_steps=len(poses))
        monty.update_ltm()
        gid = lm.get_all_known_object_ids()
        print(f"  TRAIN with tolerances={{}} survived; graphs={gid}")
        run_episode(monty, transform, ExperimentMode.EVAL, poses, max_steps=10)
        print("  EVAL with tolerances={} ALSO survived (no trap?)")
    except Exception:
        tb = traceback.format_exc().strip().splitlines()
        print("  tolerances={} FAILED:")
        for line in tb[-6:]:
            print("   ", line)


def main():
    monty, lm, transform = build_monty()
    poses = camera_poses()
    print(
        f"synthetic sweep: {len(poses)} camera poses around a "
        f"{SPHERE_R * 2 * 1000:.0f} mm sphere at {CAM_DIST * 1000:.0f} mm"
    )

    # --- sanity: does the transform actually see the sphere? ---
    obs, _ = make_observation(*poses[0], transform)
    s3d = obs[AGENT_ID][SM_ID]["semantic_3d"]
    on_obj = s3d[:, 3] > 0
    print(
        f"step0 patch: {on_obj.sum()}/{len(on_obj)} px on object; "
        f"centre xyz = {np.round(s3d[len(s3d) // 2 + 32, :3], 4)}"
    )

    # --- TRAIN ---
    n = run_episode(monty, transform, ExperimentMode.TRAIN, poses, max_steps=len(poses))
    print(
        f"\nTRAIN: {n} steps, step_type={monty.step_type}, "
        f"lm.terminal_state={lm.terminal_state}, detected={lm.detected_object}"
    )
    print(f"buffer holds {len(lm.buffer)} observations")
    monty.update_ltm()  # MUST be called explicitly; only MontyExperiment does it
    print(f"graph memory after update_ltm: {lm.get_all_known_object_ids()}")

    # --- measure the learned model's extent, in millimetres ---
    gid = lm.get_all_known_object_ids()[0]
    model = lm.graph_memory.get_graph(gid, SM_ID)
    pos = np.asarray(model.pos)
    extent_mm = (pos.max(axis=0) - pos.min(axis=0)) * 1000.0
    radial_mm = np.linalg.norm(pos - pos.mean(axis=0), axis=1) * 1000.0
    print(f"\nlearned graph '{gid}': {pos.shape[0]} nodes")
    print(f"  extent (x,y,z) = {np.round(extent_mm, 2)} mm")
    print(
        f"  max extent     = {extent_mm.max():.2f} mm   "
        f"(true sphere diameter = {SPHERE_R * 2 * 1000:.2f} mm)"
    )
    print(
        f"  mean |r| from centroid = {radial_mm.mean():.2f} mm "
        f"(true radius = {SPHERE_R * 1000:.2f} mm)"
    )
    print("  -> Monty stores locations in METRES.")

    # --- EVAL ---
    n = run_episode(monty, transform, ExperimentMode.EVAL, poses, max_steps=40)
    print(f"\nEVAL: {n} steps, terminal_state={lm.terminal_state}")
    mlh = dict(lm.current_mlh)
    mlh["rotation"] = np.round(mlh["rotation"].as_euler("xyz", degrees=True), 1)
    mlh["location"] = np.round(np.asarray(mlh["location"]), 4)
    print(f"lm.current_mlh = {mlh}")
    print(f"possible matches = {lm.get_possible_matches()}")

    print("\n--- probe: tolerances={} ---")
    probe_empty_tolerances()


if __name__ == "__main__":
    main()
