import {
  inferenceDecideCommand,
  inferenceForecastCommand,
  inferenceRankCommand,
  inferenceTiersCommand,
} from '../commands/inference';
import { CliError } from '../context';
import type {
  ArenaStats,
  DecisionRequest,
  DecisionResponse,
  ModelRoutingTiersResponse,
  NoulDecisionResult,
  RankRequest,
  RankResponse,
  RoutingDecision,
  RoutingRequest,
} from '../wire';

import { harness } from './support/harness';
import { wireFixture } from './support/wireFixtures';

/**
 * Requests and responses come from `fixtures/wire/model-routing.json`, which the
 * API's `model-routing/__tests__/cliWireContract.test.ts` checks against the
 * real controller. These tests used to hand-build responses from `wire.ts`'s
 * types, and those types described a server that never existed: every command
 * here crashed or sent a body the routes refused or ignored.
 */
const routing = wireFixture('model-routing.json');

describe('ci inference', () => {
  it('lists the tiers the server profiles and the arena size it reports', async () => {
    const ctx = harness({
      getModelRoutingTiers: async () => routing.tiers.response as ModelRoutingTiersResponse,
      getModelRoutingArena: async () => routing.arena.response as ArenaStats,
    });

    await inferenceTiersCommand(ctx);

    expect(ctx.term.text()).toMatch(/on_device\s+On-device \(local Ollama\)\s+8,192\s+yes\s+no/);
    expect(ctx.term.text()).toMatch(/private_cloud\s+Private cloud \(escalated\)\s+32,768\s+no\s+yes/);
    expect(ctx.term.text()).toContain('arena       11 cached candidate vectors');
  });

  it('prints both bodies under --json', async () => {
    const ctx = harness({
      getModelRoutingTiers: async () => routing.tiers.response as ModelRoutingTiersResponse,
      getModelRoutingArena: async () => routing.arena.response as ArenaStats,
    });

    await inferenceTiersCommand(ctx, { json: true });

    expect(JSON.parse(ctx.term.text())).toEqual({
      ...(routing.tiers.response as ModelRoutingTiersResponse),
      arena: routing.arena.response,
    });
  });

  it('sends a plan request whose every field the planner reads', async () => {
    let sent: RoutingRequest | undefined;
    const ctx = harness({
      planModelRouting: async (body) => {
        sent = body;

        return routing.plan.response as RoutingDecision;
      },
    });

    await inferenceTiersCommand(ctx, {
      inputTokens: '12000',
      reasoning: 'deep',
      toolDepth: '3',
      largeContext: true,
      sensitive: true,
      forceTier: 'private-cloud',
    });

    // `--sensitive` is `localOnly`, the privacy pin. It used to go out as
    // `requiresSensitiveData`, which the planner strips without a word.
    expect(sent).toEqual(routing.plan.request);
    expect(ctx.term.text()).toContain('tier        on_device (On-device (local Ollama))');
    expect(ctx.term.text()).toContain('reasoning   deep');
    expect(ctx.term.text()).toContain('downgraded  yes');
    expect(ctx.term.text()).toContain('localOnly: privacy pins this task on-device');
  });

  it('refuses a tier or a reasoning level the planner does not have', async () => {
    const ctx = harness({});

    await expect(inferenceTiersCommand(ctx, { forceTier: 'edge' })).rejects.toThrow(/--force-tier/);
    await expect(inferenceTiersCommand(ctx, { reasoning: 'heavy' })).rejects.toThrow(/--reasoning/);
  });

  it('sends a noul decision under `primitive` and reads the decision back', async () => {
    let sent: DecisionRequest | undefined;
    const ctx = harness({
      decideModelRouting: async (body) => {
        sent = body;

        return routing.decideNoul.response as DecisionResponse;
      },
    });

    await inferenceDecideCommand(ctx, {
      type: 'noul',
      state: 'Finished a morning run and it is warm out',
      action: 'Log a hydration reminder',
    });

    expect(sent).toEqual(routing.decideNoul.request);
    expect(ctx.term.text()).toContain('engine      hybrid');
    expect(ctx.term.text()).toContain('decision    yes: the action applies');
    expect(ctx.term.text()).toContain('probability 51.7%');
  });

  it('sends a choice decision and prints the ranked candidates', async () => {
    let sent: DecisionRequest | undefined;
    const ctx = harness({
      decideModelRouting: async (body) => {
        sent = body;

        return routing.decideChoice.response as DecisionResponse;
      },
    });

    await inferenceDecideCommand(ctx, {
      type: 'choice',
      state: 'A free evening, tired after work',
      candidates: 'Go for a walk, Watch a film, Call Sam',
    });

    expect(sent).toEqual(routing.decideChoice.request);
    expect(ctx.term.text()).toContain('selected    [1] Watch a film');
    expect(ctx.term.text()).toMatch(/0\s+Go for a walk\s+30\.2%/);
  });

  it('sends a score decision as a rubric of named poles', async () => {
    let sent: DecisionRequest | undefined;
    const ctx = harness({
      decideModelRouting: async (body) => {
        sent = body;

        return routing.decideScore.response as DecisionResponse;
      },
    });

    await inferenceDecideCommand(ctx, {
      type: 'score',
      state: 'Pay the electricity bill before Friday',
      criteria: 'urgent:needs doing today,money',
    });

    expect(sent).toEqual(routing.decideScore.request);
    expect(ctx.term.text()).toContain('score       52.4%');
    expect(ctx.term.text()).toMatch(/urgent\s+53\.3%\s+1/);
  });

  it('says when both engines are off rather than printing a neutral default as a decision', async () => {
    const ctx = harness({
      decideModelRouting: async () => ({
        ...(routing.decideNoul.response as NoulDecisionResult),
        engineUsed: 'disabled',
      }),
    });

    await inferenceDecideCommand(ctx, { type: 'noul', state: 'x', action: 'y' });

    expect(ctx.term.text()).toContain('both engines are switched off in Settings');
  });

  it('checks each primitive’s own flag before calling the server', async () => {
    const ctx = harness({});

    await expect(inferenceDecideCommand(ctx, { type: 'noul', state: 's' })).rejects.toThrow(/--action/);
    await expect(
      inferenceDecideCommand(ctx, { type: 'choice', state: 's', candidates: 'only-one' }),
    ).rejects.toBeInstanceOf(CliError);
    await expect(inferenceDecideCommand(ctx, { type: 'score', state: 's' })).rejects.toThrow(/--criteria/);
    await expect(inferenceDecideCommand(ctx, { type: 'vote', state: 's' })).rejects.toThrow(/--type/);
  });

  it('ranks candidates and reads `items`, not `ranked`', async () => {
    let sent: RankRequest | undefined;
    const ctx = harness({
      rankModelRouting: async (body) => {
        sent = body;

        return routing.rank.response as RankResponse;
      },
    });

    await inferenceRankCommand(ctx, {
      query: 'Morning routine',
      candidate: ['a1:Drink water', 'a2:Check calendar'],
      topK: '2',
    });

    expect(sent).toEqual(routing.rank.request);
    expect(ctx.term.text()).toContain('engine   hybrid');
    expect(ctx.term.text()).toContain('arena 0 cached, 2 embedded');
    expect(ctx.term.text()).toMatch(/1\s+a1\s+0\.2960\s+59\.1%\s+Drink water/);
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
