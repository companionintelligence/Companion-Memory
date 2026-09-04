"""
Nightly Runner — step functions for the nightly HBPE pipeline.

Job order (orchestrated by ci.hbpe.functions.nightly, dispatched from the
NestJS pg-boss scheduler through the function runner):
  1. label_unlabeled      long-running — run QwenLabeler on any events/content
                                         that arrived without labels. CPU-bound;
                                         a large backlog can drain over hours,
                                         so events are drained recency-window
                                         first (the window /forecast reads) and
                                         older history second.
  2. l1_stale_sweep       < 30 sec    — deactivate L1 clusters unused for 90 days.
  3. l2_stale_sweep       < 30 sec    — deactivate L2 clusters unused for 90 days.
  4. lora_fine_tune       <  5 min    — per-user LoRA adapter update.
  4b. backfill_actuals    < 30 sec    — fill prediction_log.actual_* for elapsed
                                        forecast buckets from observed token_stream
                                        labels (Phase 5a / T5.1).
  4c. recurrence_profile  <  5 min    — rebuild hbpe.recurrence_profiles (week/
                                        month-horizon occurrence + due forecasts)
                                        and backfill occurrence_log actuals.
  5. drift_detection                  score prediction_log vs actuals (Brier/ECE)
  6. cache_invalidation               [Phase 5 stub]

Each step has fail-continue semantics in the orchestrator: one step's error
does not block subsequent steps.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import UTC, date, datetime

log = logging.getLogger(__name__)


def __getattr__(name: str):
    # Lazily re-export the Phase 5a backfill entry point so callers can reach it
    # via this module (``from ci.pipeline.nightly_runner import
    # backfill_prediction_actuals``) without importing psycopg2 at module load.
    if name == "backfill_prediction_actuals":
        from ci.hbpe.pipeline.actuals_backfill import backfill_prediction_actuals

        return backfill_prediction_actuals
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# On-device inference (Qwen via llama.cpp) runs on a single-worker executor so
# blocking label work never runs concurrently across users' nightly runs.
# Concurrent use of the shared llama.cpp context corrupts its KV cache and
# aborts the process (GGML_ASSERT). The executor is created lazily on first use
# (inside the async helper, on the event-loop thread) so importing this module
# never spawns threads.
_INFERENCE_EXECUTOR = None


async def _run_inference(fn):
    """
    Run a blocking inference function on the single-flight inference executor.

    ``fn(should_stop)`` receives a ``threading.Event`` it should poll between
    items. If the surrounding task is cancelled, we set the event so the
    abandoned thread stops at the next item boundary instead of zombie-running
    the rest of the batch — bounding wasted work and freeing the single
    executor slot.
    """
    import asyncio
    import threading
    from concurrent.futures import ThreadPoolExecutor

    global _INFERENCE_EXECUTOR
    if _INFERENCE_EXECUTOR is None:
        _INFERENCE_EXECUTOR = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="hbpe-infer"
        )

    should_stop = threading.Event()
    loop = asyncio.get_event_loop()
    fut = loop.run_in_executor(_INFERENCE_EXECUTOR, fn, should_stop)
    try:
        return await asyncio.shield(fut)
    except asyncio.CancelledError:
        should_stop.set()
        raise


def _stop_poll(should_stop):
    """
    Adapt ``_run_inference``'s ``threading.Event`` to a ``should_continue()``
    predicate for the label batches, or ``None`` when there is no event.

    Callers that drive a step function directly (tests, the bounded recovery
    entry point) pass no event; those batches simply run to completion.
    """
    if should_stop is None:
        return None
    return lambda: not should_stop.is_set()


# ── Step 1 — Label unlabeled events and content ────────────────────────────────


@dataclass
class _DrainCounters:
    """Mutable tallies shared across both event phases and the content leg."""

    done: int = 0
    labeled_events: int = 0
    new_labels: int = 0
    errors: int = 0


def _midnight_utc(day: date) -> datetime:
    """UTC midnight at the start of ``day`` — the drain's phase boundary."""
    return datetime(day.year, day.month, day.day, tzinfo=UTC)


def _recency_cutoff(user_id: str, recency_days: int) -> datetime:
    """
    The instant separating the drain's recency phase from its historical one.

    It is the first day of the window the *next* serialize run will write
    (``bootstrap.label_recency_start``), not ``today - recency_days``: a label
    reaches hbpe.pipeline.recurrence — and so /forecast — only once serialize
    turns it into an hbpe.token_stream row, and serialize only ever rewrites
    that trailing window. Anchoring on the corpus rather than on the wall clock
    also keeps the two aligned when ingestion lags (see label_recency_start).

    Note it is NOT recurrence.HISTORY_DAYS. The profiler reads 180 days of
    token_stream, but nothing writes token_stream for the 90–180-day band, so
    labeling into it cannot change any forecast.
    """
    from ci.hbpe.pipeline.bootstrap import label_recency_start

    return _midnight_utc(label_recency_start(user_id, recency_days))


