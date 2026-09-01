-- migrate:up

-- hbpe.kind_l0_map: correct the seeded patterns to kinds that actually occur,
-- and index the column the map is joined on.
--
-- Companion to the code fix in backend/apps/hbpe (static_labeler.KIND_EXPR).
-- 20260828120000_hbpe_life_forecast.sql seeded this table with the importer's
-- DOTTED capture-kind vocabulary, but every consumer joined it against
-- ci.events.event_type, which carries the BARE-VERB `classification`
-- ('listen', 'watch', 'workout'). The two vocabularies never overlap, so the
-- join matched 0 of 198,733 events: the static fast path was dead, every
-- ambient event went one at a time to the chat LLM, and each one that got
-- labeled took tier 'anchor' / 5 min instead of the map's ambient / 3-15.
--
-- The dotted vocabulary lives in ci.events.metadata->>'kind'. Moving the join
-- there exposes a second defect, fixed below: four of the eight seeded
-- patterns match nothing under EITHER vocabulary.
--
-- Every count below is from this appliance's corpus (198,733 non-deleted
-- events) at the time of writing. The closed kind vocabulary itself is
-- KIND_BY_CLASSIFICATION in
-- backend/apps/api/src/domains/import/push/canonical.ts.

-- 1. 'media.listen' — the single largest stream, and the one the miss cost
--    most. 118,286 events (59.5% of the corpus), all Spotify, all carrying a
--    real end_time (mean 2.6 min). The seed already had 'media.play', the
--    generic player kind, with exactly these semantics and the same 'Listening'
--    label; 'listen' is its sibling for spoken-word/audiobook sessions
--    (canonical.ts: `listen: 'media.listen'`). Same L0/L1/tier/duration, so the
--    two share one STATIC cluster — which is correct: both are "audio playing
--    in the background", the definition of ambient. default_duration_min is
--    near-unused here because end_time is always present; 3 min is kept
--    consistent with media.play for the rows that lack one.
INSERT INTO hbpe.kind_l0_map (kind_pattern, l0_class, l1_label, tier, default_duration_min)
VALUES ('media.listen', 'LEISURE', 'Listening', 'ambient', 3)
ON CONFLICT (kind_pattern) DO NOTHING;

-- 2. 'visited' -> 'location.fix'. 'visited' is not a member of the capture-kind
--    vocabulary at all, so it can never match on any corpus. The kind that
--    carries the seed's intent is 'location.fix', and only place visits reach
--    ci.events under it: canonical.ts routes raw GPS tracks to ci.position
--    ALONE and keeps an events row only for classification='place'
--    (google_maps_places). So this pattern cannot flood the token stream with
--    trackpoints — it matches place visits and nothing else. 0 events today
--    (no places imported on this appliance yet); kept, with the anchor/30
--    semantics the seed chose, because a place visit is a genuine anchor
--    wherever one does exist.
DELETE FROM hbpe.kind_l0_map WHERE kind_pattern = 'visited';
INSERT INTO hbpe.kind_l0_map (kind_pattern, l0_class, l1_label, tier, default_duration_min)
VALUES ('location.fix', 'TRANSIT', 'Place Visit', 'anchor', 30)
ON CONFLICT (kind_pattern) DO NOTHING;

-- 3. 'view' — dropped outright, not translated. Its intent was browser page
--    views, whose kind is 'web.page_view', but canonical.ts routes
--    web.page_view / web.search / web.download to `browser_activity`, never to
--    `events`. No row in ci.events can ever carry that kind on any corpus, so
--    a pattern for it would be permanently dead weight on a predicate that
--    runs per candidate row of the drain. The 'Browsing' STATIC cluster the
--    old pattern minted is deliberately left in place: it holds 0 members, it
--    is a legitimate vocabulary entry, and deleting user rows here is the
--    riskier move.
DELETE FROM hbpe.kind_l0_map WHERE kind_pattern = 'view';

-- 4. Deliberately KEPT despite matching 0 events here — both are real members
--    of the closed kind vocabulary that this corpus simply has no source for,
--    so they will match as soon as one is imported:
--      'media.play'     canonical.ts `play: 'media.play'`   (music players)
--      'wearable.sleep' canonical.ts `sleep: 'wearable.sleep'`
--
--    Deliberately NOT added, though they do occur here — each would be a new
--    semantic claim rather than a repair, and getting the tier wrong is worse
--    than leaving the row on the LLM labeler:
--      calendar.event       1,841  free-text titles; the two-stage labeler owns
--                                  these by design (see static_labeler docstring)
--      wearable.observation 1,652  whole-DAY step totals, not point activities;
--                                  filing them EXERCISE/anchor would mint a
--                                  spurious anchor on 1,652 mornings
--      import.archive_item  1,267  a catch-all (drive-walk files, mail
--                                  attachments, YouTube subscriptions) with no
--                                  single honest L0
--      commerce.*             634  plausible ERRAND/ambient, but unverified
--      capture.photo/video    241  no throughput pressure at this size
--
--    After this migration the map covers 193,098 of 198,733 events (97.2%):
--      media.listen 118,286 | media.watch 68,638 | social.% 4,000
--      (social.post 2,737 + social.like 1,257 + social.bookmark 6)
--      fitness.workout 2,095 | travel.trip 79
--      media.play 0 | wearable.sleep 0 | location.fix 0

-- 5. Index the joined expression.
--
--    Two distinct reasons, and the second is the bigger one:
--
--    (a) static_labeler.label_mapped_events runs one claim query per pattern
--        with a LITERAL pattern, so a text_pattern_ops btree serves both the
--        wildcard-free patterns and the 'social.%' prefix. Measured today that
--        turns 8 parallel seq scans of ~105 ms each into index scans — real
--        but modest at this size.
--    (b) an expression index is also how Postgres gets STATISTICS on
--        metadata->>'kind'. Without one the planner falls back to a fixed
--        guess for every LIKE on it: EXPLAIN ANALYZE of the media.listen claim
--        query estimated 410 rows against 118,286 actual, and the drain's
--        NOT EXISTS estimated 195,429 rows against ~5,600 actual. Those
--        estimates feed join-order choices across the whole label drain.
--
--    Not partial on is_deleted: a partial index's statistics only apply when
--    the planner can prove the predicate, and 99%+ of the table qualifies
--    anyway, so the narrower index would buy nothing and cost the estimates.
--
--    Note this index cannot help the NOT EXISTS / LATERAL forms directly —
--    there the pattern is a column, not a constant, so no index on the events
--    side is applicable. Only the statistics benefit reaches those.
CREATE INDEX IF NOT EXISTS events_capture_kind_idx
    ON ci.events ((metadata->>'kind') text_pattern_ops);

COMMENT ON COLUMN hbpe.kind_l0_map.kind_pattern IS 'LIKE pattern matched against ci.events.metadata->>''kind'' (the dotted capture-kind vocabulary from import/push/canonical.ts) — NOT against ci.events.event_type, which carries the bare-verb classification.';

-- migrate:down

DROP INDEX IF EXISTS ci.events_capture_kind_idx;

COMMENT ON COLUMN hbpe.kind_l0_map.kind_pattern IS NULL;

DELETE FROM hbpe.kind_l0_map
WHERE kind_pattern IN ('media.listen', 'location.fix');

INSERT INTO hbpe.kind_l0_map (kind_pattern, l0_class, l1_label, tier, default_duration_min)
VALUES
    ('view',    'LEISURE', 'Browsing',    'ambient', 5),
    ('visited', 'TRANSIT', 'Place Visit', 'anchor',  30)
ON CONFLICT (kind_pattern) DO NOTHING;
