import { BadRequestException } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';
import { ValidationPipe } from '@ci/common/pipes';

import type { PersonalizationService } from '../../services/PersonalizationService';
import { TRUST_MODES, type TrustMode } from '../../types';
import { PersonalizationController, enabledSchema, trustModeSchema } from '../PersonalizationController';

/**
 * These bodies used to arrive as bare `@Body()` params whose TypeScript type is
 * erased at runtime, so `POST /personalization/trust-mode` would persist any
 * string as the trust mode — the setting that gates unattended LLM action.
 */
const ctx = { userId: 'user-1' } as RequestContext;

function makeController() {
  const updateTrustMode = jest.fn(async () => ({ trustMode: 'balanced' }));
  const setImageDescription = jest.fn(async (_c: unknown, enabled: boolean) => enabled);
  const setBrowserActivityInsight = jest.fn(async (_c: unknown, enabled: boolean) => enabled);

  const controller = new PersonalizationController(
    { updateTrustMode } as unknown as PersonalizationService,
    { setEnabled: setImageDescription } as never,
    { setEnabled: setBrowserActivityInsight } as never,
  );

  return { controller, updateTrustMode, setImageDescription, setBrowserActivityInsight };
}

describe('PersonalizationController body validation', () => {
  const trustPipe = new ValidationPipe(trustModeSchema);
  const enabledPipe = new ValidationPipe(enabledSchema);

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
});
