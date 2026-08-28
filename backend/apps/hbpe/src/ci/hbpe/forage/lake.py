"""Toy lake. Default ask: Saturday with Sam, Jerry, Tom.

True Saturday: beach + jerry (surf / tacos, not Tom's chess).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .math.ops import EPS
from .model import BRANCHES, CUES, PEOPLE, FactorModel, normalize_A_gaze


@dataclass(frozen=True)
class LakeItem:
    id: str
    label: str
    observation: str | None = None
    source: str = "demo"


def _likelihood(table: dict[tuple[str, str], str], noise: float = 0.02) -> np.ndarray:
    n_o, n_b, n_t = len(CUES), len(BRANCHES), len(PEOPLE)
    A = np.zeros((n_o, n_b, n_t))
    for b_i, branch in enumerate(BRANCHES):
        for t_i, person in enumerate(PEOPLE):
            cue = table.get((branch, person), "none")
            A[:, b_i, t_i] = noise / n_o
            A[CUES.index(cue), b_i, t_i] += 1.0 - noise
            A[:, b_i, t_i] /= A[:, b_i, t_i].sum()
    return A


def _all(cue: str) -> dict[tuple[str, str], str]:
    return {(b, p): cue for b in BRANCHES for p in PEOPLE}


def sam_saturday_lake() -> tuple[FactorModel, np.ndarray, list[LakeItem], dict]:
    items_spec: list[tuple[str, str, dict[tuple[str, str], str]]] = [
        (
            "calendar_saturday",
            "calendar: Saturday beach trip",
            {("beach", p): "beach_mention" for p in PEOPLE}
            | {("office", p): "office_mention" for p in PEOPLE}
            | {("errands", p): "errands_mention" for p in PEOPLE},
        ),
        (
            "packed_shorts",
            "content: board shorts in the bag",
            {("beach", p): "beach_mention" for p in PEOPLE},
        ),
        (
            "jerry_text",
            "message: Jerry is free Saturday near the beach",
            {("beach", "jerry"): "jerry_mention", ("errands", "jerry"): "jerry_mention"},
        ),
        (
            "tom_chess",
            "event: Tom at chess club Saturday",
            {("beach", "tom"): "chess_mention", ("office", "tom"): "chess_mention"},
        ),
        (
            "surf_report",
            "content: good surf, Jerry always goes",
            {("beach", "jerry"): "surf_mention"},
        ),
        (
            "slack_weekend",
            "event: no standup Saturday",
            {("office", p): "office_mention" for p in PEOPLE},
        ),
        (
            "sam_friday",
            "event: Sam seen downtown Friday",
            _all("none"),
        ),
    ]

    items = [LakeItem(id=i, label=lab) for i, lab, _ in items_spec]
    process_A = normalize_A_gaze(
        np.stack([_likelihood(table) for _, _, table in items_spec], axis=-1)
    )
    model = FactorModel()
    model.bind_gaze(len(items))
    model.A = process_A.copy()
    model.a = model.A * 8.0
    model.C = np.ones(len(CUES)) / len(CUES)
    truth = {"branch": "beach", "texture": "jerry"}
    return model, process_A, items, truth


def observe(
    process_A: np.ndarray,
    truth: dict,
    gaze: int,
    rng: np.random.Generator,
    *,
    cues: tuple[str, ...] = CUES,
    branches: tuple[str, ...] = BRANCHES,
    people: tuple[str, ...] = PEOPLE,
    observation: str | None = None,
) -> int:
    """Read a cue. Memory items are their content; the demo samples a hidden world."""
    if observation is not None:
        if observation in cues:
            return cues.index(observation)
        return cues.index("none") if "none" in cues else 0

    b = branches.index(truth["branch"])
    t = people.index(truth["texture"])
    probs = np.clip(process_A[:, b, t, gaze], EPS, None)
    probs = probs / probs.sum()
    return int(rng.choice(process_A.shape[0], p=probs))


def default_cues(branches: tuple[str, ...], people: tuple[str, ...]) -> tuple[str, ...]:
    named = tuple(f"{name}_mention" for name in (*branches, *people))
    extra = ("place_mention", "none")
    seen: list[str] = []
    for cue in (*named, *extra):
        if cue not in seen:
            seen.append(cue)
    return tuple(seen)


def _item_likelihood(
    cues: tuple[str, ...],
    branches: tuple[str, ...],
    people: tuple[str, ...],
    observation: str,
    supports_branches: list[str],
    supports_people: list[str],
    noise: float = 0.02,
) -> np.ndarray:
    n_o, n_b, n_t = len(cues), len(branches), len(people)
    A = np.zeros((n_o, n_b, n_t))
    none_i = cues.index("none") if "none" in cues else 0
    obs_i = cues.index(observation) if observation in cues else none_i

    for b_i, branch in enumerate(branches):
        for t_i, person in enumerate(people):
            A[:, b_i, t_i] = noise / n_o
            if supports_branches and supports_people:
                hit = branch in supports_branches and person in supports_people
            elif supports_branches:
                hit = branch in supports_branches
            elif supports_people:
                hit = person in supports_people
            else:
                hit = False
            A[obs_i if hit else none_i, b_i, t_i] += 1.0 - noise
            A[:, b_i, t_i] /= A[:, b_i, t_i].sum()
    return A


def lake_from_spec(spec: dict) -> tuple[FactorModel, np.ndarray, list[LakeItem], dict]:
    branches = tuple(spec["branches"])
    people = tuple(spec["people"])
    if not branches or not people:
        raise ValueError("lake spec needs branches and people")
    cues = tuple(spec["cues"]) if spec.get("cues") else default_cues(branches, people)
    interests = {
        (row["branch"], row["person"]): tuple(row.get("activities") or ())
        for row in spec.get("interests") or []
        if row.get("branch") in branches and row.get("person") in people
    }
    items: list[LakeItem] = []
    tables: list[np.ndarray] = []
    for raw in spec.get("items") or []:
        observation = raw.get("observation") or "none"
        items.append(
            LakeItem(
                id=str(raw["id"]),
                label=str(raw.get("label") or raw["id"]),
                observation=observation,
                source=str(raw.get("source") or "search"),
            )
        )
        tables.append(
            _item_likelihood(
                cues,
                branches,
                people,
                observation,
                list(raw.get("supports_branches") or []),
                list(raw.get("supports_people") or []),
            )
        )
    if not items:
        raise ValueError("lake spec needs at least one item")

    process_A = normalize_A_gaze(np.stack(tables, axis=-1))
    model = FactorModel(branches=branches, people=people, cues=cues, interests=interests, kind="memory")
    model.bind_gaze(len(items))
    model.A = process_A.copy()
    model.a = model.A * 8.0
    model.C = np.ones(len(cues)) / len(cues)
    prior = spec.get("branch_prior") or {}
    if prior:
        weights = np.array([float(prior.get(name, 1.0)) for name in branches], dtype=float)
        weights = np.clip(weights, EPS, None)
        model.D_joint = np.outer(weights / weights.sum(), np.ones(len(people)) / len(people))
        model.d_joint = model.D_joint * (len(branches) * len(people))
    truth = spec.get("truth") or {"branch": branches[0], "texture": people[0]}
    return model, process_A, items, truth


def likelihoods_from_items(
    spec_items: list[dict],
    cues: tuple[str, ...],
    branches: tuple[str, ...],
    people: tuple[str, ...],
) -> tuple[list[LakeItem], np.ndarray]:
    items = [
        LakeItem(
            id=str(raw["id"]),
            label=str(raw.get("label") or raw["id"]),
            observation=str(raw.get("observation") or "none"),
            source=str(raw.get("source") or "search"),
        )
        for raw in spec_items
    ]
    tables = [
        _item_likelihood(
            cues,
            branches,
            people,
            str(raw.get("observation") or "none"),
            list(raw.get("supports_branches") or []),
            list(raw.get("supports_people") or []),
        )
        for raw in spec_items
    ]
    return items, normalize_A_gaze(np.stack(tables, axis=-1))
