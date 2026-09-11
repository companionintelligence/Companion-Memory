/**
 * `UTILITY_MODEL` / `UTILITY_MODEL_EXPLICITLY_CONFIGURED` are read once, at
 * module load, from `@ci/configuration` (same pattern as `PROMPT_MODEL`
 * elsewhere in this file). Exercising both states of "was LLM_UTILITY_MODEL
 * actually set" therefore needs a fresh module registry per test:
 * `jest.resetModules()` + a fresh `jest.doMock('@ci/configuration', ...)` +
 * a dynamic `require('../OllamaService')`, so each test's `OllamaService`
 * class captured the constant its own mock set. `jest.requireActual` supplies
 * everything else unmocked, so a config field this test doesn't care about
 * (which `ModelTierRouter` or `LlmEndpointService` might read) stays real.
 *
 * In its own file, not appended to OllamaService.resolveModel.test.ts,
 * because module mocking is file-scoped via hoisting — sharing a file would
 * force every other test in it through the same dance for no reason.
 */
import { ModelTierRouter } from '@ci/domains/model-routing';

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function withUtilityModel(explicitlyConfigured: boolean, utilityModel: string) {
  jest.resetModules();
  jest.doMock('@ci/configuration', () => {
    const actual = jest.requireActual('@ci/configuration');

    return {
      __esModule: true,
      ...actual,
      UTILITY_MODEL_EXPLICITLY_CONFIGURED: explicitlyConfigured,
      default: { ...actual.default, llm: { ...actual.default.llm, utilityModel } },
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-require-imports -- must load AFTER the mock above
  const { OllamaService: FreshOllamaService } = require('../OllamaService');

  return FreshOllamaService;
}

function buildService(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically `require`'d class; genuinely untyped
  FreshOllamaService: new (...args: any[]) => InstanceType<typeof import('../OllamaService').OllamaService>,
  served: string[],
  visionIds: readonly string[],
  chatModel: string | null,
) {
  const vision = new Set(visionIds);
  const chatModelPreference = { getChatModel: jest.fn(async () => chatModel) };
  const service = new FreshOllamaService(
    { getOpenAiDriver: () => null, usesOpenAiDriver: () => false } as never,
    { getAgentFacingTools: () => [] } as never,
    makeLogger() as never,
    { isFeatureEnabled: jest.fn(async () => false) } as never,
    new ModelTierRouter(),
    chatModelPreference as never,
  );

  const spies = service as unknown as {
    listServedChatModelIds: () => Promise<string[]>;
    fetchModelCapabilities: (id: string, opts?: { throwOnError?: boolean }) => Promise<string[]>;
  };

  jest.spyOn(spies, 'listServedChatModelIds').mockResolvedValue(served);
  jest
    .spyOn(spies, 'fetchModelCapabilities')
    .mockImplementation(async (id: string) => (vision.has(id) ? ['vision'] : ['completion', 'tools']));

  return service;
}

const ctx = { userId: 'user-1' };
const IMAGE_MESSAGES = [{ role: 'user' as const, content: 'describe', images: ['abc'] as never }];

afterEach(() => {
  jest.dontMock('@ci/configuration');
  jest.resetModules();
});

describe('OllamaService vision model rule: the utility model exception', () => {
  it('uses the explicitly configured utility model for a vision turn when it reports vision', async () => {
    const FreshOllamaService = withUtilityModel(true, 'moondream:1.8b');
    const service = buildService(
      FreshOllamaService,
      ['Qwen3-8B', 'moondream:1.8b'],
      ['moondream:1.8b'],
      'Qwen3-8B',
    );

    const resolved = await service.resolveModel(ctx, { messages: IMAGE_MESSAGES });

    expect(resolved.model).toBe('moondream:1.8b');
  });

  it('falls through to the effective chat model when the utility model is configured but not served', async () => {
    const FreshOllamaService = withUtilityModel(true, 'moondream:1.8b');
    // Utility model configured, but not currently loaded/installed.
    const service = buildService(FreshOllamaService, ['Qwen3-8B'], [], 'Qwen3-8B');

    const resolved = await service.resolveModel(ctx, { messages: IMAGE_MESSAGES });

    expect(resolved.model).toBe('Qwen3-8B');
  });

  it('falls through to the effective chat model when the configured utility model cannot see', async () => {
    const FreshOllamaService = withUtilityModel(true, 'gemma3:1b');
    // Served, but reports no vision capability.
    const service = buildService(FreshOllamaService, ['Qwen3-8B', 'gemma3:1b'], [], 'Qwen3-8B');

    const resolved = await service.resolveModel(ctx, { messages: IMAGE_MESSAGES });

    expect(resolved.model).toBe('Qwen3-8B');
  });

  it('never reaches for the utility model when it was not explicitly configured, even if it would report vision', async () => {
    const FreshOllamaService = withUtilityModel(false, 'moondream:1.8b');
    const service = buildService(
      FreshOllamaService,
      ['Qwen3-8B', 'moondream:1.8b'],
      ['moondream:1.8b'],
      'Qwen3-8B',
    );

    const resolved = await service.resolveModel(ctx, { messages: IMAGE_MESSAGES });

    // This is the whole point of the flag: a moondream/llava image-captioner
    // sitting on disk from some other feature must never get silently
    // reused for vision work an operator did not point at it.
    expect(resolved.model).toBe('Qwen3-8B');
  });
});
