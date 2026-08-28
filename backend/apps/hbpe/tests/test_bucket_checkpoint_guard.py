"""Guard: ONNX pos_emb width must match current BUCKETS_PER_DAY and D_MODEL."""

from __future__ import annotations

from pathlib import Path

import pytest

from ci.hbpe.buckets import BUCKETS_PER_DAY
from ci.hbpe.model.transformer import D_MODEL
from ci.hbpe.pipeline import inference_engine as ie


def test_assert_accepts_matching_resolution(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ie, "_onnx_pos_emb_dims", lambda _path: (BUCKETS_PER_DAY, D_MODEL))
    ie._assert_checkpoint_bucket_resolution(Path("ok.onnx"))


def test_assert_skips_when_pos_emb_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ie, "_onnx_pos_emb_dims", lambda _path: None)
    ie._assert_checkpoint_bucket_resolution(Path("opaque.onnx"))


def test_assert_rejects_mismatched_resolution(monkeypatch: pytest.MonkeyPatch) -> None:
    stale_rows = 96 if BUCKETS_PER_DAY != 96 else 48
    monkeypatch.setattr(ie, "_onnx_pos_emb_dims", lambda _path: (stale_rows, D_MODEL))
    with pytest.raises(ValueError, match="pos_emb has"):
        ie._assert_checkpoint_bucket_resolution(Path("stale.onnx"))


def test_assert_rejects_mismatched_d_model(monkeypatch: pytest.MonkeyPatch) -> None:
    stale_width = 64 if D_MODEL != 64 else 32
    monkeypatch.setattr(
        ie, "_onnx_pos_emb_dims", lambda _path: (BUCKETS_PER_DAY, stale_width)
    )
    with pytest.raises(ValueError, match="pos_emb width"):
        ie._assert_checkpoint_bucket_resolution(Path("toy.onnx"))
