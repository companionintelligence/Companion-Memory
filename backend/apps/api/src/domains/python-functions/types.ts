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
 * Queue-level policy. `expireInSeconds` is the recovery contract for deferred
 * jobs: if the Python service dies without calling back, the job stays
 * `active` until this window elapses, then pg-boss retries it. It must exceed
 * the longest legitimate run on that target.
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
  // HBPE nightly is long; bootstrap trains models and can take hours.
  hbpe: { policy: 'short', expireInSeconds: 4 * 60 * 60, retryLimit: 2, retryDelay: 300 },
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
