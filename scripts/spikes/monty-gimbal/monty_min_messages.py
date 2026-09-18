"""Variant: bypass CameraSM entirely and feed Monty pre-built CMP Messages.

Relevant when depth+normals arrive already reconstructed (e.g. iPhone ARKit /
LiDAR point cloud) rather than as a raw square RGBD patch.  A SensorModule
subclass is still required -- MontyBase calls update_state() and step() on it --
but it can ignore `observation` and emit a Message directly.
"""

from __future__ import annotations

import numpy as np
import quaternion as qt
from monty_min import StubMotorSystem
from tbp.monty.cmp import Message
from tbp.monty.context import RuntimeContext
from tbp.monty.experiment.match_criteria import AnyLMsMatch
from tbp.monty.frameworks.experiments.mode import ExperimentMode
from tbp.monty.frameworks.models.abstract_monty_classes import SensorModule
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

AGENT_ID = "agent_id_0"
SM_ID = "patch"
SPHERE_R = 0.05


class DirectSM(SensorModule):
    """Emits a CMP Message straight from (location, normal, curvature)."""

    def __init__(self, sensor_module_id: str) -> None:
        self.sensor_module_id = sensor_module_id
        self.is_exploring = False
        self.state = None
        self._pending = None

    def feed(self, location, normal, curvatures):
        self._pending = (
            np.asarray(location, float),
            np.asarray(normal, float),
            np.asarray(curvatures, float),
        )

    def update_state(self, agent: AgentState) -> None:
        sensor = agent.sensors[self.sensor_module_id]
        self.state = SensorState(
            position=agent.position
            + qt.rotate_vectors(agent.rotation, sensor.position),
            rotation=agent.rotation * sensor.rotation,
        )

    def state_dict(self):
        return {}

    def reset(self) -> None:
        self._pending = None
        self.is_exploring = False

    def step(self, ctx: RuntimeContext, observation, motor_only_step: bool = False):
        loc, normal, curv = self._pending
        normal = normal / np.linalg.norm(normal)
        # Any two unit vectors orthogonal to the normal and to each other.
        tmp = np.array([1.0, 0.0, 0.0])
        if abs(np.dot(tmp, normal)) > 0.9:
            tmp = np.array([0.0, 1.0, 0.0])
        d1 = np.cross(normal, tmp)
        d1 /= np.linalg.norm(d1)
        d2 = np.cross(normal, d1)
        return Message(
            location=loc,
            morphological_features={
                # CMP invariant: EXACTLY (3, 3), orthonormal, row 0 = surface normal.
                "pose_vectors": np.vstack([normal, d1, d2]),
                # CMP invariant: a real python bool, not np.bool_.
                "pose_fully_defined": True,
                "on_object": 1.0,
            },
            non_morphological_features={"principal_curvatures_log": curv},
            confidence=1.0,
            pass_message=True,
            sender_id=self.sensor_module_id,
            sender_type="SM",
            process_features_in_lm=True,
        )


def fib_sphere(n):
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - 2 * i / n)
    theta = np.pi * (1 + 5**0.5) * i
    return np.stack(
        [np.cos(theta) * np.sin(phi), np.sin(theta) * np.sin(phi), np.cos(phi)], axis=1
    )


def main():
    sm = DirectSM(SM_ID)
    lm = EvidenceGraphLM(
        max_match_distance=0.01,
        tolerances={SM_ID: {"principal_curvatures_log": np.ones(2)}},
        feature_weights={},
        x_percent_threshold=20,
        object_evidence_threshold=1,
        max_graph_size=0.3,
        graph_delta_thresholds={SM_ID: {"distance": 0.005}},
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
        num_exploratory_steps=1000,
    )
    monty._match_criterion = AnyLMsMatch(count=1)

    dirs = fib_sphere(300)
    curv = np.array([np.log(1 / SPHERE_R), np.log(1 / SPHERE_R)])

    def episode(mode, n):
        monty.set_experiment_mode(mode)
        monty.reset()
        monty.fixme_set_ground_truth(
            primary_target={"object": "sphere", "quat_rotation": [1, 0, 0, 0]},
            semantic_id_to_label={},
        )
        ctx = RuntimeContext(rng=np.random.RandomState(0))
        for d in dirs[:n]:
            loc = d * SPHERE_R
            sm.feed(loc, d, curv)
            prop = ProprioceptiveState(
                {
                    AGENT_ID: AgentState(
                        sensors={
                            SM_ID: SensorState(np.zeros(3), qt.quaternion(1, 0, 0, 0))
                        },
                        position=loc * 2.0,
                        rotation=qt.quaternion(1, 0, 0, 0),
                    )
                }
            )
            # `observations` is never read by DirectSM but MontyBase indexes it.
            monty.step(ctx, {AGENT_ID: {SM_ID: {}}}, prop)
            if monty.is_done:
                break

    episode(ExperimentMode.TRAIN, len(dirs))
    monty.update_ltm()
    gid = lm.get_all_known_object_ids()[0]
    pos = np.asarray(lm.graph_memory.get_graph(gid, SM_ID).pos)
    ext = (pos.max(0) - pos.min(0)) * 1000
    print(
        f"messages-only path: graph '{gid}', {pos.shape[0]} nodes, "
        f"extent {np.round(ext, 2)} mm (true {SPHERE_R * 2000:.0f} mm)"
    )

    episode(ExperimentMode.EVAL, 40)
    print(
        f"EVAL terminal_state={lm.terminal_state} "
        f"matches={lm.get_possible_matches()} "
        f"mlh_evidence={lm.current_mlh['evidence']:.2f}"
    )


if __name__ == "__main__":
    main()
