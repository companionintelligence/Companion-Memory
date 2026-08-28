"""One outcome query: sample, pin, probe, resolve, surprise, postdict."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .lake import LakeItem, likelihoods_from_items, observe
from .math.expected import expected_free_energy_from_joint
from .math.infer import infer_joint, policy_posterior
from .math.learn import dirichlet_update_A, dirichlet_update_D, expected_A
from .math.ops import EPS, entropy
from .math.variational import variational_free_energy
from .model import FactorModel, branch_mass, texture_given_branch

COMMIT_MASS = 0.6
REFUSED_EPISTEMIC = 0.05


class ForageError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass
class SampleRecord:
    gaze: int
    item_id: str
    cue: str
    G: float
    epistemic: float
    risk: float
    ambiguity: float
    joint_before: np.ndarray
    joint_after: np.ndarray
    branch_delta: dict[str, float]


@dataclass
class ForageTrial:
    model: FactorModel
    process_A: np.ndarray
    items: list[LakeItem]
    truth: dict
    question: str = "where is Sam on Saturday"
    subject: str = "Sam"
    horizon: str = "saturday"
    rng: np.random.Generator = field(default_factory=lambda: np.random.default_rng(0))
    joint: np.ndarray = field(init=False)
    unread: list[int] = field(init=False)
    log: list[SampleRecord] = field(default_factory=list)
    pin: str | None = None
    resolved: bool = False
    actual: dict | None = None
    frozen_joint: np.ndarray | None = None

    def __post_init__(self) -> None:
        self.joint = self.model.D_joint.copy()
        self.unread = list(range(len(self.items)))

    @property
    def branches(self) -> tuple[str, ...]:
        return self.model.branches

    @property
    def people(self) -> tuple[str, ...]:
        return self.model.people

    @property
    def cues(self) -> tuple[str, ...]:
        return self.model.cues

    @property
    def outcome(self) -> str:
        return self.question

    @property
    def qs_branch(self) -> np.ndarray:
        return branch_mass(self.belief)

    @property
    def belief(self) -> np.ndarray:
        if self.frozen_joint is not None:
            return self.frozen_joint
        return self.joint

    def past_branches(self) -> set[str]:
        if not self.resolved or self.actual is None:
            return set()
        return {name for name in self.branches if name != self.actual["branch"]}

    def is_past(self, branch: str) -> bool:
        return branch in self.past_branches()

    def sampling_joint(self) -> np.ndarray:
        """Beliefs the eye uses to pick the next read. Pin zeros other branches."""
        joint = self.joint.copy()
        if self.pin is not None:
            keep = np.zeros_like(joint)
            keep[self.branches.index(self.pin)] = joint[self.branches.index(self.pin)]
            total = float(keep.sum())
            if total <= 0:
                keep[self.branches.index(self.pin)] = 1.0 / keep.shape[1]
                total = float(keep.sum())
            joint = keep / total
        return joint

    def score_gaze(self, gaze: int, joint: np.ndarray | None = None) -> dict:
        return expected_free_energy_from_joint(
            joint if joint is not None else self.sampling_joint(),
            self.model.A[:, :, :, gaze],
            self.model.C,
        )

    def shortlist(self) -> list[dict]:
        ranked = []
        for gaze in self.unread:
            scored = self.score_gaze(gaze)
            ranked.append({"gaze": gaze, "item": self.items[gaze], **scored})
        ranked.sort(key=lambda row: row["G"])
        return ranked

    def attention(self) -> list[dict]:
        rows = []
        for gaze, item in enumerate(self.items):
            scored = self.score_gaze(gaze)
            rows.append({
                "gaze": gaze,
                "id": item.id,
                "label": item.label,
                "provenance": item.id,
                "source": item.source,
                "read": gaze not in self.unread,
                "G": float(scored["G"]),
                "epistemic": float(scored["epistemic"]),
                "risk": float(scored["risk"]),
                "ambiguity": float(scored["ambiguity"]),
            })
        rows.sort(key=lambda row: row["G"])
        return rows

    def sample_next(self) -> SampleRecord:
        if self.resolved:
            raise ForageError("trial already resolved", 409)
        ranked = self.shortlist()
        if not ranked:
            raise ForageError("lake exhausted", 409)
        G = np.array([row["G"] for row in ranked])
        pi = policy_posterior(np.zeros_like(G), G, gamma=4.0)
        choice = int(self.rng.choice(len(ranked), p=pi))
        return self.read_item(ranked[choice]["item"].id, scored=ranked[choice])

    def read_item(self, item_id: str, scored: dict | None = None) -> SampleRecord:
        if self.resolved:
            raise ForageError("trial already resolved", 409)
        gaze = self._gaze_of(item_id)
        if gaze not in self.unread:
            raise ForageError(f"{item_id} already read", 409)
        if scored is None:
            scored = self.score_gaze(gaze)
        cue_i = self._observe(gaze)
        before = self.joint.copy()
        self._update(gaze, cue_i)
        self.unread.remove(gaze)
        after = self.joint.copy()
        record = SampleRecord(
            gaze=gaze,
            item_id=item_id,
            cue=self.cues[cue_i],
            G=float(scored["G"]),
            epistemic=float(scored["epistemic"]),
            risk=float(scored["risk"]),
            ambiguity=float(scored["ambiguity"]),
            joint_before=before,
            joint_after=after,
            branch_delta={
                name: float(branch_mass(after)[i] - branch_mass(before)[i])
                for i, name in enumerate(self.branches)
            },
        )
        self.log.append(record)
        return record

    def _update(self, gaze: int, cue_i: int) -> None:
        self.joint = infer_joint(cue_i, self.model.A[:, :, :, gaze], self.joint)
        n_o, n_b, n_t, _n_g = self.model.a.shape
        flat = self.model.a[:, :, :, gaze].reshape(n_o, n_b * n_t)
        flat = dirichlet_update_A(flat, cue_i, self.joint.reshape(n_b * n_t))
        self.model.a[:, :, :, gaze] = flat.reshape(n_o, n_b, n_t)
        self.model.A[:, :, :, gaze] = expected_A(flat).reshape(n_o, n_b, n_t)

    def _gaze_of(self, item_id: str) -> int:
        for i, item in enumerate(self.items):
            if item.id == item_id:
                return i
        raise ForageError(f"unknown item {item_id}", 404)

    def _observe(self, gaze: int) -> int:
        return observe(
            self.process_A,
            self.truth,
            gaze,
            self.rng,
            cues=self.cues,
            branches=self.branches,
            people=self.people,
            observation=self.items[gaze].observation,
        )

    def ingest(self, spec_items: list[dict]) -> int:
        """Append unread facts the indexes just returned. Does not rewind Q."""
        incoming = [row for row in spec_items if row.get("id") and not any(item.id == row["id"] for item in self.items)]
        if not incoming:
            return 0
        extra, extra_A = likelihoods_from_items(incoming, self.cues, self.branches, self.people)
        start = len(self.items)
        self.model.append_gaze(len(extra))
        self.model.A[:, :, :, start:] = extra_A
        self.model.a[:, :, :, start:] = extra_A * 8.0
        self.process_A = np.concatenate([self.process_A, extra_A], axis=-1)
        self.items.extend(extra)
        self.unread.extend(range(start, len(self.items)))
        return len(extra)

    def _require_branch(self, name: str) -> int:
        if name not in self.branches:
            raise ForageError(f"unknown branch {name}", 404)
        return self.branches.index(name)

    def set_pin(self, name: str) -> None:
        self._require_branch(name)
        if self.is_past(name):
            raise ForageError("cannot pin a past branch", 409)
        self.pin = name

    def clear_pin(self) -> None:
        self.pin = None

    def permutations(self, name: str) -> dict[str, float]:
        idx = self._require_branch(name)
        cond = texture_given_branch(self.belief, idx)
        return {person: float(mass) for person, mass in zip(self.people, cond)}

    def interests_for(self, name: str) -> dict[str, list[str]]:
        self._require_branch(name)
        return {
            person: list(self.model.interests.get((name, person), ()))
            for person in self.people
        }

    def why(self, name: str) -> list[dict]:
        self._require_branch(name)
        rows = []
        for rec in self.log:
            delta = rec.branch_delta.get(name, 0.0)
            if abs(delta) < 1e-9:
                continue
            rows.append({
                "item_id": rec.item_id,
                "cue": rec.cue,
                "delta_mass": delta,
            })
        return rows

    def expect(self, name: str) -> dict:
        idx = self._require_branch(name)
        if self.is_past(name):
            raise ForageError("no what-ifs on a past branch", 409)
        cond = texture_given_branch(self.belief, idx)
        slice_joint = np.zeros_like(self.belief)
        slice_joint[idx] = cond
        predicted = np.zeros(len(self.cues))
        for gaze in range(len(self.items)):
            predicted += self.model.predicted_outcome(slice_joint, gaze)
        predicted = predicted / max(float(predicted.sum()), EPS)
        top = [self.cues[i] for i in np.argsort(-predicted)[:5]]
        return {
            "branch": name,
            "permutations": {person: float(m) for person, m in zip(self.people, cond)},
            "interests": self.interests_for(name),
            "predicted_cues": {cue: float(p) for cue, p in zip(self.cues, predicted)},
            "top_cues": top,
        }

    def pick(self) -> dict:
        mass = self.qs_branch
        b = int(np.argmax(mass))
        branch_ready = float(mass[b]) >= COMMIT_MASS
        branch = self.branches[b] if branch_ready else None
        texture = None
        texture_mass = None
        if branch is not None:
            cond = texture_given_branch(self.belief, b)
            t = int(np.argmax(cond))
            if float(cond[t]) >= COMMIT_MASS:
                texture = self.people[t]
                texture_mass = float(cond[t])
        return {
            "question": self.question,
            "horizon": self.horizon,
            "ready": branch_ready,
            "branch": branch,
            "texture": texture,
            "texture_mass": texture_mass,
            "branch_mass": {name: float(m) for name, m in zip(self.branches, mass)},
            "permutations": self.permutations(branch) if branch else None,
            "entropy_branch": entropy(mass),
            "pin": self.pin,
        }

    def probe(self, item_id: str) -> dict:
        gaze = self._gaze_of(item_id)
        scored = self.score_gaze(gaze, joint=self.belief)
        cue_i = self._observe(gaze)
        qo = scored["qo"]
        surprise = -float(np.log(max(float(qo[cue_i]), EPS)))
        return {
            "item_id": item_id,
            "cue": self.cues[cue_i],
            "surprise": surprise,
            "q_cue": float(qo[cue_i]),
            "G": float(scored["G"]),
            "epistemic": float(scored["epistemic"]),
            "risk": float(scored["risk"]),
            "ambiguity": float(scored["ambiguity"]),
            "updated_q": False,
        }

    def resolve(self, actual: dict | None = None) -> dict:
        incoming = actual or dict(self.truth)
        if "branch" not in incoming or "texture" not in incoming:
            raise ForageError("resolve needs branch and texture", 400)
        if incoming["branch"] not in self.branches:
            raise ForageError(f"unknown branch {incoming['branch']}", 404)
        if incoming["texture"] not in self.people:
            raise ForageError(f"unknown texture {incoming['texture']}", 404)
        if self.resolved:
            if incoming == self.actual:
                return self.surprise()
            raise ForageError("trial already resolved", 409)
        self.actual = incoming
        self.resolved = True
        self.frozen_joint = self.joint.copy()
        return self.surprise()

    def surprise(self) -> dict:
        truth = self.actual or self.truth
        b = self.branches.index(truth["branch"])
        t = self.people.index(truth["texture"])
        joint = float(self.belief[b, t])
        mass = branch_mass(self.belief)
        cond = texture_given_branch(self.belief, b)
        return {
            "truth": truth,
            "resolved": self.resolved,
            "surprise": -float(np.log(max(joint, EPS))),
            "surprise_branch": -float(np.log(max(mass[b], EPS))),
            "surprise_texture": -float(np.log(max(cond[t], EPS))),
            "q_truth": joint,
            "q_branch": float(mass[b]),
            "q_texture_given_branch": float(cond[t]),
        }

    def postdict(self) -> list[dict]:
        truth = self.actual or self.truth
        b = self.branches.index(truth["branch"])
        t = self.people.index(truth["texture"])
        ranked = []
        prior = self.belief
        for gaze in self.unread:
            cue_i = int(np.argmax(self.process_A[:, b, t, gaze]))
            A_g = self.model.A[:, :, :, gaze]
            like = A_g[cue_i].ravel()
            F_now = variational_free_energy(prior.ravel(), like, prior.ravel())["F"]
            fictive = infer_joint(cue_i, A_g, prior)
            F_after = variational_free_energy(fictive.ravel(), like, prior.ravel())["F"]
            ranked.append({
                "gaze": gaze,
                "item_id": self.items[gaze].id,
                "would_show": self.cues[cue_i],
                "delta_F": F_now - F_after,
            })
        ranked.sort(key=lambda row: row["delta_F"], reverse=True)
        return ranked

    def close_trial(self) -> None:
        self.model.d_joint = dirichlet_update_D(self.model.d_joint, self.belief)
        self.model.D_joint = self.model.d_joint / self.model.d_joint.sum()

    def assumptions(self) -> dict:
        mass = self.qs_branch
        future_unknowns = []
        if entropy(mass) > np.log(len(self.branches)) * 0.5:
            future_unknowns.append({
                "id": "branch",
                "question": "which Saturday branch",
                "mass": {name: float(m) for name, m in zip(self.branches, mass)},
            })
        for i, name in enumerate(self.branches):
            if self.is_past(name):
                continue
            cond = texture_given_branch(self.belief, i)
            if entropy(cond) > np.log(len(self.people)) * 0.5:
                future_unknowns.append({
                    "id": f"texture|{name}",
                    "question": f"who under {name}",
                    "mass": {person: float(m) for person, m in zip(self.people, cond)},
                })
        refused = [
            row for row in self.attention()
            if (not row["read"]) and row["epistemic"] < REFUSED_EPISTEMIC
        ]
        return {
            "question": self.question,
            "C": {cue: float(p) for cue, p in zip(self.cues, self.model.C)},
            "pin": self.pin,
            "past_branches": sorted(self.past_branches()),
            "future_unknowns": future_unknowns,
            "used": [rec.item_id for rec in self.log],
            "refused": [{"id": row["id"], "epistemic": row["epistemic"]} for row in refused],
            "factors": {"branch": list(self.branches), "texture": list(self.people)},
        }

    def snapshot(self) -> dict:
        return {
            "question": self.question,
            "subject": self.subject,
            "horizon": self.horizon,
            "pin": self.pin,
            "resolved": self.resolved,
            "actual": self.actual,
            "past_branches": sorted(self.past_branches()),
            "joint": self.belief.tolist(),
            "unread": [self.items[g].id for g in self.unread],
            "log": [
                {
                    "item_id": rec.item_id,
                    "cue": rec.cue,
                    "G": rec.G,
                    "branch_delta": rec.branch_delta,
                }
                for rec in self.log
            ],
            "pick": self.pick(),
        }

    def view(self) -> dict:
        """One payload the Forecast panel can render without a second round-trip."""
        picked = self.pick()
        mass = picked["branch_mass"]
        permutation_branch = self.pin or picked["branch"] or self.branches[int(np.argmax(self.qs_branch))]
        perms = self.permutations(permutation_branch)
        return {
            "question": self.question,
            "horizon": self.horizon,
            "kind": self.model.kind,
            "pin": self.pin,
            "resolved": self.resolved,
            "ready": picked["ready"],
            "pick": picked["branch"],
            "texture": picked["texture"],
            "texture_mass": picked["texture_mass"],
            "permutation_branch": permutation_branch,
            "branches": [
                {
                    "id": name,
                    "mass": mass[name],
                    "ready": picked["branch"] == name,
                    "past": self.is_past(name),
                    "pinned": self.pin == name,
                    "top_texture": max(self.permutations(name), key=self.permutations(name).get),
                }
                for name in self.branches
            ],
            "permutations": [{"label": person, "mass": value} for person, value in perms.items()],
            "interests": self.interests_for(permutation_branch),
            "attention": self.attention(),
            "reads": [
                {
                    "item_id": rec.item_id,
                    "cue": rec.cue,
                    "G": rec.G,
                    "epistemic": rec.epistemic,
                    "branch_delta": rec.branch_delta,
                }
                for rec in self.log
            ],
        }
