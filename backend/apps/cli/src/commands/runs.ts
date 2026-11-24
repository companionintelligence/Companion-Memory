import { CliError, type CliContext } from '../context';
import { duration, json, stamp, table } from '../output';
import { waitForRuns } from '../wait';
import type { StageSummary } from '../wire';

import { parseTimeout } from './import';

export interface RunsOptions {
  limit?: string;
  wait?: boolean;
  timeout?: string;
  json?: boolean;
}

/**
 * Import runs and their stage bars.
 *
 * This is upstream's `jobs` under the name the server uses. The rename is not
 * cosmetic: `jobs` there listed the importer's own ingest jobs, which was the
 * only progress surface it had. Here there are two, for two audiences —
 * `ci_import.import_runs` in a vocabulary the person who uploaded the archive
 * recognizes, and pg-boss under `/jobs` for whoever is asked why the queue is
 * deep. This command is the first. The second is deliberately not wrapped here.
 */
export async function runsCommand(
  ctx: CliContext,
  runId: string | undefined,
  options: RunsOptions = {},
): Promise<void> {
  if (runId != null) {
    return showRun(ctx, runId, options);
  }

  const limit = options.limit == null ? undefined : Number(options.limit);

  // A whole number of runs, at least 1. `Number` alone let `-1` through, which
  // the api answered with a 500 (a negative LIMIT), and `''` became 0.
  if (limit != null && (options.limit?.trim() === '' || !Number.isInteger(limit) || limit < 1)) {
    throw new CliError(`--limit takes a whole number of runs, not "${options.limit}"`);
  }

  const runs = await ctx.client.listRuns(limit);

  if (options.json) {
    json(ctx.term, runs);

    return;
  }

  ctx.term.out(
    table(
      runs,
      [
        { header: 'id', value: (run) => run.id },
        { header: 'label', value: (run) => run.label ?? '' },
        // `running` is the run row's CACHED status, written on transitions — it
        // cannot notice a worker that died. The server's `stalled` can.
        { header: 'status', value: (run) => (run.stalled === true ? `${run.status} (stalled)` : run.status) },
        { header: '%', value: (run) => String(run.percent), align: 'right' },
        { header: 'sources', value: (run) => run.dataSources.slice(0, 4).join(' ') },
        { header: 'started', value: (run) => stamp(run.startedAt) },
      ],
      'No import runs yet.',
    ),
  );
}

async function showRun(ctx: CliContext, runId: string, options: RunsOptions): Promise<void> {
  // Before the stage table prints, as `importCommand` does before it uploads.
  const timeoutMs = parseTimeout(options.timeout);
  const detail = await ctx.client.getRun(runId);

  if (options.json && !options.wait) {
    json(ctx.term, detail);

    return;
  }

  if (!options.json) {
    ctx.term.out(`${detail.id}  ${detail.label ?? ''}`);
    ctx.term.out(
      `status ${detail.status}${detail.stalled === true ? ' (stalled)' : ''}  ${detail.percent}%  ` +
        `source ${detail.source}  stages ${detail.requestedStages.join(' → ')}`,
    );

    if (detail.dataSources.length > 0) {
      ctx.term.out(`found ${detail.dataSources.join(' ')}`);
    }

    if (detail.error != null) {
      ctx.term.err(`error ${detail.error}`);
    }

    ctx.term.out('');
    ctx.term.out(
      table(detail.stages, [
        { header: 'seq', value: (stage) => String(stage.seq), align: 'right' },
        { header: 'kind', value: (stage) => stage.kind },
        { header: 'status', value: (stage) => (stage.stalled === true ? 'stalled' : stage.status) },
        { header: 'phase', value: (stage) => stage.phase ?? '' },
        { header: 'processed', value: (stage) => String(stage.processed), align: 'right' },
        // Null total is "not yet countable", which must not print as 0 — a bar
        // drawn from that reads as no progress rather than an unknown total.
        {
          header: 'total',
          value: (stage) => (stage.total == null ? '?' : String(stage.total)),
          align: 'right',
        },
        { header: 'took', value: (stage) => duration(stage.durationMs), align: 'right' },
        { header: 'error', value: (stage) => stage.error ?? '' },
      ]),
    );

    for (const note of livenessNotes(detail.stages)) {
      ctx.term.out(note);
    }
  }

  if (options.wait) {
    const [final] = await waitForRuns(ctx.client, ctx.term, [detail.id], {
      timeoutMs,
      quiet: options.json,
    });

    if (options.json) {
      json(ctx.term, final ?? detail);
    }
  }
}

/**
 * What the stage table cannot say on its own: that a `running` stage has gone
 * silent, and that a `queued` one is there because its worker died.
 *
 * Both used to be invisible — a stage frozen mid-parse read `running` with no
 * error for as long as recovery took, and after recovery it read `queued` with
 * its counters at zero and nothing to say why. One line each, in the words a
 * person watching an import would use.
 */
function livenessNotes(stages: readonly StageSummary[], now: Date = new Date()): string[] {
  const notes: string[] = [];

  for (const stage of stages) {
    if (stage.stalled === true) {
      const silentFor =
        stage.heartbeatAt == null ? null : now.getTime() - new Date(stage.heartbeatAt).getTime();

      notes.push(
        `${stage.kind} stalled: no heartbeat${silentFor == null ? '' : ` for ${duration(silentFor)}`}` +
          `${stage.heartbeatAt == null ? '' : ` (since ${stamp(stage.heartbeatAt)})`} — its worker is gone or ` +
          'wedged. A stage whose worker is gone is retried automatically within minutes.',
      );
    }

    const interrupted = interruption(stage);

    if (interrupted != null && (stage.status === 'queued' || stage.status === 'running')) {
      const retry =
        interrupted.retry != null && interrupted.retryLimit != null
          ? `retry ${interrupted.retry} of ${interrupted.retryLimit}`
          : 'a fresh attempt';

      notes.push(
        `${stage.kind} was interrupted${interrupted.processed == null ? '' : ` at ${interrupted.processed} processed`}` +
          `${interrupted.at == null ? '' : ` (${stamp(interrupted.at)})`}: its worker stopped heartbeating. ` +
          `${stage.status === 'running' ? `Running again as ${retry}.` : `Queued for ${retry}.`}`,
      );
    }
  }

  return notes;
}

/** `detail.interrupted`, as the server's orphan reaper records it — read defensively. */
function interruption(stage: StageSummary): {
  at: string | null;
  processed: number | null;
  retry: number | null;
  retryLimit: number | null;
} | null {
  const value = stage.detail?.interrupted;

  if (value == null || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const number = (key: string) => (typeof record[key] === 'number' ? (record[key] as number) : null);

  return {
    at: typeof record.at === 'string' ? record.at : null,
    processed: number('processed'),
    retry: number('retry'),
    retryLimit: number('retryLimit'),
  };
}
