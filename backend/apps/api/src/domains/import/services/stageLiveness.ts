import { IMPORT_STAGE_STALLED_SECONDS } from '../constants';
import type { ImportStage } from '../entities/ImportStageEntity';

/**
 * Is this stage STALLED — `running`, but silent past
 * {@link IMPORT_STAGE_STALLED_SECONDS}?
 *
 * `updated_at` is the claim's heartbeat: the worker touches it every
 * `IMPORT_STAGE_HEARTBEAT_SECONDS` and on every progress write, so a running
 * stage that has not been touched in three beats is one nothing is visibly
 * working on. Reported, never acted on — the orphan reaper has its own, longer
 * window and a stricter test (see `ImportRunService.reclaimOrphanedStages`).
 *
 * The one definition every surface uses (the run detail, the active snapshot,
 * and — as SQL over the same threshold — `ImportRunService.stalledRunsFor`), so
 * "stalled" cannot mean three different things on three screens. Pure, with
 * `now` injectable, so the snapshot's tests can pin it.
 */
export function isStageStalled(
  stage: Pick<ImportStage, 'status' | 'updatedAt'>,
  now: Date = new Date(),
): boolean {
  if (stage.status !== 'running' || stage.updatedAt == null) {
    return false;
  }

  return now.getTime() - new Date(stage.updatedAt).getTime() > IMPORT_STAGE_STALLED_SECONDS * 1000;
}
