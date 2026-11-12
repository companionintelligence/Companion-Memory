import {
  inferenceDecideCommand,
  inferenceForecastCommand,
  inferenceRankCommand,
  inferenceTiersCommand,
} from '../commands/inference';
import { CliError } from '../context';

import { harness } from './support/harness';

describe('ci inference', () => {
  it('renders model routing tiers and System 1 ActionVectorArena status', async () => {
    const ctx = harness({
      getModelRoutingTiers: async () => ({
        tiers: [
          {
            tier: 'on-device',
            description: 'Local Ollama',
            latency: '10-150ms',
            cost: 'free',
            privacy: 'strict-local',
            defaultModels: { fast: 'qwen3:1.7b', balanced: 'qwen3:8b' },
          },
        ],
        arena: {
          size: 420,
          dimension: 768,
          builtAt: '2026-11-12T05:00:00.000Z',
          byCategory: { memory: 300, action: 120 },
        },
      }),
    });

    await inferenceTiersCommand(ctx);

    expect(ctx.term.text()).toContain('on-device');
    expect(ctx.term.text()).toContain('420 vectors (768d)');
    expect(ctx.term.text()).toContain('memory:300, action:120');
  });

  it('simulates a routing plan when --plan or workload options are given', async () => {
    const ctx = harness({
      planModelRouting: async (req) => ({
        tier: req.requiresSensitiveData ? 'on-device' : 'private-cloud',
        provider: 'ollama',
        model: 'qwen3:8b',
        reason: 'Sensitive personal data stays on-device.',
        estimatedLatencyMs: 85,
      }),
    });

    await inferenceTiersCommand(ctx, { plan: true, sensitive: true, reasoning: 'moderate' });

    expect(ctx.term.text()).toContain('tier        on-device');
    expect(ctx.term.text()).toContain('model       qwen3:8b');
  });

  it('runs a Dual-Engine decision and validates required flags', async () => {
    const ctx = harness({
      decideModelRouting: async (body) => ({
        type: body.type,
        engine: 'contrastive',
        tier: 'on-device',
        latencyMs: 3,
        confidence: 0.88,
        noul: false,
        contrastiveScore: 0.8123,
        reasoning: 'High cosine affinity with recent action vectors.',
      }),
    });

    await inferenceDecideCommand(ctx, {
      type: 'noul',
      state: 'User finished morning run',
      action: 'Log hydration reminder',
    });

    expect(ctx.term.text()).toContain('engine      contrastive (on-device)');
    expect(ctx.term.text()).toContain('noul        false (proceed)');

    await expect(
      inferenceDecideCommand(ctx, { type: 'choice', state: 'Pick one', candidates: 'only-one' }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('ranks candidates via System 1 / System 2', async () => {
    const ctx = harness({
      rankModelRouting: async (req) => ({
        engine: 'hybrid',
        latencyMs: 42,
        ranked: req.candidates.map((c, idx) => ({
          id: c.id,
          text: c.text,
          score: 0.9 - idx * 0.1,
          source: 'hybrid' as const,
        })),
      }),
    });

    await inferenceRankCommand(ctx, {
      query: 'Morning routine',
      candidate: ['a1:Drink water', 'a2:Check calendar'],
    });

    expect(ctx.term.text()).toContain('Drink water');
    expect(ctx.term.text()).toContain('0.9000');
  });

  it('queries HBPE day-ahead, week, due, and place forecasts', async () => {
    const ctx = harness(
      {},
      {
        forecast: async (horizon) => ({
          horizon: horizon ?? '24h',
          generatedAt: '2026-11-12T08:00:00.000Z',
          systemStatus: 'READY',
          modelVersion: 'hmt',
          stillLearning: false,
          pipelineEtaSeconds: null,
          pipelineDetail: null,
          buckets: [
            {
              bucketIndex: 0,
              startTime: '2026-11-12T08:00:00.000Z',
              predictedL0: 'WORK',
              l0Probs: [{ label: 'WORK', probability: 0.82 }],
              l1Probs: [{ label: 'Deep coding', probability: 0.65 }],
              q10: 0.2,
              q50: 0.65,
              q90: 0.9,
            },
          ],
        }),
        placeForecast: async () => [
          {
            clusterId: 'pl_1',
            lat: 37.7749,
            lng: -122.4194,
            visits: 24,
            share: 0.45,
            lastSeen: '2026-11-11T18:00:00.000Z',
            label: 'Office',
            probability: 0.72,
            backoffLevel: 'hour_dow',
          },
        ],
      },
    );

    await inferenceForecastCommand(ctx, { horizon: '24h' });
    expect(ctx.term.text()).toContain('Deep coding (65%)');

    ctx.term.lines.length = 0;
    await inferenceForecastCommand(ctx, { places: true });
    expect(ctx.term.text()).toContain('Office');
    expect(ctx.term.text()).toContain('72.0%');
  });
});
