"""
Summary Tokenizer — labels hourly summaries with L0+L1 via Qwen and returns
token records for inclusion in the HMT token stream.

Hourly summaries from ci.summaries cover 2 × 30-min buckets each.  Where a
bucket has no event-derived token, a summary-derived token fills the gap,
giving the model signal for hours that contain no calendar events (sleep,
leisure, off-calendar work, commutes).

Labels are cached in ci.summary_l1_label after the first Qwen call, so
re-serializing the same day does not re-invoke the model.

Summary tokens are written with soft_prob=SUMMARY_SOFT_PROB (0.7) to indicate
lower confidence than event-derived tokens (which arrive with similarity 1.0
from the direct L1 cluster assignment).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Optional

import psycopg2.extras

from ci.database import get_conn

log = logging.getLogger(__name__)

# Summary-derived tokens carry lower confidence than event-derived tokens.
SUMMARY_SOFT_PROB = 0.7


class SummaryTokenizer:
    """Labels hourly summaries and provides token records for the token stream."""

    def label_day(self, user_id: str, date_str: str) -> int:
        """
        Label all unlabeled hourly summaries for user+date via Qwen.

        Fetches summaries from ci.summaries that have no entry in
        ci.summary_l1_label yet, runs each through the Qwen labeler, and
        writes the result.  Returns the number of summaries newly labeled.
        """
        unlabeled = _fetch_unlabeled_summaries(user_id, date_str)
        if not unlabeled:
            return 0

        from ci.inference.qwen import get_qwen
        from ci.tokenizer.vocab_registry import (
            L0_CLASSES,
            get_l1_vocab,
            get_or_create_l1,
            normalise_l0,
        )
        from ci.tokenizer.qwen_labeler import (  # noqa: PLC0415
            _L0_BLOCK,
            _SYSTEM,
            _clean_label,
            _format_l1_vocab,
            _parse_json,
        )

        # Build L1 vocab once for the whole batch (cache across iterations).
        all_l1: dict[str, list[dict]] = {
            l0: get_l1_vocab(user_id, l0) for l0 in L0_CLASSES
        }

        labeled = 0
        for row in unlabeled:
            try:
                summary_text = _extract_summary_text(row["content"])
                if not summary_text:
                    continue

                vocab_lines = _format_l1_vocab(all_l1)
                user_msg = (
                    "Classify this hourly activity summary.\n\n"
                    f"L0 — choose EXACTLY one of these classes (use the exact name):\n{_L0_BLOCK}\n\n"
                    "L1 — activity sub-category. Choose from the existing labels below, "
                    f"or propose a new concise 2-4 word label:\n{vocab_lines}\n\n"
                    f'Summary: "{summary_text[:400]}"\n\n'
                    'Output format: {"l0": "...", "l1": "..."}'
                )

                raw = get_qwen().generate(user_msg, system_message=_SYSTEM, max_new_tokens=60)
                parsed = _parse_json(raw)

                l0 = normalise_l0(parsed.get("l0", "UNKNOWN"))
                l1_raw = _clean_label(parsed.get("l1", "General"))
                l1_id, is_new = get_or_create_l1(user_id, l0, l1_raw)

                if is_new:
                    all_l1[l0] = get_l1_vocab(user_id, l0)

                _store_summary_label(row["summary_id"], l0, l1_id)
                labeled += 1

            except Exception as exc:
                log.error(
                    "SummaryTokenizer.label_day: summary %s failed: %s",
                    row["summary_id"],
                    exc,
                )

        log.info(
            "SummaryTokenizer.label_day: labeled %d/%d summaries (user=%s date=%s)",
            labeled,
            len(unlabeled),
            user_id,
            date_str,
        )
        return labeled

    def get_tokens_for_day(self, user_id: str, date_str: str) -> list[dict]:
        """
        Return L0+L1 token records from labeled summaries for this date.

        Each hourly summary maps to 2 consecutive 30-min buckets (e.g.
        period_start 14:00 → buckets 28 and 29).  Records use the same shape
        as those returned by _fetch_tokens_for_day() in serializer.py.
        """
        return _fetch_summary_tokens(user_id, date_str)


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


def _fetch_unlabeled_summaries(user_id: str, date_str: str) -> list[dict]:
    """Fetch hourly summaries for user+date with no ci.summary_l1_label entry."""
    sql = """
        SELECT s.summary_id::text, s.period_start, s.content
        FROM ci.summaries s
        LEFT JOIN ci.summary_l1_label sl ON sl.summary_id = s.summary_id
        WHERE s.user_id     = %s::uuid
          AND s.period_type = 'hourly'
          AND s.period_start::date = %s::date
          AND sl.summary_id IS NULL
        ORDER BY s.period_start
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (user_id, date_str))
            return [dict(r) for r in cur.fetchall()]


def _store_summary_label(
    summary_id: str, l0_class: str, l1_cluster_id: Optional[str]
) -> None:
    sql = """
        INSERT INTO ci.summary_l1_label (summary_id, l0_class, l1_cluster_id)
        VALUES (%s::uuid, %s, %s::uuid)
        ON CONFLICT (summary_id) DO NOTHING
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (summary_id, l0_class, l1_cluster_id))


def _fetch_summary_tokens(user_id: str, date_str: str) -> list[dict]:
    """
    Fetch labeled summary tokens for the given date.

    Each hourly summary spans 2 consecutive 30-min buckets.  Both buckets
    receive the same L0+L1 token at SUMMARY_SOFT_PROB confidence.
    """
    sql = """
        SELECT
            sl.l0_class,
            sl.l1_cluster_id::text AS l1_cluster_id,
            s.period_start
        FROM ci.summaries s
        JOIN ci.summary_l1_label sl ON sl.summary_id = s.summary_id
        WHERE s.user_id     = %s::uuid
          AND s.period_type = 'hourly'
          AND s.period_start::date = %s::date
        ORDER BY s.period_start
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (user_id, date_str))
            rows = [dict(r) for r in cur.fetchall()]

    records: list[dict] = []
    for r in rows:
        period_start = r["period_start"]
        if isinstance(period_start, str):
            period_start = datetime.fromisoformat(period_start)

        # Compute the starting bucket index from minutes since midnight.
        midnight = period_start.replace(hour=0, minute=0, second=0, microsecond=0)
        minutes_elapsed = (period_start - midnight).total_seconds() / 60
        start_bucket = min(max(int(minutes_elapsed / 30), 0), 47)
        end_bucket = min(start_bucket + 1, 47)  # 1-hour summary → 2 buckets

        for bucket_idx in range(start_bucket, end_bucket + 1):
            records.append({
                "level": "L0",
                "token_id": r["l0_class"],
                "soft_prob_vector": [SUMMARY_SOFT_PROB],
                "bucket_idx": bucket_idx,
            })
            if r["l1_cluster_id"]:
                records.append({
                    "level": "L1",
                    "token_id": r["l1_cluster_id"],
                    "soft_prob_vector": [SUMMARY_SOFT_PROB],
                    "bucket_idx": bucket_idx,
                })

    records.sort(key=lambda rec: rec["bucket_idx"])
    return records
