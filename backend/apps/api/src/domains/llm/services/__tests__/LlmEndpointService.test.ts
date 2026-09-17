import config from '@ci/configuration';

import { LlmEndpointService } from '../LlmEndpointService';

jest.mock('../llmEndpointShared', () => {
  const actual = jest.requireActual('../llmEndpointShared');

  return {
    ...actual,
    readSharedConfig: jest.fn(() => null),
    writeSharedConfig: jest.fn(),
  };
});

jest.mock('@ci/configuration', () => ({
  __esModule: true,
  default: {
    logging: { level: 'error' },
    services: { ollama: { host: 'http://localhost:11434' } },
    llm: { apiBase: undefined, apiKey: 'ollama', chatModel: 'gemma3:1b' },
  },
}));

describe('LlmEndpointService', () => {
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  beforeEach(() => {
    (config as { llm: { apiBase?: string; apiKey: string } }).llm.apiBase = undefined;
    (config as { llm: { apiBase?: string; apiKey: string } }).llm.apiKey = 'ollama';
  });

  it('defaults to Ollama on the inferred host gateway', () => {
    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();

    expect(service.getView()).toEqual({
      backend: 'ollama',
      port: 11434,
      hostGateway: 'localhost',
      locked: false,
      endpoint: 'http://localhost:11434',
      apiKeyConfigured: true,
    });
    expect(service.usesOpenAiDriver()).toBe(false);
  });

  it('switches to an OpenAI-compatible driver when settings are updated', () => {
    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();

    service.update({
      backend: 'openai_compatible',
      port: 8000,
      apiKey: 'vllm-local',
    });

    expect(service.getView()).toMatchObject({
      backend: 'openai_compatible',
      port: 8000,
      locked: false,
      endpoint: 'http://localhost:8000/v1',
      apiKeyConfigured: true,
    });
    expect(service.getView()).not.toHaveProperty('apiKey');
    expect(service.usesOpenAiDriver()).toBe(true);
    expect(service.getOllamaHost()).toBe('http://localhost:11434');
  });

  it('treats a non-Ollama LLM_API_BASE port as locked Hub config', () => {
    (config as { llm: { apiBase?: string } }).llm.apiBase = 'http://host.docker.internal:8000/v1';

    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();

    expect(service.getView()).toMatchObject({
      backend: 'openai_compatible',
      port: 8000,
      locked: true,
    });
    expect(service.usesOpenAiDriver()).toBe(true);
  });

  it('preserves the full Hub gateway path when managed config is injected', async () => {
    (config as { llm: { apiBase?: string; apiKey: string } }).llm.apiBase =
      'https://ci-os-hub:3443/api/inference/v1';
    (config as { llm: { apiBase?: string; apiKey: string } }).llm.apiKey = 'hub-managed-key';
    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'hub-qwen' }] })),
      ) as unknown as typeof fetch;

    expect(service.getView()).toMatchObject({
      endpoint: 'https://ci-os-hub:3443/api/inference/v1',
      locked: true,
    });
    await expect(service.preflight(fetchImpl)).resolves.toMatchObject({
      endpoint: 'https://ci-os-hub:3443/api/inference/v1',
      models: ['hub-qwen'],
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ci-os-hub:3443/api/inference/v1/models',
      expect.objectContaining({ headers: { authorization: 'Bearer hub-managed-key' } }),
    );
  });

  it('sanitizes a deployment endpoint before showing or logging it', () => {
    (config as { llm: { apiBase?: string } }).llm.apiBase =
      'https://operator:deployment-secret@ci-os-hub:3443/api/inference/v1?token=query-secret#fragment';
    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();

    expect(service.getView().endpoint).toBe('https://ci-os-hub:3443/api/inference/v1');
    expect(logger.log).toHaveBeenCalledWith(
      'LLM endpoint resolved',
      expect.objectContaining({ apiBase: 'https://ci-os-hub:3443/api/inference/v1' }),
    );
  });

  it('checks the native Ollama endpoint from the API network namespace', async () => {
    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'nomic-embed-text' }] })),
      ) as unknown as typeof fetch;

    await expect(service.preflight(fetchImpl)).resolves.toEqual({
      backend: 'ollama',
      endpoint: 'http://localhost:11434',
      ok: true,
      models: ['qwen3:8b', 'nomic-embed-text'],
      message: 'Connected. 2 models reported.',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:11434/api/tags',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('does not expose a configured key when an endpoint is read', () => {
    const service = new LlmEndpointService(logger as never);
    service.onModuleInit();

    const view = service.getView() as unknown as Record<string, unknown>;

    expect(view.apiKey).toBeUndefined();
    expect(view.apiKeyConfigured).toBe(true);
  });
});
