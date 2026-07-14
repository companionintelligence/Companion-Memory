import { ConflictException, ForbiddenException } from '@nestjs/common';
import { IsNull } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';

import { ApiKeyService } from '../services/ApiKeyService';

/**
 * Unit tests for the idempotency + scope surface added for the connect flow:
 *  - createOrRotate deletes any prior (user, name) key before minting a fresh one
 *  - removeByName is the system-level, cross-user revoke used by the Hub
 *  - findByName is owner-scoped
 *  - validateKey now returns the key's scopes (defaulting empty → full-access)
 * Repository is an in-memory jest mock — same pattern as SavedSearchService.test.ts.
 */
function makeRepo() {
  return {
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest.fn(async (row: Record<string, unknown>) => row),
    findOne: jest.fn(),
    delete: jest.fn(async () => ({ affected: 1 })),
    update: jest.fn(async () => ({ affected: 1 })),
    find: jest.fn(),
  };
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
}

function makeService(repo: ReturnType<typeof makeRepo>, logger = makeLogger()) {
  return new ApiKeyService(repo as never, logger as never);
}

const ownerCtx = { userId: 'owner-1' } as UserServiceContext;

describe('ApiKeyService.createOrRotate', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes any existing (user, name) key, then mints and returns a fresh raw key', async () => {
    const repo = makeRepo();
    const service = makeService(repo);

    const result = await service.createOrRotate(ownerCtx, { name: 'app:urn:x', scopes: ['memory'] });

    // Rotation: prior key for this (user, name) is removed before minting — matched on
    // provenance too, so a rotate can only ever replace a key of its OWN kind (a connect
    // mint cannot silently delete a same-named user key; the unique index makes that
    // collision fail loudly instead).
    expect(repo.delete).toHaveBeenCalledWith({ user_id: 'owner-1', name: 'app:urn:x', managed_by: IsNull() });
    expect(repo.delete.mock.invocationCallOrder[0]).toBeLessThan(repo.save.mock.invocationCallOrder[0]);

    // Minted row is owner-scoped, carries the requested scopes, and the raw key
    // is 64 hex chars returned exactly once.
    const row = repo.create.mock.calls[0][0];
    expect(row.user_id).toBe('owner-1');
    expect(row.name).toBe('app:urn:x');
    expect(row.scopes).toEqual(['memory']);
    expect(result.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('scopes the rotate-delete to the connect namespace when minting a connect key', async () => {
    // Without the provenance filter, the consent flow's mint would delete ANY key of the
    // user that happened to share the connect name — silently revoking a credential the
    // Hub never issued, which is the same cross-namespace clobbering removeByName and
    // update already refuse.
    const repo = makeRepo();
    const service = makeService(repo);

    await service.createOrRotate(ownerCtx, { name: 'app:urn:x', scopes: [] }, 'connect');

    expect(repo.delete).toHaveBeenCalledWith({
      user_id: 'owner-1',
      name: 'app:urn:x',
      managed_by: 'connect',
    });
  });

  it('reports a name collision with a user-owned key instead of retrying forever', async () => {
    // The provenance-scoped delete refuses to remove a key it did not mint, so if a
    // user's own key holds the connect name the insert can never win the unique index.
    // Retrying to exhaustion would 500 the consent flow with nothing actionable in it.
    const repo = makeRepo();
    const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
    repo.save.mockRejectedValue(uniqueViolation);
    const service = makeService(repo);

    await expect(
      service.createOrRotate(ownerCtx, { name: 'app:urn:x', scopes: [] }, 'connect'),
    ).rejects.toBeInstanceOf(ConflictException);

    // Tried once, retried once, then gave up — no unbounded loop.
    expect(repo.save).toHaveBeenCalledTimes(2);
  });

  it('mints a non-expiring key when no expires_at is given', async () => {
    const repo = makeRepo();
    const service = makeService(repo);

    await service.createOrRotate(ownerCtx, { name: 'app:urn:y', scopes: ['memory'] });

    expect(repo.create.mock.calls[0][0].expires_at).toBeNull();
  });

  it('retries once and succeeds when a concurrent mint trips the unique index (23505)', async () => {
    const repo = makeRepo();
    // First insert loses the race on the (user, name) unique index; the retry wins.
    repo.save
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key value'), { code: '23505' }))
      .mockImplementationOnce(async (row: Record<string, unknown>) => row);
    const service = makeService(repo);

    const result = await service.createOrRotate(ownerCtx, { name: 'app:urn:z', scopes: ['memory'] });

    // Deleted again before the retry insert; a usable key is returned (no 500).
    expect(repo.delete).toHaveBeenCalledTimes(2);
    expect(repo.save).toHaveBeenCalledTimes(2);
    expect(result.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rethrows a non-unique-violation error without retrying', async () => {
    const repo = makeRepo();
    repo.save.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: '08006' }));
    const service = makeService(repo);

    await expect(service.createOrRotate(ownerCtx, { name: 'app:urn:w', scopes: ['memory'] })).rejects.toThrow(
      'connection reset',
    );
    expect(repo.delete).toHaveBeenCalledTimes(1);
  });
});

