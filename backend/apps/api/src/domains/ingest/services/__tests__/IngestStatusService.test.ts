import type { DataSource } from 'typeorm';

import { IngestStatusService } from '../IngestStatusService';

describe('IngestStatusService.snapshot', () => {
  it('assembles table counts, per-type index tallies, and queue depth from the four queries', async () => {
    const dataSource = {
      query: jest.fn(async (sql: string) => {
        if (/FROM ci\.communications/.test(sql)) {
          return [
            {
              communications: '10',
              events: '20',
              content: '30',
              inventory: '40',
              browser_activity: '50',
              position: '60',
            },
          ];
        }

        if (/ci_search\.embeddings/.test(sql)) {
          return [{ entity_type: 'communication', count: '7' }];
        }

        if (/ci_search\.index_skips/.test(sql)) {
          return [{ entity_type: 'event', count: '2' }];
        }

        // pgboss queue states
        return [
          { state: 'created', count: '5' },
          { state: 'failed', count: '1' },
        ];
      }),
    } as unknown as DataSource;

    const snapshot = await new IngestStatusService(dataSource).snapshot();

    expect(snapshot.tables).toEqual({
      communications: 10,
      events: 20,
      content: 30,
      inventory: 40,
      browser_activity: 50,
      position: 60,
    });
    expect(snapshot.searchIndex.embeddingsByType).toEqual({ communication: 7 });
    expect(snapshot.searchIndex.skipsByType).toEqual({ event: 2 });
    expect(snapshot.searchIndex.queue).toEqual({ created: 5, active: 0, failed: 1 });
    expect(new Date(snapshot.at).getTime()).not.toBeNaN();
    expect((dataSource.query as jest.Mock).mock.calls).toHaveLength(4);
  });
});
