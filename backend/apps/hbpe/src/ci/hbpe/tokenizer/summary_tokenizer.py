"""
Summary Tokenizer — labels hourly summaries with L0+L1 via Qwen and returns
token records for inclusion in the HMT token stream.

Hourly summaries from ci.summaries cover SUMMARY_BUCKETS_PER_HOUR 15-min
buckets each.  Where a
bucket has no event-derived token, a summary-derived token fills the gap,
giving the model signal for hours that contain no calendar events (sleep,
leisure, off-calendar work, commutes).

Labels are cached in hbpe.summary_l1_label after the first Qwen call, so
re-serializing the same day does not re-invoke the model.

Summary tokens are written with soft_prob=SUMMARY_SOFT_PROB (0.7) to indicate
lower confidence than event-derived tokens (which arrive with similarity 1.0
from the direct L1 cluster assignment).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from datetime import datetime

from ci.hbpe.buckets import BUCKET_MINUTES, MAX_BUCKET_INDEX, SUMMARY_BUCKETS_PER_HOUR
from ci.hbpe.database import get_conn

log = logging.getLogger(__name__)

# Summary-derived tokens carry lower confidence than event-derived tokens.
SUMMARY_SOFT_PROB = 0.7


class SummaryTokenizer:
    """Labels hourly summaries and provides token records for the token stream."""

    def label_day(
        self,
        user_id: str,
        date_str: str,
        should_continue: Callable[[], bool] | None = None,
    ) -> int:
        """
        Label all unlabeled hourly summaries for user+date via Qwen.

        Fetches summaries from ci.summaries that have no entry in
        hbpe.summary_l1_label yet, runs each through the Qwen labeler, and
        writes the result.  Returns the number of summaries newly labeled.
        """
        from ci.hbpe.data_client import get_unlabeled_summaries

        unlabeled = get_unlabeled_summaries(user_id, date_str)
        return self._label_rows(
            user_id, unlabeled, f"date={date_str}", should_continue=should_continue
        )

    def label_range(
        self,
        user_id: str,
        start_date: str,
        end_date: str,
        should_continue: Callable[[], bool] | None = None,
    ) -> int:
        """Label all unlabeled hourly summaries in an inclusive date range."""
        from ci.hbpe.data_client import get_unlabeled_summaries_in_range

        unlabeled = get_unlabeled_summaries_in_range(user_id, start_date, end_date)
        return self._label_rows(
            user_id,
            unlabeled,
            f"start={start_date} end={end_date}",
            should_continue=should_continue,
        )

    def label_days(
        self,
        user_id: str,
        dates: list[str],
        should_continue: Callable[[], bool] | None = None,
    ) -> int:
        """
        Label all unlabeled hourly summaries on an explicit set of days.

        The serialize day list is not contiguous on a bimodal corpus (imported
        events two years old, hourly summaries still landing today), so a
        ``label_range`` spanning it would fetch — and pay two Qwen calls for —
        every summary in the two-year gap, none of which serialize will ever
        publish.  One read, exactly the days that will be serialized.
        """
        from ci.hbpe.data_client import get_unlabeled_summaries_on_days

        if not dates:
            return 0
        unlabeled = get_unlabeled_summaries_on_days(user_id, dates)
        return self._label_rows(
            user_id,
            unlabeled,
            f"days={len(dates)} first={dates[0]} last={dates[-1]}",
            should_continue=should_continue,
        )

    def _label_rows(
        self,
        user_id: str,
        unlabeled: list[dict],
        scope: str,
        should_continue: Callable[[], bool] | None = None,
    ) -> int:
        """
        Run the shared L0/L1 classifier and persist labels for supplied rows.

        ``should_continue`` is polled before every row.  This batch used to be
        one day (≤24 summaries); it is now the whole serialize day list, up to
        ~2,160 summaries at two Qwen calls each — Stage 1 L0 and Stage 2 L1 —
        so a cancelled nightly that could not interrupt it would zombie-run
        ~4,300 model calls on the single-flight inference executor, blocking
        every other user's night behind it.  Stopping mid-batch is safe because
        each label is committed on its own row: the next run picks up exactly
        the summaries this one did not reach.
        """
        if not unlabeled:
            return 0

        from ci.hbpe.inference.qwen import get_qwen
        from ci.hbpe.tokenizer.qwen_labeler import (
            _L0_BLOCK,
            _L0_EXAMPLES,
            _SYSTEM,
            _build_l1_event_message,
            _clean_label,
            _parse_json,
        )
        from ci.hbpe.tokenizer.vocab_registry import (
            L0_CLASSES,
            get_l1_vocab,
            get_or_create_l1,
            normalise_l0,
        )

        # Build L1 vocab once; refreshed per-L0 when a new cluster is created.
        all_l1: dict[str, list[dict]] = {
            l0: get_l1_vocab(user_id, l0) for l0 in L0_CLASSES
        }

        labeled = 0
        stopped = False
        for row in unlabeled:
            if should_continue is not None and not should_continue():
                stopped = True
                break
            try:
                summary_text = _extract_summary_text(row["content"])
                if not summary_text:
                    continue

                text = summary_text[:400]

                # Stage 1: L0 — few-shot examples anchor model to diverse classes
                l0_msg = (
                    "Classify the activity category of this hourly activity summary.\n\n"
                    f"Categories:\n{_L0_BLOCK}\n\n"
                    f"Examples:\n{_L0_EXAMPLES}\n\n"
                    f'Summary: "{text}" → '
                )
                l0_raw = get_qwen().generate(
                    l0_msg, system_message=_SYSTEM, max_new_tokens=256
                )
                l0 = normalise_l0(_parse_json(l0_raw).get("l0", "UNKNOWN"))

                # Stage 2: L1 given locked L0
                l1_msg = _build_l1_event_message(text, None, l0, all_l1.get(l0, []))
                l1_raw_str = get_qwen().generate(
                    l1_msg, system_message=_SYSTEM, max_new_tokens=256
                )
                l1_raw = _clean_label(_parse_json(l1_raw_str).get("l1", "Activity"))

                from ci.hbpe.tokenizer.label_quality import (
                    is_displayable_label,
                    is_unknown_class,
                )

                if is_unknown_class(l0) or not is_displayable_label(l1_raw):
                    continue

                l1_id, is_new = get_or_create_l1(user_id, l0, l1_raw)

                if is_new:
                    all_l1[l0] = get_l1_vocab(user_id, l0)

                _store_summary_label(row["summary_id"], l0, l1_id, summary_text)
                labeled += 1

            except Exception:
                log.exception(
                    "SummaryTokenizer.label_day failed: summary_id=%s",
                    row["summary_id"],
                )

        log.info(
            "SummaryTokenizer: labeled %d/%d summaries (user=%s %s)%s",
            labeled,
            len(unlabeled),
            user_id,
            scope,
            " [cancelled]" if stopped else "",
        )
        return labeled

    def get_tokens_for_day(self, user_id: str, date_str: str) -> list[dict]:
        """
        Return L0+L1 token records from labeled summaries for this date.

        Each hourly summary maps to 2 consecutive 30-min buckets (e.g.
        period_start 14:00 → buckets 28–29).  Records use the same shape as
        the ones _fetch_tokens_for_day() in serializer.py collects.
        """
        from ci.hbpe.data_client import get_labeled_summaries

        return _build_summary_tokens(get_labeled_summaries(user_id, date_str))


# ── DB helpers ─────────────────────────────────────────────────────────────────


def _extract_summary_text(content: object) -> str:
    """Extract summary_text from the content JSONB column (max 400 chars)."""
    if content is None:
        return ""
    try:
        if isinstance(content, str):
            content = json.loads(content)
        return str(content.get("summary_text") or "")[:400]
    except (json.JSONDecodeError, AttributeError):
        return ""


def _store_summary_label(
    summary_id: str, l0_class: str, l1_cluster_id: str | None, summary_text: str
) -> None:
    sql = """
        WITH current_summary AS MATERIALIZED (
            SELECT summary_id FROM ci.summaries
            WHERE summary_id = %s::uuid AND period_type = 'hourly'
              AND LEFT(COALESCE(content->>'summary_text', ''), 400) = %s
            FOR SHARE
        )
        INSERT INTO hbpe.summary_l1_label (summary_id, l0_class, l1_cluster_id)
        SELECT summary_id, %s, %s::uuid FROM current_summary
        ON CONFLICT (summary_id) DO NOTHING
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (summary_id, summary_text, l0_class, l1_cluster_id))