describe('ApiKeyService.removeByName', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes by name and, on the single-owner appliance (1 row), does not log', async () => {
    const repo = makeRepo();
    repo.delete.mockResolvedValueOnce({ affected: 1 });
    const logger = makeLogger();
    const service = makeService(repo, logger);

    const removed = await service.removeByName('app:urn:x');

    expect(repo.delete).toHaveBeenCalledWith({ name: 'app:urn:x', managed_by: 'connect' });
    expect(removed).toBe(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs when >1 owner matched (single-owner invariant violated) but still revokes', async () => {
    const repo = makeRepo();
    repo.delete.mockResolvedValueOnce({ affected: 2 });
    const logger = makeLogger();
    const service = makeService(repo, logger);

    const removed = await service.removeByName('app:urn:x');

    expect(removed).toBe(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('returns 0 when nothing matched', async () => {
    const repo = makeRepo();
    repo.delete.mockResolvedValueOnce({ affected: 0 });
    const service = makeService(repo);

    expect(await service.removeByName('app:urn:none')).toBe(0);
  });
});

describe('ApiKeyService.findUserIdByName', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the single owner for a connect key', async () => {
    const repo = makeRepo();
    repo.find.mockResolvedValueOnce([{ user_id: 'owner-1' }]);
    const service = makeService(repo);

    expect(await service.findUserIdByName('app:ci-openclaw:ci-marketplace')).toBe('owner-1');
    expect(repo.find).toHaveBeenCalledWith({
      where: { name: 'app:ci-openclaw:ci-marketplace', managed_by: 'connect' },
      select: ['user_id'],
    });
  });

  it('returns null when no key exists', async () => {
    const repo = makeRepo();
    repo.find.mockResolvedValueOnce([]);
    const service = makeService(repo);

    expect(await service.findUserIdByName('app:missing:store')).toBeNull();
  });

  it('refuses (logs + null) when >1 owner holds the same name (multi-user ambiguity)', async () => {
    const repo = makeRepo();
    repo.find.mockResolvedValueOnce([{ user_id: 'owner-1' }, { user_id: 'owner-2' }]);
    const logger = makeLogger();
    const service = makeService(repo, logger);

    expect(await service.findUserIdByName('app:ci-hermes:ci-marketplace')).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('ApiKeyService.findByName', () => {
  beforeEach(() => jest.clearAllMocks());

  it('looks up owner-scoped by name', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({
      id: 'k1',
      name: 'app:urn:x',
      prefix: 'abcde',
      scopes: ['memory'],
      expires_at: null,
      last_used_at: null,
      user_id: 'owner-1',
      created_at: new Date(),
      updated_at: new Date(),
    });
    const service = makeService(repo);

    const key = await service.findByName(ownerCtx, 'app:urn:x');

    expect(repo.findOne).toHaveBeenCalledWith({ where: { user_id: 'owner-1', name: 'app:urn:x' } });
    expect(key?.name).toBe('app:urn:x');
  });

  it('returns null when no key exists', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce(null);
    const service = makeService(repo);

    expect(await service.findByName(ownerCtx, 'missing')).toBeNull();
  });
});

