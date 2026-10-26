/**
 * The pipeline stage that records media dimensions.
 *
 * DUPLICATED from `STAGE_IDS.ENRICH_MEDIA_DIMENSIONS`, for the reason
 * `MediaDimensionsBackfillListener` gives for its own copy: the pipeline barrel
 * imports this domain, so importing it back would close a cycle. The
 * accompanying spec imports the real constant and asserts this matches.
 */
export const MEDIA_DIMENSIONS_STAGE_ID = 'enrich.media_dimensions';

/**
 * How many of a user's ORIGINAL image and video files a media-dimensions
 * backfill would still have to look at. `$1` = user id, `$2` = the stage id
 * ({@link MEDIA_DIMENSIONS_STAGE_ID}).
 *
 * Shared by `POST /api/maintenance/backfill-media-dimensions` and the nightly
 * maintenance leg, so both answer `noop` at the same moment.
 *
 * `width IS NULL` alone counted a file the stage had already tried and could
 * not decode (a cut-off JPEG, a HEIC variant libvips cannot parse). The stage
 * records that as `skipped: probe_failed` in `ci.pipeline_state` and never
 * probes it again, but its width stays NULL, so the backfill answered
 * `enqueued` with the same file on every call and never reached `noop`. The
 * ledger clause below drops a file the stage has an answer for, the same way
 * `PipelineStateService.selectStale` does, except that it does not compare
 * stage versions: a version bump re-opens those files through the stage's own
 * schedule, not through this count. `deleted_at IS NULL` is the stage's own
 * applicability rule, so a soft-deleted file it will never measure is not
 * counted either.
 */
export const MEDIA_DIMENSIONS_CANDIDATE_COUNT_SQL = `
  SELECT COUNT(*)::bigint AS count
    FROM ci.files f
   WHERE f.user_id = $1
     AND f.variant = 'ORIGINAL'
     AND f.deleted_at IS NULL
     AND f.key IS NOT NULL
     AND f.width IS NULL
     AND (f.content_type LIKE 'image/%' OR f.content_type LIKE 'video/%')
     AND NOT EXISTS (
           SELECT 1
             FROM ci.pipeline_state p
            WHERE p.entity_type = 'file'
              AND p.entity_id = f.id
              AND p.stage = $2
              AND NOT (p.status = 'failed' AND p.next_attempt_at <= now()))`;
