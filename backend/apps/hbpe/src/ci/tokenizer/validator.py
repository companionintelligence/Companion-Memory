"""
Pipeline Validator — runs coverage and balance checks on hbpe.token_stream.

Checks (CI-HBPE-SPEC-001 §7.1, amended):
  • L0 coverage: ≥ 90% of bucket slots with events must have an L0 token.
  • L1 clusters per L0 class: 1–50 per class; UNKNOWN exempt from upper bound.
  • L2 cluster count: ≥ 5 total active clusters. Skipped when ci.content is
    empty — L2 is a Phase 2 concern.
  • Bucket sanity: flag days where ≥ 3 L0 tokens all share the same bucket
    (indicates a start_time parsing bug, not sparse calendar data).
  • Class balance: L0 distribution logged (imbalance expected and documented).

All checks query hbpe.token_stream and the cluster registry tables directly.
No parquet files required.

Output: validation_report.json written to corpus_dir (or CWD if not provided).
Raises ValidationError if any hard criterion fails.

Implements T1.6 (CI-Server-o52).
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

import psycopg2.extras

from ci.database import get_conn

log = logging.getLogger(__name__)

L0_COVERAGE_MIN = 0.90
L1_PER_CLASS_MIN = 1
L1_PER_CLASS_MAX = 50          # UNKNOWN is also exempt from the upper bound
L2_TOTAL_MIN = 5
BUCKET_COLLISION_THRESHOLD = 3  # ≥ this many L0 tokens in one bucket → likely a bug


class ValidationError(Exception):
    """Raised when a hard acceptance criterion fails."""


class PipelineValidator:
    """Runs all acceptance-criteria checks against hbpe.token_stream."""

    def validate(self, user_id: str, report_dir: Path | None = None) -> dict:
        """
        Run all checks and return a report dict.

        Writes validation_report.json to report_dir (defaults to CWD).
        Raises ValidationError if any hard criterion fails.
        """
        report: dict = {"user_id": user_id, "passed": True, "checks": {}}
        failures: list[str] = []

        # Confirm token_stream has rows for this user
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(DISTINCT date) FROM hbpe.token_stream WHERE user_id = %s",
                    (user_id,),
                )
                days_loaded = cur.fetchone()[0]

        if not days_loaded:
            msg = "No rows in hbpe.token_stream for this user — run TokenSerializer first"
            report["passed"] = False
            report["checks"]["token_stream"] = {"passed": False, "detail": msg}
            _write_report(report, report_dir)
            raise ValidationError(msg)

        report["checks"]["days_loaded"] = days_loaded

        # 1. L0 coverage
        l0_check = _check_l0_coverage(user_id)
        report["checks"]["l0_coverage"] = l0_check
        if not l0_check["passed"]:
            failures.append(f"L0 coverage {l0_check['coverage']:.2%} < {L0_COVERAGE_MIN:.0%}")

        # 2. L0 class balance (informational — never fails)
        report["checks"]["l0_class_balance"] = _check_l0_balance(user_id)

        # 3. L1 clusters per class
        l1_check = _check_l1_cluster_counts(user_id)
        report["checks"]["l1_cluster_counts"] = l1_check
        if not l1_check["passed"]:
            failures.append(f"L1 cluster count violation: {l1_check['violations']}")

        # 4. L2 cluster count — skipped when no content data (Phase 2)
        l2_check = _check_l2_cluster_total(user_id)
        report["checks"]["l2_cluster_total"] = l2_check
        if not l2_check["passed"] and not l2_check.get("skipped"):
            failures.append(f"L2 cluster total {l2_check['total']} < {L2_TOTAL_MIN}")

        # 5. Bucket sanity
        sanity_check = _check_bucket_sanity(user_id)
        report["checks"]["bucket_sanity"] = sanity_check
        if not sanity_check["passed"]:
            failures.append(f"Bucket collision on dates: {sanity_check['collision_dates']}")

        if failures:
            report["passed"] = False
            report["failures"] = failures
            log.error("Pipeline validation FAILED for user=%s: %s", user_id, failures)
        else:
            log.info("Pipeline validation passed for user=%s", user_id)

        _write_report(report, report_dir)

        if failures:
            raise ValidationError(f"Validation failed: {failures}")

        return report


# ── Individual checks ─────────────────────────────────────────────────────────


def _check_l0_coverage(user_id: str) -> dict:
    """≥ 90% of non-SOD/EOD bucket slots must have an L0 token."""
    sql = """
        SELECT
            COUNT(DISTINCT bucket_idx) FILTER (WHERE level = 'L0')   AS l0_slots,
            COUNT(DISTINCT bucket_idx) FILTER (WHERE level NOT IN ('SOD','EOD')) AS total_slots
        FROM hbpe.token_stream
        WHERE user_id = %s
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (user_id,))
            l0_slots, total_slots = cur.fetchone()

    coverage = (l0_slots / total_slots) if total_slots else 0.0
    return {
        "passed": coverage >= L0_COVERAGE_MIN,
        "coverage": coverage,
        "l0_slots": l0_slots,
        "total_slots": total_slots,
    }


