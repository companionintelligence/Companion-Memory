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
from collections.abc import Callable, Iterable, Sequence
from typing import Any

from .adapters.base import MemoryAdapter
from .schema import EvalQuestion, QuestionResult, SystemResult

# A scorer is (question, context) -> (hit, reason)
Scorer = Callable[[EvalQuestion, str], tuple[bool, str]]

# Optional event sink; receives ("phase", system, payload) tuples.
Listener = Callable[[str, str, dict[str, Any]], None]

# A zero-argument adapter constructor, as stored in ``adapters.ADAPTERS``.
AdapterFactory = Callable[[], MemoryAdapter]


def _iter_user_messages(persona: dict[str, Any]) -> Iterable[tuple[str, str]]:
    """Yield (session_id, content) for every user message in every session."""
    for session in persona["sessions"]:
        sid = session["id"]
        for msg in session.get("messages", []):
            if msg.get("role") == "user" and msg.get("content"):
                yield sid, msg["content"]


def run_system(
    adapter: MemoryAdapter,
    persona: dict[str, Any],
    user_id: str,
    scorer: Scorer,
    *,
    on_event: Listener | None = None,
) -> SystemResult:
    """Run one adapter end-to-end and produce a :class:`SystemResult`."""
    name = adapter.name
    questions: list[EvalQuestion] = [
        EvalQuestion.from_dict(q) for q in persona["eval_questions"]
    ]

    def emit(phase: str, payload: dict[str, Any] | None = None) -> None:
        if on_event:
            on_event(phase, name, payload or {})

    emit("start")

    # --- Setup ---
    try:
        adapter.setup(user_id)
    except Exception as exc:
        emit("error", {"phase": "setup", "error": str(exc)})
        return SystemResult(
            system_name=name,
            ingest_total_ms=0,
            flush_total_ms=0,
            error=f"setup failed: {exc}",
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
            system_name=name,
            ingest_total_ms=0,
            flush_total_ms=0,
            error=f"ingest failed: {exc}",
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
            system_name=name,
            ingest_total_ms=ingest_ms,
            flush_total_ms=0,
            error=f"flush failed: {exc}",
        )
    flush_ms = (time.monotonic() - flush_start) * 1000

    # --- Evaluate ---
    question_results: list[QuestionResult] = []
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
    persona: dict[str, Any],
    user_id: str,
    scorer: Scorer,
    *,
    on_event: Listener | None = None,
) -> list[SystemResult]:
    """Run every adapter and return one :class:`SystemResult` per system."""
    return [
        run_system(a, persona, user_id, scorer, on_event=on_event) for a in adapters
    ]


def run_user_id(user_id: str, run_index: int) -> str:
    """Per-run namespace for the synthetic user.

    Adapters key their state on ``user_id`` (mem0 names its collection after
    it, CI-Server writes memories against it, hindsight derives its bank), so
    reusing one id across runs means run 2 searches a store run 1 already
    filled and warmed. Suffixing every run — including the first, so no run
    is privileged — makes the repeats independent. The id never appears in a
    report, so this does not change any output.
    """
    return f"{user_id}__run{run_index}"


def run_system_repeated(
    adapter_factory: AdapterFactory,
    persona: dict[str, Any],
    user_id: str,
    scorer: Scorer,
    *,
    runs: int,
    on_event: Listener | None = None,
) -> list[SystemResult]:
    """Run an adapter ``runs`` times and return one :class:`SystemResult` per run.

    Takes a *factory*, not an adapter, because repeated runs have to be
    independent to be worth aggregating. Reusing one instance carries its
    caches, connections and accumulated per-adapter state into the next run,
    so run 2 measures a warmed system and the spread across runs understates
    the real variance. Each run gets a fresh instance and its own ``user_id``
    (see :func:`run_user_id`).

    Why this exists as a separate function (rather than baking the loop into
    :func:`run_system`): the single-run path is exercised by every existing
    adapter test and the JSON contract requires that ``--runs 1``
    produce byte-identical output to the single-run path. Keeping
    :func:`run_system` untouched is the cheapest way to honour that.

    Contract:

    * ``runs == 1`` returns a single-element list whose sole entry is what
      :func:`run_system` would have produced for a fresh adapter.
    * ``runs > 1`` invokes the full lifecycle (``setup → ingest → flush →
      search → teardown``) ``runs`` times, in sequence, each against its own
      adapter instance.
    * A failure in any single run is captured on that run's
      :class:`SystemResult` — including a factory that raises, which is
      recorded as a setup failure — and does NOT abort the remaining runs.
      This matches the rest of the benchmark's "errors degrade, never crash"
      stance. The aggregation layer then excludes those runs from its
      statistics rather than scoring them as zeros.
    * ``runs < 1`` raises :class:`ValueError` — there is no sensible JSON
      shape for "zero runs".
    """
    if runs < 1:
        raise ValueError(f"runs must be >= 1, got {runs}")

    results: list[SystemResult] = []
    for i in range(runs):

        def _wrapped(
            phase: str, system: str, payload: dict[str, Any], _i: int = i
        ) -> None:
            if on_event:
                on_event(phase, system, {**payload, "run_index": _i})

        listener: Listener | None = _wrapped if on_event else None
        try:
            adapter = adapter_factory()
        except Exception as exc:
            # A factory that can't construct is the same class of failure as
            # a setup() that raises, and is recorded the same way so the run
            # still occupies its slot in the returned list. The name comes
            # from an earlier run if there was one — the factory never got
            # far enough to supply it.
            traceback.print_exc()
            name = next((r.system_name for r in results if r.system_name != "?"), "?")
            if listener:
                listener("error", name, {"phase": "construct", "error": str(exc)})
            results.append(
                SystemResult(
                    system_name=name,
                    ingest_total_ms=0,
                    flush_total_ms=0,
                    error=f"setup failed: {exc}",
                )
            )
            continue
        results.append(
            run_system(
                adapter,
                persona,
                run_user_id(user_id, i),
                scorer,
                on_event=listener,
            )
        )
    return results


def _safe_teardown(adapter: MemoryAdapter) -> None:
    try:
        adapter.teardown()
    except Exception:
        traceback.print_exc()
