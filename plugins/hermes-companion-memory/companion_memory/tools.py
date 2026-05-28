"""Tool schemas exposed to the Hermes agent loop.

The actual dispatch lives in :class:`CompanionMemoryProvider.handle_tool_call`
— this module just publishes the static schema list for callers that want it
outside of the provider (e.g. when documenting or generating CLI help).
"""
from __future__ import annotations

from .provider import _TOOL_SCHEMAS

__all__ = ["tool_schemas"]


def tool_schemas() -> list[dict]:
    return list(_TOOL_SCHEMAS)
