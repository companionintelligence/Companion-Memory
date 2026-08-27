-- migrate:up
-- The retrieval knobs, as a versioned appliance-level policy instead of a
-- module-level `const`.
--
-- Every number that decides what search returns is currently a literal in one
-- of two files — `TS_RANK_WEIGHTS`, `EMBEDDING_BOOST_FACTOR`,
-- `SEMANTIC_DISTANCE_THRESHOLD` and `SEMANTIC_MAX_RESULTS` in
-- `domains/search-next/services/SearchService.ts`, and `MESSAGE_RESULTS`,
-- `MESSAGE_DISTANCE_FLOOR`, `SEED_MODE`, `GROUNDED_SIMILARITY_FLOOR` and
-- `ANCHORED_DEPTH_MULTIPLIER` in `domains/agent/services/RecallService.ts`.
-- `SearchService` makes no `config.get` call of any kind and `config/default.json`
-- has no `search` key, so today the only way to change any of them is to edit,
-- rebuild and redeploy. Their own doc comments describe a hand-run A/B and end
-- with instructions like "flip the constant (not the call sites) if the
-- benchmark reverses it" — i.e. the tuning loop is already being run, once, by
-- a person, and its result has nowhere to live but a diff.
--
-- ── Appliance-scoped, not per-user ─────────────────────────────────────────
-- No `user_id`. These are properties of the RETRIEVAL ALGORITHM, not of a
-- person: a ts_rank weight vector or a cosine floor is measured against a
-- corpus and then applies to every query the appliance serves. A per-user
-- column would invite per-user tuning that nothing here can evaluate — a 1-5
-- user appliance cannot produce a per-user significance test.
--
-- ── Versioned, append-only, never reverted ─────────────────────────────────
-- One row per version; the reader takes MAX(version) and nothing else. This is
-- the same ledger convention already documented for pipeline stages in
-- `domains/pipeline/versions.ts` ("A bad version is superseded by v+1; it is
-- never reverted"), for the same reason: a version number that can go back down
-- makes "which policy produced this result" unanswerable. Undoing v2 means
-- promoting v3 that happens to carry v1's numbers, with `notes` saying so.
--
-- Rows are NOT edited in place. Editing a superseded row would rewrite history
-- without changing behaviour (the reader only ever looks at the newest);
-- editing the newest row would change behaviour with no record that it changed.
--
-- ── v1 is today's constants, exactly ───────────────────────────────────────
-- The seed below carries the literal values compiled in today, so promoting to
-- v1 is a behavioural no-op and current behaviour is the baseline by
-- construction. `RETRIEVAL_POLICY_DEFAULTS`
-- (`domains/retrieval-policy/constants.ts`) holds the same numbers as the
-- fail-open fallback, and `RetrievalPolicyService` returns them whenever this
-- table is empty, unreadable or holds a row that fails validation. A retrieval
-- path that hard-failed on a missing config row would be a far worse bug than
-- an unturned knob.
--
-- ── No retention cron, deliberately ────────────────────────────────────────
-- This table does not accrete. It gains one row per PROMOTION, and a promotion
-- is a human decision (the automated tuning loop that would write here does not
-- exist and cannot be built until the benchmark stops writing its personas into
-- the user's own memory graph — see the PR body). An appliance tuned monthly
-- for a decade holds ~120 rows. Pruning would also be actively wrong: the
-- superseded rows ARE the audit trail that makes "why did retrieval change in
-- March" answerable, which is the entire point of versioning rather than
-- overwriting.
CREATE TABLE IF NOT EXISTS ci.retrieval_policy (
    -- Monotonic. The reader takes MAX(version); see the ledger note above.
    version                       integer PRIMARY KEY,

    -- ── SearchService knobs ────────────────────────────────────────────────
    -- PostgreSQL ts_rank weight multipliers, {D, C, B, A}. Stored as four
    -- bounded numbers rather than as the `'{0.1, 0.2, 0.4, 1.0}'` string the
    -- SQL wants, because that string is INTERPOLATED into the statement (it is
    -- a ts_rank literal, not a bindable parameter). Four CHECKed doubles that
    -- the reader formats cannot carry anything but a number.
    ts_rank_weight_d              double precision NOT NULL,
    ts_rank_weight_c              double precision NOT NULL,
    ts_rank_weight_b              double precision NOT NULL,
    ts_rank_weight_a              double precision NOT NULL,
    -- keyword_score * (1 + this * embedding_similarity). Also interpolated.
    embedding_boost_factor        double precision NOT NULL,
    -- Cosine DISTANCE floor for semanticSearch: smaller = stricter.
    semantic_distance_threshold   double precision NOT NULL,
    -- Default LIMIT for semanticSearch, and therefore the k recall is measured at.
    semantic_max_results          integer NOT NULL,

    -- ── RecallService knobs ────────────────────────────────────────────────
    -- Raw-message ("naive RAG") channel top-K.
    recall_message_results        integer NOT NULL,
    -- Cosine-distance floor forwarded to searchMessages. NULL means "inherit
    -- SearchService's own default", which is what the constant expresses today
    -- (`const MESSAGE_DISTANCE_FLOOR: number | undefined = undefined`).
    recall_message_distance_floor double precision,
    -- Seed mode for the entity/graph channel: one of SearchService's modes.
    recall_seed_mode              text NOT NULL,
    -- Cosine-SIMILARITY floor for the 'grounded' strategy's semantic channel
    -- (the caller passes 1 - this as a distance threshold).
    grounded_similarity_floor     double precision NOT NULL,
    -- How much deeper 'grounded' cuts its anchored channel than its semantic one.
    anchored_depth_multiplier     double precision NOT NULL,

    -- ── Provenance ─────────────────────────────────────────────────────────
    promoted_at                   timestamptz NOT NULL DEFAULT now(),
    -- The evaluation run whose result justified this promotion. NULL for v1
    -- (nothing was measured to arrive at it — it is what the code already did)
    -- and NULL for any hand promotion. Deliberately NOT a foreign key: no
    -- eval-run table exists yet, and the promotion gate that would populate it
    -- is the follow-up this PR explicitly does not build. Keeping the column
    -- unconstrained means the follow-up adds a FK, not a column plus a
    -- backfill.
    promoted_from_eval_run        uuid,
    -- Why. Required, because a version number with no reason attached is a
    -- number nobody can act on two quarters later.
    notes                         text NOT NULL,

    -- Versions start at 1, never 0 — same rule as the pipeline ledger.
    CONSTRAINT retrieval_policy_version_min CHECK (version >= 1),
    -- ts_rank multipliers are documented as being in [0, 1]; anything outside
    -- that is a typo, not a tuning choice.
    CONSTRAINT retrieval_policy_ts_rank_weights_range CHECK (
        ts_rank_weight_d BETWEEN 0 AND 1
        AND ts_rank_weight_c BETWEEN 0 AND 1
        AND ts_rank_weight_b BETWEEN 0 AND 1
        AND ts_rank_weight_a BETWEEN 0 AND 1
    ),
    -- A negative boost would make a better embedding match rank WORSE.
    CONSTRAINT retrieval_policy_boost_nonneg CHECK (embedding_boost_factor >= 0),
    -- Cosine distance lives in [0, 2]; a floor outside it admits everything or
    -- nothing, both of which are ways of turning the channel off by accident.
    CONSTRAINT retrieval_policy_distance_range CHECK (
        semantic_distance_threshold > 0 AND semantic_distance_threshold <= 2
    ),
    CONSTRAINT retrieval_policy_message_floor_range CHECK (
        recall_message_distance_floor IS NULL
        OR (recall_message_distance_floor > 0 AND recall_message_distance_floor <= 2)
    ),
    -- Cosine SIMILARITY, so [0, 1].
    CONSTRAINT retrieval_policy_grounded_floor_range CHECK (
        grounded_similarity_floor >= 0 AND grounded_similarity_floor <= 1
    ),
    -- Every LIMIT has to be able to return at least one row.
    CONSTRAINT retrieval_policy_limits_positive CHECK (
        semantic_max_results >= 1
        AND recall_message_results >= 1
        AND anchored_depth_multiplier >= 1
    ),
    -- The mode vocabulary is SearchService's, and it is small and stable enough
    -- that a policy row naming a mode that does not exist should never reach the
    -- reader. The reader validates it again anyway and falls back rather than
    -- throwing.
    CONSTRAINT retrieval_policy_seed_mode_known CHECK (
        recall_seed_mode IN ('semantic', 'keyword', 'boosted', 'hybrid', 'auto')
    )
);

-- v1 — the constants as compiled in on 2026-08-26. A no-op by construction.
--
-- Values, and where each one comes from:
--   ts_rank weights {0.1, 0.2, 0.4, 1.0}  SearchService TS_RANK_WEIGHTS
--   embedding_boost_factor 0.5            SearchService EMBEDDING_BOOST_FACTOR
--   semantic_distance_threshold 0.5       SearchService SEMANTIC_DISTANCE_THRESHOLD
--   semantic_max_results 25               SearchService SEMANTIC_MAX_RESULTS
--   recall_message_results 10             RecallService MESSAGE_RESULTS
--   recall_message_distance_floor NULL    RecallService MESSAGE_DISTANCE_FLOOR (undefined)
--   recall_seed_mode 'boosted'            RecallService SEED_MODE
--   grounded_similarity_floor 0.7         RecallService GROUNDED_SIMILARITY_FLOOR
--   anchored_depth_multiplier 2           RecallService ANCHORED_DEPTH_MULTIPLIER
--
-- ON CONFLICT DO NOTHING so re-running this on an appliance that has already
-- promoted a v1 of its own cannot clobber it.
INSERT INTO ci.retrieval_policy (
    version,
    ts_rank_weight_d, ts_rank_weight_c, ts_rank_weight_b, ts_rank_weight_a,
    embedding_boost_factor,
    semantic_distance_threshold,
    semantic_max_results,
    recall_message_results,
    recall_message_distance_floor,
    recall_seed_mode,
    grounded_similarity_floor,
    anchored_depth_multiplier,
    promoted_from_eval_run,
    notes
) VALUES (
    1,
    0.1, 0.2, 0.4, 1.0,
    0.5,
    0.5,
    25,
    10,
    NULL,
    'boosted',
    0.7,
    2,
    NULL,
    'Baseline. The values compiled into SearchService and RecallService when the policy table was introduced, so promoting to v1 changes nothing. Not measured by an eval run: it is what the code already did.'
) ON CONFLICT (version) DO NOTHING;

-- migrate:down
DROP TABLE IF EXISTS ci.retrieval_policy;
