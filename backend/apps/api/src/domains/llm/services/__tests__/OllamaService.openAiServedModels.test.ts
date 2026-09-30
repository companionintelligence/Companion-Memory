import { ModelTierRouter } from '@ci/domains/model-routing';

import { OllamaService } from '../OllamaService';
import type { ServedModel } from '../servedModels';

/*
 * An OpenAI-compatible endpoint lists every model it serves on `/v1/models`, and Lemonade serves
 * more than chat models: its embedder, rerankers, Whisper and TTS sit in the same list. Chat used
 * to fall through to the first listed id when the configured model was not served, which could be
 * any of those. The same rows also say what window the backend loaded a model with; the chat budget
 * used to ignore that and fall back to the static tier profile.
 */
const LEMONADE_ROWS: ServedModel[] = [
  { id: 'nomic-embed-text-v1.5-GGUF', labels: ['custom', 'embeddings'], contextTokens: 2048 },
  { id: 'bge-reranker-v2-m3-GGUF', labels: ['reranking'], contextTokens: null },
  { id: 'Whisper-Large-v3-Turbo', labels: ['transcription'], contextTokens: null },
  { id: 'Qwen3.8-27B-GGUF', labels: ['chat', 'vision'], contextTokens: 32768 },
];

function buildService(rows: ServedModel[]) {
  const driver = {
    listModels: jest.fn(async () => rows.map((row) => row.id)),
    listServedModels: jest.fn(async () => rows),
    chat: jest.fn(async () => ({ message: { role: 'assistant', content: '{}' }, done: true })),
  };
  const service = new OllamaService(
    { getOpenAiDriver: () => driver, usesOpenAiDriver: () => true } as never,
    { getAgentFacingTools: () => [] } as never,
    { setContext: jest.fn(), debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    { isFeatureEnabled: jest.fn(async () => false) } as never,
    new ModelTierRouter(),
  );

  return { service, driver };
}

describe('OllamaService on an OpenAI-compatible endpoint: served models', () => {
  it('lists only chat models', async () => {
    const { service } = buildService(LEMONADE_ROWS);

    const models = await service.getAvailableModels({} as never);

    expect(models.map((model) => model.model)).toEqual(['Qwen3.8-27B-GGUF']);
  });

  it('falls back to a chat model, not the first row, when the requested one is not served', async () => {
    const { service } = buildService(LEMONADE_ROWS);

    const { model } = await service.resolveModel({} as never, { requestedModel: 'gemma4:e4b' });

    expect(model).toBe('Qwen3.8-27B-GGUF');
  });

  it('refuses when nothing served can chat', async () => {
    const { service } = buildService(LEMONADE_ROWS.filter((row) => !row.labels.includes('chat')));

    await expect(service.resolveModel({} as never, { requestedModel: 'gemma4:e4b' })).rejects.toThrow(
      'No chat model is currently served by the inference backend',
    );
  });

  it("takes the chat window from the model's row", async () => {
    const { service } = buildService(LEMONADE_ROWS);

    await expect(service.resolveChatContextTokens('Qwen3.8-27B-GGUF')).resolves.toBe(32768);
    // A backend that reports no window, or a model it does not list, leaves the static fallback.
    await expect(service.resolveChatContextTokens('bge-reranker-v2-m3-GGUF')).resolves.toBeNull();
    await expect(service.resolveChatContextTokens('not-served')).resolves.toBeNull();
  });

  it('answers null rather than throwing when the list cannot be read', async () => {
    const { service, driver } = buildService(LEMONADE_ROWS);
    driver.listServedModels.mockRejectedValueOnce(new Error('fetch failed'));

    await expect(service.resolveChatContextTokens('Qwen3.8-27B-GGUF')).resolves.toBeNull();
  });

  it('hands a JSON Schema format to the driver whole, not collapsed to plain JSON', async () => {
    const { service, driver } = buildService(LEMONADE_ROWS);
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

    await service.chat({} as never, [{ role: 'user', content: 'hi' }], {
      model: 'Qwen3.8-27B-GGUF',
      format: schema,
    });

    expect(driver.chat).toHaveBeenCalledWith(expect.objectContaining({ format: schema }));
  });
});
