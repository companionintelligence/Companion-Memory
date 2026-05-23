"""Hermes plugin entry point — registers the Companion Intelligence memory provider."""
from __future__ import annotations

from .provider import CompanionMemoryProvider

__all__ = ["CompanionMemoryProvider", "register"]


def register(ctx) -> None:
    """Register the provider with the Hermes plugin context.

    Hermes invokes this function during plugin discovery (see
    https://hermes-agent.nousresearch.com/docs/developer-guide/memory-provider-plugin).
    """
    ctx.register_memory_provider(CompanionMemoryProvider())
