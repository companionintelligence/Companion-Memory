import { ModelTierRouter } from '@ci/domains/model-routing';

import { OllamaService } from '../OllamaService';

/**
 * `validateModel` — the guard every prompt-issuing method (`chat`, `chatStream`,
 * `generate`, `generateStream`, `getModelCapabilities`) calls before spending a
 * round trip on a model that is not actually loaded. No direct test existed;
 * exercised here through `getModelCapabilities`, its simplest public caller.
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

function buildServiceWithOpenAiDriver(servedModelIds: string[]) {
  const driver = {
    listModels: jest.fn(async () => servedModelIds),
    chat: jest.fn(),
  };
  const llmEndpointService = {
    getOpenAiDriver: () => driver,
    usesOpenAiDriver: () => true,
  };
  const service = new OllamaService(
    llmEndpointService as never,
    { getAgentFacingTools: () => [] } as never,
    makeLogger() as never,
    { isFeatureEnabled: jest.fn(async () => false) } as never,
    new ModelTierRouter(),
  );

  return { service, driver };
}

const ctx = { userId: 'user-1' };

describe('OllamaService.validateModel (via getModelCapabilities) — OpenAI-compat driver', () => {
  it('passes silently when the requested model is in the served list', async () => {
    const { service } = buildServiceWithOpenAiDriver(['served-model', 'other']);

    await expect(service.getModelCapabilities(ctx, 'served-model')).resolves.toEqual(
      expect.arrayContaining(['completion', 'tools']),
    );
  });

  it('rejects a model that is not currently served', async () => {
    const { service } = buildServiceWithOpenAiDriver(['served-model']);

    await expect(service.getModelCapabilities(ctx, 'unknown-model')).rejects.toThrow(
      'Invalid model specified: unknown-model',
    );
  });

  it('rejects even a model that IS a real config default, if it is not currently served', async () => {
    // The whole point of validateModel: a compile-time default is not a
    // guarantee the backend has it loaded right now.
    const { service } = buildServiceWithOpenAiDriver([]);

    await expect(service.getModelCapabilities(ctx, 'gemma3:1b')).rejects.toThrow('Invalid model specified');
  });

  it('re-checks on every call — a model that stops being served starts failing', async () => {
    const { service, driver } = buildServiceWithOpenAiDriver(['flaky-model']);

    await expect(service.getModelCapabilities(ctx, 'flaky-model')).resolves.toBeDefined();

    driver.listModels.mockResolvedValue([]); // the backend unloaded it between calls

    await expect(service.getModelCapabilities(ctx, 'flaky-model')).rejects.toThrow('Invalid model specified');
  });
});
