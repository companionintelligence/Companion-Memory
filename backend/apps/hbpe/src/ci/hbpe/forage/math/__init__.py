"""Paper-backed free-energy primitives. Each module cites the equation it implements."""

from .ops import entropy, kl_divergence, log_stable, normalize_columns, softmax
from .variational import variational_free_energy
from .expected import (
    expected_free_energy,
    expected_free_energy_from_joint,
    expected_free_energy_joint,
)
from .infer import infer_factors, infer_joint, infer_states, policy_posterior
from .learn import dirichlet_update_A, dirichlet_update_D

__all__ = [
    "entropy",
    "kl_divergence",
    "log_stable",
    "normalize_columns",
    "softmax",
    "variational_free_energy",
    "expected_free_energy",
    "expected_free_energy_joint",
    "expected_free_energy_from_joint",
    "infer_states",
    "infer_factors",
    "infer_joint",
    "policy_posterior",
    "dirichlet_update_A",
    "dirichlet_update_D",
]
