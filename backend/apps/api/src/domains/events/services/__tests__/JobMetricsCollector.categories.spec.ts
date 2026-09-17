import type { LoggerService } from '@ci/common/logging';

import { DEAD_LETTER_QUEUE } from '../../constants';
import { JobMetricsCollector } from '../JobMetricsCollector';

/**
 * The per-CATEGORY half of the sweep: what it groups on, what it refuses to
 * double-count, and what it does when its table is not there yet.
 *
 * `JobMetricsCollector.spec.ts` proves the per-queue gauges against real
 * Postgres, because a wrong FILTER there produces a wrong NUMBER that a mocked
 * `manager.query()` would happily hand back. The invariants here are of the
 * other kind — they are about which COLUMN the SQL names, and the wrong column
 * (`name`, the queue) is a real column that returns real rows on any database.
 * Asserting on the emitted statement is the only thing that binds.
 */

const logger = {
  setContext() {},
  log() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as LoggerService;

interface Capture {
  collector: JobMetricsCollector;
  statements: { sql: string; params: unknown[] }[];
}

function sqlFor(capture: Capture, matches: (sql: string) => boolean, what: string): string {
  const found = capture.statements.find((statement) => matches(statement.sql));

  if (!found) {
    throw new Error(`no statement issued for ${what}`);
  }

  return found.sql;
}

// Located by the shape of each statement rather than by a substring the wrong
// one also contains: the per-category FLOW query selects `data->>'name'` out of
// `pgboss.job` too, so a naive search for that would let a gauge assertion pass
// against the flow query and silently guard nothing.
//
// The two gauges are told apart by `AS event`, NOT by `AS queue` — both select
// the queue now that the category fold resolves the (event, queue) pair, and
// only the per-category one carries the event.
const perQueueGauge = (capture: Capture) =>
  sqlFor(capture, (sql) => sql.includes('AS pending') && !sql.includes('AS event'), 'the per-queue gauge');

const perCategoryGauge = (capture: Capture) =>
  sqlFor(capture, (sql) => sql.includes('AS pending') && sql.includes('AS event'), 'the per-category gauge');

const perCategoryFlow = (capture: Capture) =>
  sqlFor(capture, (sql) => sql.includes('AS arrived'), 'the per-category flow');

/** The rows handed to an INSERT, as the collector serialized them. */
function insertedRows(capture: Capture, table: string): Record<string, number | string>[] {
  const found = capture.statements.find((statement) => statement.sql.includes(`INSERT INTO ${table}`));

  if (!found) {
    throw new Error(`nothing was inserted into ${table}`);
  }

  return JSON.parse(found.params[1] as string) as Record<string, number | string>[];
}

function makeCollector(
  options: {
    categoryMetricsTable?: boolean;
    categoryGauges?: Array<Record<string, unknown>>;
    categoryFlow?: Array<Record<string, unknown>>;
  } = {},
): Capture {
  const statements: { sql: string; params: unknown[] }[] = [];

  const repository = {
    manager: {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        statements.push({ sql, params });

        if (sql.includes('to_regclass')) {
          return [
            {
              pg_boss: true,
              category_metrics: options.categoryMetricsTable ?? true,
            },
          ];
        }

        // The per-queue pair, enough to keep `sample()` past its early return.
        if (sql.includes('SELECT name AS queue')) {
          return [{ queue: 'default', pending: 1, active: 0, retry: 0, dead_lettered: 0 }];
        }

        if (sql.includes('WITH settled')) {
          return [];
        }

        // The per-category pair. `WITH recent` first: the flow query also
        // selects `data->>'name'` out of `pgboss.job`, so the gauge test below
        // it would otherwise swallow both.
        if (sql.includes('WITH recent')) {
          return options.categoryFlow ?? [];
        }

        if (sql.includes('FROM pgboss.job') && sql.includes(`data->>'name' AS event`)) {
          return options.categoryGauges ?? [];
        }

        return [];
      }),
    },
  };

  return {
    collector: new JobMetricsCollector(repository as never, logger),
    statements,
  };
}

