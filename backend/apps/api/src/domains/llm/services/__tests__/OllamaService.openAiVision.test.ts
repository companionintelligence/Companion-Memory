import { ModelTierRouter } from '@ci/domains/model-routing';

import { OllamaService, PROMPT_MODEL } from '../OllamaService';

/*
 * On an OpenAI-compatible endpoint there is no `/api/show` to ask whether a model can see, so vision
 * used to be hard-coded off there — which switched image descriptions off by default for every
 * Lemonade-backed install, although Lemonade's Qwen 3.8 27B reads images. The one signal the
 * endpoint gives is a `vision` label on the model's `/v1/models` row: Lemonade publishes one and
 * CI-Hub's pool passes the row through. A backend without labels (vLLM, Ollama's `/v1`) keeps the
 * old answer.
 */
function buildService(rows: Array<{ id: string; labels: string[] }> | null) {
  const driver = {
    listModels: jest.fn(async () => (rows ?? []).map((row) => row.id)),
    ...(rows
      ? { listServedModels: jest.fn(async () => rows.map((row) => ({ ...row, contextTokens: null }))) }
      : {}),
    chat: jest.fn(),
  };

  return new OllamaService(
    { getOpenAiDriver: () => driver, usesOpenAiDriver: () => true } as never,
    { getAgentFacingTools: () => [] } as never,
    { setContext: jest.fn(), debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    { isFeatureEnabled: jest.fn(async () => false) } as never,
    new ModelTierRouter(),
  );
}

describe('OllamaService on an OpenAI-compatible endpoint: vision from /v1/models labels', () => {
  it('sees when the chat model is labelled `vision`', async () => {
    const service = buildService([
      { id: PROMPT_MODEL, labels: ['chat', 'reasoning', 'vision', 'tool-calling'] },
    ]);

    await expect(service.resolveVisionModel(undefined, [PROMPT_MODEL])).resolves.toEqual({
      model: PROMPT_MODEL,
      supportsVision: true,
    });
  });

  it('does not see when the row carries no `vision` label, or no labels at all', async () => {
    await expect(
      buildService([{ id: PROMPT_MODEL, labels: ['chat'] }]).resolveVisionModel(undefined, [PROMPT_MODEL]),
    ).resolves.toEqual({
      model: PROMPT_MODEL,
      supportsVision: false,
    });
    await expect(buildService(null).resolveVisionModel(undefined, [PROMPT_MODEL])).resolves.toEqual({
      model: PROMPT_MODEL,
      supportsVision: false,
    });
  });

  it('marks labelled models as vision-capable in the model list', async () => {
    const service = buildService([
      { id: 'Qwen3.8-27B-GGUF', labels: ['chat', 'vision'] },
      { id: 'Qwen3-8B-GGUF', labels: ['chat'] },
    ]);

    const models = await service.getAvailableModels({} as never);

    expect(models.map((model) => [model.name, model.vision, model.capabilities?.includes('vision')])).toEqual(
      [
        ['Qwen3.8-27B-GGUF', true, true],
        ['Qwen3-8B-GGUF', false, false],
      ],
    );
  });
});
