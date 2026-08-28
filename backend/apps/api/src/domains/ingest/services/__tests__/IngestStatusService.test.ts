import type { DataSource } from 'typeorm';

import { IngestStatusService } from '../IngestStatusService';

describe('IngestStatusService.snapshot', () => {
  it('assembles table counts, per-type index tallies, queue depth, and coverage', async () => {
    const dataSource = {
      query: jest.fn(async (sql: string) => {
        if (/AS communications/.test(sql)) {
          return [
            {
              communications: '10',
              events: '20',
              content: '30',
              objects: '40',
              browser_activity: '50',
              position: '60',
              product_models: '70',
              receipts: '80',
              receipt_line_items: '90',
              object_observations: '100',
            },
          ];
        }

        if (/ci_search\.embeddings/.test(sql)) {
          return [{ entity_type: 'communication', count: '7' }];
        }

        if (/ci_search\.index_skips/.test(sql)) {
          return [{ entity_type: 'event', count: '2' }];
        }

        if (/comms_linked/.test(sql)) {
          return [
            {
              comms_linked: '4',
              events_linked: '5',
              events_geocoded: '6',
              positions_named: '0',
              inv_coords: '8',
              inv_placed: '1',
            },
          ];
        }

        return [
          { state: 'created', count: '5' },
          { state: 'failed', count: '1' },
        ];
      }),
    } as unknown as DataSource;

    const snapshot = await new IngestStatusService(dataSource).snapshot({ userId: 'user-1', scope: 'user' });

    expect(snapshot.tables).toEqual({
      communications: 10,
      events: 20,
      content: 30,
      objects: 40,
      browser_activity: 50,
      position: 60,
      product_models: 70,
      receipts: 80,
      receipt_line_items: 90,
      object_observations: 100,
    });
    expect(snapshot.searchIndex.embeddingsByType).toEqual({ communication: 7 });
    expect(snapshot.searchIndex.skipsByType).toEqual({ event: 2 });
    expect(snapshot.searchIndex.queue).toEqual({ created: 5, active: 0, failed: 1 });
    expect(snapshot.coverage.geocoded.positionsAddressed).toEqual({ rows: 60, matched: 0, pct: 0 });
    expect(snapshot.coverage.geocoded.objectPlaced.pct).toBeCloseTo(1 / 8);
    expect(snapshot.coverage.embedded.communication.pctDecided).toBeCloseTo(7 / 10);
  });
});
