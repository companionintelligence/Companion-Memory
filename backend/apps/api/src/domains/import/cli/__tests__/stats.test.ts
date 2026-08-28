import { statsCommand } from '../commands/stats';

import { harness } from './support/harness';

const ingest = {
  tables: { communications: 1_030_500, events: 88_000, content: 366_862, objects: 0, browser_activity: 12 },
  searchIndex: {
    embeddingsByType: { content: 300_000, event: 5_000 },
    skipsByType: { content: 60_000 },
    queue: { created: 4, active: 1, failed: 0 },
  },
  at: '2026-08-16T12:00:00.000Z',
};

const run = (status: string) => ({
  id: `${status}-1111-2222-3333-444444444444`,
  label: 'takeout.zip',
  source: 'cli',
  dataSources: ['gmail', 'google_photos'],
  declaredSources: null,
  status,
  percent: 100,
  requestedStages: [],
  error: null,
  createdAt: new Date('2026-08-16T10:00:00Z'),
  startedAt: new Date('2026-08-16T10:00:00Z'),
  finishedAt: new Date('2026-08-16T11:00:00Z'),
});

describe('ci-import stats', () => {
  it('reports the destination tables, the index, and a run rollup', async () => {
    const ctx = harness({
      ingestStatus: async () => ingest,
      listRuns: async () => [run('completed'), run('partial'), run('completed')],
    });

    await statsCommand(ctx);

    const text = ctx.term.text();

    expect(text).toContain('Records in ci.*');
    expect(text).toContain('1,030,500');
    expect(text).toContain('Search index');
    // Skips are decided rows, not a shortfall — counted in their own column.
    expect(text).toContain('skipped');
    expect(text).toContain('queue  4 waiting, 1 in flight, 0 failed');
    expect(text).toContain('gmail(3)');
    expect(text).toMatch(/completed\s+2/);
  });

  it('survives an appliance with nothing imported yet', async () => {
    const ctx = harness({
      ingestStatus: async () => ({
        ...ingest,
        searchIndex: { embeddingsByType: {}, skipsByType: {}, queue: { created: 0, active: 0, failed: 0 } },
      }),
      listRuns: async () => [],
    });

    await statsCommand(ctx);

    expect(ctx.term.text()).toContain('Import runs');
    expect(ctx.term.text()).toContain('(none)');
  });

  it('emits both halves under --json', async () => {
    const ctx = harness({ ingestStatus: async () => ingest, listRuns: async () => [run('completed')] });

    await statsCommand(ctx, { json: true });

    const parsed = JSON.parse(ctx.term.text());

    expect(parsed.ingest.tables.communications).toBe(1_030_500);
    expect(parsed.runs.byStatus).toEqual({ completed: 1 });
    expect(parsed.runs.byDataSource).toEqual({ gmail: 1, google_photos: 1 });
  });
});
