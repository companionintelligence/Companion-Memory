/* eslint-disable @typescript-eslint/no-explicit-any */
import { AnomaliesRecentTool } from '../AnomaliesRecentTool';
import { SUMMARY_SCAN_LIMIT } from '../summaryNarrative';

const ctx = { userId: 'user-1' };

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
}

function summary(id: string, periodEnd: string, anomalies: string[]) {
  return {
    summaryId: id,
    periodStart: new Date(Date.parse(periodEnd) - 60 * 60_000),
    periodEnd: new Date(periodEnd),
    periodType: 'daily',
    keyInsights: ['insight noise that must not leak into anomalies'],
    anomalies,
  } as any;
}

function makeTool(summaries: any[] | Error) {
  const findRecent = jest.fn().mockImplementation(async () => {
    if (summaries instanceof Error) {
      throw summaries;
    }

    return summaries;
  });
  const tool = new AnomaliesRecentTool({ findRecent } as any, makeLogger());

  return { tool, findRecent };
}

describe('AnomaliesRecentTool', () => {
  it('declares the curated read-only anomalies intent', () => {
    const { tool } = makeTool([]);

    expect(tool.schema.name).toBe('anomalies.recent');
    expect(tool.schema.domain).toBe('anomalies');
    expect(tool.schema.privacy).toEqual({
      access: 'read',
      sensitivity: 'personal',
      destructive: false,
      external: false,
    });
  });

  it('projects the anomalies field (not insights) with llm-narrative basis (happy path)', async () => {
    const { tool, findRecent } = makeTool([
      summary('s2', '2026-07-06T00:00:00Z', ['No commute recorded on a weekday']),
      summary('s1', '2026-07-05T00:00:00Z', []),
    ]);

    const result = await tool.execute(ctx, {});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      basis: 'llm-narrative',
      count: 1,
      items: [
        {
          text: 'No commute recorded on a weekday',
          summaryId: 's2',
          periodStart: '2026-07-05T23:00:00.000Z',
          periodEnd: '2026-07-06T00:00:00.000Z',
          periodType: 'daily',
        },
      ],
    });
    expect(findRecent).toHaveBeenCalledWith({ userId: 'user-1' }, SUMMARY_SCAN_LIMIT);
  });

  it('honors the since lower bound', async () => {
    const { tool } = makeTool([
      summary('s2', '2026-07-06T00:00:00Z', ['fresh']),
      summary('s1', '2026-06-01T00:00:00Z', ['stale']),
    ]);

    const result = await tool.execute(ctx, { since: '2026-07-01T00:00:00Z' });

    expect((result.data as any).items.map((i: any) => i.text)).toEqual(['fresh']);
  });

  it('returns a clean empty result when no windows carry anomalies', async () => {
    const { tool } = makeTool([summary('s1', '2026-07-06T00:00:00Z', [])]);

    const result = await tool.execute(ctx, {});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ basis: 'llm-narrative', items: [], count: 0 });
  });

  it('surfaces a service failure as a structured tool error', async () => {
    const { tool } = makeTool(new Error('db down'));

    const result = await tool.execute(ctx, {});

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('db down');
  });
});
