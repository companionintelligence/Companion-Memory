"""Expected free energy G. Process Theory (2.5)–(2.6).

    G(π, τ) = D[Q(o_τ|π) || P(o_τ)] + E_Q[H[P(o_τ|s_τ)]]
            = o_π · (ln o_τ − U) + s_π · H
              risk                     + ambiguity

Equivalent split (2.5): G = −epistemic − extrinsic,
where epistemic is mutual information I(S;O|π) and extrinsic is E[U(o)].

Risk is KL from predicted outcomes to preferences C = P(o) = σ(U).
Ambiguity is the expected column-entropy of A: how noisy the observation
would be even if the state were known.
"""

from __future__ import annotations

import numpy as np

from .ops import EPS, kl_divergence, log_stable


def column_entropy(A: np.ndarray) -> np.ndarray:
    """H_j = −Σ_i A_{ij} ln A_{ij}. Process Theory (2.6): H = −diag(Ă · A)."""
    A = np.clip(A, EPS, None)
    return -np.sum(A * np.log(A), axis=0)


def expected_free_energy(
    qs: np.ndarray,
    A: np.ndarray,
    preferences: np.ndarray,
) -> dict:
    """G for a one-step look-ahead under current beliefs qs.

    A is (n_obs, n_states). preferences is C = P(o), a distribution over
    outcomes (softmax of utility U).
    """
    qs = np.clip(qs, EPS, None)
    qs = qs / qs.sum()
    C = np.clip(preferences, EPS, None)
    C = C / C.sum()

    qo = A @ qs
    qo = np.clip(qo, EPS, None)
    qo = qo / qo.sum()

    risk = kl_divergence(qo, C)
    H = column_entropy(A)
    ambiguity = float(np.dot(qs, H))
    G = risk + ambiguity

    outcome_entropy = float(-np.dot(qo, log_stable(qo)))
    epistemic = outcome_entropy - ambiguity
    extrinsic = float(np.dot(qo, log_stable(C)))

    return {
        "G": G,
        "risk": risk,
        "ambiguity": ambiguity,
        "epistemic": epistemic,
        "extrinsic": extrinsic,
        "qo": qo,
    }


def expected_free_energy_joint(
    qs_branch: np.ndarray,
    qs_place: np.ndarray,
    A_gaze: np.ndarray,
    preferences: np.ndarray,
) -> dict:
    """G under Q(branch)Q(place) and A[:, :, :] at one gaze.

    A_gaze is (n_obs, n_branch, n_place). This is (2.6) with a factorized
    state, not an average of two one-factor G's.
    """
    qs_branch = np.clip(qs_branch, EPS, None)
    qs_branch = qs_branch / qs_branch.sum()
    qs_place = np.clip(qs_place, EPS, None)
    qs_place = qs_place / qs_place.sum()
    C = np.clip(preferences, EPS, None)
    C = C / C.sum()

    qo = np.einsum("obp,b,p->o", A_gaze, qs_branch, qs_place)
    qo = np.clip(qo, EPS, None)
    qo = qo / qo.sum()

    risk = kl_divergence(qo, C)
    H = -np.sum(np.clip(A_gaze, EPS, None) * np.log(np.clip(A_gaze, EPS, None)), axis=0)
    ambiguity = float(np.einsum("bp,b,p->", H, qs_branch, qs_place))
    G = risk + ambiguity

    outcome_entropy = float(-np.dot(qo, log_stable(qo)))
    epistemic = outcome_entropy - ambiguity
    extrinsic = float(np.dot(qo, log_stable(C)))

    return {
        "G": G,
        "risk": risk,
        "ambiguity": ambiguity,
        "epistemic": epistemic,
        "extrinsic": extrinsic,
        "qo": qo,
    }


def expected_free_energy_from_joint(
    joint: np.ndarray,
    A_gaze: np.ndarray,
    preferences: np.ndarray,
) -> dict:
    """G under a full Q(branch, texture), not Q(b)Q(t)."""
    joint = np.clip(joint, EPS, None)
    joint = joint / joint.sum()
    C = np.clip(preferences, EPS, None)
    C = C / C.sum()

    qo = np.einsum("obt,bt->o", A_gaze, joint)
    qo = np.clip(qo, EPS, None)
    qo = qo / qo.sum()

    risk = kl_divergence(qo, C)
    H = -np.sum(np.clip(A_gaze, EPS, None) * np.log(np.clip(A_gaze, EPS, None)), axis=0)
    ambiguity = float(np.einsum("bt,bt->", H, joint))
    G = risk + ambiguity
    outcome_entropy = float(-np.dot(qo, log_stable(qo)))
    return {
        "G": G,
        "risk": risk,
        "ambiguity": ambiguity,
        "epistemic": outcome_entropy - ambiguity,
        "extrinsic": float(np.dot(qo, log_stable(C))),
        "qo": qo,
    }
