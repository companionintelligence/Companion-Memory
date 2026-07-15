import { createHash } from 'crypto';

import { ConnectCodeService } from '../services/ConnectCodeService';

/**
 * Unit tests for ConnectCodeService — the single-use authorization grant that
 * bridges the browser consent step and the Hub's server-to-server key exchange.
 * The code carries NO key material (the key is minted at exchange time); it only
 * authorizes minting for a (user, app) pair. Repository is an in-memory jest mock.
 */
function makeRepo() {
  return {
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest.fn(async (row: Record<string, unknown>) => row),
    findOne: jest.fn(),
    update: jest.fn(async () => ({ affected: 1 })),
    delete: jest.fn(async () => ({ affected: 0 })),
  };
}

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn(), log: jest.fn(), error: jest.fn() };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('ConnectCodeService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('issues a hashed, TTL-bounded code carrying no key material, and returns the raw code once', async () => {
    const repo = makeRepo();
    const service = new ConnectCodeService(repo as never, makeLogger() as never);

    const code = await service.issue('user-1', 'urn:app:x');

    expect(code).toMatch(/^[0-9a-f]{64}$/);
    const row = repo.create.mock.calls[0][0] as {
      hashed_code: string;
      user_id: string;
      app_urn: string;
      used_at: Date | null;
      expires_at: Date;
    };
    expect(row.hashed_code).toBe(sha256(code)); // raw code never stored
    expect(row).not.toHaveProperty('encrypted_key'); // no key material at rest
    expect(row.user_id).toBe('user-1');
    expect(row.app_urn).toBe('urn:app:x');
    expect(row.used_at).toBeNull();
    expect(row.expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('round-trips: consume returns the bound (user, app) for the caller to mint under', async () => {
    const repo = makeRepo();
    const service = new ConnectCodeService(repo as never, makeLogger() as never);

    const code = await service.issue('user-1', 'urn:app:x');
    repo.findOne.mockResolvedValueOnce(repo.save.mock.calls[0][0]);

    const consumed = await service.consume(code);

    expect(repo.findOne).toHaveBeenCalledWith({ where: { hashed_code: sha256(code) } });
    expect(consumed).toEqual({ userId: 'user-1', appUrn: 'urn:app:x' });
  });

  it('opportunistically sweeps expired rows on issue (no dedicated scheduler)', async () => {
    const repo = makeRepo();
    const service = new ConnectCodeService(repo as never, makeLogger() as never);

    await service.issue('user-1', 'urn:app:x');

    expect(repo.delete).toHaveBeenCalled(); // pruneExpired fired
  });

  it('rejects an unknown code', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce(null);
    const service = new ConnectCodeService(repo as never, makeLogger() as never);

    expect(await service.consume('deadbeef')).toBeNull();
  });

  it('rejects an already-used code', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({
      id: 'c1',
      app_urn: 'urn:app:x',
      user_id: 'user-1',
      used_at: new Date(),
      expires_at: new Date(Date.now() + 10_000),
    });
    const service = new ConnectCodeService(repo as never, makeLogger() as never);

    expect(await service.consume('somecode')).toBeNull();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects an expired code', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({
      id: 'c1',
      app_urn: 'urn:app:x',
      user_id: 'user-1',
      used_at: null,
      expires_at: new Date(Date.now() - 1),
    });
    const service = new ConnectCodeService(repo as never, makeLogger() as never);

    expect(await service.consume('somecode')).toBeNull();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('loses the race when the atomic claim affects no rows (concurrent exchange)', async () => {
    const repo = makeRepo();
    const service = new ConnectCodeService(repo as never, makeLogger() as never);

    const code = await service.issue('user-1', 'urn:app:x');
    repo.findOne.mockResolvedValueOnce(repo.save.mock.calls[0][0]);
    repo.update.mockResolvedValueOnce({ affected: 0 }); // another exchange claimed it first

    expect(await service.consume(code)).toBeNull();
  });
});
