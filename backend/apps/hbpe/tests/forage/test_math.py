"""Identities from Process Theory (2.4)–(2.7)."""

import numpy as np
import pytest

from ci.hbpe.forage.math.expected import (
    column_entropy,
    expected_free_energy,
    expected_free_energy_from_joint,
    expected_free_energy_joint,
)
from ci.hbpe.forage.math.infer import infer_factors, infer_joint, infer_states, policy_posterior
from ci.hbpe.forage.math.learn import dirichlet_update_A, expected_A
from ci.hbpe.forage.math.ops import kl_divergence, log_stable, softmax
from ci.hbpe.forage.math.variational import variational_free_energy


def test_softmax_is_a_distribution():
    p = softmax(np.array([1.0, 2.0, 3.0]))
    assert p.sum() == pytest.approx(1.0)
    assert np.all(p > 0)


def test_F_is_at_least_surprise():
    """(2.4): F = D[Q||P(s|o)] − ln P(o) ≥ −ln P(o)."""
    prior = np.array([0.5, 0.5])
    like = np.array([0.9, 0.1])  # P(o|s)
    evidence = prior @ like
    true_posterior = prior * like
    true_posterior = true_posterior / true_posterior.sum()

    at_opt = variational_free_energy(true_posterior, like, prior)
    assert at_opt["F"] == pytest.approx(at_opt["surprise"], abs=1e-9)
    assert at_opt["surprise"] == pytest.approx(-np.log(evidence), abs=1e-9)

    worse = variational_free_energy(np.array([0.1, 0.9]), like, prior)
    assert worse["F"] > at_opt["F"]


def test_G_is_risk_plus_ambiguity():
    """(2.6): G = o·(ln o − U) + s·H = risk + ambiguity."""
    A = np.array([
        [0.8, 0.1],
        [0.2, 0.9],
    ])
    qs = np.array([0.5, 0.5])
    C = np.array([0.5, 0.5])
    out = expected_free_energy(qs, A, C)
    assert out["G"] == pytest.approx(out["risk"] + out["ambiguity"], abs=1e-9)
    assert out["epistemic"] >= -1e-9
    H = column_entropy(A)
    assert out["ambiguity"] == pytest.approx(float(qs @ H), abs=1e-9)


def test_G_prefers_informative_columns():
    """A sure observation has lower G than a coin-flip observation when C is flat."""
    sure = np.array([[0.99, 0.01], [0.01, 0.99]], dtype=float)
    noisy = np.array([[0.5, 0.5], [0.5, 0.5]], dtype=float)
    qs = np.array([0.5, 0.5])
    C = np.array([0.5, 0.5])
    g_sure = expected_free_energy(qs, sure, C)
    g_noisy = expected_free_energy(qs, noisy, C)
    assert g_sure["G"] < g_noisy["G"]
    assert g_sure["epistemic"] > g_noisy["epistemic"]


def test_infer_states_matches_bayes():
    A = np.array([[0.9, 0.2], [0.1, 0.8]])
    prior = np.array([0.5, 0.5])
    qs = infer_states(0, A, prior)
    expected = prior * A[0]
    expected = expected / expected.sum()
    np.testing.assert_allclose(qs, expected, atol=1e-9)


def test_policy_posterior_softmax_of_minus_G():
    G = np.array([1.0, 0.1, 2.0])
    pi = policy_posterior(np.zeros(3), G, gamma=1.0)
    np.testing.assert_allclose(pi, softmax(-G), atol=1e-9)
    assert pi[1] == max(pi)


def test_dirichlet_update_moves_A_toward_observation():
    a = np.ones((2, 2))
    qs = np.array([1.0, 0.0])
    a2 = dirichlet_update_A(a, 0, qs)
    A = expected_A(a2)
    assert A[0, 0] > A[1, 0]


def test_kl_zero_when_equal():
    p = np.array([0.2, 0.5, 0.3])
    assert kl_divergence(p, p) == pytest.approx(0.0, abs=1e-12)


def test_joint_G_matches_one_factor_when_place_is_a_point():
    """If Q(place) is a delta, joint G equals the one-factor G on that slice."""
    A = np.zeros((2, 2, 2))
    A[:, :, 0] = [[0.9, 0.2], [0.1, 0.8]]
    A[:, :, 1] = [[0.5, 0.5], [0.5, 0.5]]
    qs_b = np.array([0.5, 0.5])
    qs_p = np.array([1.0, 0.0])
    C = np.array([0.5, 0.5])
    joint = expected_free_energy_joint(qs_b, qs_p, A, C)
    single = expected_free_energy(qs_b, A[:, :, 0], C)
    assert joint["G"] == pytest.approx(single["G"], abs=1e-9)
    assert joint["G"] == pytest.approx(joint["risk"] + joint["ambiguity"], abs=1e-9)


def test_infer_factors_uses_expected_log():
    """A cue that only fires at (beach, santa_cruz) should lift both sliders."""
    A = np.full((2, 2, 2), 0.05)
    A[0, 0, 0] = 0.95
    A[1, 0, 0] = 0.05
    A[1, 0, 1] = 0.95
    A[1, 1, 0] = 0.95
    A[1, 1, 1] = 0.95
    prior = np.array([0.5, 0.5])
    qb, qp = infer_factors(0, A, prior, prior)
    assert qb[0] > qb[1]
    assert qp[0] > qp[1]


def test_infer_joint_renormalizes_texture_given_branch():
    A = np.full((2, 2, 2), 0.05)
    A[0, 0, 0] = 0.9
    A[1, 0, 0] = 0.1
    A[0, 0, 1] = 0.1
    A[1, 0, 1] = 0.9
    prior = np.ones((2, 2)) / 4.0
    post = infer_joint(0, A, prior)
    beach = post[0] / post[0].sum()
    assert beach[0] > beach[1]


def test_from_joint_matches_product_when_independent():
    A = np.zeros((2, 2, 2))
    A[:, :, 0] = [[0.9, 0.2], [0.1, 0.8]]
    A[:, :, 1] = [[0.5, 0.5], [0.5, 0.5]]
    qs_b = np.array([0.5, 0.5])
    qs_t = np.array([1.0, 0.0])
    C = np.array([0.5, 0.5])
    product = expected_free_energy_joint(qs_b, qs_t, A, C)
    joint = expected_free_energy_from_joint(np.outer(qs_b, qs_t), A, C)
    assert joint["G"] == pytest.approx(product["G"], abs=1e-9)


def test_ln_E_A_is_not_E_ln_A():
    """Documents the Jensen gap we used to ship."""
    A_row = np.array([0.9, 0.1])
    qs = np.array([0.5, 0.5])
    ln_E = np.log(A_row @ qs)
    E_ln = qs @ log_stable(A_row)
    assert ln_E > E_ln
