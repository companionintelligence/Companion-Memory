"""Tests for 30-min → 15-min bucket migration helpers."""

from __future__ import annotations

from ci.hbpe.buckets import (
    LEGACY_MAX_BUCKET_INDEX,
    MAX_BUCKET_INDEX,
    detect_legacy_token_stream,
    legacy_hist_to_forecast_buckets,
)


def test_detect_legacy_from_eod_at_47():
    tokens = [
        {"level": "SOD", "token_id": "SOD", "bucket_idx": 0},
        {"level": "EOD", "token_id": "EOD", "bucket_idx": LEGACY_MAX_BUCKET_INDEX},
    ]
    assert detect_legacy_token_stream(tokens) is True


def test_detect_current_from_eod_at_95():
    tokens = [
        {"level": "SOD", "token_id": "SOD", "bucket_idx": 0},
        {"level": "EOD", "token_id": "EOD", "bucket_idx": MAX_BUCKET_INDEX},
    ]
    assert detect_legacy_token_stream(tokens) is False


def test_detect_current_from_bucket_above_legacy_max():
    tokens = [{"level": "L0", "token_id": "WORK", "bucket_idx": 50}]
    assert detect_legacy_token_stream(tokens) is False


def test_legacy_hist_to_forecast_buckets():
    assert legacy_hist_to_forecast_buckets(0) == [0, 1]
    assert legacy_hist_to_forecast_buckets(10) == [20, 21]
    assert legacy_hist_to_forecast_buckets(47) == [94, 95]
