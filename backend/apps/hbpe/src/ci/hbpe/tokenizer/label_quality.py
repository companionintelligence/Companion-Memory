"""
Mint-time gates for L1/L2 names.

Keep in sync with frontend/apps/web/src/lib/forecastDisplay.ts and
backend/.../forecastQuality.ts — junk tokenizer names never become vocab.
"""

from __future__ import annotations

import re

NEWS_LIKE = {
    "ransom",
    "activist",
    "riot",
    "hostage",
    "protest",
    "shooting",
    "war",
    "attack",
}

JUNK_PHRASES = {
    "nothink",
    "noidea",
    "unknown",
    "unsorted",
    "general",
    # The labeler prompt's own placeholder. Title-cased it reads as a real
    # activity ("Tuesday nights you usually have Label") when HBPE has no name.
    "label",
}

THINKING_ECHO = {"nothink", "think", "nothinking"}

L1_PER_CLASS_MAX = 50
FALLBACK_LABEL = "Activity"


def letters_of(name: str) -> str:
    return re.sub(r"[^a-z]+", "", name.lower())


def is_unknown_class(label: str) -> bool:
    return label.strip().upper() == "UNKNOWN"


def is_thinking_echo(name: str) -> bool:
    return letters_of(name) in THINKING_ECHO


def is_displayable_label(name: str) -> bool:
    trimmed = name.strip()
    if not trimmed or is_unknown_class(trimmed) or re.search(r"_\d+$", trimmed):
        return False
    letters = letters_of(trimmed)
    if len(letters) < 4:
        return False
    if letters in NEWS_LIKE or letters in JUNK_PHRASES or letters in THINKING_ECHO:
        return False
    return True


def nearest_label(proposed: str, existing: list[str]) -> str | None:
    """Best existing label by shared-letter overlap; None if the list is empty."""
    if not existing:
        return None
    target = set(letters_of(proposed))
    if not target:
        return existing[0]
    scored = []
    for label in existing:
        letters = set(letters_of(label))
        if not letters:
            continue
        overlap = len(target & letters) / len(target | letters)
        scored.append((overlap, label))
    if not scored:
        return existing[0]
    scored.sort(key=lambda row: (-row[0], row[1]))
    return scored[0][1]
