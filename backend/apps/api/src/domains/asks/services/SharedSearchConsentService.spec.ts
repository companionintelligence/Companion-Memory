
import type { AskGrantEntity } from '../entities/AskGrantEntity';
import type { DisclosureRung } from '../types';

import {
  SAVED_SEARCH_RESOURCE,
  SHARE_QUERY_TYPE,
  SharedSearchConsentService,
  shareAuditQuery,
} from './SharedSearchConsentService';

const NOW = new Date('2026-08-26T12:00:00.000Z');
const PAST = new Date('2026-01-01T00:00:00.000Z');
const FUTURE = new Date('2027-01-01T00:00:00.000Z');

function grant(overrides: Partial<AskGrantEntity> = {}): AskGrantEntity {
  return {
    id: 'grant-1',
    ownerUserId: 'owner-9',
    granteeUserId: 'viewer-1',
    granteePeerLinkId: null,
    resourceType: SAVED_SEARCH_RESOURCE,
    resourceId: 'saved-7',
    queryType: SHARE_QUERY_TYPE,
    dataClass: null,
    scope: null,
    mode: 'auto',
    purpose: null,
    createdAt: PAST,
    updatedAt: PAST,
    revokedAt: null,
    expiresAt: null,
    revocationReason: null,
    version: 1,
    supersedesGrantId: null,
    ...overrides,
  } as AskGrantEntity;
}

function makeService(existing: AskGrantEntity[] = []) {
  const rows = [...existing];
  const repository = {
    find: jest.fn(async () => [...rows]),
    create: jest.fn((row: AskGrantEntity) => row),
    save: jest.fn(async (row: AskGrantEntity) => {
      rows.push(row);

      return row;
    }),
  };
  const auditService = { record: jest.fn(async () => undefined) };
  const logger = { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn() };

  const service = new SharedSearchConsentService(repository as never, auditService as never, logger as never);

  return { service, repository, auditService, rows };
}

const BASE = {
  ownerUserId: 'owner-9',
  viewerUserId: 'viewer-1',
  savedSearchId: 'saved-7',
  now: NOW,
};

