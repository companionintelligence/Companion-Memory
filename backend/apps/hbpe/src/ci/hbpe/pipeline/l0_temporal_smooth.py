"""
Within-day L0 temporal smoothing for histogram inference.

The transformer scores each 15-minute bucket independently, which produces
 unrealistic flicker (e.g. TRANSIT → WORK → TRANSIT).  We treat the raw
 per-bucket class distributions as HMM emissions and smooth them with a
 row-stochastic transition matrix learned from hbpe.token_stream, blended
 with a sticky prior so contiguous activity blocks stay coherent.
"""

from __future__ import annotations

import logging

import numpy as np
import psycopg2.extras

from ci.hbpe.database import get_conn
from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES

log = logging.getLogger(__name__)

L0_INDEX = {name: i for i, name in enumerate(L0_CLASSES)}
NUM_L0 = len(L0_CLASSES)

# Prior stickiness when empirical transitions are sparse.
DEFAULT_STICKINESS = 0.9
TRANSITION_LOOKBACK_DAYS = 90
MIN_TRANSITIONS_FOR_FULL_EMPIRICAL = 400


def default_l0_transition(stickiness: float = DEFAULT_STICKINESS) -> np.ndarray:
    """Row-stochastic prior: likely to stay in the same L0 class bucket-to-bucket."""
    off = (1.0 - stickiness) / max(NUM_L0 - 1, 1)
    trans = np.full((NUM_L0, NUM_L0), off, dtype=np.float64)
    np.fill_diagonal(trans, stickiness)
    return trans


def counts_to_transition(
    counts: np.ndarray, stickiness: float = DEFAULT_STICKINESS
) -> np.ndarray:
    """Laplace-smoothed row-stochastic matrix from an (C, C) count matrix."""
    counts = np.asarray(counts, dtype=np.float64)
    if counts.shape != (NUM_L0, NUM_L0):
        raise ValueError(f"Expected transition counts shape ({NUM_L0}, {NUM_L0})")

    prior = default_l0_transition(stickiness) * 2.0  # weak Dirichlet prior
    blended = counts + prior
    row_sums = blended.sum(axis=1, keepdims=True)
    row_sums = np.maximum(row_sums, 1e-12)
    return blended / row_sums


def fetch_l0_transition_counts(
    user_id: str, lookback_days: int = TRANSITION_LOOKBACK_DAYS
) -> np.ndarray:
    """
    Count adjacent-bucket L0 transitions from token_stream.

    Only consecutive bucket indices within the same calendar day contribute
    (b → b+1), matching how the histogram is read left-to-right through the day.
    """
    sql = """
        SELECT date, bucket_idx, token_id
        FROM hbpe.token_stream
        WHERE user_id = %s
          AND level = 'L0'
          AND token_id NOT IN ('SOD', 'EOD')
          AND date >= CURRENT_DATE - %s::int
        ORDER BY date, bucket_idx, seq_order
    """
    counts = np.zeros((NUM_L0, NUM_L0), dtype=np.float64)

    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (user_id, lookback_days))
            rows = cur.fetchall()

    by_day: dict[object, dict[int, str]] = {}
    for row in rows:
        cls = row["token_id"]
        if cls not in L0_INDEX:
            continue
        day = row["date"]
        bucket = int(row["bucket_idx"])
        by_day.setdefault(day, {})[bucket] = cls

    for buckets in by_day.values():
        for b, cls_from in buckets.items():
            cls_to = buckets.get(b + 1)
            if cls_to is None:
                continue
            counts[L0_INDEX[cls_from], L0_INDEX[cls_to]] += 1.0

    return counts


def build_l0_transition(user_id: str) -> np.ndarray:
    """Empirical transition matrix blended with a sticky default."""
    counts = fetch_l0_transition_counts(user_id)
    total = counts.sum()
    empirical = counts_to_transition(counts)
    prior = default_l0_transition()

    if total < 1:
        return prior

    weight = min(1.0, total / MIN_TRANSITIONS_FOR_FULL_EMPIRICAL)
    trans = weight * empirical + (1.0 - weight) * prior
    row_sums = trans.sum(axis=1, keepdims=True)
    return trans / np.maximum(row_sums, 1e-12)


