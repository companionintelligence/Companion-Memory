import type { RequestContext } from '@ci/common/context';

import { GraphController } from '../GraphController';

describe('GraphController.getMemoryStats', () => {
  const ctx = { userId: 'user-1' } as RequestContext;

  it('returns thing totals plus life series and forwards the date window', async () => {
    const getLifeSeries = jest.fn(async () => ({
      spend: { rows: [] },
      time: { mode: 'counts', coverage: { timedEvents: 0, consideredEvents: 0 }, rows: [] },
      conversations: { rows: [] },
      social: { granularity: 'week', rows: [] },
      channels: { rows: [] },
      insights: [],
    }));

    const controller = new GraphController(
      {} as never,
      {} as never,
      {
        getRelationshipStats: jest.fn(async () => ({
          totalRelationships: 2,
          relationshipsByType: [{ type: 'KNOWS', count: 2 }],
          entitiesByType: [{ type: 'Person', count: 5 }],
        })),
        getEntityCountsBySource: jest.fn(async () => []),
      } as never,
      {} as never,
      { getTagUsageCounts: jest.fn(async () => []) } as never,
      { getTimelineStats: jest.fn(async () => ({ totalEvents: 9, earliest: null, latest: null })) } as never,
      { getLifeSeries } as never,
    );

    const result = await controller.getMemoryStats(ctx, {
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
    });

    expect(getLifeSeries).toHaveBeenCalledWith('user-1', {
      from: new Date('2026-05-01T00:00:00.000Z'),
      to: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(result.data.totals.entities).toBe(5);
    expect(result.data.byEntityType).toEqual([{ type: 'Person', count: 5 }]);
    expect(result.data.spend).toEqual({ rows: [] });
  });
});
