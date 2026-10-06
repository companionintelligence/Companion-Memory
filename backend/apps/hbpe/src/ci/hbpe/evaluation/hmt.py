"""
Adapter for the deployed HMT path, kept out of ``forecaster.py`` on purpose.

Importing this module pulls in the inference engine, and with it ONNX Runtime,
torch and a live database connection.  The reference forecasters must stay
importable without any of that so the harness can run — and be unit-tested —
on a machine with no checkpoint and no Postgres.

⚠ Leakage caveat.  Every other forecaster receives a pre-filtered ``history``
and physically cannot see past it.  ``InferenceEngine`` does not: it fetches
its own occupancy rows from the database and manages the cutoff internally via
``as_of``.  The engine's window loop reads ``as_of - (i + 1)`` days, so it
starts at the day before the target and is correct as written — but that is a
property of the engine, verified by reading it, not a guarantee this harness
enforces.  Treat the ``hmt`` row as trustworthy to the extent that
``inference_engine.predict``'s own walk-forward is.
"""

from __future__ import annotations

import datetime
from collections.abc import Sequence

import numpy as np

from ci.hbpe.buckets import BUCKETS_PER_DAY
from ci.hbpe.evaluation.forecaster import N_CLASSES, DayFit
from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES


class HmtForecaster:
    """
    The transformer as the serving path actually runs it.

    ``force_model='hmt'`` bypasses the D3 gate so this row measures the model
    rather than the gate's fallback to B2 — the gate is then re-applied
    separately by ``WalkForwardResult.served_verdict``.

    ``force_model`` is not absolute: with no checkpoint on disk the engine runs
    no transformer windows and silently serves B1 instead (``predict``'s
    ``served == MODEL_HMT and hmt_days == 0`` branch).  The returned buckets
    carry no model tag, so without the check below the harness would label a
    B1-plus-HMM curve ``hmt`` and score it against B1 as if it were a rival.
    """

    name = "hmt"

    def __init__(self, user_id: str, device: str = "cpu") -> None:
        from ci.hbpe.pipeline.inference_engine import InferenceEngine

        self.user_id = user_id
        self._engine = InferenceEngine(user_id, device=device)

    def forecast(
        self,
        history: Sequence[dict],
        target_date: datetime.date,
        fit: DayFit,
    ) -> np.ndarray:
        horizon_start = datetime.datetime(
            target_date.year, target_date.month, target_date.day
        )
        buckets = self._engine.predict(
            horizon_start=horizon_start,
            as_of=target_date,
            force_model="hmt",
        )
        served = self._engine.last_model_version
        if served != "hmt":
            raise RuntimeError(
                f"engine served {served!r}, not 'hmt', for {target_date}: there is "
                f"no usable checkpoint for user {self.user_id}, so this row would "
                f"report {served!r} under the name 'hmt'. Train a checkpoint, or "
                f"drop --with-hmt."
            )
        out = np.full((BUCKETS_PER_DAY, N_CLASSES), 1.0 / N_CLASSES, dtype=np.float64)
        for entry in buckets:
            idx = int(entry["bucket_index"])
            if idx < 0 or idx >= BUCKETS_PER_DAY:
                continue
            probs = entry.get("l0_probs") or {}
            vec = np.array(
                [float(probs.get(c, 0.0)) for c in L0_CLASSES], dtype=np.float64
            )
            total = vec.sum()
            if total > 0:
                out[idx] = vec / total
        return out
