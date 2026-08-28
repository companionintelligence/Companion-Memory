"""Write trial snapshots so a later look-back is not RAM-only."""

from __future__ import annotations

import json
import os
from pathlib import Path

DEFAULT_DIR = Path(os.environ.get("FORAGE_DATA_DIR", "/tmp/ci-forage"))


def data_dir() -> Path:
    raw = os.environ.get("FORAGE_DATA_DIR")
    path = Path(raw) if raw else DEFAULT_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_trial(trial_id: str, snapshot: dict) -> Path:
    path = data_dir() / f"{trial_id}.json"
    path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
    return path
