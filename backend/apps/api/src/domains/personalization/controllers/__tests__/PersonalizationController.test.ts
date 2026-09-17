import { BadRequestException } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';
import { ValidationPipe } from '@ci/common/pipes';

import type { PersonalizationService } from '../../services/PersonalizationService';
import { TRUST_MODES, type TrustMode } from '../../types';
import {
  PersonalizationController,
  chatModelSchema,
  enabledSchema,
  nullableEnabledSchema,
  trustModeSchema,
} from '../PersonalizationController';

/**
 * These bodies used to arrive as bare `@Body()` params whose TypeScript type is
 * erased at runtime, so `POST /personalization/trust-mode` would persist any
 * string as the trust mode — the setting that gates unattended LLM action.
 */
const ctx = { userId: 'user-1' } as RequestContext;

function makeController() {
  const updateTrustMode = jest.fn(async () => ({ trustMode: 'balanced' }));
  const setImageDescription = jest.fn(async (_c: unknown, enabled: boolean | null) => enabled);
  const setBrowserActivityInsight = jest.fn(async (_c: unknown, enabled: boolean) => enabled);
  const getChatModel = jest.fn(async () => 'gemma4:e4b' as string | null);
  const setChatModel = jest.fn(async (_c: unknown, model: string | null) => model);
  const getToolsEnabled = jest.fn(async () => true);
  const setToolsEnabled = jest.fn(async (_c: unknown, enabled: boolean) => enabled);
  const getThinkingEnabled = jest.fn(async () => true);
  const setThinkingEnabled = jest.fn(async (_c: unknown, enabled: boolean) => enabled);

  const controller = new PersonalizationController(
    { updateTrustMode } as unknown as PersonalizationService,
    { setEnabled: setImageDescription } as never,
    { setEnabled: setBrowserActivityInsight } as never,
    {
      getChatModel,
      setChatModel,
      getToolsEnabled,
      setToolsEnabled,
      getThinkingEnabled,
      setThinkingEnabled,
    } as never,
  );

  return {
    controller,
    updateTrustMode,
    setImageDescription,
    setBrowserActivityInsight,
    getChatModel,
    setChatModel,
    getToolsEnabled,
    setToolsEnabled,
    getThinkingEnabled,
    setThinkingEnabled,
  };
}

describe('PersonalizationController body validation', () => {
  const trustPipe = new ValidationPipe(trustModeSchema);
  const enabledPipe = new ValidationPipe(enabledSchema);
  const nullableEnabledPipe = new ValidationPipe(nullableEnabledSchema);
  const chatModelPipe = new ValidationPipe(chatModelSchema);

  it.each([...TRUST_MODES])('accepts the declared trust mode %s', (trustMode) => {
    expect(trustPipe.transform({ trustMode })).toEqual({ trustMode });
  });

  it.each([
    ['an unknown string', { trustMode: 'yolo' }],
    ['a missing field', {}],
    ['a non-string', { trustMode: 1 }],
    ['a non-object body', 'hands_off'],
  ])('rejects %s with 400', (_label, body) => {
    expect(() => trustPipe.transform(body)).toThrow(BadRequestException);
  });

  it('rejects a non-boolean enabled flag with 400, instead of silently coercing it to false', () => {
    expect(() => enabledPipe.transform({ enabled: 'true' })).toThrow(BadRequestException);
    expect(() => enabledPipe.transform({})).toThrow(BadRequestException);
    expect(enabledPipe.transform({ enabled: true })).toEqual({ enabled: true });
  });

  it('accepts null on the nullable image-description schema, unlike the plain one', () => {
    expect(nullableEnabledPipe.transform({ enabled: null })).toEqual({ enabled: null });
    expect(nullableEnabledPipe.transform({ enabled: true })).toEqual({ enabled: true });
    expect(() => enabledPipe.transform({ enabled: null })).toThrow(BadRequestException);
  });

  it('accepts a chat model id or null, and rejects an empty/blank string', () => {
    expect(chatModelPipe.transform({ chatModel: 'qwen3.6:27b' })).toEqual({ chatModel: 'qwen3.6:27b' });
    expect(chatModelPipe.transform({ chatModel: null })).toEqual({ chatModel: null });
    expect(() => chatModelPipe.transform({ chatModel: '' })).toThrow(BadRequestException);
    expect(() => chatModelPipe.transform({ chatModel: '   ' })).toThrow(BadRequestException);
    expect(() => chatModelPipe.transform({})).toThrow(BadRequestException);
  });

  it('still persists a valid trust mode', async () => {
    const { controller, updateTrustMode } = makeController();

    const body = trustPipe.transform({ trustMode: 'hands_off' }) as { trustMode: TrustMode };

    await controller.updateTrustMode(ctx, body);

    expect(updateTrustMode).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), 'hands_off');
  });

  it('still toggles the preference flags', async () => {
    const { controller, setImageDescription, setBrowserActivityInsight } = makeController();

    await expect(controller.updateImageDescription(ctx, { enabled: true })).resolves.toEqual({
      enabled: true,
    });
    await expect(controller.updateBrowserActivityInsight(ctx, { enabled: false })).resolves.toEqual({
      enabled: false,
    });

    expect(setImageDescription).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), true);
    expect(setBrowserActivityInsight).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      false,
    );
  });

  it('clears the image-description override with enabled: null', async () => {
    const { controller, setImageDescription } = makeController();

    await controller.updateImageDescription(ctx, { enabled: null });

    expect(setImageDescription).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), null);
  });

  it('reads and writes the chat model preference', async () => {
    const { controller, setChatModel } = makeController();

    await expect(controller.getChatModel(ctx)).resolves.toEqual({ chatModel: 'gemma4:e4b' });

    await expect(controller.updateChatModel(ctx, { chatModel: 'qwen3.6:27b' })).resolves.toEqual({
      chatModel: 'qwen3.6:27b',
    });
    expect(setChatModel).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), 'qwen3.6:27b');

    await controller.updateChatModel(ctx, { chatModel: null });
    expect(setChatModel).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), null);
  });

  it('reads and writes the tools and thinking preferences independently', async () => {
    const { controller, setToolsEnabled, setThinkingEnabled } = makeController();

    await expect(controller.getTools(ctx)).resolves.toEqual({ enabled: true });
    await expect(controller.getThinking(ctx)).resolves.toEqual({ enabled: true });

    await controller.updateTools(ctx, { enabled: false });
    expect(setToolsEnabled).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), false);

    await controller.updateThinking(ctx, { enabled: false });
    expect(setThinkingEnabled).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), false);
  });
});
