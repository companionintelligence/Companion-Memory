"""Variational free energy F. Process Theory (2.4).

    F = E_Q[ln Q(x) − ln P(x, o)]
      = D[Q(x) || P(x|o)] − ln P(o)          bound on surprise
      = D[Q(x) || P(x)] − E_Q[ln P(o|x)]     complexity − accuracy

When Q = P(x|o), F equals surprise −ln P(o). Otherwise F is strictly larger.
"""

from __future__ import annotations

import numpy as np

from .ops import EPS, kl_divergence, log_stable


def variational_free_energy(
    qs: np.ndarray,
    likelihood_given_o: np.ndarray,
    prior: np.ndarray,
) -> dict:
    """One-factor, one-observation F.

    Parameters
    ----------
    qs
        Q(s), current beliefs over hidden states.
    likelihood_given_o
        P(o|s) as a vector over s for the *observed* outcome (one row of A).
    prior
        P(s), usually D or the predictive prior from B.
    """
    qs = np.clip(qs, EPS, None)
    qs = qs / qs.sum()
    prior = np.clip(prior, EPS, None)
    prior = prior / prior.sum()
    like = np.clip(likelihood_given_o, EPS, None)

    # accuracy = E_Q[ln P(o|s)]
    accuracy = float(np.dot(qs, log_stable(like)))
    complexity = kl_divergence(qs, prior)
    F = complexity - accuracy

    # exact surprise under this likelihood and prior (for the bound check)
    evidence = float(np.dot(prior, like))
    surprise = -float(np.log(max(evidence, EPS)))

    return {
        "F": F,
        "complexity": complexity,
        "accuracy": accuracy,
        "surprise": surprise,
    }
