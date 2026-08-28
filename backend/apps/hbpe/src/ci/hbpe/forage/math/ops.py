"""Numerics used by every free-energy module."""

from __future__ import annotations

import numpy as np

EPS = 1e-16


def log_stable(x: np.ndarray) -> np.ndarray:
    return np.log(np.clip(x, EPS, None))


def softmax(logits: np.ndarray) -> np.ndarray:
    """σ(z) from (2.1) / (2.7). Column-stable."""
    shifted = logits - np.max(logits)
    exp = np.exp(shifted)
    return exp / exp.sum()


def normalize_columns(matrix: np.ndarray) -> np.ndarray:
    """Each column is P(row | column). A and B are stored this way."""
    denom = matrix.sum(axis=0, keepdims=True)
    denom = np.where(denom <= 0, 1.0, denom)
    return matrix / denom


def kl_divergence(q: np.ndarray, p: np.ndarray) -> float:
    """D[Q || P] = E_Q[ln Q − ln P]."""
    q = np.clip(q, EPS, None)
    p = np.clip(p, EPS, None)
    q = q / q.sum()
    p = p / p.sum()
    return float(np.sum(q * (np.log(q) - np.log(p))))


def entropy(p: np.ndarray) -> float:
    """H[P] = −E_P[ln P]."""
    p = np.clip(p, EPS, None)
    p = p / p.sum()
    return float(-np.sum(p * np.log(p)))
