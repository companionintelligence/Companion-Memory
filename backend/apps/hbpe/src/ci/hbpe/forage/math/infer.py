"""Belief updates. Process Theory (2.7).

Inference (one factor, observed o at time τ):

    s_τ = σ( Aᵀ o + ln B_{τ−1} s_{τ−1} + ln B_τᵀ s_{τ+1} )

For the first observation there is no future state yet, so the past
message is ln D. That is one-shot Bayes written as a softmax:

    s = σ( ln A[o, :] + ln D )

Policies:

    π = σ( −F − γ G )
"""

from __future__ import annotations

import numpy as np

from .ops import EPS, log_stable, softmax


def infer_states(
    observation_index: int,
    A: np.ndarray,
    prior: np.ndarray,
    future_message: np.ndarray | None = None,
) -> np.ndarray:
    """Posterior Q(s | o) from likelihood row A[o] and a predictive prior.

    ``future_message`` is the optional ln Bᵀ s_{τ+1} term from (2.7).
    """
    like = np.clip(A[observation_index], EPS, None)
    logits = log_stable(like) + log_stable(prior)
    if future_message is not None:
        logits = logits + future_message
    return softmax(logits)


def infer_factors(
    observation_index: int,
    A_gaze: np.ndarray,
    prior_branch: np.ndarray,
    prior_place: np.ndarray,
    steps: int = 8,
) -> tuple[np.ndarray, np.ndarray]:
    """Mean-field update: E[ln A], not ln E[A]. See factors.md.

    A_gaze is (n_obs, n_branch, n_place). Priors stay fixed. Q iterates.
        s_b = σ( ln D_b + Σ_p Q(p) ln A[o, b, p] )
        s_p = σ( ln D_p + Σ_b Q(b) ln A[o, b, p] )
    """
    logA = log_stable(A_gaze[observation_index])
    log_db = log_stable(prior_branch)
    log_dp = log_stable(prior_place)
    qs_b = np.asarray(prior_branch, dtype=float).copy()
    qs_p = np.asarray(prior_place, dtype=float).copy()
    qs_b = qs_b / qs_b.sum()
    qs_p = qs_p / qs_p.sum()
    for _ in range(steps):
        qs_b = softmax(log_db + logA @ qs_p)
        qs_p = softmax(log_dp + qs_b @ logA)
    return qs_b, qs_p


def infer_joint(
    observation_index: int,
    A_gaze: np.ndarray,
    prior_joint: np.ndarray,
) -> np.ndarray:
    """Exact Bayes on Q(branch, texture). A_gaze[o] is (n_branch, n_texture).

    Q(texture | branch) is then the renormalized row. That is the Jerry/Tom
    conditional the routes must return.
    """
    like = np.clip(A_gaze[observation_index], EPS, None)
    post = like * np.clip(prior_joint, EPS, None)
    total = float(post.sum())
    if total <= 0:
        post = np.clip(prior_joint, EPS, None)
        total = float(post.sum())
    return post / total


def policy_posterior(
    F: np.ndarray,
    G: np.ndarray,
    gamma: float = 1.0,
) -> np.ndarray:
    """π = σ(−F − γ G). Process Theory (2.7)."""
    return softmax(-np.asarray(F, dtype=float) - gamma * np.asarray(G, dtype=float))
