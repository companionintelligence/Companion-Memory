"""Dirichlet learning. Process Theory (2.7).

    a ← a + o ⊗ s          (likelihood counts)
    d ← d + s_1            (initial-state counts)

Concentration parameters are occurrence counts. The expected A is the
column-normalized a. We use a, not the digamma form ψ(a)−ψ(a₀), until
we need the full variational likelihood.
"""

from __future__ import annotations

import numpy as np

from .ops import normalize_columns


def dirichlet_update_A(
    concentration: np.ndarray,
    observation_index: int,
    qs: np.ndarray,
) -> np.ndarray:
    """a += o ⊗ s. ``concentration`` is (n_obs, n_states)."""
    updated = concentration.copy()
    updated[observation_index] += qs
    return updated


def dirichlet_update_D(concentration: np.ndarray, qs: np.ndarray) -> np.ndarray:
    """d += s_1."""
    return concentration + qs


def expected_A(concentration: np.ndarray) -> np.ndarray:
    """Ă = a / a₀. Process Theory (2.6) without the digamma."""
    return normalize_columns(concentration)
