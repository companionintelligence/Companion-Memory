import { type UserServiceContext } from '@ci/common/context';

import { SavedSearchService } from '../SavedSearchService';

/**
 * Unit tests for the sharing-related invariants on SavedSearchService:
 *  - setSharing mints a fresh token on enable, clears it on disable, rotates on
 *    every re-enable, and is owner-scoped (predicate always carries userId).
 *  - findByShareToken is the ONE deliberately non-user-scoped finder (it is the
 *    viewer path) and short-circuits an empty token.
 * Repository is an in-memory jest mock — same pattern as GeocodeService.test.ts.
 */

function makeRepo() {
  return {
    update: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest.fn(async (row: Record<string, unknown>) => row),
  };
}

function makeService(repo: ReturnType<typeof makeRepo>) {
  const eventService = { send: jest.fn() };

  return {
    service: new SavedSearchService(repo as never, eventService as never),
    eventService,
  };
}

const ownerCtx = { userId: 'owner-1' } as UserServiceContext;

describe('SavedSearchService.create', () => {
  beforeEach(() => jest.clearAllMocks());

  it('persists the secondary filters object alongside the primary fields', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);
    const filters = { eventTypes: ['visited'], hasLocation: true, sortBy: 'time' };

    await service.create(ownerCtx, { name: 'trip', query: 'paris', entityTypes: ['event'], filters });

    expect(repo.create).toHaveBeenCalledTimes(1);
    const row = repo.create.mock.calls[0][0];
    expect(row.filters).toEqual(filters);
    expect(row.userId).toBe('owner-1');
  });

  it('stores null filters when none are supplied', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);

    await service.create(ownerCtx, { name: 'plain', query: 'q' });

    expect(repo.create.mock.calls[0][0].filters).toBeNull();
  });
});

describe('SavedSearchService.update', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes a new filters object through to the owner-scoped update', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 1 });
    repo.findOne.mockResolvedValue({ id: 'id1' });
    const { service } = makeService(repo);
    const filters = { people: ['alice'], sortBy: 'time', sortOrder: 'desc' };

    await service.update(ownerCtx, 'id1', { name: 'trip', filters });

    const [predicate, payload] = repo.update.mock.calls[0];
    expect(predicate).toEqual({ id: 'id1', userId: 'owner-1' });
    expect(payload.filters).toEqual(filters);
  });
});

describe('SavedSearchService.setSharing', () => {
  beforeEach(() => jest.clearAllMocks());

  it('mints a 128-bit hex token and scopes the update to the owner when enabling', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 1 });
    repo.findOne.mockResolvedValue({ id: 'id1', userId: 'owner-1', isPublic: true, shareToken: 'x' });
    const { service } = makeService(repo);

    const result = await service.setSharing(ownerCtx, 'id1', true);

    expect(repo.update).toHaveBeenCalledTimes(1);
    const [predicate, payload] = repo.update.mock.calls[0];
    expect(predicate).toEqual({ id: 'id1', userId: 'owner-1' });
    expect(payload.isPublic).toBe(true);
    expect(payload.shareToken).toMatch(/^[0-9a-f]{32}$/);
    expect(result).not.toBeNull();
  });

  it('clears the token when disabling', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 1 });
    repo.findOne.mockResolvedValue({ id: 'id1' });
    const { service } = makeService(repo);

    await service.setSharing(ownerCtx, 'id1', false);

    const [, payload] = repo.update.mock.calls[0];
    expect(payload).toEqual({ isPublic: false, shareToken: null });
  });

  it('rotates the token on every re-enable so an old link cannot be resurrected', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 1 });
    repo.findOne.mockResolvedValue({ id: 'id1' });
    const { service } = makeService(repo);

    await service.setSharing(ownerCtx, 'id1', true);
    await service.setSharing(ownerCtx, 'id1', true);

    const token1 = repo.update.mock.calls[0][1].shareToken;
    const token2 = repo.update.mock.calls[1][1].shareToken;
    expect(token1).not.toBe(token2);
  });

  it('returns null without re-reading when nothing matched (non-owner / not found)', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 0 });
    const { service } = makeService(repo);

    const result = await service.setSharing(ownerCtx, 'id1', true);

    expect(result).toBeNull();
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});

describe('SavedSearchService.findByShareToken', () => {
  beforeEach(() => jest.clearAllMocks());

  it('matches on token + isPublic and is deliberately NOT user-scoped', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({ id: 'id1', userId: 'owner-1' });
    const { service } = makeService(repo);

    await service.findByShareToken('tok');

    const { where } = repo.findOne.mock.calls[0][0];
    expect(where).toEqual({ shareToken: 'tok', isPublic: true });
    // The non-scoping is the whole point — the viewer is not the owner.
    expect(where).not.toHaveProperty('userId');
  });

  it('returns the raw entity including the owner userId (runSharedSearch needs it)', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({ id: 'id1', userId: 'owner-1' });
    const { service } = makeService(repo);

    const result = await service.findByShareToken('tok');

    expect(result?.userId).toBe('owner-1');
  });

  it('short-circuits an empty token without hitting the database', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);

    const result = await service.findByShareToken('');

    expect(result).toBeNull();
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});
