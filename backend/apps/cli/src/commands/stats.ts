import type { RunSummary } from '../wire';
import type { CliContext } from '../context';
import { json, stamp, table } from '../output';

export interface StatsOptions {
  json?: boolean;
}

/**
 * Did the import land, and how far along is the index?
 *
 * Upstream's `stats` counted rows in the importer's own SQLite mirror — items,
 * entities, relationships — because that mirror was where imported data lived
 * until a push shipped it onward. There is no mirror now, so the same question
 * is asked of the destination: `ci.*` row counts and the search-index backlog,
 * plus a rollup of this user's runs, which is the half the maintenance endpoint
 * cannot see.
 */
export async function statsCommand(ctx: CliContext, options: StatsOptions = {}): Promise<void> {
  // Both halves, and one failing must not take the other with it: ingest-status
  // touches five tables (a plain count on the communications hypertable is
  // seconds at a million rows) while the run list is cheap and always available.
  const [ingest, runs] = await Promise.all([ctx.client.ingestStatus(), ctx.client.listRuns(200)]);

  const byStatus = new Map<string, number>();

  for (const run of runs) {
    byStatus.set(run.status, (byStatus.get(run.status) ?? 0) + 1);
  }

  const dataSources = new Map<string, number>();

  for (const run of runs) {
    for (const source of run.dataSources) {
      dataSources.set(source, (dataSources.get(source) ?? 0) + 1);
    }
  }

  if (options.json) {
    json(ctx.term, {
      ingest,
      runs: {
        total: runs.length,
        byStatus: Object.fromEntries(byStatus),
        byDataSource: Object.fromEntries(dataSources),
        latest: runs[0] ?? null,
      },
    });

    return;
  }

  ctx.term.out('Records in ci.*');
  ctx.term.out(
    table(Object.entries(ingest.tables ?? {}), [
      { header: 'table', value: ([name]) => name },
      { header: 'rows', value: ([, count]) => count.toLocaleString('en-US'), align: 'right' },
    ]),
  );

  const embeddings = ingest.searchIndex?.embeddingsByType ?? {};
  const skips = ingest.searchIndex?.skipsByType ?? {};
  const types = [...new Set([...Object.keys(embeddings), ...Object.keys(skips)])].sort();

  ctx.term.out('\nSearch index');
  ctx.term.out(
    table(types, [
      { header: 'type', value: (type) => type },
      {
        header: 'embedded',
        value: (type) => (embeddings[type] ?? 0).toLocaleString('en-US'),
        align: 'right',
      },
      // A skip is a decided row, not a failure: nothing worth embedding.
      // Counted separately so coverage is not read as a shortfall.
      { header: 'skipped', value: (type) => (skips[type] ?? 0).toLocaleString('en-US'), align: 'right' },
    ]),
  );

  const queue = ingest.searchIndex?.queue;

  if (queue != null) {
    ctx.term.out(`queue  ${queue.created} waiting, ${queue.active} in flight, ${queue.failed} failed`);
  }

  ctx.term.out('\nImport runs');

  if (runs.length === 0) {
    ctx.term.out('(none)');

    return;
  }

  ctx.term.out(
    table([...byStatus.entries()].sort(), [
      { header: 'status', value: ([status]) => status },
      { header: 'runs', value: ([, count]) => String(count), align: 'right' },
    ]),
  );

  if (dataSources.size > 0) {
    ctx.term.out(
      `\nsources  ${[...dataSources.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}(${count})`)
        .join(' ')}`,
    );
  }

  ctx.term.out(`latest   ${describeLatest(runs[0])}`);
  ctx.term.out(`measured ${stamp(ingest.at)}`);
}

function describeLatest(run: RunSummary): string {
  return `${run.id.slice(0, 8)} ${run.status} ${run.percent}% ${run.label ?? ''} ${stamp(run.createdAt)}`.trim();
}
