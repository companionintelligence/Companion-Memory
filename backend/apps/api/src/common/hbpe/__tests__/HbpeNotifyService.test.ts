import { HbpeNotifyService, HBPE_NOTIFY_CHANNELS, utcDay } from '../HbpeNotifyService';

function build() {
  const query = jest.fn(async () => undefined);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn() };
  const service = new HbpeNotifyService({ query } as never, logger as never);

  return { service, query, logger };
}

describe('utcDay', () => {
  it('is the UTC calendar date, not a local-offset day', () => {
    expect(utcDay(new Date('2026-08-30T01:00:00-07:00'))).toBe('2026-08-30');
    expect(utcDay(new Date('2026-08-30T23:00:00+02:00'))).toBe('2026-08-30');
  });
});

describe('HbpeNotifyService', () => {
  it('notifies once per distinct UTC day with the HBPE payload shape', async () => {
    const { service, query, logger } = build();

    await service.notifyCommunications('user-1', [
      new Date('2026-08-30T10:00:00Z'),
      new Date('2026-08-30T22:00:00Z'),
      new Date('2026-08-31T01:00:00Z'),
    ]);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
      HBPE_NOTIFY_CHANNELS.communications,
      JSON.stringify({ user_id: 'user-1', date: '2026-08-30' }),
    ]);
    expect(query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
      HBPE_NOTIFY_CHANNELS.communications,
      JSON.stringify({ user_id: 'user-1', date: '2026-08-31' }),
    ]);
    expect(logger.log).toHaveBeenCalledWith(
      'HBPE cache invalidate notified',
      expect.objectContaining({ channel: 'ci_communications', userId: 'user-1' }),
    );
  });

  it('skips invalid times and an empty user id', async () => {
    const { service, query } = build();

    await service.notifyEvents('', [new Date('2026-08-30T00:00:00Z')]);
    await service.notifyEvents('user-1', [new Date('not-a-date'), null, undefined]);

    expect(query).not.toHaveBeenCalled();
  });

  it('swallows a notify failure so the write path stays up', async () => {
    const { service, query, logger } = build();
    query.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(
      service.notifyBrowserActivity('user-1', new Date('2026-08-30T12:00:00Z')),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'HBPE notify failed',
      expect.objectContaining({ channel: 'ci_browser_activity' }),
    );
  });
});
