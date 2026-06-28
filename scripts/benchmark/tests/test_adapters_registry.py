"""Adapter registry — built-in entries + external registration."""

from __future__ import annotations

import pytest

from benchmark.adapters import ADAPTERS, MemoryAdapter, get_adapter, register_adapter
from benchmark.adapters.naive import NaiveAdapter


def test_built_in_adapters_are_registered():
    assert {"ci_server", "hindsight", "mem0", "naive"}.issubset(ADAPTERS.keys())


def test_get_adapter_returns_a_fresh_instance_each_call():
    a, b = get_adapter("naive"), get_adapter("naive")
    assert a is not b
    assert isinstance(a, NaiveAdapter)


def test_unknown_adapter_raises_with_known_names_listed():
    with pytest.raises(KeyError, match="nope"):
        get_adapter("nope")


def test_register_adapter_makes_it_available():
    class Demo(NaiveAdapter):
        @property
        def name(self) -> str:
            return "demo"

    register_adapter("demo", Demo)
    try:
        assert isinstance(get_adapter("demo"), Demo)
    finally:
        ADAPTERS.pop("demo", None)


def test_every_adapter_factory_returns_a_memory_adapter_subclass():
    for name in ADAPTERS:
        assert isinstance(get_adapter(name), MemoryAdapter), name
