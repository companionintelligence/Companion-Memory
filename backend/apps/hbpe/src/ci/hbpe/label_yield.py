"""
Stand aside for an interactive chat turn before each label request.

The chat labeler shares ONE single-slot Ollama runner with the appliance's
chat. Measured 2026-09-11: this labeler issued a request every ~12 s all
afternoon, the API's image-description queue another every ~10 s, and between
them the runner never went idle — so Ollama could never swap the chat model
in, and two chat turns in a row waited five minutes for a response that never
came. The API's own background queues now yield through
``queueOptions.yieldsTo`` (see ``domains/events/yieldGates.ts``); this is the
same rule for the sidecar, reading the same signal.

The signal is ``ci.threads.generation_status``: the API writes ``queued`` when
a turn is enqueued and ``running``/``idle`` around it, so a row in either
state is the app's own statement that a person is waiting on the model. It is
bounded on ``updated_at`` because the status is not always cleaned up — a
process that dies mid-turn leaves ``running`` behind — and an unbounded read
would park the labeler for good on one stale row.

Fails OPEN: a database error means the labeler carries on exactly as it did
before this module existed. It never turns a database hiccup into a stalled
nightly.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable

from ci.hbpe import database as db
from ci.hbpe.config import settings

log = logging.getLogger(__name__)

# Mirrors the API's llm queue expiry (LLM_QUEUE_OPTIONS.expireInSeconds, 900):
# the longest a chat job may legitimately stay active before pg-boss retries
# it, and a retry rewrites the status and refreshes updated_at. A row nobody
# refreshed within that window belongs to a turn that died with its process.
PENDING_GENERATION_FRESHNESS_SECONDS = 900

_PENDING_SQL = """
    SELECT count(*)
      FROM ci.threads
     WHERE generation_status IN ('queued', 'running')
       AND updated_at > now() - make_interval(secs => %s)
"""


def chat_turn_pending() -> bool:
    """``True`` when any thread has a chat turn queued or running right now."""
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(_PENDING_SQL, (PENDING_GENERATION_FRESHNESS_SECONDS,))
            row = cur.fetchone()
    return bool(row and row[0])


def wait_for_chat_idle(
    *,
    max_wait_seconds: float | None = None,
    poll_seconds: float | None = None,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> float:
    """
    Block until no chat turn is pending, or until ``max_wait_seconds`` has
    passed — whichever comes first. Returns the seconds spent waiting.

    The cap exists so a stale ``running`` row inside the freshness window can
    delay labeling by at most one cap, never stop it. It is deliberately long
    (the default is ten minutes): a real turn with thinking and tool rounds
    on a local model can take several, and cutting in early re-creates the
    starvation this is here to prevent.
    """
    if not settings.label_yield_to_chat:
        return 0.0

    cap = (
        settings.label_yield_max_seconds
        if max_wait_seconds is None
        else max_wait_seconds
    )
    poll = settings.label_yield_poll_seconds if poll_seconds is None else poll_seconds
    started = clock()
    logged = False

    while True:
        try:
            pending = chat_turn_pending()
        except Exception as exc:  # fail open, whatever the cause
            log.warning("could not read pending chat turns; not yielding: %s", exc)
            break

        waited = clock() - started

        if not pending:
            if logged:
                log.info("chat turn finished; resuming labeling after %.0fs", waited)
            break

        if waited >= cap:
            log.warning(
                "chat turn still pending after %.0fs; resuming labeling anyway", waited
            )
            break

        if not logged:
            log.info("chat turn pending; labeler standing aside")
            logged = True

        sleep(poll)

    return clock() - started
