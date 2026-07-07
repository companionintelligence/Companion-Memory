/* eslint-disable @typescript-eslint/no-explicit-any */
import { ServiceUnavailableException } from '@nestjs/common';

import type { ForecastResponse } from '@ci/domains/predictions';

import { PredictionsForecastTool } from '../PredictionsForecastTool';

const USER_ID = '2b6f0cc9-04f6-4b91-8c5a-000000000001';
const ctx = { userId: USER_ID };

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
}

function bucket(startTime: string, l0: Record<string, number>, l1: Record<string, number> = {}) {
  return {
    bucket_index: 0,
    start_time: startTime,
    l0_probs: l0,
    l1_probs: l1,
    l2_probs: null,
    q10: 0.1,
    q50: 0.5,
    q90: 0.9,
  };
}

function readyResponse(buckets: ReturnType<typeof bucket>[]): ForecastResponse {
  return {
    horizon: '24h',
    generated_at: '2026-07-06T00:00:00Z',
    system_status: 'READY',
    buckets,
  };
}

function makeTool({
  hbpeEnabled = true,
  forecast,
}: {
  hbpeEnabled?: boolean;
  forecast?: ForecastResponse | Error;
} = {}) {
  const getForecast = jest.fn().mockImplementation(async () => {
    if (forecast instanceof Error) {
      throw forecast;
    }

    return forecast;
  });
  const hbpe = { getForecast } as any;
  const features = { isFeatureEnabled: jest.fn().mockResolvedValue(hbpeEnabled) } as any;
  const tool = new PredictionsForecastTool(hbpe, features, makeLogger());

  return { tool, getForecast, features };
}

/** Future ISO timestamps relative to "now", so fromNow filtering keeps them. */
function futureIso(minutesAhead: number): string {
  return new Date(Date.now() + minutesAhead * 60_000).toISOString();
}

describe('PredictionsForecastTool', () => {
  it('declares the curated read-only predictions intent', () => {
    const { tool } = makeTool();

    expect(tool.schema.name).toBe('predictions.forecast');
    expect(tool.schema.domain).toBe('predictions');
    expect(tool.schema.privacy).toEqual({
      access: 'read',
      sensitivity: 'personal',
      destructive: false,
      external: false,
    });
  });

  it('transforms READY buckets into top-activity/top-context pairs (happy path)', async () => {
    const { tool, getForecast } = makeTool({
      forecast: readyResponse([
        bucket(futureIso(30), { sleep: 0.7, work: 0.2 }, { home: 0.9, office: 0.05 }),
        bucket(futureIso(60), { work: 0.55, sleep: 0.1 }),
      ]),
    });

    const result = await tool.execute(ctx, {});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      available: true,
      horizon: '24h',
      generatedAt: '2026-07-06T00:00:00Z',
      systemStatus: 'READY',
      buckets: [
        {
          startTime: expect.any(String),
          topActivity: { label: 'sleep', prob: 0.7 },
          topContext: { label: 'home', prob: 0.9 },
        },
        {
          startTime: expect.any(String),
          topActivity: { label: 'work', prob: 0.55 },
          topContext: null,
        },
      ],
    });
    expect(getForecast).toHaveBeenCalledWith({ userId: USER_ID }, '24h');

    // q10/q50/q90 are a cross-day spread, not a predictive interval — never exposed.
    expect(JSON.stringify(result.data)).not.toMatch(/q10|q50|q90|confidence/);
  });

  it('drops past buckets by default but keeps them with fromNow:false', async () => {
    const past = bucket('2020-01-01T00:00:00Z', { sleep: 1 });
    const future = bucket(futureIso(30), { work: 1 });

    const filtered = await makeTool({ forecast: readyResponse([past, future]) }).tool.execute(ctx, {});
    expect((filtered.data as any).buckets).toHaveLength(1);
    expect((filtered.data as any).buckets[0].topActivity.label).toBe('work');

    const unfiltered = await makeTool({ forecast: readyResponse([past, future]) }).tool.execute(ctx, {
      fromNow: false,
    });
    expect((unfiltered.data as any).buckets).toHaveLength(2);
  });

  it('reports unavailable without calling HBPE when the hbpe feature flag is off', async () => {
    const { tool, getForecast } = makeTool({ hbpeEnabled: false });

    const result = await tool.execute(ctx, {});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ available: false, reason: 'hbpe feature disabled' });
    expect(getForecast).not.toHaveBeenCalled();
  });

  it('is honest about cold start instead of returning placeholder buckets', async () => {
    const { tool } = makeTool({
      forecast: {
        horizon: '24h',
        generated_at: '2026-07-06T00:00:00Z',
        system_status: 'COLD_START',
        buckets: [bucket(futureIso(30), { sleep: 0.5 })],
      },
    });

    const result = await tool.execute(ctx, {});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      available: false,
      status: 'COLD_START',
      message: 'still learning your patterns',
    });
  });

  it('treats an empty READY histogram as still-learning too', async () => {
    const { tool } = makeTool({ forecast: readyResponse([]) });

    const result = await tool.execute(ctx, {});

    expect(result.data).toEqual({
      available: false,
      status: 'READY',
      message: 'still learning your patterns',
    });
  });

  it('returns a structured unavailable result when the HBPE sidecar is unreachable', async () => {
    const { tool } = makeTool({
      forecast: new ServiceUnavailableException('Forecast service unavailable'),
    });

    const result = await tool.execute(ctx, {});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ available: false, reason: 'forecast service unavailable' });
  });

  it('rejects horizons the sidecar does not support without calling it', async () => {
    const { tool, getForecast } = makeTool();

    const result = await tool.execute(ctx, { horizon: '7d' });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      available: false,
      reason: expect.stringContaining("unsupported horizon '7d'"),
    });
    expect(getForecast).not.toHaveBeenCalled();
  });

  it('fails validation on a malformed input instead of calling HBPE', async () => {
    const { tool, getForecast } = makeTool();

    const result = await tool.execute(ctx, { fromNow: 'yes-please' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(getForecast).not.toHaveBeenCalled();
  });
});
