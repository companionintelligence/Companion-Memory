import { ConflictException, ForbiddenException } from '@nestjs/common';
import { IsNull } from 'typeorm';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';

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

  it('returns the identity AND the provenance of a live key', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({
      id: 'k1',
      user_id: 'owner-1',
      expires_at: null,
      scopes: ['memory'],
      capability: 'write',
      name: null,
      managed_by: null,
    });
    const service = makeService(repo);

    // `name` and `managedBy` joined the return type so the managed-app gate can
    // tell WHO is calling, not only what they may do. A key the owner made
    // themselves has neither, and both are null rather than absent — a caller
    // reading `managedBy` must be able to distinguish "not an app" from "this
    // build does not report provenance".
    expect(await service.validateKey(validRaw)).toEqual({
      keyId: 'k1',
      userId: 'owner-1',
      scopes: ['memory'],
      capability: 'write',
      name: null,
      managedBy: null,
    });
  });

  it('reports an installed app as managed, which is what the gate keys on', async () => {
    // `managed_by: 'connect'` is the ONLY thing that distinguishes a harness key
    // from an owner's own key of the same capability, and since the harnesses
    // are minted at `full` it is the whole basis for confirming them. A key
    // whose provenance were dropped here would be indistinguishable from the
    // owner and would execute irreversible calls unasked.
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({
      id: 'k1',
      user_id: 'owner-1',
      expires_at: null,
      scopes: ['memory', 'intents', 'mcp'],
      capability: 'full',
      name: 'app:ci-openclaw:ci-marketplace',
      managed_by: 'connect',
    });
    const service = makeService(repo);

    expect(await service.validateKey(validRaw)).toEqual({
      keyId: 'k1',
      userId: 'owner-1',
      scopes: ['memory', 'intents', 'mcp'],
      capability: 'full',
      name: 'app:ci-openclaw:ci-marketplace',
      managedBy: 'connect',
    });
  });

  it('defaults a null scopes column to empty (legacy full-access)', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({
      id: 'k1',
      user_id: 'owner-1',
      expires_at: null,
      scopes: null,
      capability: 'write',
      name: null,
      managed_by: null,
    });
    const service = makeService(repo);

    expect(await service.validateKey(validRaw)).toEqual({
      keyId: 'k1',
      userId: 'owner-1',
      scopes: [],
      capability: 'write',
      name: null,
      managedBy: null,
    });
  });

  it('reads an unrecognised stored capability as read-only, not as the default', async () => {
    // A CHECK constraint keeps the column to the three known values, but a rolled-back deploy could
    // leave one this build does not understand. An authority level we cannot read is not one to
    // guess in the caller's favour.
    const repo = makeRepo();
    repo.findOne.mockResolvedValueOnce({
      id: 'k1',
      user_id: 'owner-1',
      expires_at: null,
      scopes: [],
      capability: 'superuser',
    });
    const service = makeService(repo);

    expect((await service.validateKey(validRaw))?.capability).toBe('read');
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

/**
 * findAllByUser / findOneByUser / remove all share the same tenancy gate:
 *
 *   ...(context.userId !== SYSTEM_USER && { user_id: context.userId })
 *
 * which is meant to scope every ordinary caller to their own rows while
 * letting only the trusted system caller (SYSTEM_USER — never reachable from
 * a request; only internal callers construct that context) see across
 * owners. If that condition were ever inverted or dropped, an ordinary
 * authenticated user could list, read, or delete another user's API keys
 * through GET/DELETE /keys/:id — a direct tenancy leak on credential
 * material.
 *
 * Unlike the tests above (which only assert the `where`/criteria shape
 * against a repo mock that echoes back whatever it's given), these use a
 * small in-memory repo that actually FILTERS by the criteria it receives —
 * so a regression that dropped or inverted the `user_id` filter would make
 * these tests fail by returning/deleting the wrong owner's row, not just by
 * mismatching the call it happened to be given.
 */
function makeTenantScopedRepo(rows: Array<Record<string, unknown>>) {
  const table = [...rows];

  const matches = (row: Record<string, unknown>, where?: Record<string, unknown>) =>
    !where || Object.entries(where).every(([key, value]) => row[key] === value);

  return {
    find: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
      table.filter((row) => matches(row, where)),
    ),
    findOne: jest.fn(async ({ where }: { where?: Record<string, unknown> }) => {
      return table.find((row) => matches(row, where)) ?? null;
    }),
    delete: jest.fn(async (criteria: Record<string, unknown>) => {
      const before = table.length;
      const survivors = table.filter((row) => !matches(row, criteria));

      table.length = 0;
      table.push(...survivors);

      return { affected: before - survivors.length };
    }),
  };
}

function makeKeyRow(id: string, userId: string) {
  return {
    id,
    user_id: userId,
    name: `key-${id}`,
    prefix: 'aaaaa',
    scopes: [] as string[],
    capability: 'write' as const,
    expires_at: null,
    last_used_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    managed_by: null,
  };
}

describe('ApiKeyService tenancy scoping (findAllByUser / findOneByUser / remove)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('findOneByUser', () => {
    it('rejects an ordinary user reading another user’s key by id', async () => {
      const repo = makeTenantScopedRepo([makeKeyRow('key-1', 'user-1'), makeKeyRow('key-2', 'user-2')]);
      const service = makeService(repo as never);

      const result = await service.findOneByUser({ userId: 'user-1' } as ServiceContext, 'key-2');

      expect(result).toBeNull();
      expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 'key-2', user_id: 'user-1' } });
    });

    it('lets the owning user read their own key', async () => {
      const repo = makeTenantScopedRepo([makeKeyRow('key-1', 'user-1'), makeKeyRow('key-2', 'user-2')]);
      const service = makeService(repo as never);

      const result = await service.findOneByUser({ userId: 'user-1' } as ServiceContext, 'key-1');

      expect(result?.id).toBe('key-1');
    });

    it('lets the trusted SYSTEM_USER context bypass the owner filter', async () => {
      const repo = makeTenantScopedRepo([makeKeyRow('key-1', 'user-1'), makeKeyRow('key-2', 'user-2')]);
      const service = makeService(repo as never);

      const result = await service.findOneByUser({ userId: SYSTEM_USER } as ServiceContext, 'key-2');

      expect(result?.id).toBe('key-2');
      expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 'key-2' } });
    });
  });

  describe('findAllByUser', () => {
    it('never returns another user’s keys to an ordinary caller', async () => {
      const repo = makeTenantScopedRepo([makeKeyRow('key-1', 'user-1'), makeKeyRow('key-2', 'user-2')]);
      const service = makeService(repo as never);

      const results = await service.findAllByUser({ userId: 'user-1' } as ServiceContext);

      expect(results.map((k) => k.id)).toEqual(['key-1']);
    });

    it('lists across all owners for the trusted SYSTEM_USER context', async () => {
      const repo = makeTenantScopedRepo([makeKeyRow('key-1', 'user-1'), makeKeyRow('key-2', 'user-2')]);
      const service = makeService(repo as never);

      const results = await service.findAllByUser({ userId: SYSTEM_USER } as ServiceContext);

      expect(results.map((k) => k.id).sort()).toEqual(['key-1', 'key-2']);
    });
  });

  describe('remove', () => {
    it('refuses to delete another user’s key, and it survives untouched', async () => {
      const repo = makeTenantScopedRepo([makeKeyRow('key-1', 'user-1'), makeKeyRow('key-2', 'user-2')]);
      const service = makeService(repo as never);

      const removed = await service.remove({ userId: 'user-1' } as ServiceContext, 'key-2');

      expect(removed).toBe(false);
      expect(repo.delete).toHaveBeenCalledWith({ id: 'key-2', user_id: 'user-1' });
      // Prove it by reading it back, not just by the delete-criteria shape.
      const survivor = await service.findOneByUser({ userId: 'user-2' } as ServiceContext, 'key-2');
      expect(survivor?.id).toBe('key-2');
    });

    it('lets the owning user delete their own key', async () => {
      const repo = makeTenantScopedRepo([makeKeyRow('key-1', 'user-1'), makeKeyRow('key-2', 'user-2')]);
      const service = makeService(repo as never);

      expect(await service.remove({ userId: 'user-1' } as ServiceContext, 'key-1')).toBe(true);
    });

    it('lets the trusted SYSTEM_USER context delete any user’s key', async () => {
      const repo = makeTenantScopedRepo([makeKeyRow('key-1', 'user-1'), makeKeyRow('key-2', 'user-2')]);
      const service = makeService(repo as never);

      expect(await service.remove({ userId: SYSTEM_USER } as ServiceContext, 'key-2')).toBe(true);
      expect(repo.delete).toHaveBeenCalledWith({ id: 'key-2' });
    });
  });
});
