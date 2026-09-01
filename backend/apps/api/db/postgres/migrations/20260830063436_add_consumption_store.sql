-- migrate:up
-- ---------------------------------------------------------------------------
-- Durable, indivisible consumption counters. G8.
--
-- Three separate abuse controls were in-process `Map`s, and all three said so
-- in their own docstrings: `AskRateLimitService`, `PeerRateLimitService`, and
-- the replay-nonce cache inside `PeerSignatureService`.
--
-- For the two rate limiters the consequence is a quantitative one -- N api
-- processes means N times the effective limit, and a restart resets every
-- window. For the nonce cache it is qualitative: per-process memory means a
-- REPLAY SUCCEEDS ONCE PER REPLICA. A defence that is defeated by horizontal
-- scaling is not a defence, and nothing about the deployment shape made that
-- visible.
--
-- UMA's finding #7 is the framing: single-use must be INDIVISIBLE, not merely
-- once. They ship an in-memory and a Postgres backend behind one interface and
-- require both to pass the same concurrency suite. The test discipline is as
-- much the point as the store, so `consumptionStore.contract.spec.ts` races
-- concurrent callers at both.
--
-- ═══ WHY TWO TABLES AND NOT ONE ═══
--
-- They have genuinely different shapes. A window is a MUTABLE SET that shrinks
-- as time passes and is read-modify-written under contention. A nonce is an
-- IMMUTABLE CLAIM whose entire semantics are "the first writer wins" -- which a
-- primary key already expresses, with no lock and no read, and therefore with
-- no way to get the concurrency wrong. Collapsing them would give the nonce the
-- window's read-modify-write and lose exactly the property that makes it safe.
--
-- CI-Server #2365.
-- ---------------------------------------------------------------------------

-- A sliding window's retained hit timestamps, keyed by whatever the caller is
-- limiting on (an asker id, a peer's issuer+subject, a bucket name).
--
-- `hits` is an ARRAY rather than a row per hit. The array is bounded by the
-- caller's own `max` -- `checkSlidingWindow` never retains more than that -- so
-- it cannot grow without limit, and one row per key means the read-modify-write
-- takes exactly one row lock. A row-per-hit table would have needed either an
-- advisory lock or a serializable transaction to count and insert atomically.
CREATE TABLE ci.consumption_windows (
    key TEXT PRIMARY KEY,
    -- Epoch milliseconds, ascending. BIGINT because epoch-ms overflows INT in 1970.
    hits BIGINT[] NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reaping abandoned keys. A window whose owner never returns is retained
-- forever otherwise -- harmless per row, unbounded in aggregate across every
-- one-off asker a box ever sees.
CREATE INDEX consumption_windows_updated_idx ON ci.consumption_windows (updated_at);

-- Single-use claims. The PRIMARY KEY is the whole mechanism: an
-- `INSERT ... ON CONFLICT DO NOTHING RETURNING` returns a row for exactly one
-- caller, however many race, without a lock, a read, or a transaction.
--
-- Note what is NOT here: no `created_at`, no claimant, no counter. A nonce
-- record answers one question -- "has this been used" -- and every additional
-- column would be a fact about the caller that this table has no business
-- keeping.
CREATE TABLE ci.consumed_nonces (
    key TEXT PRIMARY KEY,
    -- When this claim stops mattering. Bounded by MAX_SIGNATURE_LIFETIME_MS at
    -- the caller, so the table's live set is bounded by the request rate over
    -- that window rather than by total traffic.
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX consumed_nonces_expiry_idx ON ci.consumed_nonces (expires_at);

COMMENT ON TABLE ci.consumption_windows IS
    'Sliding-window rate-limit state. Read-modify-written under a row lock; see PostgresConsumptionStore.';
COMMENT ON TABLE ci.consumed_nonces IS
    'Single-use claims (signature replay nonces). First writer wins by primary key.';

-- migrate:down
DROP TABLE IF EXISTS ci.consumed_nonces;
DROP TABLE IF EXISTS ci.consumption_windows;
