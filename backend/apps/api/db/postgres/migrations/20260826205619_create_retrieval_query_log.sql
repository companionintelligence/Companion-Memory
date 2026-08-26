-- migrate:up
-- One row per REAL retrieval call: what the appliance was actually asked, in
-- shape only, and what came back.
--
-- The two retrieval-health mechanisms that already exist both measure the index
-- rather than the answers. `ci.retrieval_health_snapshots` measures COVERAGE
-- (are the rows in the index at all). `ci.recall_probe_results` measures ANN
-- RECALL against an exact answer, using query vectors SAMPLED FROM THE INDEX
-- ITSELF — synthetic questions, drawn from rows that are by construction
-- present. Neither can observe the case that matters most: a question a person
-- actually asked coming back empty.
--
-- Nothing observed that before this table. `SearchService` has no logger at all
-- — a repo grep for `logger` in it returns zero hits — so every search it
-- serves is unrecorded. `RecallService` returns `resultCount` to its caller and
-- persists nothing; its only log calls are `.warn` on failure, so a SUCCESSFUL
-- zero-result recall is completely silent.
--
-- ═══ NO QUERY TEXT — DELIBERATE, LOAD-BEARING ═══
--
-- There is no `query` column and there must never be one. On a personal
-- appliance the question someone asks their own memory is exactly as sensitive
-- as the memory it searches — often more so, because a query states an intent
-- the corpus only implies ("divorce lawyer", a person's name, a diagnosis). A
-- query log is the single highest-value target in a retrieval system and the
-- one artifact a personal appliance can most easily do without: every question
-- this table exists to answer ("what fraction of real searches come back
-- empty", "does the semantic path return short of its LIMIT") is answerable
-- from SHAPE alone. So the query is reduced at the call site to
-- `query_token_count` — a whitespace token count — and the text is never sent
-- to the queue, never serialised into a pg-boss job payload, and never stored.
-- `include_types`/`exclude_types` are a closed code vocabulary
-- (INDEXABLE_ENTITIES), not user content.
--
-- A PLAIN TABLE, not a hypertable. See
-- docs/architecture/adr/0002-timescaledb-hypertable-criteria.md: a per-query
-- log on a 1-5 user appliance fails Gate 4 (>=10^4 rows/day/user) by orders of
-- magnitude — a heavy day is hundreds of retrievals, not tens of thousands —
-- and the sibling telemetry tables above are both plain for the same reason.
-- Retention is a dated DELETE from the nightly cron
-- (QUERY_LOG_RETENTION_DAYS in RetrievalQueryLogService), matching
-- RetrievalHealthService.prune.
CREATE TABLE IF NOT EXISTS ci.retrieval_query_log (
    id                uuid PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
    ts                timestamptz NOT NULL DEFAULT now(),
    -- Whose retrieval this was. Every production retrieval path is user-scoped,
    -- and a query log must die with the account it describes.
    user_id           uuid NOT NULL REFERENCES ci.users (id) ON DELETE CASCADE,
    -- Which entry point ran: 'search', 'search_prompt', 'search_messages',
    -- 'search_anchored', 'recall'. A code vocabulary (RetrievalCaller), so no
    -- CHECK: adding an entry point is a code change, not a migration.
    caller            text NOT NULL,
    -- The strategy actually taken, AFTER 'auto' resolved — 'keyword',
    -- 'boosted', 'semantic', 'hybrid' for search; the recall strategy for
    -- recall. Recording the requested mode instead would make every auto call
    -- indistinguishable, which is most of them.
    mode_taken        text,
    -- Whitespace token count of the query. See the privacy note above: this is
    -- the ONLY thing retained about what was asked.
    query_token_count integer NOT NULL,
    -- The type filters the query actually ran with, INCLUDING the defaults the
    -- service injects. SearchService.applyDefaultTypeExclusions substitutes
    -- exclude_types = {message,position} whenever the caller names neither, so
    -- essentially every default semantic search is a FILTERED search — and the
    -- filters sit outside the HNSW ORDER BY, which is what makes a filtered
    -- search able to return short of its LIMIT.
    include_types     text[],
    exclude_types     text[],
    result_count      integer NOT NULL CHECK (result_count >= 0),
    -- Generated, not written by the caller: "the search came back empty" is a
    -- restatement of result_count and must never be able to disagree with it.
    zero_result       boolean GENERATED ALWAYS AS (result_count = 0) STORED,
    -- Best score in the result set, on whatever scale the caller's ranker uses
    -- (ts_rank for lexical, cosine similarity for semantic). NULL where the
    -- path returns no score at all (search_anchored orders by embedding
    -- distance and selects none) or where nothing matched.
    top_score         double precision,
    latency_ms        integer NOT NULL CHECK (latency_ms >= 0)
);

-- The rollup read shape: one user's recent window, newest first.
CREATE INDEX IF NOT EXISTS retrieval_query_log_user_ts_idx
    ON ci.retrieval_query_log (user_id, ts DESC);

-- Retention prune deletes by age across all users.
CREATE INDEX IF NOT EXISTS retrieval_query_log_ts_idx
    ON ci.retrieval_query_log (ts);

-- migrate:down
DROP TABLE IF EXISTS ci.retrieval_query_log;
