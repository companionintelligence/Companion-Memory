import type { DataSource } from 'typeorm';

/**
 * The pipeline stage that records media dimensions, and the version of it that
 * is current.
 *
 * DUPLICATED from `STAGE_IDS.ENRICH_MEDIA_DIMENSIONS` and
 * `STAGE_VERSIONS[...]`, for the reason `MediaDimensionsBackfillListener` gives
 * for its own copy of the id: the pipeline barrel imports this domain, so
 * importing it back would close a cycle. `mediaDimensionsCandidates.spec.ts`
 * imports the real values and asserts these match, so a version bump in
 * `domains/pipeline/versions.ts` fails that spec until this one moves with it.
 */
export const MEDIA_DIMENSIONS_STAGE_ID = 'enrich.media_dimensions';
export const MEDIA_DIMENSIONS_STAGE_VERSION = 2;

/**
 * How many of a user's ORIGINAL image and video files with no width the stage
 * would still look at. `$1` = user id, `$2` = the stage id, `$3` = its current
 * version.
 *
 * `width IS NULL` alone counted a file the stage had already tried and could
 * not decode (a cut-off JPEG, a HEIC variant libvips cannot parse). The stage
 * records that as `skipped: probe_failed` in `ci.pipeline_state` and does not
 * probe it again at that version, but its width stays NULL, so the backfill
 * answered `enqueued` with the same file on every call and never reached
 * `noop`.
 *
 * The ledger clause is `PipelineStateService.selectStale`'s, version arm
 * included: a file drops out only once the CURRENT version has an answer for it
 * that is not a due retry. Leaving the version out would also drop a file
 * decided under an older version (the HEIC originals v1 recorded
 * `probe_failed`, which v2 exists to re-read), a row `reopen()` put back to 0,
 * and a claim a killed worker left `running` at 0, all of which the sweep still
 * picks up. `deleted_at IS NULL` is the stage's own applicability rule, so a
 * soft-deleted file it will never measure is not counted either.
 */
const MEDIA_DIMENSIONS_CANDIDATE_COUNT_SQL = `
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
              AND p.stage_version >= $3
              AND NOT (p.status = 'failed' AND p.next_attempt_at <= now()))`;

/**
 * The candidate count behind `POST /api/maintenance/backfill-media-dimensions`
 * and the orchestrator's `media_dimensions` leg, which both go through
 * `MaintenanceOrchestratorService.runMediaDimensionsLeg`. See
 * {@link MEDIA_DIMENSIONS_CANDIDATE_COUNT_SQL} for what it counts.
 */
export async function countMediaDimensionsCandidates(
  db: Pick<DataSource, 'query'>,
  userId: string,
): Promise<number> {
  const rows = await db.query<Array<{ count: string }>>(MEDIA_DIMENSIONS_CANDIDATE_COUNT_SQL, [
    userId,
    MEDIA_DIMENSIONS_STAGE_ID,
    MEDIA_DIMENSIONS_STAGE_VERSION,
  ]);

  return Number(rows[0]?.count ?? 0);
}
