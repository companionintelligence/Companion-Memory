"""Registry of built-in memory adapters.

Add a new system by:
  1. Implementing :class:`benchmark.adapters.base.MemoryAdapter`.
  2. Registering its factory in :data:`ADAPTERS` (or
     :func:`register_adapter` at startup).

The runner picks adapters by name from this registry. Factories take no
arguments — each adapter reads its own config from env vars / its constructor
defaults so the CLI stays uniform.
"""

from __future__ import annotations

from typing import Callable, Dict

from .base import MemoryAdapter
from .ci_server import CIServerAdapter
from .mem0 import Mem0Adapter
from .naive import NaiveAdapter

AdapterFactory = Callable[[], MemoryAdapter]

ADAPTERS: Dict[str, AdapterFactory] = {
    "ci_server": CIServerAdapter,
    "mem0": Mem0Adapter,
    "naive": NaiveAdapter,
}


def register_adapter(name: str, factory: AdapterFactory) -> None:
    """Register an extra adapter (e.g. mem0, honcho) without editing this file."""
    ADAPTERS[name] = factory


def get_adapter(name: str) -> MemoryAdapter:
    if name not in ADAPTERS:
        raise KeyError(f"unknown adapter: {name!r}. Known: {sorted(ADAPTERS)}")
    return ADAPTERS[name]()


__all__ = ["MemoryAdapter", "ADAPTERS", "register_adapter", "get_adapter"]
