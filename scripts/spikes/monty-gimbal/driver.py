"""driver.py -- the Monty half: build the model, feed it patches, read its actions.

Closes the loop:

    rig.capture(yaw, pitch)          a real depth frame
      -> patch.extract_patch()       Monty's square patch, its own frustum
      -> DepthTo3DLocations          metric 3D per pixel, world frame
      -> CameraSM                    surface normal + curvature at the ANCHOR
      -> EvidenceGraphLM             evidence over hypotheses; builds the graph
      -> list[Action]                where to look next
      -> gimbal.step_gimbal()        one absolute move of the head
      -> back to rig.capture()

The construction below is the one the API survey proved runs end to end. Five
things in it are load-bearing and each fails in a way that does not look like
its cause:

  1. `monty._match_criterion` is NOT a constructor argument. MontyExperiment
     injects it after construction (monty_experiment.py:418). Omit it and
     check_terminal_conditions() raises AttributeError on the first matching step.
  2. `tolerances` MUST be non-empty AND keyed by the sensor module id, because the
     key is the input channel name, which is `Message.sender_id`, which is the
     sensor_module_id. `tolerances={}` raises KeyError at graph_matching.py:1055
     on the first matching step -- nowhere near where you would look. Keying it
     "patch_0" while the SM is "patch" raises the identical error.
     `feature_weights={}` IS safe: _fill_feature_weights_with_default creates the
     channel key from tolerances.
  3. `max_graph_size` SILENTLY DISCARDS an oversized object. GridTooSmallError is
     caught and only logged (graph_memory.py:105/149/191), so you get
     "building graph for patch" followed by an empty memory and no exception.
     Worse, the voxel grid is centred on the FIRST OBSERVATION rather than the
     centroid, so it needs roughly 2.25x the object's diameter, not 1x.
     `learn()` asserts the graph is non-empty for exactly this reason.
  4. `update_ltm()` must be called explicitly. Only MontyExperiment.post_episode
     calls it, and we are not using MontyExperiment. Without it nothing is ever
     learned and the failure looks like "the model did not recognise anything".
  5. `fixme_set_ground_truth()` must be called per episode or stepwise_target_object
     is never initialised.

WHAT THE LEARNED GRAPH ACTUALLY IS
----------------------------------
One node per accepted observation, at the patch's ANCHOR PIXEL. Not a fusion of
the patch point clouds -- the other 4095 pixels only estimate the normal and
curvature at that one point. So the motor plan, not the patch size or the depth
resolution, decides what geometry gets measured. A sweep that never points at the
top of the object learns an object with no top, and says nothing about it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np
from gimbal import GimbalClient, GimbalHead, step_gimbal
from patch import Patch, extract_patch
from rig import Frame
from tbp.monty.cmp import Goal, Message
from tbp.monty.context import RuntimeContext
from tbp.monty.experiment.match_criteria import AnyLMsMatch
from tbp.monty.frameworks.actions.actions import (
    Action,
    LookDown,
    LookUp,
    TurnLeft,
    TurnRight,
)
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

AGENT_ID = "agent_id_0"
SM_ID = "patch"  # == the tolerances / feature_weights channel key. See note 2.
PATCH_DIM = 64  # square only: ObservationProcessor does int(sqrt(N))

logger = logging.getLogger(__name__)


class DriverError(RuntimeError):
    pass


# --------------------------------------------------------------------------------------
# Motor system
# --------------------------------------------------------------------------------------
class SweepMotorSystem:
    """Emits real Monty Actions that walk a planned (yaw, pitch) sweep.

    MontyBase touches exactly four members of a motor system -- __call__, reset(),
    the motor_only_step property (with a setter), and state_dict(). There is nothing
    to subclass and no MotorPolicy to configure.

    Why emit Actions at all, when we could just move the head ourselves? Because the
    Action -> (yaw, pitch) -> gimbal mapping is the part of this rig that has to be
    right, and code that is never executed is not evidence of anything. Routing the
    sweep through TurnLeft/TurnRight/LookUp/LookDown exercises the sign conventions,
    the envelope clamp, and the truncation reporting on every single step.

    It also self-corrects. Each call computes the delta from where the HEAD actually
    is (`head.yaw_deg`, after clamping) to the next planned pose, not from where the
    plan says the previous step should have left it. Once the head hits a stop, those
    two diverge, and integrating the requested delta instead of the achieved one puts
    every subsequent observation at the wrong place in the object model with nothing
    raised.

    Milestone 2 replaces this with `gsg=EvidenceGoalGenerator(...)` on the LM, so that
    Monty chooses where to look next from its own hypotheses. The consumer of the
    actions does not change.
    """

    def __init__(
        self, head: GimbalHead, agent_id: str = AGENT_ID, tol_deg: float = 1e-4
    ):
        self.head = head
        self.agent_id = agent_id
        self.tol_deg = tol_deg
        self.plan: list[tuple[float, float]] = []
        self.index = 0
        self.exhausted = False
        self._motor_only_step = False

    def set_plan(self, plan) -> None:
        self.plan = [(float(y), float(p)) for y, p in plan]
        self.index = 0
        self.exhausted = False

    def __call__(
        self,
        ctx: RuntimeContext,
        observations: dict,
        proprioceptive_state: ProprioceptiveState,
        percept: Message,
        goals: list[Goal],
    ) -> list[Action]:
        if self.index + 1 >= len(self.plan):
            self.exhausted = True
            return []
        self.index += 1
        target_yaw, target_pitch = self.plan[self.index]
        d_yaw = target_yaw - self.head.yaw_deg
        d_pitch = target_pitch - self.head.pitch_deg

        actions: list[Action] = []
        if abs(d_yaw) > self.tol_deg:
            actions.append(
                TurnLeft(self.agent_id, d_yaw)
                if d_yaw > 0
                else TurnRight(self.agent_id, -d_yaw)
            )
        if abs(d_pitch) > self.tol_deg:
            actions.append(
                LookUp(self.agent_id, d_pitch)
                if d_pitch > 0
                else LookDown(self.agent_id, -d_pitch)
            )
        return actions

    def reset(self) -> None:
        self.index = 0
        self.exhausted = False
        self._motor_only_step = False

    @property
    def motor_only_step(self) -> bool:
        return self._motor_only_step

    @motor_only_step.setter
    def motor_only_step(self, value: bool) -> None:
        self._motor_only_step = value

    def state_dict(self) -> dict:
        return {}


# --------------------------------------------------------------------------------------
# Measurement
# --------------------------------------------------------------------------------------
def extent_mm(pos_m: np.ndarray, pct: float = 0.0) -> np.ndarray:
    """Per-axis extent of a point cloud, in MILLIMETRES.

    `pct=0` is plain max-minus-min. On this rig it is the right estimator for the two
    LATERAL axes and the wrong one for the DEPTH axis, and the reason is worth knowing:

      * The lateral extents are set by pose geometry times range. Depth noise barely
        perturbs them -- measured on the synthetic sphere, 5 mm of per-pixel depth
        noise moved them by 0.84 mm.
      * The depth extent IS the depth noise. It is a min-to-max over the noisy axis,
        so it grows without bound: the same 5 mm of noise inflated a 16.9 mm cap
        depth to 36.1 mm. That axis is reported as a lower bound and written NULL for
        exactly this reason.

    `pct>0` measures a percentile range instead. DO NOT reach for it as "the robust
    version" -- it is not. It trades the noise bias for a SAMPLING-GEOMETRY bias that
    is much larger here: a serpentine disc sweep puts most of its anchors near the
    middle, so p2..p98 cut 13 mm off a 75 mm extent on NOISE-FREE data. It is kept
    only because measuring that bias is the fastest way to see how a scan's points
    are distributed. It is not a measurement of the object.
    """
    pos_m = np.asarray(pos_m, dtype=np.float64)
    if len(pos_m) == 0:
        return np.zeros(3)
    if pct <= 0:
        return (pos_m.max(axis=0) - pos_m.min(axis=0)) * 1000.0
    lo = np.percentile(pos_m, pct, axis=0)
    hi = np.percentile(pos_m, 100.0 - pct, axis=0)
    return (hi - lo) * 1000.0


# --------------------------------------------------------------------------------------
# Sweep planning
# --------------------------------------------------------------------------------------
def serpentine_disc(
    half_angle_deg: float,
    n_yaw: int = 13,
    n_pitch: int = 11,
    coverage: float = 0.8,
    phase: float = 0.0,
) -> list[tuple[float, float]]:
    """A serpentine raster clipped to the disc the object actually subtends.

    Mirrors what the gimbal MCP's `plan_scan_grid` produces (serpentine, so the head
    never makes a long return traverse), with one addition: poses outside the
    object's silhouette are dropped rather than commanded. An off-object anchor is
    not an error -- Monty marks the percept `process_features_in_lm=False` and moves
    on -- but it is a wasted move, and a move is 1-3 seconds of real wall clock on
    real hardware.

    `coverage` < 1 keeps the sweep inside the silhouette, where the surface faces the
    camera. At the rim the surface is edge-on, depth gradients are extreme, and both
    the normal and the curvature estimate degrade.
    """
    lim = half_angle_deg * coverage
    poses: list[tuple[float, float]] = []
    for i, pitch in enumerate(np.linspace(-lim, lim, n_pitch)):
        row = np.linspace(-lim, lim, n_yaw)
        if i % 2:
            row = row[::-1]
        for yaw in row:
            yaw = float(yaw) + phase
            pitch = float(pitch)
            if np.hypot(yaw - phase, pitch) <= lim + 1e-9:
                poses.append((yaw, pitch))
    return poses


# --------------------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------------------
@dataclass
class EpisodeResult:
    mode: str
    steps: int
    step_type: str
    terminal_state: object
    detected_object: object
    n_observations: int
    n_on_object: int
    n_off_object: int
    n_truncated: int
    n_unsupported: int
    plan_exhausted: bool


def _env_float(name: str, default: float) -> float:
    """Read a float from the environment, falling back to `default`."""
    import os

    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return float(default)
    try:
        return float(raw)
    except ValueError as exc:
        raise SystemExit(f"{name} must be a number, got {raw!r}") from exc


# ---------------------------------------------------------------------------
# Matching thresholds.
#
# These three defaults are DISCRIMINATION-TUNED, and they are not Monty's own
# defaults. Monty ships x_percent_threshold=20.0 / object_evidence_threshold=1.0,
# which are so permissive that a CUBE matches a memory containing only a SPHERE:
# an adversarial two-object probe measured len(graph_memory)==1 for every pair
# tried, including grossly distinct shapes. That is not a tuning nit -- the
# merged graph's extent belongs to NEITHER object (a 100mm+120mm sphere pair
# merged to x=97.52 y=88.73 z=35.30 mm), and that chimeric number is exactly
# what a writeback would put in ci.objects.width_mm.
#
# Bisection found the values below, which correctly separate sphere100 /
# sphere120 / cube100 into three graphs while still collapsing two scans of the
# SAME object into one. They are strict, so re-identification needs adequate
# sweep coverage -- if EVAL starts returning no_match on a genuine repeat, widen
# the sweep before loosening these.
#
# Override per run: MONTY_X_PERCENT, MONTY_OBJ_EVIDENCE, MONTY_MAX_MATCH_DIST.
# Set MONTY_PERMISSIVE=1 to restore Monty's shipped values for comparison.
# ---------------------------------------------------------------------------
def _matching_defaults() -> tuple[float, float, float]:
    import os

    if os.environ.get("MONTY_PERMISSIVE", "").strip() in {"1", "true", "yes"}:
        return 0.01, 20.0, 1.0
    return (
        _env_float("MONTY_MAX_MATCH_DIST", 0.002),
        _env_float("MONTY_X_PERCENT", 1.0),
        _env_float("MONTY_OBJ_EVIDENCE", 20.0),
    )


class MontyDriver:
    """Owns the Monty model and the per-step plumbing from Frame to Message."""

    def __init__(
        self,
        patch_hfov_deg: float,
        max_graph_size: float,
        patch_dim: int = PATCH_DIM,
        agent_id: str = AGENT_ID,
        sm_id: str = SM_ID,
        head: GimbalHead | None = None,
        graph_delta_distance: float = 0.004,
        max_match_distance: float | None = None,
        x_percent_threshold: float | None = None,
        object_evidence_threshold: float | None = None,
        num_model_voxels_per_dim: int = 50,
        min_train_steps: int = 3,
        min_eval_steps: int = 3,
        num_exploratory_steps: int = 1000,
        seed: int = 42,
    ) -> None:
        _mmd, _xpct, _oet = _matching_defaults()
        max_match_distance = (
            _mmd if max_match_distance is None else float(max_match_distance)
        )
        x_percent_threshold = (
            _xpct if x_percent_threshold is None else float(x_percent_threshold)
        )
        object_evidence_threshold = (
            _oet
            if object_evidence_threshold is None
            else float(object_evidence_threshold)
        )
        self.max_match_distance = max_match_distance
        self.x_percent_threshold = x_percent_threshold
        self.object_evidence_threshold = object_evidence_threshold

        self.agent_id = agent_id
        self.sm_id = sm_id
        self.patch_dim = patch_dim
        self.patch_hfov_deg = float(patch_hfov_deg)
        self.max_graph_size = float(max_graph_size)
        self.head = head or GimbalHead()
        self.ctx = RuntimeContext(rng=np.random.RandomState(seed))

        # The transform must describe the PATCH's frustum, not the source camera's.
        # This is where the metric scale is set: get it wrong and every learned
        # dimension is wrong by the same factor, with nothing to flag it.
        self.transform = DepthTo3DLocations(
            agent_id=agent_id,
            sensor_ids=[sm_id],
            resolutions=[(patch_dim, patch_dim)],
            world_coord=True,
            zooms=1.0,
            hfov=self.patch_hfov_deg,
            get_all_points=True,  # REQUIRED: CameraSM reads obs["sensor_frame_data"]
            use_semantic_sensor=False,
            depth_clip_sensors=[],  # [] == distant agent. [0] would clip depth to 5 cm.
        )

        self.sm = CameraSM(
            sensor_module_id=sm_id,
            features=[
                "pose_vectors",
                "pose_fully_defined",
                "on_object",
                "object_coverage",
                "principal_curvatures_log",
            ],
            save_raw_obs=False,
        )

        self.lm = EvidenceGraphLM(
            max_match_distance=max_match_distance,
            tolerances={sm_id: {"principal_curvatures_log": np.ones(2)}},  # see note 2
            feature_weights={},
            x_percent_threshold=x_percent_threshold,
            object_evidence_threshold=object_evidence_threshold,
            max_graph_size=self.max_graph_size,  # see note 3
            num_model_voxels_per_dim=num_model_voxels_per_dim,
            graph_delta_thresholds={
                sm_id: {
                    "distance": graph_delta_distance,
                    "pose_vectors": [np.pi / 8, np.pi * 2, np.pi * 2],
                    "principal_curvatures_log": [1.0, 1.0],
                }
            },
            gsg=None,  # milestone 2: EvidenceGoalGenerator, so Monty aims the gimbal
            hypotheses_updater_args={"max_nneighbors": 5},
        )
        self.lm.learning_module_id = "LM_0"

        self.motor = SweepMotorSystem(self.head, agent_id=agent_id)

        self.monty = MontyForEvidenceGraphMatching(
            sensor_modules=[self.sm],
            learning_modules=[self.lm],
            motor_system=self.motor,
            sm_to_agent_dict={sm_id: agent_id},
            sm_to_lm_matrix=[[0]],
            lm_to_lm_matrix=None,
            lm_to_lm_vote_matrix=None,
            min_eval_steps=min_eval_steps,
            min_train_steps=min_train_steps,
            num_exploratory_steps=num_exploratory_steps,
        )
        self.monty._match_criterion = AnyLMsMatch(count=1)  # see note 1

    # -- per-step plumbing -------------------------------------------------------------
    def to_observation(self, frame: Frame, patch: Patch):
        """Frame + Patch -> the (observations, proprioceptive_state) pair Monty wants.

        `semantic` is supplied explicitly rather than left to the transform's
        `depth >= 1` fallback. The fallback is right only because we write exactly
        1.0 for "no return"; handing over the mask we actually computed keeps that
        from being a coincidence, and on real ARKit frames it carries the
        confidence gate, which depth alone cannot express.
        """
        observations = {
            self.agent_id: {
                self.sm_id: {
                    "depth": patch.depth,
                    "rgba": patch.rgba,
                    "semantic": patch.semantic,
                }
            }
        }
        prop = ProprioceptiveState(
            {
                self.agent_id: AgentState(
                    sensors={
                        self.sm_id: SensorState(
                            position=np.zeros(3),
                            # patch frame -> camera frame. The transform composes
                            # agent_rotation * sensor_rotation, which is exactly the
                            # patch -> world rotation we need. Identity for a centred
                            # anchor, which is the gimbal-aimed case.
                            rotation=patch.sensor_rotation,
                        )
                    },
                    position=np.asarray(frame.position, dtype=np.float64),
                    # camera -> world. ARKit's own pose on the real rig; the gimbal's
                    # dead-reckoned setpoint only as a fallback.
                    rotation=frame.rotation,
                )
            }
        )
        observations = self.transform.call(observations, state=prop)
        return observations, prop

    def step(self, frame: Frame, patch: Patch) -> list[Action]:
        observations, prop = self.to_observation(frame, patch)
        return self.monty.step(self.ctx, observations, prop)

    # -- episodes ----------------------------------------------------------------------
    def begin_episode(self, mode: ExperimentMode, plan, target_label: str) -> None:
        self.motor.set_plan(plan)
        self.monty.set_experiment_mode(
            mode
        )  # an Enum, compared with `is`. Never a string.
        self.monty.reset()  # also resets the motor system
        self.monty.fixme_set_ground_truth(  # inits stepwise_target_object; see note 5
            primary_target={
                "object": target_label,
                "quat_rotation": [1.0, 0.0, 0.0, 0.0],
            },
            semantic_id_to_label={},
        )
        self.head.reset()
        self.motor.set_plan(plan)  # monty.reset() cleared the index

    def learn(self) -> list[str]:
        """Commit the episode buffer to long-term memory, and PROVE it landed.

        The assert is the whole point. An object larger than `max_graph_size` is
        dropped with no exception and no error log above INFO, so the only way to
        know is to look.
        """
        self.monty.update_ltm()  # see note 4
        ids = list(self.lm.get_all_known_object_ids())
        if not ids:
            raise DriverError(
                "update_ltm() produced an EMPTY graph memory. Almost always "
                f"max_graph_size={self.max_graph_size:.3f} m is too small: the voxel grid is "
                "centred on the FIRST observation rather than the centroid, so it needs about "
                "2.25x the object's diameter. GridTooSmallError is swallowed and only logged "
                "at INFO (graph_memory.py:105/149/191), which is why this is an assert and not "
                "an exception you caught."
            )
        return ids

    # -- readout -----------------------------------------------------------------------
    def graph_points_m(self, graph_id: str | None = None) -> np.ndarray:
        ids = list(self.lm.get_all_known_object_ids())
        if not ids:
            return np.zeros((0, 3))
        gid = graph_id or ids[0]
        model = self.lm.graph_memory.get_graph(gid, self.sm_id)
        return np.asarray(model.pos, dtype=np.float64)  # METRES

    def learned_extent_mm(
        self, graph_id: str | None = None, pct: float = 0.0
    ) -> np.ndarray:
        return extent_mm(self.graph_points_m(graph_id), pct=pct)

    def mlh(self) -> dict:
        """Most-likely hypothesis, with the rotation flattened to degrees for printing."""
        mlh = dict(self.lm.current_mlh) if self.lm.current_mlh else {}
        if "rotation" in mlh and hasattr(mlh["rotation"], "as_euler"):
            mlh["rotation_deg"] = np.round(
                mlh["rotation"].as_euler("xyz", degrees=True), 1
            ).tolist()
            mlh.pop("rotation")
        if "location" in mlh:
            mlh["location"] = np.round(np.asarray(mlh["location"], float), 4).tolist()
        return mlh


# --------------------------------------------------------------------------------------
# The loop
# --------------------------------------------------------------------------------------
def run_episode(
    driver: MontyDriver,
    rig,
    client: GimbalClient,
    plan,
    mode: ExperimentMode,
    target_label: str,
    max_steps: int,
    dwell_ms: int = 800,
    move_duration_s: float = 1.0,
    min_conf: int = 2,
    verbose: bool = False,
) -> EpisodeResult:
    """Capture -> patch -> Monty -> Action -> gimbal, until terminal or out of plan."""
    driver.begin_episode(mode, plan, target_label)
    head = driver.head

    # Get the head to the first planned pose before the first capture, so that step 0
    # is taken from a known place rather than wherever the head happened to be left.
    start_yaw, start_pitch = plan[0]
    client.move_to(
        start_yaw, start_pitch, dwell_ms=dwell_ms, move_duration_s=move_duration_s
    )
    head.yaw_deg, head.pitch_deg = start_yaw, start_pitch

    n_on = n_off = n_trunc = n_unsup = 0
    steps = 0

    for _ in range(max_steps):
        yaw, pitch = head.target()
        frame = rig.capture(yaw, pitch)
        patch = extract_patch(
            frame,
            out_dim=driver.patch_dim,
            patch_hfov_deg=driver.patch_hfov_deg,
            min_conf=min_conf,
        )
        n_on += int(patch.anchor_on_object)
        n_off += int(not patch.anchor_on_object)

        actions = driver.step(frame, patch)
        steps += 1

        if verbose:
            print(
                f"    step {steps:3d} yaw={yaw:+6.2f} pitch={pitch:+6.2f} "
                f"anchor={'ON ' if patch.anchor_on_object else 'off'} "
                f"d={patch.anchor_depth_m:.4f}m cov={patch.coverage:5.1%} "
                f"actions={[a.name for a in actions]}"
            )

        if driver.monty.is_done:
            break
        if not actions:
            # The plan is spent (or a goal generator had nothing to say). Either way
            # there is nowhere further to look, so stop rather than re-measuring the
            # same pose and inflating the evidence for free.
            if driver.motor.exhausted:
                break
            continue

        out = step_gimbal(
            client, head, actions, dwell_ms=dwell_ms, move_duration_s=move_duration_s
        )
        n_trunc += len(out["truncated"])
        n_unsup += len(out["unsupported"])

    return EpisodeResult(
        mode=mode.name,
        steps=steps,
        step_type=driver.monty.step_type,
        terminal_state=driver.lm.terminal_state,
        detected_object=driver.lm.detected_object,
        n_observations=len(driver.lm.buffer),
        n_on_object=n_on,
        n_off_object=n_off,
        n_truncated=n_trunc,
        n_unsupported=n_unsup,
        plan_exhausted=driver.motor.exhausted,
    )


if __name__ == "__main__":
    # Smoke test: construct everything and take three steps. No learning, no reporting.
    logging.basicConfig(level=logging.ERROR)
    from patch import patch_hfov_for_object
    from rig import make_rig

    rig = make_rig().connect()
    hfov = patch_hfov_for_object(rig.obj.size_m, rig.range_m)
    head = GimbalHead()
    driver = MontyDriver(patch_hfov_deg=hfov, max_graph_size=0.3, head=head)
    plan = serpentine_disc(rig.silhouette_half_angle_deg, n_yaw=5, n_pitch=5)
    print(f"plan: {len(plan)} poses, patch hfov {hfov:.2f} deg")
    res = run_episode(
        driver,
        rig,
        GimbalClient(fake=True),
        plan,
        ExperimentMode.TRAIN,
        "smoke",
        max_steps=6,
        dwell_ms=0,
        verbose=True,
    )
    print(res.mode, res.steps, res.step_type, res.terminal_state, res.n_observations)
