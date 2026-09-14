"""
A ceiling on how often the chat labeler may hit the shared chat runner.

``label_yield.py`` stands aside while a PERSON is waiting on the chat model.
This module covers the other half of the problem: when nobody is chatting, the
labeler is free to run flat out, and measured 2026-09-14 it did — ~190 chat
requests per ten minutes, each a few seconds of generation, so the 27B chat
model's runner never went idle for the whole afternoon. That has a cost beyond
the labeler's own throughput. Ollama can only evict or swap a runner that has
no request in flight, so a runner kept permanently busy pins the GPU: the
API's request to load its utility model queued behind an eviction that could
never happen, and every later request for a non-resident model queued behind
that, silently (see ``docs/operations/gpu-model-residency.md``).

The fix is spacing, not batching. A bucket that allows N requests and then
sleeps would still deliver N back-to-back generations with no gap; what the
scheduler needs is a moment between requests when the runner is idle. So the
ceiling is expressed as a minimum gap of ``60 / label_max_requests_per_minute``
seconds between the START of consecutive requests. At the default of 6 per
minute that is one request every 10 s — roughly 70% idle for a 3 s generation,
against ~0% before.

Applies to the HTTP backend only, like the yield: the in-process GGUF fallback
shares nothing with chat and is not slowed. Waiting here counts against
``label_budget_seconds`` — the nightly labels fewer events per run and the
backlog drains over more nights, which is the trade being made on purpose.
Raise ``HBPE_LABEL_MAX_REQUESTS_PER_MINUTE`` on a box with a dedicated labeler
model; set it to 0 to remove the ceiling.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from ci.hbpe.config import settings

log = logging.getLogger(__name__)

_LOCK = threading.Lock()
# time.monotonic() at which the most recent request was released. Module-level
# on purpose: every OpenAIChatLabeler instance in the process shares one runner,
# so they share one ceiling.
_LAST_RELEASED_AT: float | None = None


def reset_for_tests() -> None:
    global _LAST_RELEASED_AT
    with _LOCK:
        _LAST_RELEASED_AT = None


def minimum_gap_seconds(max_per_minute: float | None = None) -> float:
    """Seconds that must separate two request starts; 0 when the ceiling is off."""
    limit = (
        settings.label_max_requests_per_minute
        if max_per_minute is None
        else max_per_minute
    )
    if limit is None or limit <= 0:
        return 0.0
    return 60.0 / float(limit)


def wait_for_request_slot(
    *,
    max_per_minute: float | None = None,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> float:
    """
    Block until the minimum gap since the previous request has elapsed, then
    claim this instant as the new reference point. Returns the seconds waited.

    Callers that hold ``OpenAIChatLabeler._gen_lock`` serialise on it anyway;
    the lock here is for the module state, so two labeler instances cannot
    both read a stale ``_LAST_RELEASED_AT`` and go at once.
    """
    global _LAST_RELEASED_AT

    gap = minimum_gap_seconds(max_per_minute)
    if gap <= 0:
        return 0.0

    started = clock()
    logged = False

    with _LOCK:
        while True:
            now = clock()
            if _LAST_RELEASED_AT is None:
                _LAST_RELEASED_AT = now
                break

            remaining = gap - (now - _LAST_RELEASED_AT)
            if remaining <= 0:
                _LAST_RELEASED_AT = now
                break

            if not logged:
                log.debug(
                    "label request ceiling: waiting %.1fs to keep one request per %.1fs",
                    remaining,
                    gap,
                )
                logged = True

            sleep(remaining)

    return clock() - started
