/* eslint-disable @typescript-eslint/no-explicit-any */
import { InsightsListTool } from '../InsightsListTool';
import { SUMMARY_SCAN_LIMIT } from '../summaryNarrative';

const ctx = { userId: 'user-1' };

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
}

function summary(
  id: string,
  periodEnd: string,
  keyInsights: string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    summaryId: id,
    periodStart: new Date(Date.parse(periodEnd) - 60 * 60_000),
    periodEnd: new Date(periodEnd),
    periodType: 'daily',
    keyInsights,
    anomalies: [],
    ...overrides,
  } as any;
}

function makeTool(summaries: any[] | Error) {
  const findRecent = jest.fn().mockImplementation(async () => {
    if (summaries instanceof Error) {
      throw summaries;
    }

    return summaries;
  });
  const tool = new InsightsListTool({ findRecent } as any, makeLogger());

  return { tool, findRecent };
}

describe('InsightsListTool', () => {
  it('declares the curated read-only insights intent', () => {
    const { tool } = makeTool([]);

    expect(tool.schema.name).toBe('insights.list');
    expect(tool.schema.domain).toBe('insights');
    expect(tool.schema.privacy).toEqual({
      access: 'read',
      sensitivity: 'personal',
      destructive: false,
      external: false,
    });
  });

  it('flattens keyInsights across summary windows and labels the basis (happy path)', async () => {
    const { tool, findRecent } = makeTool([
      summary('s2', '2026-07-06T00:00:00Z', ['Deep-work mornings', 'Late dinners this week']),
      summary('s1', '2026-07-05T00:00:00Z', ['More walking than usual']),
    ]);

    const result = await tool.execute(ctx, {});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      basis: 'llm-narrative',
      count: 3,
      items: [
        {
          text: 'Deep-work mornings',
          summaryId: 's2',
          periodStart: '2026-07-05T23:00:00.000Z',
          periodEnd: '2026-07-06T00:00:00.000Z',
          periodType: 'daily',
        },
        {
          text: 'Late dinners this week',
          summaryId: 's2',
          periodStart: '2026-07-05T23:00:00.000Z',
          periodEnd: '2026-07-06T00:00:00.000Z',
          periodType: 'daily',
        },
        {
          text: 'More walking than usual',
          summaryId: 's1',
          periodStart: '2026-07-04T23:00:00.000Z',
          periodEnd: '2026-07-05T00:00:00.000Z',
          periodType: 'daily',
        },
      ],
    });
    expect(findRecent).toHaveBeenCalledWith({ userId: 'user-1' }, SUMMARY_SCAN_LIMIT);
  });

  it('honors since (window periodEnd lower bound) and limit', async () => {
    const summaries = [
      summary('s2', '2026-07-06T00:00:00Z', ['a', 'b']),
      summary('s1', '2026-07-01T00:00:00Z', ['old']),
    ];

    const sinceFiltered = await makeTool(summaries).tool.execute(ctx, {
      since: '2026-07-05T00:00:00Z',
    });
    expect((sinceFiltered.data as any).items.map((i: any) => i.text)).toEqual(['a', 'b']);

    const limited = await makeTool(summaries).tool.execute(ctx, { limit: 1 });
    expect((limited.data as any).items.map((i: any) => i.text)).toEqual(['a']);
    expect((limited.data as any).count).toBe(1);
  });

  it('returns a clean empty result when no summaries carry insights', async () => {
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

  it('rejects malformed input without calling the service', async () => {
    const { tool, findRecent } = makeTool([]);

    const result = await tool.execute(ctx, { limit: 0 });

    expect(result.success).toBe(false);
    expect(findRecent).not.toHaveBeenCalled();
  });
});