describe('SharedSearchConsentService.authorize', () => {
  it('needs no grant when the owner reads their own share', async () => {
    const { service, repository } = makeService();

    const result = await service.authorize({
      ...BASE,
      viewerUserId: 'owner-9',
      declaredCeiling: 'count',
    });

    expect(result).toEqual({ grantId: null, ceiling: undefined });
    // Not merely "no ceiling" — the owner's own preview must not touch the
    // grant table at all, or every preview mints a grant against themselves.
    expect(repository.find).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('mints a grant on first read, stamping the ceiling and the expiry', async () => {
    const { service, repository } = makeService();

    const result = await service.authorize({
      ...BASE,
      declaredCeiling: 'count',
      shareExpiresAt: FUTURE,
    });

    expect(repository.save).toHaveBeenCalledTimes(1);
    const minted = repository.save.mock.calls[0][0] as AskGrantEntity;
    expect(minted).toMatchObject({
      ownerUserId: 'owner-9',
      granteeUserId: 'viewer-1',
      resourceType: SAVED_SEARCH_RESOURCE,
      resourceId: 'saved-7',
      queryType: SHARE_QUERY_TYPE,
      mode: 'auto',
      expiresAt: FUTURE,
      scope: { maxDisclosure: 'count' },
    });
    expect(result).toEqual({ grantId: minted.id, ceiling: 'count' });
  });

  it('reuses the live grant on later reads rather than minting a second', async () => {
    const { service, repository } = makeService([grant({ id: 'grant-live' })]);

    const result = await service.authorize({ ...BASE, declaredCeiling: null });

    expect(result).toEqual({ grantId: 'grant-live', ceiling: undefined });
    expect(repository.save).not.toHaveBeenCalled();
  });

  /**
   * The property that makes "revoke Dana" mean anything. Without it the revoked
   * row simply stops being active, the live lookup finds nothing, and the very
   * next read mints a replacement — so the revoke would last until Dana hit
   * refresh.
   */
  it('treats an owner revocation as a STANDING denial, not a gap to re-mint into', async () => {
    const { service, repository } = makeService([
      grant({ id: 'grant-gone', revokedAt: PAST, revocationReason: 'revoked' }),
    ]);

    const result = await service.authorize({ ...BASE, declaredCeiling: null });

    expect(result).toBeNull();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('does not treat a SUPERSEDED grant as a denial — it has a live successor', async () => {
    const { service } = makeService([
      grant({ id: 'grant-new', scope: { maxDisclosure: 'summary' } }),
      grant({ id: 'grant-old', revokedAt: PAST, revocationReason: 'superseded' }),
    ]);

    const result = await service.authorize({ ...BASE, declaredCeiling: null });

    expect(result).toEqual({ grantId: 'grant-new', ceiling: 'summary' });
  });

  it('re-mints after a grant LAPSES, because lapsing is not something the owner did', async () => {
    const { service, repository } = makeService([grant({ id: 'grant-old', expiresAt: PAST })]);

    const result = await service.authorize({ ...BASE, declaredCeiling: 'full' });

    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(result?.grantId).not.toBe('grant-old');
    expect(result?.ceiling).toBe('full');
  });

  describe('combining the stamped ceiling with the share live one', () => {
    it('takes the NARROWER when the stamped one is stricter', async () => {
      const { service } = makeService([grant({ scope: { maxDisclosure: 'count' } })]);

      const result = await service.authorize({ ...BASE, declaredCeiling: 'full' });

      expect(result?.ceiling).toBe('count');
    });

    it('takes the NARROWER when the live one is stricter — tightening a share tightens readers', async () => {
      const { service } = makeService([grant({ scope: { maxDisclosure: 'full' } })]);

      const result = await service.authorize({ ...BASE, declaredCeiling: 'boolean' });

      expect(result?.ceiling).toBe('boolean');
    });

    /**
     * The `20260821010000` bug, in its share-path form: read only the LIVE
     * ceiling and an owner who clears the share posture makes every existing
     * reader's answer GROW. A source that says nothing must not erase one that
     * does.
     */
    it('keeps the stamped ceiling when the share stops declaring one', async () => {
      const { service } = makeService([grant({ scope: { maxDisclosure: 'count' } })]);

      const result = await service.authorize({ ...BASE, declaredCeiling: null });

      expect(result?.ceiling).toBe('count');
    });

    it('fails closed on a stamped ceiling that names no rung', async () => {
      // `scope` is jsonb: the TYPE says DisclosureRung, the COLUMN holds
      // whatever a client or a migration wrote. The cast is the point of the
      // test — this is the value the type system cannot stop arriving.
      const { service } = makeService([grant({ scope: { maxDisclosure: 'summry' as DisclosureRung } })]);

      const result = await service.authorize({ ...BASE, declaredCeiling: 'full' });

      expect(result?.ceiling).toBe('none');
    });
  });

  it('resolves the mint race to the row that won at the database', async () => {
    const { service, repository } = makeService();
    const winner = grant({ id: 'grant-winner', scope: { maxDisclosure: 'summary' } });

    // First `find` (the pre-check) sees nothing; the insert loses the unique
    // index; the post-failure `find` sees the winner.
    repository.find.mockResolvedValueOnce([]).mockResolvedValueOnce([winner]);
    repository.save.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));

    const result = await service.authorize({ ...BASE, declaredCeiling: 'full' });

    expect(result).toEqual({ grantId: 'grant-winner', ceiling: 'summary' });
  });

  it('rethrows a save failure that is not a lost race', async () => {
    const { service, repository } = makeService();
    const boom = new Error('connection terminated');
    repository.find.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    repository.save.mockRejectedValueOnce(boom);

    await expect(service.authorize({ ...BASE, declaredCeiling: null })).rejects.toThrow(boom);
  });
});

describe('SharedSearchConsentService.recordRead', () => {
  const READ = {
    ownerUserId: 'owner-9',
    viewerUserId: 'viewer-1',
    savedSearchId: 'saved-7',
    savedSearchName: 'Lake trip',
    disclosedEntityIds: ['note-1'],
    backingEntityIds: ['note-1', 'note-2'],
  };

  it('writes the owner a Disclosure History row', async () => {
    const { service, auditService } = makeService();

    await service.recordRead({ ...READ, grantId: 'grant-1' });

    expect(auditService.record).toHaveBeenCalledWith({
      askId: null,
      askerUserId: 'viewer-1',
      responderUserId: 'owner-9',
      query: shareAuditQuery('saved-7', 'Lake trip'),
      consentBasis: 'grant-1',
      outcome: 'auto_answered',
      disclosedEntities: ['note-1'],
      disclosedCount: 1,
      backingEntities: ['note-1', 'note-2'],
    });
  });

  it('writes nothing for the owner reading their own share', async () => {
    const { service, auditService } = makeService();

    await service.recordRead({ ...READ, grantId: null });

    expect(auditService.record).not.toHaveBeenCalled();
  });
});

describe('shareAuditQuery', () => {
  it('does not borrow an ask archetype for a share', async () => {
    const query = shareAuditQuery('saved-7', 'Lake trip');

    expect(query.queryType).toBe(SHARE_QUERY_TYPE);
    expect(query.prompt).toBe('Lake trip');
    expect(query.filters).toEqual({ resourceType: SAVED_SEARCH_RESOURCE, resourceId: 'saved-7' });
  });

  it('names an unnamed share without leaving the prompt blank', async () => {
    expect(shareAuditQuery('saved-7', '   ').prompt).toBe('A shared saved search');
    expect(shareAuditQuery('saved-7', null).prompt).toBe('A shared saved search');
  });
});
