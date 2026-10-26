import { NotFoundException } from '@nestjs/common';

import { BlueBubblesWebhookController } from '../BlueBubblesWebhookController';

/**
 * The webhook is unauthenticated apart from its path secret, so what it may
 * WRITE is the whole question. `last_webhook_received_at` feeds every account's
 * Services card, so a delivery the appliance is not taking must leave it alone.
 */
const SECRET = 'a'.repeat(64);

function setup(config: { enabled: boolean } | null) {
  const configService = {
    find: jest.fn(async () => (config == null ? null : { id: 'cfg-1', webhookSecret: SECRET, ...config })),
    recordWebhookReceived: jest.fn(async () => undefined),
  };
  const syncService = { ingestWebhookMessage: jest.fn(async () => undefined) };
  const logger = { setContext: jest.fn(), error: jest.fn() };
  const controller = new BlueBubblesWebhookController(configService as never, syncService as never, logger as never);

  return { controller, configService, syncService };
}

describe('BlueBubblesWebhookController', () => {
  it('takes a delivery while BlueBubbles is on: records it and queues the message', async () => {
    const { controller, configService, syncService } = setup({ enabled: true });

    await expect(controller.handle(SECRET, { type: 'new-message', data: { guid: 'm1' } })).resolves.toEqual({
      ok: true,
    });
    expect(configService.recordWebhookReceived).toHaveBeenCalledWith('cfg-1');
    expect(syncService.ingestWebhookMessage).toHaveBeenCalledWith({ guid: 'm1' });
  });

  it('refuses a delivery while BlueBubbles is switched off, like a wrong secret, and records nothing', async () => {
    const { controller, configService, syncService } = setup({ enabled: false });

    await expect(controller.handle(SECRET, { type: 'typing-indicator' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.handle(SECRET, { type: 'new-message', data: { guid: 'm1' } })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(configService.recordWebhookReceived).not.toHaveBeenCalled();
    expect(syncService.ingestWebhookMessage).not.toHaveBeenCalled();
  });

  it('refuses a wrong secret, and a missing config row, without recording', async () => {
    const on = setup({ enabled: true });

    await expect(on.controller.handle('not-the-secret', { type: 'typing-indicator' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(on.configService.recordWebhookReceived).not.toHaveBeenCalled();

    const none = setup(null);

    await expect(none.controller.handle(SECRET, { type: 'typing-indicator' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(none.configService.recordWebhookReceived).not.toHaveBeenCalled();
  });
});
