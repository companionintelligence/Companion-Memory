"""
Collapse a day's events to at most one L0 + one L1 token per bucket.

Tier (anchor) beats duration. Losers remain in the L0 occupancy distribution
written on the winning L0 token's soft_prob.
"""

from __future__ import annotations

from collections import defaultdict

from ci.hbpe.buckets import BUCKET_MINUTES, BUCKETS_PER_DAY
from ci.hbpe.tokenizer.vocab_registry import L0_CLASSES

L0_INDEX = {name: i for i, name in enumerate(L0_CLASSES)}

ANCHOR = "anchor"
AMBIENT = "ambient"


def overlap_minutes(
    start_min: float,
    end_min: float | None,
    bucket: int,
    default_minutes: float,
) -> float:
    """Minutes of [start, end] that fall in `bucket`. Point events use default_minutes."""
    lo = bucket * BUCKET_MINUTES
    hi = lo + BUCKET_MINUTES
    span_end = (
        end_min
        if end_min is not None and end_min > start_min
        else start_min + default_minutes
    )
    return max(0.0, min(hi, span_end) - max(lo, start_min))


def aggregate_day(events: list[dict]) -> list[dict]:
    """
    events items:
      start_min, end_min?, default_minutes, tier, l0_class, l1_cluster_id,
      l1_sim, priority?, l2_cluster_id?, l2_sim?

    Returns token records (L0/L1/L2) ready for TokenSerializer, at most one
    L0+L1 (+optional L2) per bucket.
    """
    by_bucket: dict[int, list[tuple[float, dict]]] = defaultdict(list)
    occupancy: dict[int, list[float]] = {
        b: [0.0] * len(L0_CLASSES) for b in range(BUCKETS_PER_DAY)
    }

    for event in events:
        start_min = float(event["start_min"])
        end_min = event.get("end_min")
        default = float(
            event.get("default_minutes") or event.get("default_duration_min") or 5
        )
        first = int(start_min // BUCKET_MINUTES)
        last_end = (
            float(end_min)
            if end_min is not None and end_min > start_min
            else start_min + default
        )
        last = int(max(last_end - 1e-6, start_min) // BUCKET_MINUTES)
        for bucket in range(max(0, first), min(BUCKETS_PER_DAY, last + 1)):
            minutes = overlap_minutes(start_min, end_min, bucket, default)
            if minutes <= 0:
                continue
            by_bucket[bucket].append((minutes, event))
            l0 = event.get("l0_class") or "UNKNOWN"
            if l0 in L0_INDEX:
                occupancy[bucket][L0_INDEX[l0]] += minutes

    records: list[dict] = []
    for bucket in range(BUCKETS_PER_DAY):
        claimants = by_bucket.get(bucket) or []
        if not claimants:
            continue
        winner_minutes, winner = max(claimants, key=lambda row: _rank(row[0], row[1]))
        dist = occupancy[bucket]
        total = sum(dist)
        soft = [x / total for x in dist] if total > 0 else [0.0] * len(L0_CLASSES)
        records.append(
            {
                "level": "L0",
                "token_id": winner.get("l0_class") or "UNKNOWN",
                "soft_prob_vector": soft,
                "bucket_idx": bucket,
            }
        )
        if winner.get("l1_cluster_id"):
            records.append(
                {
                    "level": "L1",
                    "token_id": winner["l1_cluster_id"],
                    "soft_prob_vector": [float(winner.get("l1_sim") or 1.0)],
                    "bucket_idx": bucket,
                }
            )
        if winner.get("l2_cluster_id"):
            records.append(
                {
                    "level": "L2",
                    "token_id": winner["l2_cluster_id"],
                    "soft_prob_vector": [float(winner.get("l2_sim") or 0.0)],
                    "bucket_idx": bucket,
                }
            )
        _ = winner_minutes
    return records


def _rank(minutes: float, event: dict) -> tuple:
    tier_rank = 1 if (event.get("tier") or ANCHOR) == ANCHOR else 0
    priority = int(event.get("priority") or 0)
    start_min = float(event.get("start_min") or 0)
    return (tier_rank, minutes, priority, start_min)
