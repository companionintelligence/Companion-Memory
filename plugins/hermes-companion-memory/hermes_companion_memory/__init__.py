"""Companion Intelligence memory provider for Hermes Agent."""
from .provider import CompanionMemoryProvider


def register(ctx) -> None:  # noqa: ANN001
    """Register the Companion memory provider with the Hermes plugin registry."""
    ctx.register_memory_provider(CompanionMemoryProvider())


__all__ = ["CompanionMemoryProvider", "register"]
