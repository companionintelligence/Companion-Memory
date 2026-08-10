"""Tests for independent L0 energy-potential inference."""

from __future__ import annotations

import numpy as np

from ci.hbpe.pipeline.inference_engine import _logits_to_potentials, _sigmoid
from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES


def test_sigmoid_bounds():
    x = np.array([-5.0, 0.0, 5.0])
    y = _sigmoid(x)
    assert np.all(y >= 0.0) and np.all(y <= 1.0)


def test_logits_to_potentials_are_independent():
    logits = np.zeros(12)
    logits[4] = 2.0  # WORK
    logits[5] = 2.0  # EXERCISE
    potentials = _logits_to_potentials(logits, temperature=1.0, vocab_size=12)
    work = potentials[4]
    exercise = potentials[5]
    assert 0.0 < work < 1.0
    assert 0.0 < exercise < 1.0
    assert abs(work - exercise) < 1e-6
    assert potentials[4 : 4 + len(L0_CLASSES)].sum() > 1.0


def test_logits_to_potentials_ignore_special_tokens():
    logits = np.zeros(12)
    logits[0] = 100.0  # PAD should not affect behavioral potentials
    potentials = _logits_to_potentials(logits, temperature=1.0, vocab_size=12)
    assert np.allclose(potentials[4:], 0.5)
