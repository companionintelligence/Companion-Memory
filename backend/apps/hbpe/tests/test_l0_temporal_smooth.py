"""Tests for within-day L0 HMM smoothing."""

from __future__ import annotations

import numpy as np

from ci.hbpe.pipeline.l0_temporal_smooth import (
    default_l0_transition,
    forward_backward_smooth,
    smooth_l0_potentials,
)
from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES


def _one_hot(class_name: str, weight: float = 0.9) -> np.ndarray:
    vec = np.full(len(L0_CLASSES), (1.0 - weight) / (len(L0_CLASSES) - 1))
    vec[L0_CLASSES.index(class_name)] = weight
    return vec


def test_forward_backward_reduces_single_bucket_flicker():
    """A one-bucket WORK blip between TRANSIT blocks should soften."""
    transit = _one_hot("TRANSIT")
    work = _one_hot("WORK")

    emissions = np.vstack([transit, work, transit, transit])
    transition = default_l0_transition(stickiness=0.92)

    smoothed = forward_backward_smooth(emissions, transition)

    assert (
        smoothed[1, L0_CLASSES.index("WORK")] < emissions[1, L0_CLASSES.index("WORK")]
    )
    assert (
        smoothed[1, L0_CLASSES.index("TRANSIT")]
        > emissions[1, L0_CLASSES.index("TRANSIT")]
    )


def test_forward_backward_preserves_stable_run():
    """A long WORK block should stay WORK-dominant after smoothing."""
    work = _one_hot("WORK")
    emissions = np.vstack([work, work, work, work])
    transition = default_l0_transition(stickiness=0.9)

    smoothed = forward_backward_smooth(emissions, transition)

    work_idx = L0_CLASSES.index("WORK")
    assert np.all(smoothed[:, work_idx] > 0.85)


def test_transition_rows_stochastic():
    trans = default_l0_transition()
    assert trans.shape == (len(L0_CLASSES), len(L0_CLASSES))
    np.testing.assert_allclose(trans.sum(axis=1), np.ones(len(L0_CLASSES)), rtol=1e-6)


def test_smooth_l0_potentials_preserves_independence():
    """Potentials are smoothed per class and not forced to sum to 1."""
    raw = np.array(
        [
            [0.8, 0.2, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
            [0.2, 0.7, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
            [0.1, 0.1, 0.9, 0.1, 0.1, 0.1, 0.1, 0.1],
        ],
        dtype=np.float64,
    )
    smoothed = smooth_l0_potentials(raw, window=3)
    assert smoothed.shape == raw.shape
    assert smoothed[1].sum() > 1.0
    assert np.all(smoothed >= 0.0) and np.all(smoothed <= 1.0)
