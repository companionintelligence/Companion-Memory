import { ImageDescriptionPreferenceService } from '../ImageDescriptionPreferenceService';

/**
 * "Describe images" is a per-model setting, but `isEnabled` cached its answer
 * per user for 60 s. After a chat-model switch Settings > Model and the
 * background describer kept the old model's value for that long (63 s
 * measured going from a text model to gemma4:e2b), and flipping the stale
 * switch stored the opposite of what was meant for the new model.
 */
const USER_ID = 'user-1';
const SELF_ID = 'self-entity-1';
const VISION = new Set(['gemma4:e2b']);

function harness(opts: { withChatModelPreference?: boolean } = {}) {
  const state = { chatModel: 'llama3.2:latest' as string | null, overrides: {} as Record<string, unknown> };
  const personService = {
    findById: jest.fn(async () => ({
      id: SELF_ID,
      properties: { planner: { image_description_overrides: state.overrides } },
    })),
  };
  const userContextService = { getSelfIdentity: jest.fn(async () => ({ entityId: SELF_ID })) };
  const ollamaService = {
    resolveVisionModel: jest.fn(async () => {
      const model = state.chatModel ?? 'qwen3.5:9b';

      return { model, supportsVision: VISION.has(model) };
    }),
  };
  const chatModelPreference = { getChatModel: jest.fn(async () => state.chatModel) };

  const service = new ImageDescriptionPreferenceService(
    personService as never,
    userContextService as never,
    {} as never,
    ollamaService as never,
    undefined,
    opts.withChatModelPreference === false ? undefined : (chatModelPreference as never),
  );

  return { service, state, ollamaService };
}

describe('ImageDescriptionPreferenceService after a chat-model switch', () => {
  it('answers for the new model on the next read, not a minute later', async () => {
    const { service, state } = harness();

    await expect(service.isEnabled(USER_ID)).resolves.toBe(false);

    state.chatModel = 'gemma4:e2b';
    await expect(service.isEnabled(USER_ID)).resolves.toBe(true);

    state.chatModel = 'llama3.2:latest';
    await expect(service.isEnabled(USER_ID)).resolves.toBe(false);
  });

  it("uses the new model's own override, not the old model's value", async () => {
    const { service, state } = harness();
    state.overrides = { 'gemma4:e2b': false };
    state.chatModel = 'gemma4:e2b';

    await expect(service.isEnabled(USER_ID)).resolves.toBe(false);

    state.chatModel = 'llama3.2:latest';
    state.overrides = { 'gemma4:e2b': false, 'llama3.2:latest': true };
    await expect(service.isEnabled(USER_ID)).resolves.toBe(true);
  });

  it('still serves repeat reads on the same model from the cache', async () => {
    const { service, ollamaService } = harness();

    await service.isEnabled(USER_ID);
    await service.isEnabled(USER_ID);
    await service.isEnabled(USER_ID);

    expect(ollamaService.resolveVisionModel).toHaveBeenCalledTimes(1);
  });

  it('keeps the plain 60 s cache when built without the chat-model preference', async () => {
    const { service, state, ollamaService } = harness({ withChatModelPreference: false });

    await expect(service.isEnabled(USER_ID)).resolves.toBe(false);
    state.chatModel = 'gemma4:e2b';

    await expect(service.isEnabled(USER_ID)).resolves.toBe(false);
    expect(ollamaService.resolveVisionModel).toHaveBeenCalledTimes(1);
  });
});
