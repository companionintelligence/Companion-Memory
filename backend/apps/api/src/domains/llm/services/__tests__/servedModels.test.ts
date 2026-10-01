import {
  isChatCapableModel,
  servedModelFromRow,
  servedModelSeesImages,
  serverPropsFromPayload,
} from '../servedModels';

describe('servedModelFromRow', () => {
  it("reads Lemonade's labels and loaded window", () => {
    expect(
      servedModelFromRow({
        id: 'Qwen3.8-27B-GGUF',
        object: 'model',
        labels: ['chat', 'vision', 'tool-calling'],
        context_length: 32768,
        max_context_window: 262144,
        recipe: 'llamacpp',
      }),
    ).toEqual({ id: 'Qwen3.8-27B-GGUF', labels: ['chat', 'vision', 'tool-calling'], contextTokens: 32768 });
  });

  it("reads vLLM's max_model_len", () => {
    expect(servedModelFromRow({ id: 'Qwen/Qwen3-8B', owned_by: 'vllm', max_model_len: 40960 })).toEqual({
      id: 'Qwen/Qwen3-8B',
      labels: [],
      contextTokens: 40960,
    });
  });

  it('reports nothing for a plain OpenAI row, or for malformed fields', () => {
    expect(servedModelFromRow({ id: 'qwen3:14b', owned_by: 'library' })).toEqual({
      id: 'qwen3:14b',
      labels: [],
      contextTokens: null,
    });
    expect(
      servedModelFromRow({ id: 'x', labels: 'chat', context_length: '32768', max_model_len: -1 }),
    ).toEqual({ id: 'x', labels: [], contextTokens: null });
  });
});

describe('isChatCapableModel', () => {
  it.each([
    [{ id: 'Qwen3.8-27B-GGUF', labels: ['chat', 'vision'] }],
    // Speech-in chat models carry `chat` beside their transcription tag.
    [{ id: 'Qwen2.5-Omni-7B-GGUF', labels: ['chat', 'vision', 'chat-transcription'] }],
    // A chat model registered by hand in Lemonade carries only `custom`.
    [{ id: 'user.My-Model-GGUF', labels: ['custom'] }],
    // Unlabelled backends fall back to the name.
    [{ id: 'qwen3.8:27b-mtp-q4_K_M', labels: [] }],
    [{ id: 'Qwen/Qwen3-8B' }],
    [{ id: 'gemma4:e4b' }],
  ])('keeps %j', (model) => {
    expect(isChatCapableModel(model)).toBe(true);
  });

  it.each([
    [{ id: 'nomic-embed-text-v1.5-GGUF', labels: ['custom', 'embeddings'] }],
    [{ id: 'bge-reranker-v2-m3-GGUF', labels: ['reranking'] }],
    [{ id: 'Whisper-Large-v3-Turbo', labels: ['transcription', 'realtime-transcription'] }],
    [{ id: 'kokoro-v1', labels: ['tts'] }],
    [{ id: 'SD-Turbo', labels: ['image'] }],
    [{ id: 'mxbai-embed-large:latest' }],
    [{ id: 'BAAI/bge-m3' }],
    [{ id: 'openai/whisper-large-v3' }],
    [{ id: 'Alibaba-NLP/gte-reranker-modernbert-base' }],
  ])('drops %j', (model) => {
    expect(isChatCapableModel(model)).toBe(false);
  });

  it('drops the configured embedder whatever it is called, with or without `:latest`', () => {
    expect(isChatCapableModel({ id: 'my-vectors' }, 'my-vectors')).toBe(false);
    expect(isChatCapableModel({ id: 'my-vectors:latest' }, 'my-vectors')).toBe(false);
    expect(isChatCapableModel({ id: 'my-vectors' }, 'my-vectors:latest')).toBe(false);
    expect(isChatCapableModel({ id: 'gemma4:e4b' }, 'my-vectors')).toBe(true);
  });
});

describe('serverPropsFromPayload', () => {
  it("reads a llama-server's loaded window and modalities", () => {
    expect(
      serverPropsFromPayload({
        default_generation_settings: { n_ctx: 32768, seed: -1 },
        modalities: { vision: true, audio: false },
        total_slots: 1,
      }),
    ).toEqual({ contextTokens: 32768, vision: true });
    expect(serverPropsFromPayload({ modalities: { vision: false } })).toEqual({
      contextTokens: null,
      vision: false,
    });
  });

  it('answers null for anything that is not that route: HTML, another JSON, nothing', () => {
    expect(serverPropsFromPayload('<!doctype html>')).toBeNull();
    expect(serverPropsFromPayload({ data: [] })).toBeNull();
    expect(serverPropsFromPayload(null)).toBeNull();
  });
});

describe('servedModelSeesImages', () => {
  it('trusts labels when the backend publishes them, with or without vision', () => {
    expect(servedModelSeesImages({ id: 'Qwen3.8-27B-GGUF', labels: ['chat', 'vision'] })).toBe(true);
    expect(
      servedModelSeesImages(
        { id: 'Qwen3-VL-8B-GGUF', labels: ['chat'] },
        { contextTokens: null, vision: true },
      ),
    ).toBe(false);
  });

  it("falls back to the server's /props, then to the name, when there are no labels", () => {
    expect(
      servedModelSeesImages({ id: 'qwen3.8-27b', labels: [] }, { contextTokens: 32768, vision: true }),
    ).toBe(true);
    expect(
      servedModelSeesImages(
        { id: 'Qwen/Qwen3-VL-8B-Instruct', labels: [] },
        { contextTokens: 32768, vision: false },
      ),
    ).toBe(false);
    expect(servedModelSeesImages({ id: 'Qwen/Qwen3-VL-8B-Instruct', labels: [] }, null)).toBe(true);
    expect(servedModelSeesImages({ id: 'llava-v1.6-mistral-7b' })).toBe(true);
    expect(servedModelSeesImages({ id: 'google/gemma-3-12b-it' })).toBe(true);
    expect(servedModelSeesImages({ id: 'google/gemma-3-1b-it' })).toBe(false);
    expect(servedModelSeesImages({ id: 'Qwen/Qwen3-8B' })).toBe(false);
    expect(servedModelSeesImages({ id: 'meta-llama/Llama-3.1-8B-Instruct' })).toBe(false);
  });
});
