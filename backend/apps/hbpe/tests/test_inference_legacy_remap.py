"""Tests for legacy bucket remapping during histogram aggregation."""

from __future__ import annotations

import datetime
from unittest.mock import MagicMock, patch

import numpy as np

from ci.hbpe.pipeline.inference_engine import InferenceEngine


def _make_engine() -> InferenceEngine:
    engine = InferenceEngine.__new__(InferenceEngine)
    engine.user_id = "user-test"
    engine.device = "cpu"
    engine._l0_vocab = MagicMock()
    engine._l0_vocab.__len__.return_value = 12
    engine._l1_vocab = MagicMock()
    engine._l1_vocab.__len__.return_value = 4
    engine._l1_display_names = {}
    engine._onnx_seq_len = None
    engine._l1_dim = 4
    engine._session_path = None
    engine._session_mtime = None
    engine._session = MagicMock()
    engine._temp = 1.0
    engine._output_cache = {}
    engine._l0_transition = None
    return engine


def test_predict_remaps_legacy_day_across_full_forecast():
    engine = _make_engine()
    logits = np.zeros(12, dtype=np.float32)
    logits[4] = 3.0  # WORK slot in vocab

    legacy_day = {
        "legacy": True,
        "l0": {10: logits.copy(), 20: logits.copy()},
        "l1": {},
    }

    with (
        patch.object(engine, "_try_reload_session"),
        patch.object(engine, "_reload_if_model_changed"),
        patch.object(engine, "_get_day_output", return_value=legacy_day),
        patch.object(
            engine, "_smooth_l0_potentials_across_day", side_effect=lambda x: x
        ),
    ):
        buckets = engine.predict(horizon_start=datetime.datetime(2026, 8, 11, 0, 0, 0))

    by_index = {b["bucket_index"]: b for b in buckets}
    assert by_index[20]["l0_probs"]["WORK"] > 0.6
    assert by_index[21]["l0_probs"]["WORK"] > 0.6
    assert by_index[40]["l0_probs"]["WORK"] > 0.6
    assert by_index[41]["l0_probs"]["WORK"] > 0.6
    assert by_index[80]["l0_probs"]["WORK"] == 0.5
