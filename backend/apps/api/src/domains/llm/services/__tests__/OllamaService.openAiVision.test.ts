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
function buildService(
  rows: Array<{ id: string; labels: string[] }> | null,
  props: { contextTokens: number | null; vision: boolean | null } | null = null,
) {
  const driver = {
    listModels: jest.fn(async () => (rows ?? []).map((row) => row.id)),
    ...(rows
      ? { listServedModels: jest.fn(async () => rows.map((row) => ({ ...row, contextTokens: null }))) }
      : {}),
    serverProps: jest.fn(async () => props),
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

  it('does not see when the row carries no `vision` label, or when nothing at all says the model can', async () => {
    await expect(
      buildService([{ id: PROMPT_MODEL, labels: ['chat'] }]).resolveVisionModel(undefined, [PROMPT_MODEL]),
    ).resolves.toEqual({
      model: PROMPT_MODEL,
      supportsVision: false,
    });
    // No labels, no /props, and a name that says nothing about images.
    await expect(buildService(null).resolveVisionModel(undefined, ['Qwen3-8B-GGUF'])).resolves.toEqual({
      model: 'Qwen3-8B-GGUF',
      supportsVision: false,
    });
  });

  it('sees on a bare llama-server whose /props says it loaded a vision projector, and not otherwise', async () => {
    const withProjector = buildService([{ id: PROMPT_MODEL, labels: [] }], {
      contextTokens: 32768,
      vision: true,
    });
    const without = buildService([{ id: PROMPT_MODEL, labels: [] }], { contextTokens: 32768, vision: false });

    await expect(withProjector.resolveVisionModel(undefined, [PROMPT_MODEL])).resolves.toMatchObject({
      supportsVision: true,
    });
    await expect(without.resolveVisionModel(undefined, [PROMPT_MODEL])).resolves.toMatchObject({
      supportsVision: false,
    });
  });

  it('sees a vLLM model whose name says it reads images, with no labels and no /props', async () => {
    const service = buildService([{ id: 'Qwen/Qwen3-VL-8B-Instruct', labels: [] }]);

    await expect(service.resolveVisionModel(undefined, ['Qwen/Qwen3-VL-8B-Instruct'])).resolves.toEqual({
      model: 'Qwen/Qwen3-VL-8B-Instruct',
      supportsVision: true,
    });
    await expect(service.getAvailableModels({} as never)).resolves.toMatchObject([{ vision: true }]);
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