def _logsumexp(a: np.ndarray, axis: int = -1) -> np.ndarray:
    a_max = np.max(a, axis=axis, keepdims=True)
    stable = np.exp(a - a_max)
    return np.log(np.sum(stable, axis=axis)) + np.squeeze(a_max, axis=axis)


def forward_backward_smooth(
    emissions: np.ndarray,
    transition: np.ndarray,
) -> np.ndarray:
    """
    HMM forward–backward smoothing over a single day's bucket chain.

    Args:
        emissions: (T, C) row-stochastic class probabilities per bucket.
        transition: (C, C) row-stochastic P(class_t | class_{t-1}).

    Returns:
        (T, C) smoothed row-stochastic probabilities.
    """
    emissions = np.asarray(emissions, dtype=np.float64)
    transition = np.asarray(transition, dtype=np.float64)

    if emissions.ndim != 2 or emissions.shape[1] != NUM_L0:
        raise ValueError(f"Expected emissions shape (T, {NUM_L0})")
    if transition.shape != (NUM_L0, NUM_L0):
        raise ValueError(f"Expected transition shape ({NUM_L0}, {NUM_L0})")

    t_steps, _ = emissions.shape
    if t_steps == 0:
        return emissions
    if t_steps == 1:
        return emissions.copy()

    eps = 1e-12
    log_emit = np.log(np.clip(emissions, eps, 1.0))
    log_trans = np.log(np.clip(transition, eps, 1.0))
    log_start = np.log(np.full(NUM_L0, 1.0 / NUM_L0))

    log_alpha = np.zeros((t_steps, NUM_L0))
    log_alpha[0] = log_start + log_emit[0]
    for t in range(1, t_steps):
        prev = log_alpha[t - 1][:, np.newaxis] + log_trans
        log_alpha[t] = log_emit[t] + _logsumexp(prev, axis=0)

    log_beta = np.zeros((t_steps, NUM_L0))
    for t in range(t_steps - 2, -1, -1):
        nxt = log_trans + log_emit[t + 1] + log_beta[t + 1]
        log_beta[t] = _logsumexp(nxt, axis=1)

    log_joint = log_alpha + log_beta
    log_joint -= _logsumexp(log_joint, axis=1)[:, np.newaxis]
    smoothed = np.exp(log_joint)
    row_sums = smoothed.sum(axis=1, keepdims=True)
    return smoothed / np.maximum(row_sums, eps)


def smooth_l0_potentials(
    potentials: np.ndarray,
    window: int = 3,
) -> np.ndarray:
    """
    Temporal smooth for independent per-class energy potentials.

    Each L0 class is averaged over a small time window. Rows are NOT
    renormalized — potentials stay independent and need not sum to 1.
    """
    potentials = np.asarray(potentials, dtype=np.float64)
    if potentials.ndim != 2 or potentials.shape[1] != NUM_L0:
        raise ValueError(f"Expected potentials shape (T, {NUM_L0})")

    t_steps = potentials.shape[0]
    if t_steps <= 1 or window <= 1:
        return np.clip(potentials.copy(), 0.0, 1.0)

    half = window // 2
    out = np.zeros_like(potentials)
    for c in range(NUM_L0):
        for t in range(t_steps):
            lo = max(0, t - half)
            hi = min(t_steps, t + half + 1)
            out[t, c] = potentials[lo:hi, c].mean()
    return np.clip(out, 0.0, 1.0)


def smooth_l0_emission_matrix(
    user_id: str,
    class_probs: np.ndarray,
) -> np.ndarray:
    """Apply user-specific transition smoothing to a (T, 8) L0 matrix."""
    try:
        transition = build_l0_transition(user_id)
        return forward_backward_smooth(class_probs, transition)
    except Exception:
        log.exception("L0 temporal smooth failed — returning raw emissions")
        return class_probs
