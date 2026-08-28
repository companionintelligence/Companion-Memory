import config from '@ci/configuration';
import { ModelTierRouter } from '@ci/domains/model-routing';

import { estimateInputTokens, OllamaService } from '../OllamaService';

/**
 * `ModelTierRouter` shipped with a REST endpoint and no internal caller. This
 * covers its first one: chat model selection in `OllamaService.resolveModel`.
 *
 * The load-bearing assertion is the FIRST one — with `llm.tierRouting.enabled`
 * false (the default), selection is byte-for-byte what it was before the router
 * was wired in. The router's on-device context window is an admitted estimate,
 * and an estimate must not silently become the escalation threshold on every
 * appliance.
 */

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

const ON_DEVICE = 'qwen3:4b';
const ESCALATED = 'qwen3:32b';
const SERVED = [ON_DEVICE, ESCALATED, 'some-other-model'];

function buildService(served: string[] = SERVED) {
  const driver = {
    listModels: jest.fn(async () => served),
    chat: jest.fn(),
  };
  const service = new OllamaService(
    { getOpenAiDriver: () => driver } as never,
    { getAgentFacingTools: () => [] } as never,
    makeLogger() as never,
    { isFeatureEnabled: jest.fn(async () => false) } as never,
    new ModelTierRouter(),
  );

  return { service, driver };
}

type TierRoutingConfig = (typeof config)['llm']['tierRouting'];

const defaults: TierRoutingConfig = { ...config.llm.tierRouting };

function setRouting(overrides: Partial<TierRoutingConfig>): void {
  Object.assign(config.llm.tierRouting, defaults, overrides);
}

const ctx = { userId: 'user-1' };

/** A prompt whose estimated token count comfortably exceeds `tokens`. */
function longTurn(tokens: number) {
  return [{ role: 'user', content: 'x'.repeat(tokens * 4 + 4) }];
}

afterEach(() => {
  Object.assign(config.llm.tierRouting, defaults);
});

describe('llm.tierRouting defaults to off', () => {
  it('ships disabled, with no tier models named', () => {
    expect(defaults).toStrictEqual({
      enabled: false,
      onDeviceModel: '',
      escalatedModel: '',
      onDeviceContextTokens: 0,
    });
  });

  it('reproduces the pre-routing selection exactly — even for a turn that would escalate', async () => {
    const { service } = buildService();

    // 20k estimated tokens + deep reasoning: every escalation heuristic fires.
    const resolved = await service.resolveModel(ctx, {
      requestedModel: ON_DEVICE,
      enableThinking: true,
      messages: longTurn(20_000) as never,
    });

    // Unrouted resolution honours the requested id because it is served.
    expect(resolved.model).toBe(ON_DEVICE);
  });
});

describe('OllamaService.resolveModel consults ModelTierRouter when routing is enabled', () => {
  it('keeps a small, shallow turn on the on-device model', async () => {
    setRouting({ enabled: true, onDeviceModel: ON_DEVICE, escalatedModel: ESCALATED });
    const { service } = buildService();

    const resolved = await service.resolveModel(ctx, {
      requestedModel: 'some-other-model',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(resolved.model).toBe(ON_DEVICE);
  });

  it('escalates a turn whose context exceeds the on-device window', async () => {
    setRouting({ enabled: true, onDeviceModel: ON_DEVICE, escalatedModel: ESCALATED });
    const { service } = buildService();

    const resolved = await service.resolveModel(ctx, {
      requestedModel: ON_DEVICE,
      messages: longTurn(20_000) as never,
    });

    expect(resolved.model).toBe(ESCALATED);
  });

  it('escalates when the caller asked for thinking (deep reasoning)', async () => {
    setRouting({ enabled: true, onDeviceModel: ON_DEVICE, escalatedModel: ESCALATED });
    const { service } = buildService();

    const resolved = await service.resolveModel(ctx, {
      enableThinking: true,
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(resolved.model).toBe(ESCALATED);
  });

  it('honours a measured on-device window instead of the router estimate', async () => {
    setRouting({
      enabled: true,
      onDeviceModel: ON_DEVICE,
      escalatedModel: ESCALATED,
      // Real window is 128k, so a 20k turn that the 8k ESTIMATE would escalate
      // stays local.
      onDeviceContextTokens: 131_072,
    });
    const { service } = buildService();

    const resolved = await service.resolveModel(ctx, {
      requestedModel: ESCALATED,
      messages: longTurn(20_000) as never,
    });

    expect(resolved.model).toBe(ON_DEVICE);
  });

  it('falls back on-device when the escalated model is not served', async () => {
    setRouting({ enabled: true, onDeviceModel: ON_DEVICE, escalatedModel: 'not-loaded:70b' });
    const { service } = buildService();

    const resolved = await service.resolveModel(ctx, {
      messages: longTurn(20_000) as never,
    });

    expect(resolved.model).toBe(ON_DEVICE);
  });

  it('keeps the unrouted choice when the chosen tier names no model', async () => {
    setRouting({ enabled: true, escalatedModel: ESCALATED });
    const { service } = buildService();

    const resolved = await service.resolveModel(ctx, {
      requestedModel: 'some-other-model',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(resolved.model).toBe('some-other-model');
  });

  it('never overrides the vision-model choice for a turn carrying images', async () => {
    setRouting({ enabled: true, onDeviceModel: ON_DEVICE, escalatedModel: ESCALATED });
    const { service } = buildService(['llava:13b', ON_DEVICE, ESCALATED]);

    // Small turn: routing would otherwise pin ON_DEVICE. Images opt the turn out
    // of routing entirely, so capability-based resolution wins.
    const resolved = await service.resolveModel(ctx, {
      requestedModel: 'llava:13b',
      messages: [{ role: 'user', content: 'describe', images: ['abc'] as never }],
    });

    expect(resolved.model).toBe('llava:13b');
  });
});

describe('estimateInputTokens', () => {
  it('rounds up so a turn is never reported smaller than it is', () => {
    expect(estimateInputTokens([{ role: 'user', content: 'abcde' }])).toBe(2);
  });

  it('sums every message and tolerates empty content', () => {
    expect(
      estimateInputTokens([
        { role: 'system', content: 'a'.repeat(400) },
        { role: 'user', content: '' },
        { role: 'user', content: 'b'.repeat(400) },
      ]),
    ).toBe(200);
  });
});
