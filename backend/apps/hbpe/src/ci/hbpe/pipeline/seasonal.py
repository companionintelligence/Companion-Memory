"""
Month-of-year seasonal profiles. Cheap SQL, no GPU.
"""

from __future__ import annotations

import datetime
import logging
from collections import defaultdict

import numpy as np
import psycopg2.extras

from ci.hbpe.database import get_conn

log = logging.getLogger(__name__)

MAX_HISTORY_DAYS = 800
MOY_PRIOR = 0.25


def rebuild_seasonal_profiles(user_id: str) -> dict:
    today = datetime.datetime.utcnow().date()
    start = today - datetime.timedelta(days=MAX_HISTORY_DAYS)
    sql = """
        SELECT ts.token_id::uuid AS cluster_id, ts.date
        FROM hbpe.token_stream ts
        JOIN hbpe.l1_clusters c
          ON c.cluster_id::text = ts.token_id AND c.user_id = ts.user_id
        WHERE ts.user_id = %s
          AND ts.level = 'L1'
          AND ts.date >= %s
          AND ts.date <= %s
          AND c.is_active
          AND COALESCE(c.tier, 'anchor') = 'anchor'
        GROUP BY ts.token_id, ts.date
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (str(user_id), start, today))
            rows = [dict(r) for r in cur.fetchall()]

    by_cluster: dict[str, list[datetime.date]] = defaultdict(list)
    for row in rows:
        by_cluster[str(row["cluster_id"])].append(row["date"])

    upserts = []
    for cid, dates in by_cluster.items():
        moy = [0] * 12
        years = set()
        doys: list[int] = []
        for d in dates:
            moy[d.month - 1] += 1
            years.add(d.year)
            doys.append(d.timetuple().tm_yday)
        distinct = len(years)
        counts = np.asarray(moy, dtype=np.float64)
        total = counts.sum()
        if total == 0:
            continue
        peaked = counts / (counts + MOY_PRIOR)
        annual = float(np.clip(peaked.max() * min(1.0, distinct / 2.0), 0.0, 1.0))
        if distinct < 2:
            annual = 0.0
        upserts.append(
            (
                user_id,
                cid,
                [int(v) for v in moy],
                distinct,
                int(np.median(doys)) if doys else None,
                annual,
            )
        )

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM hbpe.seasonal_profiles WHERE user_id = %s",
                (str(user_id),),
            )
            if upserts:
                psycopg2.extras.execute_batch(
                    cur,
                    """
                    INSERT INTO hbpe.seasonal_profiles
                        (user_id, l1_cluster_id, computed_at, moy_counts,
                         distinct_years, typical_day_of_year, annual_confidence)
                    VALUES (%s, %s, NOW(), %s, %s, %s, %s)
                    """,
                    upserts,
                )
    log.info("seasonal_profiles user=%s rows=%d", user_id[:8], len(upserts))
    return {"profiles": len(upserts)}


def seasonal_forecast(user_id: str) -> list[dict]:
    sql = """
        SELECT s.l1_cluster_id::text, c.label, c.l0_class,
               s.moy_counts, s.distinct_years, s.typical_day_of_year,
               s.annual_confidence
        FROM hbpe.seasonal_profiles s
        JOIN hbpe.l1_clusters c ON c.cluster_id = s.l1_cluster_id
        WHERE s.user_id = %s AND c.is_active
          AND COALESCE(c.tier, 'anchor') = 'anchor'
          AND s.annual_confidence > 0
        ORDER BY s.annual_confidence DESC
    """
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, (str(user_id),))
            rows = [dict(r) for r in cur.fetchall()]
    out = []
    for r in rows:
        out.append(
            {
                "cluster_id": r["l1_cluster_id"],
                "name": (r["label"] or "").replace("_", " ").title(),
                "l0_class": r["l0_class"],
                "moy_counts": list(r["moy_counts"] or []),
                "distinct_years": r["distinct_years"],
                "typical_day_of_year": r["typical_day_of_year"],
                "annual_confidence": float(r["annual_confidence"]),
            }
        )
    return out
