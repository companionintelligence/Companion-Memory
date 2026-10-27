import { ApiError } from '../client';
import { CliError, type CliContext } from '../context';
import { json, stamp, table } from '../output';
import { waitForRuns } from '../wait';
import type { RetryFailedPushResult } from '../wire';

import { parseTimeout } from './import';

export interface PushOptions {
  /** Restrict to these run ids. Absent means every eligible run. */
  run?: string[];
  dryRun?: boolean;
  /**
   * Re-drive the named runs' push instead: rows it could not write go back from
   * `failed` to `pending`, and the run's own push stage is re-queued for them.
   */
  retryFailed?: boolean;
  wait?: boolean;
  timeout?: string;
  json?: boolean;
}

/**
 * Push staged rows into `ci.*` — the wizard's Sync step, at the command line.
 *
 * The name is upstream's and the meaning is not. There, `push` was the HTTP
 * transport that shipped a local SQLite mirror to a remote CI-Server, and that
 * whole apparatus is gone: the database IS local now. Here `push` is a STAGE of
 * an import, and this command exists for the one case the stage list makes
 * possible — a run started with `--stages unpack,parse,media` has staged its
 * rows and committed none of them. This finishes those runs.
 *
 * A run with nothing pending is not eligible and is not an error: "nothing to
 * push" is the state you wanted to be in.
 *
 * `--retry-failed` is the other door, for a run whose push already RAN — see
 * {@link retryFailedPush}.
 */
export async function pushCommand(ctx: CliContext, options: PushOptions = {}): Promise<void> {
  // Before anything is pushed, for the reason `importCommand` gives.
  const timeoutMs = parseTimeout(options.timeout);

  if (options.retryFailed) {
    await retryFailedPush(ctx, options, timeoutMs);

    return;
  }

  const unpushed = await ctx.client.listUnpushed();
  const wanted = options.run == null || options.run.length === 0 ? null : new Set(options.run);
  const selected = wanted == null ? unpushed : unpushed.filter((run) => wanted.has(run.id));

  if (wanted != null) {
    const missing = [...wanted].filter((id) => !unpushed.some((run) => run.id === id));

    if (missing.length > 0) {
      throw new CliError(
        `Not waiting to be pushed: ${missing.join(', ')}. ` +
          `A run is eligible once its parse has completed and no push stage exists yet — ` +
          `see \`ci runs <id>\`.`,
      );
    }
  }

  if (options.dryRun || selected.length === 0) {
    if (options.json) {
      json(ctx.term, selected);
    } else {
      ctx.term.out(
        table(
          selected,
          [
            { header: 'id', value: (run) => run.id },
            { header: 'label', value: (run) => run.label ?? '' },
            { header: 'items', value: (run) => String(run.pendingItems), align: 'right' },
            { header: 'entities', value: (run) => String(run.pendingEntities), align: 'right' },
            { header: 'finished', value: (run) => stamp(run.finishedAt) },
          ],
          'Nothing is waiting to be pushed.',
        ),
      );
    }

    return;
  }

  const { runs } = await ctx.client.startPush(wanted == null ? undefined : [...wanted]);

  if (options.json) {
    json(ctx.term, runs);
  } else {
    ctx.term.out(
      table(runs, [
        { header: 'id', value: (run) => run.id },
        { header: 'label', value: (run) => run.label ?? '' },
        { header: 'status', value: (run) => run.status },
      ]),
    );
    ctx.term.out(`\n${runs.length} run(s) queued for push.`);
  }

  if (options.wait && runs.length > 0) {
    await waitForRuns(
      ctx.client,
      ctx.term,
      runs.map((run) => run.id),
      { timeoutMs, quiet: options.json },
    );
  }
}

/**
 * `ci push --run <id> --retry-failed`: push the rows a finished push could not
 * write.
 *
 * The plain `push` cannot reach them, and that is by design rather than
 * oversight: it only offers a run that has never had a push stage, and the
 * stage itself reads only `pending` rows. So a row the push marked `failed`
 * sat there for good — which is how a Postgres crash-restart mid-import left
 * 437 perfectly good rows behind on a run that otherwise worked. This asks the
 * appliance (`POST /import/runs/:id/push/retry`) to move them back to
 * `pending` and re-queue the run's push stage, which then pushes those rows
 * and nothing else. It also re-drives a push that ran and FAILED — with rows
 * still pending, or after every row settled — so it is the one command for
 * "finish this run's push".
 *
 * Explicit run ids only. Re-pushing is safe — every destination upserts — but
 * "retry everything that ever failed, everywhere" is not a thing anyone should
 * be able to type by accident.
 *
 * The appliance refuses (409) a run still working, a run whose stages ahead of
 * the push did not complete (cancelled mid-parse), and a push that never ran,
 * each with a message saying what to do instead; those and a run that is not
 * yours are reported per run, and the others go ahead. `--wait` follows the
 * re-queued runs to their close-out, which is where the run's status is
 * recomputed.
 */
