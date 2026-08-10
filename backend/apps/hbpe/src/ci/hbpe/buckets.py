"""Shared HBPE day-bucketing constants (15-minute resolution)."""

BUCKET_MINUTES = 15
BUCKET_SECONDS = BUCKET_MINUTES * 60
BUCKETS_PER_DAY = (24 * 60) // BUCKET_MINUTES
BUCKETS_PER_PART = BUCKETS_PER_DAY // 4
MAX_BUCKET_INDEX = BUCKETS_PER_DAY - 1
SUMMARY_BUCKETS_PER_HOUR = 60 // BUCKET_MINUTES

# Pre-2026-08-09 token_stream rows used 30-minute buckets (48/day, EOD at 47).
LEGACY_BUCKET_MINUTES = 30
LEGACY_BUCKET_SECONDS = LEGACY_BUCKET_MINUTES * 60
LEGACY_BUCKETS_PER_DAY = (24 * 60) // LEGACY_BUCKET_MINUTES
LEGACY_MAX_BUCKET_INDEX = LEGACY_BUCKETS_PER_DAY - 1


def detect_legacy_token_stream(tokens: list[dict]) -> bool:
    """
    True when a day's token_stream rows still use 30-minute bucket indexing.

    Serialized days always include [EOD] at the final bucket index — 47 for
    legacy rows, 95 for current 15-minute rows.
    """
    for token in tokens:
        if token.get("token_id") == "EOD" or token.get("level") == "EOD":
            return int(token["bucket_idx"]) == LEGACY_MAX_BUCKET_INDEX

    l0_buckets = [
        int(token["bucket_idx"])
        for token in tokens
        if token.get("level") == "L0" and token.get("token_id") not in ("SOD", "EOD")
    ]
    if not l0_buckets:
        return False
    if max(l0_buckets) > LEGACY_MAX_BUCKET_INDEX:
        return False
    # Partial day without EOD — treat as current format (re-serialize will fix).
    return False


def legacy_hist_to_forecast_buckets(hist_bucket: int) -> list[int]:
    """Map one legacy 30-min hist bucket to its two 15-min forecast buckets."""
    start = hist_bucket * 2
    return [b for b in (start, start + 1) if b <= MAX_BUCKET_INDEX]
