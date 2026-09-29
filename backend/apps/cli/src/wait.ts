import { ApiError } from './client';
import type { ImportApiClient } from './client';
import type { Term } from './output';
import type { RunDetail } from './wire';

/**
 * The run statuses that mean "nothing more will happen here".
 *
 * `partial` is terminal and success-ish, not a failure: a Takeout holding six
 * sources where one parser chokes has imported five, and waiting for it to
 * become `completed` would wait forever.
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'partial',
  'cancelled',
]);

export interface WaitOptions {
  intervalMs?: number;
  /** Give up after this long. 0 (the default) waits as long as the import takes. */
  timeoutMs?: number;
  /** Injected in tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests; defaults to `Date.now`. */
  now?: () => number;
  quiet?: boolean;
}

export class WaitTimeoutError extends Error {
  constructor(readonly pending: RunDetail[]) {
    super(
      `Timed out waiting for ${pending.length} run(s): ${pending.map((run) => run.id).join(', ')}. ` +
        `The import is still going — follow it with \`ci runs <id>\`.`,
    );
    this.name = 'WaitTimeoutError';
  }
}

/**
 * How many polls in a row may fail before the wait gives up on a run.
 *
 * An appliance that restarts mid-import — a deploy, a worker recycling, a
 * `nodemon` reload during development — refuses connections for a few seconds.
 * Retrying across that is the difference between a wait that survives a restart
 * and one that ends at it.
 */
export const MAX_CONSECUTIVE_POLL_FAILURES = 5;

/** Raised when the appliance stopped answering about a run that had not finished. */
export class WaitUnreachableError extends Error {
  constructor(
    readonly runId: string,
    readonly cause: unknown,
  ) {
    super(
      `Lost contact with the appliance while waiting for run ${runId} ` +
        `(${MAX_CONSECUTIVE_POLL_FAILURES} consecutive polls failed: ${describeError(cause)}). ` +
        `The import itself is unaffected and is probably still going — follow it with \`ci runs ${runId}\`.`,
    );
    this.name = 'WaitUnreachableError';
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Follow runs to their terminal state.
 *
 * Prints a line when something CHANGES — a stage begins, the percentage moves,
 * the run closes — rather than redrawing on a timer. That reads the same
 * whether stdout is a terminal or a log file, and it is what makes the wait
 * legible in CI, where a redrawn progress bar becomes thousands of lines of
 * escape codes.
 *
 * A run that vanishes mid-wait (deleted from another session) is dropped rather
 * than retried forever; a run that is already terminal returns on the first
 * poll without sleeping, which is what makes `--wait` free when the work is
 * already done.
 *
 * "Vanished" means a 404 and nothing else. Every other poll failure — a
 * restarting appliance refusing connections, a 502, a socket reset — is
 * transient and is retried up to {@link MAX_CONSECUTIVE_POLL_FAILURES} times,
 * then raised. Dropping those quietly is what let `import --wait` return 0 on a
 * run that was still pushing: the caller's script read a success exit code and
 * went on to verify a database the import had not finished writing.
 */
export async function waitForRuns(
  client: ImportApiClient,
  term: Term,
  runIds: readonly string[],
  options: WaitOptions = {},
): Promise<RunDetail[]> {
  const intervalMs = options.intervalMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 0;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());

  const startedAt = now();
  const pending = new Map<string, RunDetail | null>(runIds.map((id) => [id, null]));
  const finished: RunDetail[] = [];
  const lastLine = new Map<string, string>();
  const failures = new Map<string, number>();

  while (pending.size > 0) {
    for (const runId of [...pending.keys()]) {
      let detail: RunDetail;

      try {
        detail = await client.getRun(runId);
      } catch (err: unknown) {
        if (err instanceof ApiError && err.status === 404) {
          // Gone — deleted from another session. This wait has nothing left to
          // say about it.
          pending.delete(runId);
          continue;
        }

        const consecutive = (failures.get(runId) ?? 0) + 1;

        if (consecutive >= MAX_CONSECUTIVE_POLL_FAILURES) {
          throw new WaitUnreachableError(runId, err);
        }

        failures.set(runId, consecutive);
        continue;
      }

      failures.delete(runId);

      if (!options.quiet) {
        const line = describe(detail, runIds.length > 1);

        if (lastLine.get(runId) !== line) {
          lastLine.set(runId, line);
          term.out(line);
        }
      }

      if (TERMINAL_RUN_STATUSES.has(detail.status)) {
        pending.delete(runId);
        finished.push(detail);
      } else {
        pending.set(runId, detail);
      }
    }

    if (pending.size === 0) {
      break;
    }

    if (timeoutMs > 0 && now() - startedAt >= timeoutMs) {
      throw new WaitTimeoutError([...pending.values()].filter((run): run is RunDetail => run != null));
    }

    await sleep(intervalMs);
  }

  return finished;
}

/** One run's current position, as a single line. */
function describe(run: RunDetail, prefixId: boolean): string {
  const active =
    run.stages.find((stage) => stage.status === 'running') ??
    [...run.stages].reverse().find((stage) => stage.status === 'completed');

  const where = active == null ? '' : ` ${active.kind}${active.phase ? `/${active.phase}` : ''}`;
  const counted = active?.total != null && active.total > 0 ? ` ${active.processed}/${active.total}` : '';
  const prefix = prefixId ? `[${run.id.slice(0, 8)}] ` : '';
  // A line of its own when the stage goes quiet: the percentage stops moving
  // either way, and only this says whether that is slow work or no work.
  const stalled = active?.stalled === true ? '  stalled: no heartbeat' : '';

  return `${prefix}${String(run.percent).padStart(3)}%  ${run.status}${where}${counted}${stalled}`;
}
