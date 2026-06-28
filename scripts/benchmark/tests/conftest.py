"""Test fixtures and import path setup."""

from __future__ import annotations

import sys
from pathlib import Path

# Make the in-tree ``benchmark`` package importable without installation.
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