async function retryFailedPush(ctx: CliContext, options: PushOptions, timeoutMs: number): Promise<void> {
  const runIds = options.run ?? [];

  if (runIds.length === 0) {
    throw new CliError(
      '--retry-failed needs the run to retry: `ci push --run <id> --retry-failed`. ' +
        '`ci runs` lists runs; a run with failed push rows ends `partial`.',
    );
  }

  if (options.dryRun) {
    throw new CliError(
      '--retry-failed does not take --dry-run. `ci runs <id> --json` shows how many rows the push ' +
        'failed (the push stage’s `detail.failed`) without changing anything.',
    );
  }

  const results: Array<{ runId: string; result?: RetryFailedPushResult; error?: string }> = [];

  for (const runId of runIds) {
    try {
      results.push({ runId, result: await ctx.client.retryFailedPush(runId) });
    } catch (err) {
      // A refusal is about THAT run — still pushing, or not this account's —
      // and says so. Anything else (the appliance unreachable, a 500) is not a
      // per-run answer, and goes up to the entry point as it always has.
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        results.push({ runId, error: err.message });
        continue;
      }

      throw err;
    }
  }

  const requeued = results.filter((entry) => entry.result?.requeued === true);
  const refused = results.filter((entry) => entry.error != null);

  if (options.json) {
    json(
      ctx.term,
      results.map((entry) => ({
        runId: entry.runId,
        ...(entry.result ?? {}),
        ...(entry.error ? { error: entry.error } : {}),
      })),
    );
  } else {
    ctx.term.out(
      table(results, [
        { header: 'id', value: (entry) => entry.runId },
        {
          header: 'items',
          value: (entry) => (entry.result ? String(entry.result.items) : ''),
          align: 'right',
        },
        {
          header: 'entities',
          value: (entry) => (entry.result ? String(entry.result.entities) : ''),
          align: 'right',
        },
        {
          header: 'push',
          value: (entry) =>
            entry.error != null
              ? 'refused'
              : !entry.result?.requeued
                ? 'nothing to retry'
                : entry.result.items + entry.result.entities > 0
                  ? 'queued'
                  : 'queued (stage re-run)',
        },
      ]),
    );

    for (const entry of refused) {
      ctx.term.err(`${entry.runId}: ${entry.error}`);
    }

    const items = requeued.reduce((sum, entry) => sum + (entry.result?.items ?? 0), 0);
    const entities = requeued.reduce((sum, entry) => sum + (entry.result?.entities ?? 0), 0);
    // Re-queued with no row moved: the push itself did not finish — it failed
    // with rows still pending, or with none left while closing out — and is
    // simply run again. Worth saying, or "0 item(s) moved" reads like the
    // retry did nothing.
    const stageOnly = requeued.filter((entry) => entry.result!.items + entry.result!.entities === 0).length;

    if (requeued.length > 0) {
      ctx.term.out(
        `\n${requeued.length} run(s) queued for push; ${items} item(s) and ${entities} entit(ies) ` +
          `moved from failed back to pending.` +
          (stageOnly > 0
            ? ` ${stageOnly} of them had no failed rows: the push itself did not finish, and is run again.`
            : ''),
      );
    } else if (refused.length < results.length) {
      ctx.term.out(
        '\nNothing to retry: no failed push rows and no unfinished push on the run(s) named. ' +
          'A run whose rows were never pushed is `ci push --run <id>`, without --retry-failed.',
      );
    }
  }

  if (options.wait && requeued.length > 0) {
    await waitForRuns(
      ctx.client,
      ctx.term,
      requeued.map((entry) => entry.runId),
      { timeoutMs, quiet: options.json },
    );
  }

  if (refused.length > 0) {
    throw new CliError(
      `${refused.length} of ${results.length} run(s) could not be retried.`,
      requeued.length > 0 ? 2 : 1,
    );
  }
}
