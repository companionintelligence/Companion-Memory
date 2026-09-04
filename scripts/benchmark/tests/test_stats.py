"""Edge cases for the stats helpers used in multi-run aggregation."""

from __future__ import annotations

import math

import pytest
from benchmark.stats import describe, iqr, mean, median, stddev

# ── median ──────────────────────────────────────────────────────────────────


def test_median_empty_returns_zero():
    assert median([]) == 0.0


def test_median_single_element():
    assert median([42]) == 42.0


def test_median_odd_length_picks_middle():
    assert median([3, 1, 2]) == 2.0


def test_median_even_length_averages_middle_pair():
    assert median([1, 2, 3, 4]) == 2.5


def test_median_identical_values():
    assert median([7, 7, 7, 7]) == 7.0


# ── mean ────────────────────────────────────────────────────────────────────


def test_mean_empty_returns_zero():
    assert mean([]) == 0.0


def test_mean_single_value():
    assert mean([5]) == 5.0


def test_mean_basic():
    assert mean([1, 2, 3, 4, 5]) == pytest.approx(3.0)


# ── iqr ─────────────────────────────────────────────────────────────────────


def test_iqr_empty_returns_zero():
    assert iqr([]) == 0.0


def test_iqr_single_value_returns_zero():
    assert iqr([10]) == 0.0


def test_iqr_identical_values_returns_zero():
    assert iqr([5, 5, 5, 5, 5]) == 0.0


def test_iqr_known_dataset():
    # statistics.quantiles([1..9], n=4) → [2.5, 5.0, 7.5]; IQR = 5.0
    assert iqr([1, 2, 3, 4, 5, 6, 7, 8, 9]) == pytest.approx(5.0)


# ── stddev ──────────────────────────────────────────────────────────────────


def test_stddev_empty_returns_zero():
    assert stddev([]) == 0.0


def test_stddev_single_value_returns_zero_not_raises():
    # pstdev is population stddev so n=1 is well-defined as 0.0.
    assert stddev([42]) == 0.0


def test_stddev_identical_values_returns_zero():
    assert stddev([3, 3, 3]) == 0.0


def test_stddev_known_dataset():
    # pstdev([1, 2, 3, 4, 5]) ~ sqrt(2)
    assert stddev([1, 2, 3, 4, 5]) == pytest.approx(math.sqrt(2.0))


# ── describe ────────────────────────────────────────────────────────────────


def test_describe_empty_returns_empty_dict():
    assert describe([]) == {}


def test_describe_single_value_is_self_consistent():
    d = describe([7.5])
    assert d["median"] == 7.5
    assert d["mean"] == 7.5
    assert d["min"] == 7.5
    assert d["max"] == 7.5
    assert d["iqr"] == 0.0
    assert d["stddev"] == 0.0
    assert d["count"] == 1.0


def test_describe_multi_value_has_all_keys():
    d = describe([1, 2, 3, 4, 5])
    for k in ("median", "mean", "min", "max", "iqr", "stddev", "count"):
        assert k in d
    assert d["min"] == 1.0
    assert d["max"] == 5.0
    assert d["count"] == 5.0


def test_describe_accepts_floats_and_ints_mixed():
    d = describe([1, 2.5, 3])
    assert d["min"] == 1.0
    assert d["max"] == 3.0
    assert isinstance(d["mean"], float)