def _drain_events(
    *,
    user_id: str,
    labeler,
    should_stop,
    counters: _DrainCounters,
    deadline: float,
    since: datetime | None,
    before: datetime | None,
    newest_first: bool,
    fetch=None,
    progress=None,
    clock=time.monotonic,
) -> int:
    """
    Label unlabeled events in one window until ``deadline``; return how many
    events this call labeled.

    ``after_start`` / ``after_id`` are locals, so every call owns its own keyset
    cursor. That is load-bearing: the two phases scan disjoint windows in
    opposite directions, and a cursor hoisted out of here (shared between them)
    would have phase 2 resume from phase 1's newest-first position and skip the
    entire historical backlog.

    The cursor advances even when ``label_event`` raises, so one poison row
    cannot wedge the drain into an infinite re-fetch of the same batch.
    """
    if fetch is None:
        from ci.hbpe.data_client import get_unlabeled_events as fetch
    if progress is None:
        from ci.hbpe.functions import update_pipeline_progress as progress

    labeled_here = 0
    after_start = None
    after_id = None

    while clock() < deadline and not should_stop.is_set():
        batch = fetch(
            user_id,
            after_start=after_start,
            after_id=after_id,
            since=since,
            before=before,
            newest_first=newest_first,
        )
        if not batch:
            break
        for row in batch:
            if should_stop.is_set() or clock() >= deadline:
                break
            try:
                result = labeler.label_event(
                    event_id=row["event_id"],
                    user_id=user_id,
                    title=row.get("title") or "",
                    description=row.get("description"),
                )
                counters.labeled_events += 1
                labeled_here += 1
                if result.get("is_new_l1"):
                    counters.new_labels += 1
            except Exception:
                log.exception(
                    "label_unlabeled event failed: event_id=%s", row["event_id"]
                )
                counters.errors += 1
            counters.done += 1
            after_start = row.get("start_time")
            after_id = row["event_id"]
            if counters.done == 1 or counters.done % 10 == 0:
                progress(user_id, done=counters.done, total=max(counters.done + 10, 1))

    return labeled_here


def _drain_event_phases(
    *,
    user_id: str,
    labeler,
    should_stop,
    counters: _DrainCounters,
    cutoff: datetime,
    started_at: float,
    budget_seconds: float,
    recency_share: float,
    fetch=None,
    progress=None,
    clock=time.monotonic,
) -> dict:
    """
    Run the two-phase event drain and return ``{"recent", "historical", ...}``.

    Phase 1 covers ``[cutoff, +inf)`` newest-first; phase 2 covers
    ``(-inf, cutoff)`` oldest-first. The bounds are half-open against the same
    cutoff, so the phases partition the unlabeled set with no overlap and no gap.

    Newest-first inside phase 1 is not cosmetic. A truncated descending drain
    leaves a contiguous ``[T-k, +inf)`` block — a short but well-formed history
    whose per-cluster ``last_seen`` is genuinely recent. A truncated *ascending*
    drain would leave ``[cutoff, cutoff+k]``, i.e. every cluster's last_seen
    a whole serialize window stale, which makes recurrence's
    ``since = (start - last_seen)``
    absorb at the max observed gap and floods the due list with false "overdue"
    flags. Phase 1 is also intentionally unbounded above so future-dated calendar
    rows are labeled first — the week-forecast calendar overlay and the due-list
    reconciliation both join hbpe.l1_event_cluster, so an unlabeled future event
    is invisible to them.

    Only phase 2's deadline is the hard one: unused phase-1 time rolls straight
    over, so an empty or already-drained recency window costs a single query
    rather than 80% of the night.
    """
    share = min(max(recency_share, 0.0), 1.0)
    hard_deadline = started_at + budget_seconds
    recency_deadline = started_at + budget_seconds * share

    recent = _drain_events(
        user_id=user_id,
        labeler=labeler,
        should_stop=should_stop,
        counters=counters,
        deadline=recency_deadline,
        since=cutoff,
        before=None,
        newest_first=True,
        fetch=fetch,
        progress=progress,
        clock=clock,
    )
    historical = _drain_events(
        user_id=user_id,
        labeler=labeler,
        should_stop=should_stop,
        counters=counters,
        deadline=hard_deadline,
        since=None,
        before=cutoff,
        newest_first=False,
        fetch=fetch,
        progress=progress,
        clock=clock,
    )
    log.info(
        "label drain user=%s cutoff=%s recent=%d historical=%d",
        user_id[:8],
        cutoff.date().isoformat(),
        recent,
        historical,
    )
    return {
        "recent": recent,
        "historical": historical,
        "cutoff": cutoff.date().isoformat(),
    }


