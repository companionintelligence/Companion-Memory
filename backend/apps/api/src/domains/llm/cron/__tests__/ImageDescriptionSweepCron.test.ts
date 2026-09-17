import { ImageDescriptionBackfillRequestEvent } from '@ci/domains/files';

import { ImageDescriptionSweepCron } from '../ImageDescriptionSweepCron';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeCron(opts: { candidateUserIds: string[]; enabledFor?: Set<string>; sendImpl?: jest.Mock }) {
  const enabledFor = opts.enabledFor ?? new Set(opts.candidateUserIds);
  const fileService = {
    listUserIdsWithUndescribedImages: jest.fn(async () => opts.candidateUserIds),
  };
  const imageDescriptionPreference = {
    isEnabled: jest.fn(async (userId: string) => enabledFor.has(userId)),
  };
  const eventService = { send: opts.sendImpl ?? jest.fn(async () => ['job-id']) };
  const logger = makeLogger();

  const cron = new ImageDescriptionSweepCron(
    fileService as never,
    imageDescriptionPreference as never,
    eventService as never,
    logger as never,
  );

  return { cron, fileService, imageDescriptionPreference, eventService, logger };
}

describe('ImageDescriptionSweepCron.sweep', () => {
  it('does nothing when no user has any undescribed image', async () => {
    const { cron, imageDescriptionPreference, eventService } = makeCron({ candidateUserIds: [] });

    await cron.sweep();

    expect(imageDescriptionPreference.isEnabled).not.toHaveBeenCalled();
    expect(eventService.send).not.toHaveBeenCalled();
  });

  it('requests a backfill for a user whose setting is on, keyed exactly like a Settings toggle would', async () => {
    const { cron, eventService } = makeCron({ candidateUserIds: ['user-1'] });

    await cron.sweep();

    expect(eventService.send).toHaveBeenCalledWith(
      ImageDescriptionBackfillRequestEvent,
      { userId: 'user-1' },
      { singletonKey: 'image-description-backfill:user-1' },
    );
  });

  // The whole point of this cron: the setting can already read "on" with no
  // false→true transition ever having fired `setEnabled`'s own backfill —
  // exactly what happened for the first library imported on this appliance.
  it('requests a backfill purely from the setting reading on right now, with no transition involved', async () => {
    const { cron, imageDescriptionPreference, eventService } = makeCron({ candidateUserIds: ['user-1'] });

    await cron.sweep();

    expect(imageDescriptionPreference.isEnabled).toHaveBeenCalledWith('user-1');
    expect(eventService.send).toHaveBeenCalledTimes(1);
  });

  it('skips a user whose setting resolves off, without requesting anything for them', async () => {
    const { cron, eventService } = makeCron({
      candidateUserIds: ['user-1', 'user-2'],
      enabledFor: new Set(['user-2']),
    });

    await cron.sweep();

    expect(eventService.send).toHaveBeenCalledTimes(1);
    expect(eventService.send).toHaveBeenCalledWith(
      ImageDescriptionBackfillRequestEvent,
      { userId: 'user-2' },
      expect.anything(),
    );
  });

  it('keeps sweeping the rest when one user errors', async () => {
    const send = jest.fn(async (_event: unknown, payload: { userId: string }) => {
      if (payload.userId === 'user-1') {
        throw new Error('boom');
      }

      return ['job-id'];
    });
    const { cron, eventService } = makeCron({ candidateUserIds: ['user-1', 'user-2'], sendImpl: send });

    await expect(cron.sweep()).resolves.toBeUndefined();

    expect(eventService.send).toHaveBeenCalledTimes(2);
  });
});
