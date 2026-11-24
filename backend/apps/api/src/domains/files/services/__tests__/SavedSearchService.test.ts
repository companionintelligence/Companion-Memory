import { type UserServiceContext } from '@ci/common/context';

import { DEFAULT_SAVED_SEARCHES } from '../../seeds/defaultSavedSearches';
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
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn(),
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

  // ═══ AN ABSENT `tags` MEANS "LEAVE IT ALONE", NOT "CLEAR IT" ═══
  //
  // `UpdateSavedSearchInput` makes every field optional, and the edit dialog
  // used to update `name`/`description`/`filters` without ever selecting
  // `tags` on its mutation — `assembleTags(data)` was called unconditionally
  // with `data.tags || []`, so the update wrote an EMPTY array over whatever
  // tags the row actually had. Renaming a search deleted its tag filter.
  it('does not touch the tags column when the caller never named tags', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 1 });
    const { service } = makeService(repo);

    await service.update(ownerCtx, 'id1', { name: 'renamed' });

    const [, payload] = repo.update.mock.calls[0];
    expect(payload).not.toHaveProperty('tags');
  });

  it('does not touch tags even when the query text changes and could carry hashtags', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 1 });
    const { service } = makeService(repo);

    // A #hashtag here would previously have been scraped into a rebuilt
    // (and otherwise emptied) tags array, discarding any non-hashtag tags
    // the row already had.
    await service.update(ownerCtx, 'id1', { query: 'lake trip #vacation' });

    const [, payload] = repo.update.mock.calls[0];
    expect(payload).not.toHaveProperty('tags');
  });

  it('still writes tags when the caller explicitly names them, hashtags included', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 1 });
    const { service } = makeService(repo);

    await service.update(ownerCtx, 'id1', { query: 'lake trip #vacation', tags: ['work'] });

    const [, payload] = repo.update.mock.calls[0];
    expect(payload.tags).toEqual(expect.arrayContaining(['work', 'vacation']));
  });

  it('accepts an explicit empty array as "clear the tags", distinct from omitting the field', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 1 });
    const { service } = makeService(repo);

    await service.update(ownerCtx, 'id1', { tags: [] });

    const [, payload] = repo.update.mock.calls[0];
    expect(payload).toHaveProperty('tags', []);
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

  it('clears the token AND the posture when disabling', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 1 });
    repo.findOne.mockResolvedValue({ id: 'id1' });
    const { service } = makeService(repo);

    await service.setSharing(ownerCtx, 'id1', false, {
      maxDisclosure: 'count',
      expiresAt: new Date('2027-01-01'),
    });

    // The posture belongs to the LINK. Leaving a ceiling or an expiry behind
    // would mean a later re-share silently inherited a restriction the owner
    // wrote for a different audience — or, worse, appeared to and did not.
    const [, payload] = repo.update.mock.calls[0];
    expect(payload).toEqual({
      isPublic: false,
      shareToken: null,
      shareMaxDisclosure: null,
      shareExpiresAt: null,
    });
  });

  it('stamps the ceiling and the expiry when enabling', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 1 });
    repo.findOne.mockResolvedValue({ id: 'id1' });
    const { service } = makeService(repo);
    const expiresAt = new Date('2027-01-01T00:00:00.000Z');

    await service.setSharing(ownerCtx, 'id1', true, { maxDisclosure: 'count', expiresAt });

    const [, payload] = repo.update.mock.calls[0];
    expect(payload.shareMaxDisclosure).toBe('count');
    expect(payload.shareExpiresAt).toBe(expiresAt);
  });

  it('records NO ceiling when the owner declares none, rather than defaulting to full', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 1 });
    repo.findOne.mockResolvedValue({ id: 'id1' });
    const { service } = makeService(repo);

    await service.setSharing(ownerCtx, 'id1', true);

    // Absent and `full` are different statements, and only one of them is
    // something the owner said. `ceilingForShare` reads NULL as "no ceiling
    // from this source", which is the pre-existing behaviour of every link.
    const [, payload] = repo.update.mock.calls[0];
    expect(payload.shareMaxDisclosure).toBeNull();
    expect(payload.shareExpiresAt).toBeNull();
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

    // Two branches OR'd: no expiry, or an expiry still in the future.
    const { where } = repo.findOne.mock.calls[0][0];
    expect(Array.isArray(where)).toBe(true);
    expect(where).toHaveLength(2);

    for (const branch of where) {
      expect(branch.shareToken).toBe('tok');
      expect(branch.isPublic).toBe(true);
      // The non-scoping is the whole point — the viewer is not the owner.
      expect(branch).not.toHaveProperty('userId');
    }
  });

  it('will not resolve a link whose expiry has passed', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue({ id: 'id1', userId: 'owner-1' });
    const { service } = makeService(repo);
    const now = new Date('2026-08-26T12:00:00.000Z');

    await service.findByShareToken('tok', now);

    // The lapse is enforced in SQL, not after the read, so there is no branch
    // above this that could report "expired" rather than "no such link" — the
    // two have to stay indistinguishable to the caller.
    const { where } = repo.findOne.mock.calls[0][0];
    const [noExpiry, stillLive] = where;
    expect(noExpiry.shareExpiresAt._type).toBe('isNull');
    expect(stillLive.shareExpiresAt._type).toBe('moreThan');
    expect(stillLive.shareExpiresAt._value).toBe(now);
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

describe('SavedSearchService.ensureDefaults', () => {
  beforeEach(() => jest.clearAllMocks());

  it('no-ops when the user already has saved searches', async () => {
    const repo = makeRepo();
    repo.count.mockResolvedValue(3);
    const { service } = makeService(repo);

    await expect(service.ensureDefaults(ownerCtx)).resolves.toBe(false);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('inserts the starter catalog once when the user has none', async () => {
    const repo = makeRepo();
    repo.count.mockResolvedValue(0);
    const { service } = makeService(repo);

    await expect(service.ensureDefaults(ownerCtx)).resolves.toBe(true);
    expect(repo.save).toHaveBeenCalledTimes(1);

    const rows = repo.save.mock.calls[0][0] as unknown as Array<Record<string, unknown>>;
    expect(rows.length).toBe(DEFAULT_SAVED_SEARCHES.length);
    expect(rows[0]).toMatchObject({
      name: 'Recent Entertainment',
      userId: 'owner-1',
    });
    expect(rows.some((row) => row.name === 'All my stuff')).toBe(true);
    expect(rows.some((row) => row.name === 'Recent Images')).toBe(true);
    // The product-session joke searches were dropped on 2026-10-15.
    expect(rows.some((row) => row.name === 'Yoga for the Power Mad')).toBe(false);
    expect(rows.some((row) => row.name === 'Shopping List')).toBe(true);
  });

  it('extracts hashtags from a query into tags', async () => {
    // Used to lean on the "MicroFlesh Diet" seed, whose query was two
    // hashtags; that seed is gone, and the rule is the service's, not a seed's.
    const repo = makeRepo();
    const { service } = makeService(repo);

    await service.create(ownerCtx, { name: 'Branded meat', query: '#NotBeyondMeat #PossibleBurger' });

    const row = repo.create.mock.calls[0][0] as { tags: string[] };
    expect(row.tags).toEqual(expect.arrayContaining(['NotBeyondMeat', 'PossibleBurger']));
  });

  // Every seeded row must be flaggable as a starter, so the frontend can put
  // it in its own collapsed section instead of mixing it into what the user
  // thinks they saved themselves.
  it('marks every inserted row as seeded', async () => {
    const repo = makeRepo();
    repo.count.mockResolvedValue(0);
    const { service } = makeService(repo);

    await service.ensureDefaults(ownerCtx);

    const rows = repo.save.mock.calls[0][0] as unknown as Array<{ isSeed: boolean }>;
    expect(rows.every((row) => row.isSeed === true)).toBe(true);
  });
});

describe('SavedSearchService.findAll', () => {
  beforeEach(() => jest.clearAllMocks());

  function entity(overrides: Partial<Record<string, unknown>>) {
    return { userId: 'owner-1', name: '', description: null, tags: [], isSeed: false, ...overrides };
  }

  it('scopes to the caller by default, with no query or isSeed filter', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);

    await service.findAll(ownerCtx);

    expect(repo.find).toHaveBeenCalledWith({ where: { userId: 'owner-1' } });
  });

  it('filters at the database level by isSeed when asked', async () => {
    const repo = makeRepo();
    const { service } = makeService(repo);

    await service.findAll(ownerCtx, { isSeed: true });

    expect(repo.find).toHaveBeenCalledWith({ where: { userId: 'owner-1', isSeed: true } });
  });

  it('matches query text against name, description or tags, case-insensitively', async () => {
    const repo = makeRepo();
    repo.find.mockResolvedValue([
      entity({ id: '1', name: 'Yoga for the Power Mad' }),
      entity({ id: '2', name: 'Space Car', description: 'blueprints for a YOGA studio' }),
      entity({ id: '3', name: 'Weekend trip', tags: ['Yoga'] }),
      entity({ id: '4', name: 'Groceries' }),
    ]);
    const { service } = makeService(repo);

    const result = await service.findAll(ownerCtx, { query: 'yoga' });

    expect(result.map((row) => row.id)).toEqual(['1', '2', '3']);
  });
});
