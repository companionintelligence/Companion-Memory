import { CliError, type CliContext } from '../context';
import { duration, json, stamp, table } from '../output';
import { waitForRuns } from '../wait';

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

  if (limit != null && !Number.isFinite(limit)) {
    throw new CliError(`--limit takes a number, not "${options.limit}"`);
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
        { header: 'status', value: (run) => run.status },
        { header: '%', value: (run) => String(run.percent), align: 'right' },
        { header: 'sources', value: (run) => run.dataSources.slice(0, 4).join(' ') },
        { header: 'started', value: (run) => stamp(run.startedAt) },
      ],
      'No import runs yet.',
    ),
  );
}

async function showRun(ctx: CliContext, runId: string, options: RunsOptions): Promise<void> {
  const detail = await ctx.client.getRun(runId);

  if (options.json && !options.wait) {
    json(ctx.term, detail);

    return;
  }

  if (!options.json) {
    ctx.term.out(`${detail.id}  ${detail.label ?? ''}`);
    ctx.term.out(
      `status ${detail.status}  ${detail.percent}%  source ${detail.source}  ` +
        `stages ${detail.requestedStages.join(' → ')}`,
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
        { header: 'status', value: (stage) => stage.status },
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
  }

  if (options.wait) {
    const [final] = await waitForRuns(ctx.client, ctx.term, [detail.id], {
      timeoutMs: parseTimeout(options.timeout),
      quiet: options.json,
    });

    if (options.json) {
      json(ctx.term, final ?? detail);
    }
  }
}