def _check_l0_balance(user_id: str) -> dict:
    """Return L0 class distribution (informational — never a failure)."""
    sql = """
        SELECT token_id, COUNT(*) AS n
        FROM hbpe.token_stream
        WHERE user_id = %s AND level = 'L0'
        GROUP BY token_id
        ORDER BY n DESC
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (user_id,))
            distribution = {row[0]: row[1] for row in cur.fetchall()}

    return {"distribution": distribution, "note": "imbalance is expected per spec §7.1"}


def _check_l1_cluster_counts(user_id: str) -> dict:
    """
    Each active L0 class must have between L1_PER_CLASS_MIN and L1_PER_CLASS_MAX clusters.
    UNKNOWN is exempt from the upper bound.
    """
    sql = """
        SELECT l0_class, COUNT(*) AS cluster_count
        FROM hbpe.l1_clusters
        WHERE user_id = %s AND is_active = TRUE
        GROUP BY l0_class
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (user_id,))
            rows = {r["l0_class"]: int(r["cluster_count"]) for r in cur.fetchall()}

    violations = {
        cls: cnt for cls, cnt in rows.items()
        if cnt < L1_PER_CLASS_MIN or (cnt > L1_PER_CLASS_MAX and cls != "UNKNOWN")
    }
    return {"passed": len(violations) == 0, "counts": rows, "violations": violations}


def _check_l2_cluster_total(user_id: str) -> dict:
    """≥ L2_TOTAL_MIN active L2 clusters required; skipped when ci.content is empty."""
    from ci.data_client import count_user_content
    content_count = count_user_content(user_id)

    if content_count == 0:
        return {
            "passed": True,
            "skipped": True,
            "note": "no ci.content rows — L2 validation deferred to Phase 2",
            "total": 0,
        }

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM hbpe.l2_clusters WHERE user_id = %s AND is_active = TRUE",
                (user_id,),
            )
            total = cur.fetchone()[0]

    return {"passed": total >= L2_TOTAL_MIN, "skipped": False, "total": total, "minimum": L2_TOTAL_MIN}


def _check_bucket_sanity(user_id: str) -> dict:
    """
    Flag days where all L0 tokens land in the same bucket — indicates a
    start_time parsing bug.  Normal sparse calendar days will not trigger this.
    """
    sql = """
        SELECT date::text
        FROM hbpe.token_stream
        WHERE user_id = %s AND level = 'L0'
        GROUP BY date
        HAVING COUNT(*) >= %s
           AND COUNT(DISTINCT bucket_idx) = 1
        ORDER BY date
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (user_id, BUCKET_COLLISION_THRESHOLD))
            collision_dates = [row[0] for row in cur.fetchall()]

    return {
        "passed": len(collision_dates) == 0,
        "collision_dates": collision_dates,
        "note": "flags days where all events share one bucket (start_time bug)",
    }


def _write_report(report: dict, report_dir: Path | None) -> None:
    out_dir = report_dir or Path(".")
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "validation_report.json"
    with open(out, "w") as fh:
        json.dump(report, fh, indent=2, default=str)
    log.info("Validation report written to %s", out)
