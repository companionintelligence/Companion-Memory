"""Generative model: A over (branch, texture).

Slider 1 is the branch (beach / office / errands).
Slider 2 is texture: who you meet. Activities hang off (branch, who).
Jerry at the beach is not Tom at the beach. Routes must use
Q(texture | branch) from the joint, not a shared texture vector.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .math.ops import EPS, normalize_columns

BRANCHES = ("beach", "office", "errands")
PEOPLE = ("jerry", "tom", "colleague", "solo")
CUES = (
    "beach_mention",
    "office_mention",
    "errands_mention",
    "jerry_mention",
    "tom_mention",
    "colleague_mention",
    "surf_mention",
    "tacos_mention",
    "chess_mention",
    "coffee_mention",
    "standup_mention",
    "none",
)

# Predicted overlap if you take this branch and meet this person.
INTERESTS: dict[tuple[str, str], tuple[str, ...]] = {
    ("beach", "jerry"): ("surf", "tacos"),
    ("beach", "tom"): ("chess", "coffee"),
    ("beach", "solo"): ("walk",),
    ("office", "colleague"): ("standup", "docs"),
    ("office", "solo"): ("deep_work",),
    ("errands", "solo"): ("groceries",),
    ("errands", "jerry"): ("hardware_store",),
}


@dataclass
class FactorModel:
    branches: tuple[str, ...] = BRANCHES
    people: tuple[str, ...] = PEOPLE
    cues: tuple[str, ...] = CUES
    interests: dict[tuple[str, str], tuple[str, ...]] = field(default_factory=dict)
    kind: str = "demo"
    A: np.ndarray = field(init=False)
    C: np.ndarray = field(init=False)
    D_joint: np.ndarray = field(init=False)
    a: np.ndarray = field(init=False)
    d_joint: np.ndarray = field(init=False)

    def __post_init__(self) -> None:
        n_o, n_b, n_t = len(self.cues), len(self.branches), len(self.people)
        self.A = np.ones((n_o, n_b, n_t, 1)) / n_o
        self.C = np.ones(n_o) / n_o
        self.D_joint = np.ones((n_b, n_t)) / (n_b * n_t)
        self.a = np.ones_like(self.A)
        self.d_joint = np.ones((n_b, n_t))
        if not self.interests and self.branches == BRANCHES and self.people == PEOPLE:
            self.interests = dict(INTERESTS)

    def bind_gaze(self, n_gaze: int) -> None:
        n_o, n_b, n_t = len(self.cues), len(self.branches), len(self.people)
        self.A = np.ones((n_o, n_b, n_t, n_gaze)) / n_o
        self.a = np.ones_like(self.A)

    def append_gaze(self, n_extra: int) -> None:
        if n_extra <= 0:
            return
        n_o, n_b, n_t, _n_g = self.A.shape
        extra_A = np.ones((n_o, n_b, n_t, n_extra)) / n_o
        extra_a = np.ones_like(extra_A)
        self.A = np.concatenate([self.A, extra_A], axis=-1)
        self.a = np.concatenate([self.a, extra_a], axis=-1)

    def predicted_outcome(self, joint: np.ndarray, gaze: int) -> np.ndarray:
        qo = np.einsum("obt,bt->o", self.A[:, :, :, gaze], joint)
        qo = np.clip(qo, EPS, None)
        return qo / qo.sum()

    def set_preferences_for_outcome(self, cue: str, strength: float = 2.0) -> None:
        U = np.zeros(len(self.cues))
        U[self.cues.index(cue)] = strength
        exp = np.exp(U - U.max())
        self.C = exp / exp.sum()


def normalize_A_gaze(A: np.ndarray) -> np.ndarray:
    n_o, n_b, n_t, n_g = A.shape
    flat = A.reshape(n_o, -1)
    return normalize_columns(flat).reshape(n_o, n_b, n_t, n_g)


def branch_mass(joint: np.ndarray) -> np.ndarray:
    mass = joint.sum(axis=1)
    return mass / max(float(mass.sum()), EPS)


def texture_given_branch(joint: np.ndarray, branch_index: int) -> np.ndarray:
    row = np.clip(joint[branch_index], EPS, None)
    return row / row.sum()