describe('JobMetricsCollector — the per-category sweep', () => {
  it('groups on the (event, queue) pair the category fold resolves on', async () => {
    const capture = makeCollector();

    await capture.collector.sample(new Date('2026-09-01T12:00:00.000Z'));

    const gauges = perCategoryGauge(capture);

    // Both columns, because `categoryOfJob` resolves the PAIR: a handful of
    // events mean different things on different queues, and this table is read
    // beside the Jobs list's category chips, which resolve the same way.
    expect(gauges).toContain(`SELECT data->>'name' AS event`);
    expect(gauges).toMatch(/name\s+AS queue/);
    expect(gauges).toMatch(/GROUP BY 1, 2\b/);
    // The queue is a grouping COLUMN, never the category key on its own —
    // pg-boss rewrites it to the literal `dead-letter` on the copy it makes of a
    // dead-lettered job (43% of rows on a live appliance), and `categoryOfJob`
    // falls back to the event name for exactly those. See its doc comment.
    expect(gauges).toContain('name = $1');
  });

  it('counts a dead-lettered job ONCE, unlike the per-queue gauge that must count it twice', async () => {
    const capture = makeCollector();

    await capture.collector.sample(new Date('2026-09-01T12:00:00.000Z'));

    const perQueue = perQueueGauge(capture);
    const perCategory = perCategoryGauge(capture);

    // The per-queue gauge has to add `state = 'failed'` because the DLQ copy
    // has lost its origin queue and would be attributable to nothing.
    expect(perQueue).toContain(`FILTER (WHERE name = $1 OR state = 'failed')`);
    // The per-category gauge must NOT: the copy keeps `data->>'name'`, so both
    // it and the `failed` original fold to the same category, and counting both
    // doubles every dead-lettered job.
    expect(perCategory).toContain('FILTER (WHERE name = $1)::int                        AS dead_lettered');
    expect(perCategory).not.toContain(`name = $1 OR state = 'failed'`);
  });

  it('excludes the dead-letter copy from arrivals, and only from arrivals', async () => {
    const capture = makeCollector();

    await capture.collector.sample(new Date('2026-09-01T12:00:00.000Z'));

    const flow = perCategoryFlow(capture);

    // A dead-lettered job is INSERTED again with a fresh created_on, so
    // counting it would draw a burst of new work at the moment work broke.
    expect(flow).toMatch(/FILTER \(WHERE created_on >= \$1 AND name <> \$2\)/);
    // completed/failed need no such guard — nothing consumes the DLQ, so its
    // rows never reach a terminal state.
    expect(flow).toMatch(/FILTER \(WHERE completed_on >= \$1 AND state = 'completed'\)/);
    expect(flow).toMatch(/FILTER \(WHERE completed_on >= \$1 AND state = 'failed'\)/);
  });

  it('writes folded CATEGORIES, summing every event that maps to the same one', async () => {
    const capture = makeCollector({
      categoryGauges: [
        { event: 'note.created', pending: 2, active: 0, retry: 0, dead_lettered: 1 },
        { event: 'person.created', pending: 3, active: 1, retry: 0, dead_lettered: 0 },
        { event: 'zz.not-in-the-taxonomy', pending: 5, active: 0, retry: 0, dead_lettered: 0 },
      ],
      categoryFlow: [{ event: 'note.created', arrived: 4, completed: 2, failed: 1 }],
    });

    await capture.collector.sample(new Date('2026-09-01T12:00:00.000Z'));

    const rows = insertedRows(capture, 'ci.job_category_metrics');
    const byCategory = Object.fromEntries(rows.map((row) => [row.category, row]));

    // note.created and person.created are both `search` in the taxonomy.
    expect(byCategory.search).toEqual({
      category: 'search',
      pending: 5,
      active: 1,
      retry: 0,
      dead_lettered: 1,
      arrived: 4,
      completed: 2,
      failed: 1,
    });
    // An event with no taxonomy entry is the ABSENCE of a classification, not a
    // category of work — it gets its own bucket rather than borrowing one.
    expect(byCategory.unclassified.pending).toBe(5);
    expect(Object.keys(byCategory).sort()).toEqual(['search', 'unclassified']);
  });

  it('folds a queue-scoped event by its queue, and its dead-letter copy by its event', async () => {
    // `content.created` is `search` on `search-index` and `pipeline` on
    // `pipeline-index`. Folding on the event alone put all three rows below
    // under `search` — which is what the Jobs list's category chips did too,
    // while the table and the filter beside them said `pipeline`. This table is
    // read on the same page, so it has to fold the same way.
    const capture = makeCollector({
      categoryGauges: [
        {
          event: 'content.created',
          queue: 'search-index',
          pending: 2,
          active: 0,
          retry: 0,
          dead_lettered: 0,
        },
        {
          event: 'content.created',
          queue: 'pipeline-index',
          pending: 7,
          active: 0,
          retry: 0,
          dead_lettered: 0,
        },
        // The dead-letter copy: pg-boss rewrote the queue, so the pair is
        // unrecoverable and the fold degrades to the event — exactly as the
        // list's filter does for the same row.
        {
          event: 'content.created',
          queue: DEAD_LETTER_QUEUE,
          pending: 0,
          active: 0,
          retry: 0,
          dead_lettered: 3,
        },
      ],
    });

    await capture.collector.sample(new Date('2026-09-01T12:00:00.000Z'));

    const byCategory = Object.fromEntries(
      insertedRows(capture, 'ci.job_category_metrics').map((row) => [row.category, row]),
    );

    expect(byCategory.pipeline.pending).toBe(7);
    expect(byCategory.search.pending).toBe(2);
    expect(byCategory.search.dead_lettered).toBe(3);
  });

  it('still writes the per-queue sample when the category table has not been migrated yet', async () => {
    const capture = makeCollector({
      categoryMetricsTable: false,
      categoryGauges: [{ event: 'note.created', pending: 1, active: 0, retry: 0, dead_lettered: 0 }],
    });

    const queues = await capture.collector.sample(new Date('2026-09-01T12:00:00.000Z'));

    expect(queues).toBe(1);
    // A rolling deploy can boot this code against a database whose migrations
    // have not landed. An unguarded INSERT would throw inside a cron every five
    // minutes and take the per-queue sample down with it.
    expect(capture.statements.some((s) => s.sql.includes('INSERT INTO ci.job_category_metrics'))).toBe(false);
    expect(capture.statements.some((s) => s.sql.includes('INSERT INTO ci.job_metrics'))).toBe(true);
    // And it does not scan pg-boss for numbers it cannot store.
    expect(capture.statements.some((s) => s.sql.includes('WITH recent'))).toBe(false);
  });

  it('purges both tables on the same retention horizon', async () => {
    const capture = makeCollector();

    await capture.collector.purge(new Date('2026-09-01T12:00:00.000Z'));

    const deletes = capture.statements.filter((statement) => statement.sql.includes('DELETE FROM'));

    expect(deletes.map((statement) => statement.sql.trim())).toEqual([
      'DELETE FROM ci.job_metrics WHERE sampled_at < $1',
      'DELETE FROM ci.job_category_metrics WHERE sampled_at < $1',
    ]);
    // Same cutoff for both: the two charts sit on the same screen, and a window
    // that runs off the end of one of them is worse than a shorter window on
    // both.
    expect(deletes[0].params[0]).toEqual(deletes[1].params[0]);
  });
});