describe('ApiKeyService.update', () => {
  beforeEach(() => jest.clearAllMocks());

  const managedKey = {
    id: 'k-managed',
    name: 'app:ci-openclaw:ci-marketplace',
    prefix: 'abcde',
    scopes: ['memory'],
    expires_at: null,
    last_used_at: null,
    user_id: 'owner-1',
    created_at: new Date(),
    updated_at: new Date(),
    // Recorded at mint time by the connect flow — NOT inferred from the name.
    managed_by: 'connect' as const,
  };

  it('refuses to rename a Hub-managed connection key (would orphan the Hub revoke)', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({ ...managedKey });
    const service = makeService(repo);

    await expect(service.update(ownerCtx, 'k-managed', { name: 'stolen' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('refuses to re-scope a Hub-managed connection key', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({ ...managedKey });
    const service = makeService(repo);

    await expect(service.update(ownerCtx, 'k-managed', { scopes: [] })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('tolerates a no-op submit that echoes the managed key name and scopes', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({ ...managedKey });
    const service = makeService(repo);

    const result = await service.update(ownerCtx, 'k-managed', {
      name: 'app:ci-openclaw:ci-marketplace',
      scopes: ['memory'],
    });

    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(result?.name).toBe('app:ci-openclaw:ci-marketplace');
  });

  it('renames an ordinary (non-managed) key', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({
      ...managedKey,
      id: 'k-user',
      name: 'My key',
      scopes: [],
      managed_by: null,
    });
    const service = makeService(repo);

    const result = await service.update(ownerCtx, 'k-user', { name: 'Renamed' });

    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(result?.name).toBe('Renamed');
  });

  it('leaves a user-created key alone even when it is named like a connect key', async () => {
    // Key names are free-form. Before provenance was recorded, an `app:`-prefixed
    // name was treated as proof the Hub owned the key — so a user could not edit
    // their own `app:home-assistant`, while the Hub's revoke/rotate happily
    // operated on it.
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({
      ...managedKey,
      id: 'k-user',
      name: 'app:home-assistant',
      managed_by: null,
    });
    repo.save.mockImplementation(async (k: Record<string, unknown>) => k);
    const service = makeService(repo);

    await expect(service.update(ownerCtx, 'k-user', { scopes: ['memory'] })).resolves.toBeDefined();
    expect(repo.save).toHaveBeenCalled();
  });

  it('refuses to re-scope a connect-minted key regardless of the scopes it holds', async () => {
    // Connect keys now carry per-app scope sets, incl. an EMPTY set for
    // broad-access apps like ci-import-tools. The `app:` name prefix alone marks
    // a key Hub-managed, so a rename that would orphan the Hub's revoke-by-name
    // is refused even when the key has no scopes.
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({ ...managedKey, id: 'k-appish', scopes: [] });
    const service = makeService(repo);

    await expect(service.update(ownerCtx, 'k-appish', { name: 'renamed' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('lets the owner of a legacy `app:`-named key save it without renaming it', async () => {
    // The settings dialog always submits the name field, pre-filled with the key's
    // current name. Rejecting the reserved prefix on the request body would 400 that
    // no-op echo — leaving the grandfathered `app:`-named user keys this release hands
    // back to their owners uneditable, which is the opposite of the intent.
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({
      ...managedKey,
      id: 'k-user',
      name: 'app:home-assistant',
      managed_by: null,
    });
    repo.save.mockImplementation(async (k: Record<string, unknown>) => k);
    const service = makeService(repo);

    const result = await service.update(ownerCtx, 'k-user', {
      name: 'app:home-assistant',
      scopes: ['memory'],
    });

    expect(result?.scopes).toEqual(['memory']);
    expect(repo.save).toHaveBeenCalled();
  });

  it('refuses to RENAME any key INTO the reserved `app:` namespace', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({ ...managedKey, id: 'k-user', name: 'My key', managed_by: null });
    const service = makeService(repo);

    await expect(
      service.update(ownerCtx, 'k-user', { name: 'app:ci-hermes:ci-marketplace' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('returns null when the key does not exist', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce(null);
    const service = makeService(repo);

    expect(await service.update(ownerCtx, 'missing', { name: 'x' })).toBeNull();
  });
});

describe('ApiKeyService.validateKey', () => {
  const validRaw = 'a'.repeat(64);

  beforeEach(() => jest.clearAllMocks());

  it('returns userId and scopes for a live key', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({
      id: 'k1',
      user_id: 'owner-1',
      expires_at: null,
      scopes: ['memory'],
    });
    const service = makeService(repo);

    expect(await service.validateKey(validRaw)).toEqual({
      keyId: 'k1',
      userId: 'owner-1',
      scopes: ['memory'],
    });
  });

  it('defaults a null scopes column to empty (legacy full-access)', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({ id: 'k1', user_id: 'owner-1', expires_at: null, scopes: null });
    const service = makeService(repo);

    expect(await service.validateKey(validRaw)).toEqual({ keyId: 'k1', userId: 'owner-1', scopes: [] });
  });

  it('rejects an expired key', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({
      id: 'k1',
      user_id: 'owner-1',
      expires_at: new Date(Date.now() - 1000),
      scopes: ['memory'],
    });
    const service = makeService(repo);

    expect(await service.validateKey(validRaw)).toBeNull();
  });

  it('rejects a malformed key without hitting the database', async () => {
    const repo = makeRepo();
    const service = makeService(repo);

    expect(await service.validateKey('not-hex')).toBeNull();
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});