def _build_summary_tokens(rows: list[dict]) -> list[dict]:
    """
    Convert labeled summary rows into token records.

    Each hourly summary spans 2 consecutive 30-min buckets.  All buckets
    receive the same L0+L1 token at SUMMARY_SOFT_PROB confidence.
    Rows must have keys: l0_class, l1_cluster_id, period_start.
    """
    records: list[dict] = []
    for r in rows:
        period_start = r["period_start"]
        if isinstance(period_start, str):
            period_start = datetime.fromisoformat(period_start)

        # Compute the starting bucket index from minutes since midnight.
        midnight = period_start.replace(hour=0, minute=0, second=0, microsecond=0)
        minutes_elapsed = (period_start - midnight).total_seconds() / 60
        start_bucket = min(
            max(int(minutes_elapsed / BUCKET_MINUTES), 0), MAX_BUCKET_INDEX
        )
        end_bucket = min(start_bucket + SUMMARY_BUCKETS_PER_HOUR - 1, MAX_BUCKET_INDEX)

        for bucket_idx in range(start_bucket, end_bucket + 1):
            records.append(
                {
                    "level": "L0",
                    "token_id": r["l0_class"],
                    "soft_prob_vector": [SUMMARY_SOFT_PROB],
                    "bucket_idx": bucket_idx,
                }
            )
            if r["l1_cluster_id"]:
                records.append(
                    {
                        "level": "L1",
                        "token_id": r["l1_cluster_id"],
                        "soft_prob_vector": [SUMMARY_SOFT_PROB],
                        "bucket_idx": bucket_idx,
                    }
                )

    records.sort(key=lambda rec: rec["bucket_idx"])
    return records
