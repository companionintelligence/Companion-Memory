import { z } from 'zod/v3';

import type { IMPORT_STAGE_KINDS } from './constants';

/**
 * One stage of one run, handed to the generic worker.
 *
 * Deliberately just identifiers. Everything the runner needs — which drop, which
 * scratch directory, how far the previous stage got — is read from
 * `ci_import.import_runs` / `import_stages` at the moment the job runs, not
 * carried in the payload. A payload that carried state would be a second copy of
 * the run, written when the job was ENQUEUED and stale by the time a retry
 * picked it up, and pg-boss retries are exactly when the truth has moved.
 */
export const importStagePayloadSchema = z.object({
  runId: z.string().uuid(),
  stageId: z.string().uuid(),

  /**
   * Whose import this is. Present so the worker can build a service context
   * without a read, and so a payload is legible on its own in `pgboss.job`.
   * The stage row is still the authority — a mismatch fails the stage.
   */
  userId: z.string().uuid(),
});

export type ImportStagePayload = z.infer<typeof importStagePayloadSchema>;

/** What a stage runner reports back to the worker. */
export interface StageOutcome {
  /**
   * Rows, files or archives the stage got through. Written to
   * `import_stages.processed` and used for the run's percent rollup.
   */
  processed: number;

  /** Denominator when the stage knows one, else null (a parse discovers its total). */
  total: number | null;

  /**
   * Free-form record for the stage's `detail` JSONB — rejected archives, the
   * drop ledger, which datasources were recognized. Rendered by the run UI, so
   * it holds what a person would ask about a stage that half-worked.
   */
  detail: Record<string, unknown>;

  /**
   * True when the stage did its job but not on everything: a Takeout where one
   * of six parsers choked, an archive quarantined as unreadable. Rolls the run
   * up as `partial` rather than `completed` — a terminal success-ish state,
   * because reporting it as failure is what teaches people to re-run the whole
   * 40GB archive.
   */
  partial?: boolean;
}

/** Contract every stage kind implements. One class per kind, resolved by the worker. */
export interface ImportStageRunner {
  readonly kind: (typeof IMPORT_STAGE_KINDS)[number];

  /**
   * Do the work. Throwing fails the stage (and, through it, the run); the worker
   * records the reason and lets pg-boss's own retry and dead-letter machinery
   * apply.
   */
  run(context: StageRunContext): Promise<StageOutcome>;
}

/** Everything a stage runner is given. */
export interface StageRunContext {
  userId: string;
  runId: string;
  stageId: string;

  /** The run's working directory. Owned by the run, reclaimed when it finishes. */
  scratchDir: string;

  /**
   * Report incremental progress. Cheap to call — the implementation throttles
   * writes, because a parse ticking per item would otherwise write a row per
   * record for the length of a 40GB import.
   */
  progress(update: { processed: number; total?: number | null; phase?: string }): Promise<void>;
}
