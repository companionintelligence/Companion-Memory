import { CliError, type CliContext } from '../context';
import { json, stamp, table } from '../output';
import { waitForRuns } from '../wait';

import { parseTimeout } from './import';

export interface PushOptions {
  /** Restrict to these run ids. Absent means every eligible run. */
  run?: string[];
  dryRun?: boolean;
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
 */
export async function pushCommand(ctx: CliContext, options: PushOptions = {}): Promise<void> {
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
      { timeoutMs: parseTimeout(options.timeout), quiet: options.json },
    );
  }
}