async def label_unlabeled(user_id: str) -> dict:
    """
    Step 1: Assign L0/L1 to any events and L0/L1/L2 to any content items
    that do not yet have a label in ci.l1_event_cluster / ci.l2_content_cluster.

    Uses QwenLabeler for all assignments.  New vocabulary entries trigger an
    HMT retrain flag (tracked in the return dict).

    Events are drained in two phases (see ``_drain_event_phases``): the window
    a serialize run can still turn into hbpe.token_stream rows first — the only
    labels a forecast can ever see — then the older history. The drain used to
    be a single oldest-first walk of the whole corpus, which is fine on a toy
    dataset and useless on a real one: a 198k event corpus reaching back to
    2006 kept the labeling front in 2022 for months, so the profiler's window
    contained zero labeled tokens, hbpe.recurrence_profiles stayed empty and
    GET /forecast returned ``clusters: []`` on every day of the week,
    indefinitely. The historical phase keeps its reserved share of the budget
    every night, so old data is slowed, never starved.

    The cutoff is computed once per run rather than per batch: recomputing it
    across a midnight boundary could let a row fall out of phase 1's window
    after phase 1 finished and into phase 2's only after phase 2 passed it, so
    it would be labeled by neither. A run that starts just before midnight
    therefore uses the previous day's cutoff for its whole length; the next
    run corrects it.
    """

    def _run(should_stop) -> dict:
        from ci.hbpe.config import settings
        from ci.hbpe.data_client import get_unlabeled_content
        from ci.hbpe.functions import update_pipeline_progress
        from ci.hbpe.tokenizer.qwen_labeler import QwenLabeler
        from ci.hbpe.tokenizer.static_labeler import label_mapped_events
        from ci.hbpe.tokenizer.vocab_cleanup import cleanup_junk_vocab

        cleanup = cleanup_junk_vocab(user_id)
        static = label_mapped_events(user_id)

        labeler = QwenLabeler()
        labeled_content = 0
        counters = _DrainCounters()

        started_at = time.monotonic()
        deadline = started_at + settings.label_budget_seconds
        phases = _drain_event_phases(
            user_id=user_id,
            labeler=labeler,
            should_stop=should_stop,
            counters=counters,
            cutoff=_recency_cutoff(user_id, settings.label_recency_days),
            started_at=started_at,
            budget_seconds=settings.label_budget_seconds,
            recency_share=settings.label_recency_budget_share,
        )

        unlabeled_content = get_unlabeled_content(user_id)
        for row in unlabeled_content:
            if should_stop.is_set() or time.monotonic() >= deadline:
                break
            try:
                result = labeler.label_content(
                    content_id=row["content_id"],
                    user_id=user_id,
                    title=row.get("title") or "",
                    content_type=row.get("content_type"),
                )
                labeled_content += 1
                if result.get("is_new_l1") or result.get("is_new_l2"):
                    counters.new_labels += 1
            except Exception:
                log.exception(
                    "label_unlabeled content failed: content_id=%s", row["content_id"]
                )
                counters.errors += 1
            counters.done += 1
            if counters.done == 1 or counters.done % 10 == 0:
                update_pipeline_progress(
                    user_id, done=counters.done, total=max(counters.done + 10, 1)
                )

        return {
            "user_id": user_id,
            "labeled_events": counters.labeled_events,
            "labeled_content": labeled_content,
            "static": static,
            "cleanup": cleanup,
            "new_labels": counters.new_labels,
            "errors": counters.errors,
            "phases": phases,
        }

    return await _run_inference(_run)


# ── Step 1b — Label hourly summaries ──────────────────────────────────────────


