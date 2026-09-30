import { ModelTierRouter } from '@ci/domains/model-routing';

import { OllamaService, PROMPT_MODEL } from '../OllamaService';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function buildService(served: string[], { pinnedDemoModels = false } = {}) {
  const driver = {
    listModels: jest.fn(async () => served),
    chat: jest.fn(),
  };
  const service = new OllamaService(
    { getOpenAiDriver: () => driver } as never,
    { getAgentFacingTools: () => [] } as never,
    makeLogger() as never,
    { isFeatureEnabled: jest.fn(async () => pinnedDemoModels) } as never,
    new ModelTierRouter(),
  );

  return { service, driver };
}

function buildNativeService(
  served: string[],
  visionIds: readonly string[],
  opts: { chatModel?: string | null } = {},
) {
  const vision = new Set(visionIds);
  const chatModelPreference = { getChatModel: jest.fn(async () => opts.chatModel ?? null) };
  const service = new OllamaService(
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

describe('OllamaService.resolveModel uses the loaded backend model', () => {
  it('prefers a requested id when that model is actually served', async () => {
    const { service } = buildService(['Qwen3.8-27B-Uncensored', 'other']);

    const resolved = await service.resolveModel(ctx, { requestedModel: 'Qwen3.8-27B-Uncensored' });

    expect(resolved.model).toBe('Qwen3.8-27B-Uncensored');
  });

  it('falls back to the live vLLM/Ollama model when the config default is not loaded', async () => {
    const { service } = buildService(['Qwen3.8-27B-Uncensored']);

    const resolved = await service.resolveModel(ctx, { requestedModel: 'gemma3:1b' });

    expect(resolved.model).toBe('Qwen3.8-27B-Uncensored');
  });

  it('uses the first served chat model when nothing was requested', async () => {
    const { service } = buildService(['Qwen3.8-27B-Uncensored']);

    const resolved = await service.resolveModel(ctx);

    expect(resolved.model).toBe('Qwen3.8-27B-Uncensored');
  });

  it('errors when the backend is serving no chat models', async () => {
    const { service } = buildService([]);

    await expect(service.resolveModel(ctx)).rejects.toThrow(/No chat model is currently served/);
  });

  it('falls back past an unloaded vision default like llava:7b on vLLM', async () => {
    const { service } = buildService(['Qwen3-8B']);

    const resolved = await service.resolveModel(ctx, {
      requestedModel: 'llava:7b',
      messages: [{ role: 'user', content: 'describe', images: ['abc'] as never }],
    });

    expect(resolved.model).toBe('Qwen3-8B');
  });

  /**
   * `resolveServedChatModel` used to scan every INSTALLED model (not just
   * loaded ones) for the first reporting `vision`, and silently reroute an
   * image turn onto it — regardless of what the user was actually talking
   * to. A shared appliance with two models pulled could load-swap the GPU on
   * every other request depending only on whether the last turn carried an
   * image. That is gone: a vision turn runs on the SAME model resolution
   * gives a text turn (the user's effective chat model, or PROMPT_MODEL with
   * no override — see OllamaService.visionModelRule.test.ts for the one
   * exception, an explicitly configured vision-capable utility model).
   */
  it('sends an image turn to the effective chat model, never to some other installed vision model', async () => {
    const service = buildNativeService(['Qwen3-8B', 'llava:13b'], ['llava:13b'], { chatModel: 'Qwen3-8B' });

    const resolved = await service.resolveModel(ctx, {
      requestedModel: 'llava:7b',
      messages: [{ role: 'user', content: 'describe', images: ['abc'] as never }],
    });

    expect(resolved.model).toBe('Qwen3-8B');
  });

  it('sends an image turn to the user’s chosen chat model even when it is not vision-capable', async () => {
    const service = buildNativeService(['Qwen3-8B', 'llava:13b'], ['llava:13b'], { chatModel: 'Qwen3-8B' });

    const resolved = await service.resolveModel(ctx, {
      messages: [{ role: 'user', content: 'describe', images: ['abc'] as never }],
    });

    // Qwen3-8B cannot see; the caller's own isNonMultimodalModelError handling
    // is what turns the resulting 400 into "skip the description", not a
    // resolver-level reroute onto llava.
    expect(resolved.model).toBe('Qwen3-8B');
  });

  /**
   * The one case that still lets a caller name a DIFFERENT vision model than
   * the user's chat model: the Capture modal's own model picker, a person
   * choosing which model analyses this one photo, right now. Automatic
   * background vision work (image descriptions, thing vision) essentially
   * never sets `requestedModel`, so it always falls through to the rule
   * above — this override exists for the interactive path alone.
   */
  it('honours an explicit, actually vision-capable requestedModel over the effective chat model', async () => {
    const service = buildNativeService(['Qwen3-8B', 'llava:13b'], ['llava:13b'], { chatModel: 'Qwen3-8B' });

    const resolved = await service.resolveModel(ctx, {
      requestedModel: 'llava:13b',
      messages: [{ role: 'user', content: 'describe', images: ['abc'] as never }],
    });

    expect(resolved.model).toBe('llava:13b');
  });

  it('ignores an explicit requestedModel for a vision turn when that model cannot actually see', async () => {
    const service = buildNativeService(['Qwen3-8B', 'llava:13b'], ['llava:13b'], { chatModel: 'llava:13b' });

    const resolved = await service.resolveModel(ctx, {
      requestedModel: 'Qwen3-8B',
      messages: [{ role: 'user', content: 'describe', images: ['abc'] as never }],
    });

    expect(resolved.model).toBe('llava:13b');
  });
});

/**
 * Baseline pin for the `pinned.demo.models` branch of `resolveModel`. These
 * assertions describe the behaviour that existed BEFORE tier routing was added
 * and must survive it unchanged — the demo pin is a hard override that outranks
 * every other selection input.
 */
describe('OllamaService ignores a stored chat model the backend no longer serves', () => {
  // A Settings → Model preference outlives the tag it names (the tag gets
  // removed or renamed under it). Measured 2026-09-16: a stale `qwen3.6:27b`
  // skipped the appliance default, landed chat on whichever model `ollama
  // list` returned first, and — because the vision default probes the stored
  // model's capabilities — read as "cannot see" and drained every queued image
  // description as "disabled".
  const TEXT = [{ role: 'user' as const, content: 'hello' }];
  const IMAGE = [{ role: 'user' as const, content: 'describe', images: ['abc'] as never }];

  it('falls back to the appliance default for a text turn, not to the first served model', async () => {
    const service = buildNativeService(['first-listed:7b', PROMPT_MODEL], [], { chatModel: 'removed:27b' });

    const resolved = await service.resolveModel(ctx, { messages: TEXT });

    expect(resolved.model).toBe(PROMPT_MODEL);
  });

  it('keeps the first-served fallback only when neither the override nor the default is served', async () => {
    const service = buildNativeService(['first-listed:7b', 'second:7b'], [], { chatModel: 'removed:27b' });

    const resolved = await service.resolveModel(ctx, { messages: TEXT });

    expect(resolved.model).toBe('first-listed:7b');
  });

  it('evaluates the vision default against the appliance default instead of the missing model', async () => {
    const service = buildNativeService(['first-listed:7b', PROMPT_MODEL], [PROMPT_MODEL], {
      chatModel: 'removed:27b',
    });

    await expect(service.resolveVisionModel('user-1')).resolves.toEqual({
      model: PROMPT_MODEL,
      supportsVision: true,
    });
    // …and an image turn goes to the same model the default was evaluated for.
    const resolved = await service.resolveModel(ctx, { messages: IMAGE });
    expect(resolved.model).toBe(PROMPT_MODEL);
  });

  it('still honours the override while it is served', async () => {
    const service = buildNativeService([PROMPT_MODEL, 'chosen:9b'], ['chosen:9b'], {
      chatModel: 'chosen:9b',
    });

    await expect(service.resolveVisionModel('user-1')).resolves.toEqual({
      model: 'chosen:9b',
      supportsVision: true,
    });
    expect((await service.resolveModel(ctx, { messages: TEXT })).model).toBe('chosen:9b');
  });
});

describe('OllamaService.resolveModel honours the pinned demo models', () => {
  it('pins the demo vision model (tools + thinking off) when the turn carries images', async () => {
    const { service } = buildService(['gemma3:27b', 'qwen3:14b'], { pinnedDemoModels: true });

    const resolved = await service.resolveModel(ctx, {
      requestedModel: 'Qwen3-8B',
      enableThinking: true,
      enableTools: true,
      messages: [{ role: 'user', content: 'describe', images: ['abc'] as never }],
    });

    expect(resolved).toStrictEqual({
      model: 'gemma3:27b',
      enableThinking: false,
      enableTools: false,
    });
  });

  it('pins the demo text model (tools + thinking on) for a text-only turn', async () => {
    const { service } = buildService(['gemma3:27b', 'qwen3:14b'], { pinnedDemoModels: true });

    const resolved = await service.resolveModel(ctx, {
      requestedModel: 'Qwen3-8B',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(resolved).toStrictEqual({
      model: 'qwen3:14b',
      enableThinking: true,
      enableTools: true,
    });
  });
});
