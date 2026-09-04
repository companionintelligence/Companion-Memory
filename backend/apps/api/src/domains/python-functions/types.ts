/**
 * Python function-runner targets and queues.
 *
 * Each target is a Python FastAPI service exposing `POST /functions/run`; jobs
 * are dispatched from pg-boss and completed out-of-band via the callback
 * controller once the Python worker pool finishes (see
 * PythonFunctionDispatchListener / PythonFunctionCallbackController).
 */

export const PYTHON_FUNCTION_TARGETS = ['summary', 'hbpe'] as const;

export type PythonFunctionTarget = (typeof PYTHON_FUNCTION_TARGETS)[number];

/** One pg-boss queue per target so expiration/retry policy can differ. */
export const PYTHON_FUNCTION_QUEUES: Record<PythonFunctionTarget, string> = {
  summary: 'py-fn-summary',
  hbpe: 'py-fn-hbpe',
};

/**
 * HBPE's labeling wall-clock budget — mirrors `HBPE_LABEL_BUDGET_SECONDS` in
 * `backend/apps/hbpe/src/ci/hbpe/config.py`. `label_unlabeled` runs a hard
 * `started_at + budget` deadline, so on any appliance whose backlog outlasts
 * one night it returns *at* the budget, every night — the dev corpus is
 * 195,600 unlabeled events against 3,133 labeled. #2485 (kind_l0_map joined on
 * the capture kind) moves more events onto the free static labeler and so
 * shortens the typical drain, but it does not change this worst case: the
 * budget is still what a genuinely large backlog spends.
 */
const HBPE_LABEL_BUDGET_SECONDS = 4 * 60 * 60;

/**
 * Everything the nightly/bootstrap pipelines run AFTER the labeling drain
 * returns — label_summaries, the L1/L2 sweeps, serialize, the bootstrap branch
 * (train + export), lora, backfill_actuals, recurrence, drift, cache.
 *
 * `ci.hbpe.functions.STEP_ETA_SECONDS` sums those steps to 3,955 s, but that
 * table calls itself "conservative wall-clock guesses" and it is optimistic by
 * roughly 3x. Measured on the dev appliance: pg-boss job
 * bdb5b4a6-003f-4c54-99a5-1e23f8419c1f (`nightly`, 2026-08-30) took 11,230 s
 * end to end while its `step1_label` had already failed in under a second, so
 * that figure is the post-label tail and nothing else; `ensure_bootstrap` job
 * 60cb9ea9 took 12,820 s the same day. 4 h is the larger of those measurements
 * plus ~12% — the headroom is deliberately thin because it is the delay before
 * a genuinely dead sidecar is recovered.
 */
const HBPE_POST_LABEL_SECONDS = 4 * 60 * 60;

/**
 * Queue-level policy. `expireInSeconds` is the recovery contract for deferred
 * jobs: if the Python service dies without calling back, the job stays
 * `active` until this window elapses, then pg-boss retries it. It must exceed
 * the longest legitimate run on that target — an expiry that fires on a run
 * that is still working does not recover anything, it duplicates it.
 *
 * `policy: 'short'` is what makes every caller's singletonKey-based dedup
 * (fan-out crons, SmartRotationListener, ForecastResolver.triggerHbpe) actually
 * refuse a duplicate — pg-boss's default `standard` policy stores a
 * singletonKey but never enforces it. Safe here because PythonFunctionService
 * only omits the key when a caller doesn't pass one, and every real caller
 * does.
 */
export const PYTHON_FUNCTION_QUEUE_OPTIONS: Record<
  PythonFunctionTarget,
  { policy: 'short'; expireInSeconds: number; retryLimit: number; retryDelay: number }
> = {
  // Summaries/insights/actions: LLM-bound, minutes per run on CPU.
  summary: { policy: 'short', expireInSeconds: 30 * 60, retryLimit: 3, retryDelay: 60 },
  // HBPE nightly/bootstrap: the labeling drain spends its WHOLE budget before
  // the rest of the pipeline starts, so the two costs add — the expiry has to
  // be the sum, not the budget. It used to be exactly HBPE_LABEL_BUDGET_SECONDS,
  // which meant a backlogged nightly was declared expired while it was still
  // in the middle of train/export, could therefore never report completion, and
  // was re-dispatched 300 s later into a function runner whose concurrency is 1
  // (FUNCTION_RUNNER_CONCURRENCY, hbpe/config.py) — so the duplicate queued
  // behind the original and re-ran the whole drain, up to three full pipelines
  // per night.
  //
  // retryLimit stays at 2 on purpose. It cannot distinguish the two ways this
  // job fails, and the cheap one needs it: `ack.fail()` from the dispatch
  // listener (sidecar restarting, 429 from a full runner pool) is a
  // sub-second failure where two retries 300 s apart are exactly the right
  // tolerance. A retry after *expiry* is never useful — nothing here can tell
  // "sidecar died" from "sidecar still working", and the nightly cron plus the
  // 03:00 ensure_bootstrap sweep already re-enqueue every day, so recovery
  // does not depend on it. Making that retry harmless is the expiry's job, not
  // retryLimit's: with the window sized above, an expiry only fires when the
  // run really is gone.
  hbpe: {
    policy: 'short',
    expireInSeconds: HBPE_LABEL_BUDGET_SECONDS + HBPE_POST_LABEL_SECONDS,
    retryLimit: 2,
    retryDelay: 300,
  },
};

/**
 * Function-name allowlists, mirroring each service's runner registry
 * (summary: runner registry in ci.summary.functions; hbpe: ci.hbpe.functions).
 * Dispatching an unknown name throws at the call site instead of failing three
 * retries deep in the queue.
 */
export const PYTHON_FUNCTIONS: Record<PythonFunctionTarget, readonly string[]> = {
  summary: [
    'hourly_summary',
    // Operator-initiated recovery, never scheduled — no cron sends it. It is
    // listed because this array is a dispatch allowlist, not a schedule: the
    // summary sidecar registers `hourly_summary_backfill` in its own FUNCTIONS
    // registry, and without a matching entry here `dispatch()` rejects the name
    // before it ever reaches a queue.
    'hourly_summary_backfill',
    'daily_summary',
    'weekly_summary',
    'monthly_summary',
    'dossier_refresh',
    'insights_generation',
    'actions_generation',
  ],
  hbpe: ['nightly', 'bootstrap', 'ensure_bootstrap'],
};

export type PythonFunctionDispatchOptions = {
  /** pg-boss singleton key — dedupes pending runs of the same work. */
  singletonKey?: string;

  /** pg-boss priority (higher runs sooner). */
  priority?: number;
};

/** Payload of the `python.function.run` job. */
export type PythonFunctionRunPayload = {
  target: PythonFunctionTarget;
  function: string;

  /** Keyword arguments passed verbatim to the Python function. */
  args: Record<string, unknown>;

  /** Owner of the work; the Python callback JWT is signed with this subject. */
  userId: string;
};

/** Body of the completion webhook POSTed by the Python runner. */
export type PythonFunctionCallbackBody = {
  job_id: string;
  queue: string;
  status: 'completed' | 'failed';
  result?: Record<string, unknown>;
  error?: string;
};