async def label_summary_tokens(
    user_id: str,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict:
    """
    Step 1b: Label the hourly summaries the next serialize run will publish.

    Summary tokens fill 15-min buckets that have no event-derived coverage
    (sleep, leisure, off-calendar hours).  Labels are stored in
    hbpe.summary_l1_label and merged into the token stream at serialization time.
    An explicit inclusive range may be supplied for bounded recovery.

    The default target is ``bootstrap.token_source_days`` — the same day *list*
    serialize walks, not the span between its ends.  Aiming at a span would pay
    two Qwen calls per summary for every day in a bimodal corpus's two-year gap,
    none of which serialize would then publish.
    """
    import datetime

    def _run(should_stop) -> dict:
        from ci.hbpe.pipeline.bootstrap import (
            SERIALIZE_WINDOW_DAYS,
            token_source_days,
        )
        from ci.hbpe.tokenizer.summary_tokenizer import SummaryTokenizer

        if (start_date is None) != (end_date is None):
            raise ValueError(
                "summary label recovery requires both start_date and end_date"
            )

        keep_going = _stop_poll(should_stop)

        if start_date is not None and end_date is not None:
            start = datetime.date.fromisoformat(start_date)
            end = datetime.date.fromisoformat(end_date)
            if end < start:
                raise ValueError(
                    "summary label end_date must be on or after start_date"
                )
            if (end - start).days > SERIALIZE_WINDOW_DAYS:
                raise ValueError(
                    "summary label recovery cannot exceed the serialization window"
                )
            n = SummaryTokenizer().label_range(
                user_id,
                start.isoformat(),
                end.isoformat(),
                should_continue=keep_going,
            )
            return {
                "labeled": n,
                "start_date": start.isoformat(),
                "end_date": end.isoformat(),
                "days": (end - start).days + 1,
            }

        days = token_source_days(user_id)
        if not days:
            # No dated source at or before today at all — no event, no hourly
            # summary, no leftover token_stream row. NOT "the newest summary is
            # too fresh to be listed": the day list is clamped with
            # ``< today + 1 day``, so a summary written minutes ago is already in
            # it. Labeling yesterday therefore finds nothing either. The branch
            # is here so the step still reports a concrete day rather than
            # indexing into an empty list below, and it is a harmless no-op on
            # every corpus that can reach it.
            yesterday = datetime.datetime.now(datetime.UTC).date() - datetime.timedelta(
                days=1
            )
            days = [yesterday]

        dates = [d.isoformat() for d in days]
        n = SummaryTokenizer().label_days(user_id, dates, should_continue=keep_going)
        return {
            "labeled": n,
            "start_date": dates[0],
            "end_date": dates[-1],
            "days": len(dates),
        }

    return await _run_inference(_run)


# ── Step 2 — L1 staleness sweep ────────────────────────────────────────────────


async def l1_stale_sweep(user_id: str) -> int:
    """Step 2: Deactivate L1 clusters with no activity in staleness_days."""
    import asyncio

    def _run() -> int:
        from ci.hbpe.tokenizer.l1_staleness import L1Staleness

        return L1Staleness().run(user_id)

    return await asyncio.get_event_loop().run_in_executor(None, _run)


# ── Step 3 — L2 staleness sweep ────────────────────────────────────────────────


async def l2_stale_sweep(user_id: str) -> int:
    """Step 3: Deactivate L2 clusters with no activity in staleness_days."""
    import asyncio

    def _run() -> int:
        from ci.hbpe.tokenizer.l2_staleness import L2Staleness

        return L2Staleness().run(user_id)

    return await asyncio.get_event_loop().run_in_executor(None, _run)


# ── Step 4 — LoRA fine-tune ────────────────────────────────────────────────────


async def lora_fine_tune(user_id: str) -> dict:
    """
    Step 4: Fine-tune the per-user LoRA adapter on yesterday's token stream.

    Skipped gracefully if the base HMT checkpoint does not exist yet
    (cold-start: requires the full training pipeline to run first).
    """
    import asyncio
    import datetime

    def _run() -> dict:
        from ci.hbpe.model.checkpoints import HMT_CKPT, user_ckpt_dir

        checkpoint = user_ckpt_dir(user_id) / HMT_CKPT
        if not checkpoint.exists():
            log.info(
                "lora_fine_tune: base checkpoint not found — skipping (cold start)"
            )
            return {"skipped": True, "reason": "no_base_checkpoint"}

        from ci.hbpe.model.nightly_finetune import fine_tune_nightly

        yesterday = datetime.date.today() - datetime.timedelta(days=1)
        return fine_tune_nightly(user_id, yesterday)

    return await asyncio.get_event_loop().run_in_executor(None, _run)


async def needs_bootstrap(user_id: str) -> dict:
    """
    Decide whether the user needs a (re)bootstrap before LoRA fine-tune.

    Returns {"needs": bool, "reason": str}. Needs is True when the user has no
    per-user HMT checkpoint (cold start), when the checkpoint was trained with
    a different HMT shape (64-d toy → 256-d), or when their current L1 vocabulary
    has drifted away from the one their checkpoint was trained with (so a freshly
    built model would no longer load the saved weights — the size-mismatch that
    motivated CI-Server-ad4).
    """
    import asyncio

    def _run() -> dict:
        import torch

        from ci.hbpe.model.checkpoints import (
            HMT_CALIBRATED,
            HMT_CKPT,
            architecture_fingerprint,
            architecture_matches,
            l1_vocab_fingerprint,
            model_exists,
            user_ckpt_dir,
        )
        from ci.hbpe.model.vocab import build_l1_vocab

        if not model_exists(user_id):
            return {"needs": True, "reason": "no_checkpoint"}

        if not architecture_matches(user_id):
            return {"needs": True, "reason": "architecture_mismatch"}

        d = user_ckpt_dir(user_id)
        ckpt_path = (
            d / HMT_CALIBRATED if (d / HMT_CALIBRATED).exists() else d / HMT_CKPT
        )
        try:
            ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
        except Exception:
            return {"needs": True, "reason": "checkpoint_unreadable"}

        stored_arch = ckpt.get("architecture")
        if stored_arch and stored_arch != architecture_fingerprint():
            return {"needs": True, "reason": "architecture_mismatch"}

        stored = ckpt.get("l1_vocab_fingerprint")
        current = l1_vocab_fingerprint(build_l1_vocab(user_id))
        if stored != current:
            return {"needs": True, "reason": "vocab_drift"}
        return {"needs": False, "reason": "up_to_date"}

    return await asyncio.get_event_loop().run_in_executor(None, _run)


# ── Step 4b — Backfill prediction actuals (Phase 5a / T5.1) ─────────────────────


async def backfill_actuals(user_id: str) -> dict:
    """
    Step 4b: Fill hbpe.prediction_log.actual_l0/l1/l2 for elapsed forecast
    buckets from the observed hbpe.token_stream labels of the day that has
    since passed.

    Enables retrospective accuracy measurement (§6 success metric: ≥95% of
    buckets whose window has elapsed are backfilled). Idempotent — only rewrites
    rows whose observed labels changed.
    """
    import asyncio

    def _run() -> dict:
        from ci.hbpe.pipeline.actuals_backfill import backfill_prediction_actuals

        return backfill_prediction_actuals(user_id)

    return await asyncio.get_event_loop().run_in_executor(None, _run)


# ── Step 4c — Recurrence profiles (week/month-horizon forecasts) ───────────────


async def recurrence_profile(user_id: str) -> dict:
    """
    Step 4c: Rebuild hbpe.recurrence_profiles from token_stream history
    (per-L1-cluster DoW/daypart histograms, inter-arrival stats, periodicity
    confidence), then backfill hbpe.occurrence_log.actual for elapsed
    week-forecast days. Backs GET /forecast and GET /forecast/due.
    """
    import asyncio

    def _run() -> dict:
        from ci.hbpe.pipeline.recurrence import (
            backfill_occurrence_actuals,
            build_recurrence_profiles,
        )

        result = build_recurrence_profiles(user_id)
        result["occurrence_actuals"] = backfill_occurrence_actuals(user_id)["updated"]
        try:
            from ci.hbpe.pipeline.seasonal import rebuild_seasonal_profiles
            from ci.hbpe.pipeline.token_rollup import rebuild_token_rollups

            result["rollup"] = rebuild_token_rollups(user_id)
            result["seasonal"] = rebuild_seasonal_profiles(user_id)
        except Exception as exc:
            log.info("rollup/seasonal skipped: %s", exc)
        return result

    return await asyncio.get_event_loop().run_in_executor(None, _run)


# ── Phase 5 stubs ──────────────────────────────────────────────────────────────


async def drift_detection(user_id: str) -> str:
    import asyncio

    from ci.hbpe.pipeline.baselines import score_baselines_and_store
    from ci.hbpe.pipeline.l2_gate import count_l2_tokens
    from ci.hbpe.pipeline.scoring import score_and_store

    result = await asyncio.get_event_loop().run_in_executor(
        None, lambda: score_and_store(user_id)
    )
    status = str(result.get("status", "scored"))
    log.info("drift_detection: %s (user=%s)", status, user_id)

    base = await asyncio.get_event_loop().run_in_executor(
        None, lambda: score_baselines_and_store(user_id)
    )
    log.info("drift_detection baselines: %s (user=%s)", base.get("status"), user_id)

    n_l2 = await asyncio.get_event_loop().run_in_executor(
        None, lambda: count_l2_tokens(user_id)
    )
    log.info("L2 token count user=%s n=%d", user_id[:8], n_l2)

    return status


async def cache_invalidation(user_id: str) -> str:
    log.info("cache_invalidation: stub — Phase 5 (user=%s)", user_id)
    return "skipped"
