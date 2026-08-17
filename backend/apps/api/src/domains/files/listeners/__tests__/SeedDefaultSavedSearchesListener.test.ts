import { SeedDefaultSavedSearchesListener } from '../SeedDefaultSavedSearchesListener';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('SeedDefaultSavedSearchesListener', () => {
  it('seeds defaults for the new user id', async () => {
    const ensureDefaults = jest.fn().mockResolvedValue(true);
    const logger = makeLogger();
    const listener = new SeedDefaultSavedSearchesListener({ ensureDefaults } as never, logger as never);

    await listener.seedForNewUser({ userId: 'user-1' });

    expect(ensureDefaults).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(logger.log).toHaveBeenCalled();
  });

  it('stays quiet when the catalog was already present', async () => {
    const ensureDefaults = jest.fn().mockResolvedValue(false);
    const logger = makeLogger();
    const listener = new SeedDefaultSavedSearchesListener({ ensureDefaults } as never, logger as never);

    await listener.seedForNewUser({ userId: 'user-1' });

    expect(logger.log).not.toHaveBeenCalled();
  });
});
