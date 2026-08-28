"""Mint-time label gates — junk names never become vocab."""

from __future__ import annotations

from ci.hbpe.tokenizer.label_quality import (
    FALLBACK_LABEL,
    is_displayable_label,
    is_thinking_echo,
    nearest_label,
)


def test_rejects_tokenizer_junk():
    assert not is_displayable_label("No_think")
    assert not is_displayable_label("No Think")
    assert not is_displayable_label("UNKNOWN")
    assert not is_displayable_label("Drs")
    assert not is_displayable_label("Air_2")
    assert not is_displayable_label("Ransom")
    assert not is_displayable_label("general")
    assert is_thinking_echo("no_think")


def test_accepts_life_labels():
    assert is_displayable_label("Standup")
    assert is_displayable_label("Beach trip")
    assert is_displayable_label(FALLBACK_LABEL)


def test_nearest_label_picks_overlap():
    assert nearest_label("Stand-up", ["Standup", "Gym"]) == "Standup"
    assert nearest_label("zzz", []) is None
