"""The benchmark runner.

For each adapter:

  setup → ingest every user message in every session → flush →
  search each question → score → teardown

The runner never re-raises an adapter error; instead it records the failure on
the :class:`SystemResult` and moves on so a single broken backend can't tank a
multi-system run.
"""

from __future__ import annotations

import time
import traceback
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence

from .adapters.base import MemoryAdapter
from .schema import EvalQuestion, QuestionResult, SystemResult

# A scorer is (question, context) -> (hit, reason)
Scorer = Callable[[EvalQuestion, str], tuple[bool, str]]

# Optional event sink; receives ("phase", system, payload) tuples.
Listener = Callable[[str, str, Dict[str, Any]], None]


def _iter_user_messages(persona: Dict[str, Any]) -> Iterable[tuple[str, str]]:
    """Yield (session_id, content) for every user message in every session."""
    for session in persona["sessions"]:
        sid = session["id"]
        for msg in session.get("messages", []):
            if msg.get("role") == "user" and msg.get("content"):
                yield sid, msg["content"]


def run_system(
    adapter: MemoryAdapter,
    persona: Dict[str, Any],
    user_id: str,
    scorer: Scorer,
    *,
    on_event: Optional[Listener] = None,
) -> SystemResult:
    """Run one adapter end-to-end and produce a :class:`SystemResult`."""
    name = adapter.name
    questions: List[EvalQuestion] = [EvalQuestion.from_dict(q) for q in persona["eval_questions"]]

    def emit(phase: str, payload: Optional[Dict[str, Any]] = None) -> None:
        if on_event:
            on_event(phase, name, payload or {})

    emit("start")

    # --- Setup ---
    try:
        adapter.setup(user_id)
    except Exception as exc:  # noqa: BLE001 — adapter contracts are best-effort
        emit("error", {"phase": "setup", "error": str(exc)})
        return SystemResult(
            system_name=name, ingest_total_ms=0, flush_total_ms=0, error=f"setup failed: {exc}"
        )

    # --- Ingest ---
    ingest_start = time.monotonic()
    try:
        for sid, content in _iter_user_messages(persona):
            adapter.ingest(content, session_id=sid)
    except Exception as exc:
        traceback.print_exc()
        _safe_teardown(adapter)
        emit("error", {"phase": "ingest", "error": str(exc)})
        return SystemResult(
            system_name=name, ingest_total_ms=0, flush_total_ms=0, error=f"ingest failed: {exc}"
        )
    ingest_ms = (time.monotonic() - ingest_start) * 1000

    # --- Flush ---
    flush_start = time.monotonic()
    try:
        adapter.flush()
    except Exception as exc:
        traceback.print_exc()
        _safe_teardown(adapter)
        emit("error", {"phase": "flush", "error": str(exc)})
        return SystemResult(
            system_name=name, ingest_total_ms=ingest_ms, flush_total_ms=0, error=f"flush failed: {exc}"
        )
    flush_ms = (time.monotonic() - flush_start) * 1000

    # --- Evaluate ---
    question_results: List[QuestionResult] = []
    for q in questions:
        t0 = time.monotonic()
        try:
            context = adapter.search(q.question)
        except Exception as exc:  # adapter search errors map to "no context"
            emit("search_error", {"question": q.id, "error": str(exc)})
            context = ""
        latency_ms = (time.monotonic() - t0) * 1000
        hit, reason = scorer(q, context)
        question_results.append(
            QuestionResult(
                question_id=q.id,
                question=q.question,
                category=q.category,
                keywords=list(q.keywords),
                context=context,
                hit=hit,
                latency_ms=latency_ms,
                reason=reason,
            )
        )
        emit("question", {"id": q.id, "hit": hit, "latency_ms": latency_ms})

    _safe_teardown(adapter)

    result = SystemResult(
        system_name=name,
        ingest_total_ms=ingest_ms,
        flush_total_ms=flush_ms,
        question_results=question_results,
    )
    emit("done", {"score": result.overall_score, "total": result.total_questions})
    return result


def run_all(
    adapters: Sequence[MemoryAdapter],
    persona: Dict[str, Any],
    user_id: str,
    scorer: Scorer,
    *,
    on_event: Optional[Listener] = None,
) -> List[SystemResult]:
    """Run every adapter and return one :class:`SystemResult` per system."""
    return [run_system(a, persona, user_id, scorer, on_event=on_event) for a in adapters]


def run_system_repeated(
    adapter: MemoryAdapter,
    persona: Dict[str, Any],
    user_id: str,
    scorer: Scorer,
    *,
    runs: int,
    on_event: Optional[Listener] = None,
) -> List[SystemResult]:
    """Run an adapter ``runs`` times and return one :class:`SystemResult` per run.

    Why this exists as a separate function (rather than baking the loop into
    :func:`run_system`): the single-run path is exercised by every existing
    adapter test and the locked JSON contract requires that ``--runs 1``
    produce byte-identical output to round-3. Keeping :func:`run_system`
    untouched is the cheapest way to honour that.

    Contract:

    * ``runs == 1`` returns ``[run_system(...)]`` — a single-element list whose
      sole entry is exactly what :func:`run_system` would have produced.
    * ``runs > 1`` invokes the full lifecycle (``setup → ingest → flush →
      search → teardown``) ``runs`` times, in sequence, against the same
      adapter instance. Adapters are expected to be re-entrant across
      ``setup/teardown`` pairs; if one isn't, that's a bug in the adapter,
      not here.
    * A failure in any single run is captured on that run's
      :class:`SystemResult` (via :func:`run_system`'s own error path) and
      does NOT abort the remaining runs. This matches the rest of the
      benchmark's "errors degrade, never crash" stance and lets the
      aggregation layer compute medians over the runs that did complete.
    * ``runs < 1`` raises :class:`ValueError` — there is no sensible JSON
      shape for "zero runs".
    """
    if runs < 1:
        raise ValueError(f"runs must be >= 1, got {runs}")

    results: List[SystemResult] = []
    for i in range(runs):
        def _wrapped(phase: str, system: str, payload: Dict[str, Any], _i: int = i) -> None:
            if on_event:
                on_event(phase, system, {**payload, "run_index": _i})

        listener: Optional[Listener] = _wrapped if on_event else None
        results.append(run_system(adapter, persona, user_id, scorer, on_event=listener))
    return results


def _safe_teardown(adapter: MemoryAdapter) -> None:
    try:
        adapter.teardown()
    except Exception:
        traceback.print_exc()
