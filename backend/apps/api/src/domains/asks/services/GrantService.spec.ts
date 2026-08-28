import { type UserServiceContext } from '@ci/common/context';

import type { AskGrantEntity } from '../entities/AskGrantEntity';

import { GrantService } from './GrantService';

/**
 * Unit coverage for the grant LIFECYCLE — revoke, supersede, and the read paths.
 *
 * The authorization WHERE clauses are proved against real Postgres in
 * `__tests__/GrantService.integration.spec.ts`; a mocked repository cannot show
 * that a scoping clause excludes another user's rows. What it can show — and
 * what these cover — is the behaviour the service adds on top: that revocation
 * reaches asks already riding the grant, that a change writes a new row instead
 * of mutating one, and that history is readable without widening the default
 * read.
 */

const NOW = new Date('2026-07-15T00:00:00Z');
const OWNER: UserServiceContext = { userId: 'owner-1' };

function grantRow(overrides: Partial<AskGrantEntity> = {}): AskGrantEntity {
  return {
    id: 'grant-1',
    ownerUserId: 'owner-1',
    granteeUserId: 'asker-1',
    granteePeerLinkId: null,
    queryType: 'photos',
    dataClass: 'beach',
    scope: null,
    mode: 'auto',
    purpose: null,
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
    expiresAt: null,
    revocationReason: null,
    version: 1,
    supersedesGrantId: null,
    ...overrides,
  } as AskGrantEntity;
}

function askRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ask-1',
    askerUserId: 'asker-1',
    responderUserId: 'owner-1',
    query: { queryType: 'photos', prompt: 'q' },
    status: 'delivered',
    consentBasis: 'grant-1',
    ...overrides,
  };
}

function makeService(options: { grants?: AskGrantEntity[]; asks?: Record<string, unknown>[] } = {}) {
  const grants = options.grants ?? [grantRow()];
  const grantRepository = {
    find: jest.fn().mockResolvedValue(grants),
    findOne: jest.fn().mockResolvedValue(grants[0] ?? null),
    create: jest.fn().mockImplementation((data: unknown) => data),
    save: jest.fn().mockImplementation((e: unknown) => Promise.resolve(e)),
    manager: {
      transaction: jest
        .fn()
        .mockImplementation((work: (m: unknown) => Promise<unknown>) =>
          work({ save: (_entity: unknown, row: unknown) => Promise.resolve(row) }),
        ),
    },
  };
  const askRepository = {
    find: jest.fn().mockResolvedValue(options.asks ?? []),
    save: jest.fn().mockImplementation((e: unknown) => Promise.resolve(e)),
  };
  const logger = { setContext: jest.fn(), log: jest.fn() };

  const service = new GrantService(grantRepository as never, askRepository as never, logger as never);

  return { service, grantRepository, askRepository };
}

// DEFECT 2 — revocation was not retroactive.
describe('GrantService.revoke — revocation reaches asks already riding the grant', () => {
  it('SECURITY: strips the consent stamp from a delivered ask and returns it to owner review', async () => {
    const stranded = askRow();
    const { service, askRepository } = makeService({ asks: [stranded] });

    await service.revoke(OWNER, 'grant-1');

    // `delivered` + a consent basis is exactly what `isAnswerable` accepts, so
    // clearing the basis is what makes the existing answer gate reject the ask.
    expect(stranded.consentBasis).toBeNull();
    expect(stranded.status).toBe('under_review');
    expect(askRepository.save).toHaveBeenCalledWith([stranded]);
  });

  it('only sweeps asks in `delivered` — an owner-approved ask is a human decision, not a grant', async () => {
    const { service, askRepository } = makeService({ asks: [] });

    await service.revoke(OWNER, 'grant-1');

    expect(askRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'delivered', consentBasis: 'grant-1' }),
      }),
    );
  });

  it('records WHY the grant ended, so an audit can tell revoke from supersede', async () => {
    const row = grantRow();
    const { service } = makeService({ grants: [row] });

    await service.revoke(OWNER, 'grant-1');

    expect(row.revokedAt).not.toBeNull();
    expect(row.revocationReason).toBe('revoked');
  });

  it('is idempotent and does not re-sweep an already-revoked grant', async () => {
    const row = grantRow({ revokedAt: new Date('2026-07-14T00:00:00Z'), revocationReason: 'revoked' });
    const { service, askRepository } = makeService({ grants: [row] });

    const result = await service.revoke(OWNER, 'grant-1');

    expect(result.revokedAt).toEqual(new Date('2026-07-14T00:00:00Z'));
    expect(askRepository.find).not.toHaveBeenCalled();
  });
});

// DEFECT 2 — the pull-side re-check at answer time.
describe('GrantService.isConsentStanding', () => {
  it('SECURITY: a revoked grant no longer stands, however the ask was stamped', async () => {
    const { service } = makeService({ grants: [grantRow({ revokedAt: new Date('2026-07-14T00:00:00Z') })] });

    await expect(service.isConsentStanding(askRow() as never, NOW)).resolves.toBe(false);
  });

  it('SECURITY: a lapsed grant no longer stands', async () => {
    const { service } = makeService({ grants: [grantRow({ expiresAt: new Date('2026-07-14T00:00:00Z') })] });

    await expect(service.isConsentStanding(askRow() as never, NOW)).resolves.toBe(false);
  });

  it('SECURITY: a consent basis naming a grant that no longer exists fails closed', async () => {
    const { service, grantRepository } = makeService();
    grantRepository.findOne.mockResolvedValue(null);

    await expect(service.isConsentStanding(askRow() as never, NOW)).resolves.toBe(false);
  });

  it('a live grant still stands', async () => {
    const { service } = makeService();

    await expect(service.isConsentStanding(askRow() as never, NOW)).resolves.toBe(true);
  });

  it('an ask with no consent basis is not this check’s business', async () => {
    const { service, grantRepository } = makeService();

    await expect(service.isConsentStanding(askRow({ consentBasis: null }) as never, NOW)).resolves.toBe(true);
    expect(grantRepository.findOne).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the RESPONDER, so a basis cannot name someone else’s grant', async () => {
    const { service, grantRepository } = makeService();

    await service.isConsentStanding(askRow() as never, NOW);

    expect(grantRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'grant-1', ownerUserId: 'owner-1' },
    });
  });
});

// DEFECTS 6 + 7 — the missing change mutation, and its audit trail.
describe('GrantService.supersede', () => {
  it('writes a NEW row rather than mutating the existing grant', async () => {
    const previous = grantRow({ mode: 'auto' });
    const { service } = makeService({ grants: [previous] });

    const replacement = await service.supersede(OWNER, 'grant-1', { mode: 'review' });

    expect(replacement.id).not.toBe(previous.id);
    expect(replacement.mode).toBe('review');
    // The predecessor is closed out, not overwritten: its mode is still what the
    // owner had before, which is the whole point of keeping the row.
    expect(previous.mode).toBe('auto');
    expect(previous.revokedAt).not.toBeNull();
    expect(previous.revocationReason).toBe('superseded');
  });

  it('leaves a reconstructible audit trail (version + supersedes pointer)', async () => {
    const previous = grantRow({ version: 3 });
    const { service } = makeService({ grants: [previous] });

    const replacement = await service.supersede(OWNER, 'grant-1', { mode: 'block' });

    expect(replacement.version).toBe(4);
    expect(replacement.supersedesGrantId).toBe('grant-1');
  });

  it('inherits every field the change does not mention', async () => {
    const previous = grantRow({
      dataClass: 'beach',
      purpose: 'wedding',
      scope: { maxDisclosure: 'count' },
      expiresAt: new Date('2026-12-31T00:00:00Z'),
    });
    const { service } = makeService({ grants: [previous] });

    const replacement = await service.supersede(OWNER, 'grant-1', { mode: 'review' });

    expect(replacement.dataClass).toBe('beach');
    expect(replacement.purpose).toBe('wedding');
    expect(replacement.scope).toEqual({ maxDisclosure: 'count' });
    expect(replacement.expiresAt).toEqual(new Date('2026-12-31T00:00:00Z'));
    expect(replacement.queryType).toBe('photos');
    expect(replacement.granteeUserId).toBe('asker-1');
  });

  it('keeps a PEER grantee a peer grantee', async () => {
    // A grant addressed to a linked peer became writable through GraphQL only
    // once `createAskGrant` learned `granteePeerLinkId`; the change path has to
    // carry it too. `UpdateAskGrantDto` names no grantee at all — the grantee is
    // part of WHICH grant this is — so the replacement copies both keys, which
    // is also what keeps it on the right side of `ask_grants_grantee_chk`:
    // exactly one of the two is set, before and after.
    const previous = grantRow({ granteeUserId: null, granteePeerLinkId: 'link-ada' });
    const { service } = makeService({ grants: [previous] });

    const replacement = await service.supersede(OWNER, 'grant-1', { mode: 'review' });

    expect(replacement.granteePeerLinkId).toBe('link-ada');
    expect(replacement.granteeUserId).toBeNull();
  });

  /**
   * ═══ NARROWING A GRANT USED TO WIDEN ITS DISCLOSURE ═══
   *
   * `scope` carries several INDEPENDENT restrictions and the Grant Manager edits
   * them one at a time, but `supersede` assigned the object WHOLESALE
   * (`changes.scope ?? previous.scope`). So an owner tightening the class list of
   * a grant capped at "digest only" sent `{ dataClasses: [...] }` and silently
   * DELETED `maxDisclosure` with it — the next ask under that grant disclosed in
   * full. The edit the owner made did narrow; the one they did not make widened,
   * invisibly, in the same tap.
   */
  describe('SECURITY: a scope change MERGES, so tightening one dimension cannot drop another', () => {
    const capped = () => grantRow({ scope: { maxDisclosure: 'summary', dataClasses: ['beach'] } });

    it('keeps maxDisclosure when only dataClasses is changed', async () => {
      const { service } = makeService({ grants: [capped()] });

      const replacement = await service.supersede(OWNER, 'grant-1', {
        scope: { dataClasses: ['beach', 'lake'] },
      });

      expect(replacement.scope).toEqual({ maxDisclosure: 'summary', dataClasses: ['beach', 'lake'] });
    });

    it('keeps dataClasses when only maxDisclosure is changed', async () => {
      const { service } = makeService({ grants: [capped()] });

      const replacement = await service.supersede(OWNER, 'grant-1', {
        scope: { maxDisclosure: 'count' },
      });

      expect(replacement.scope).toEqual({ maxDisclosure: 'count', dataClasses: ['beach'] });
    });

    it('replaces a list rather than appending to it — narrowing must stay narrowing', async () => {
      // Shallow by design: a deep merge would make "narrow this to lake" mean
      // "add lake to whatever it already covered".
      const { service } = makeService({ grants: [capped()] });

      const replacement = await service.supersede(OWNER, 'grant-1', { scope: { dataClasses: ['lake'] } });

      expect(replacement.scope?.dataClasses).toEqual(['lake']);
    });

    it('still honours an explicit null as "remove every scope restriction"', async () => {
      const { service } = makeService({ grants: [capped()] });

      const replacement = await service.supersede(OWNER, 'grant-1', { scope: null });

      expect(replacement.scope).toBeNull();
    });

    it('merges onto a grant that had no scope at all', async () => {
      const { service } = makeService({ grants: [grantRow({ scope: null })] });

      const replacement = await service.supersede(OWNER, 'grant-1', {
        scope: { maxDisclosure: 'boolean' },
      });

      expect(replacement.scope).toEqual({ maxDisclosure: 'boolean' });
    });
  });

  /**
   * Strict at WRITE time, fail-closed at READ time — the two halves are paired
   * on purpose. `ceilingOf` reads an unreadable `maxDisclosure` as `none`, the
   * strictest rung, so a typo can never be the loosest reading of the owner's
   * own restriction; that is right for a value already in the table and useless
   * as feedback, because the owner's grant would simply answer nothing forever
   * with no indication why.
   */
  describe('a declared disclosure ceiling must name a real rung', () => {
    it.each(['summry', 'everything', 'FULL', 'full ', '', 42, {}])('rejects %p on create', async (value) => {
      const { service, grantRepository } = makeService();

      await expect(
        service.create(OWNER, {
          granteeUserId: 'asker-1',
          queryType: 'photos',
          scope: { maxDisclosure: value as never },
        }),
      ).rejects.toThrow(/maxDisclosure/);
      expect(grantRepository.save).not.toHaveBeenCalled();
    });

    it('rejects it on a change too, before anything is written', async () => {
      const { service, grantRepository } = makeService();

      await expect(
        service.supersede(OWNER, 'grant-1', { scope: { maxDisclosure: 'summry' as never } }),
      ).rejects.toThrow(/maxDisclosure/);
      expect(grantRepository.manager.transaction).not.toHaveBeenCalled();
    });

    it('accepts every rung on the ladder, and an omitted ceiling', async () => {
      for (const rung of ['none', 'boolean', 'count', 'summary', 'redacted', 'full'] as const) {
        const { service } = makeService();
        const created = await service.create(OWNER, {
          granteeUserId: 'asker-1',
          queryType: 'photos',
          scope: { maxDisclosure: rung },
        });
        expect(created.scope?.maxDisclosure).toBe(rung);
      }

      const { service } = makeService();
      await expect(
        service.create(OWNER, { granteeUserId: 'asker-1', queryType: 'photos', scope: { dataClasses: [] } }),
      ).resolves.toMatchObject({ scope: { dataClasses: [] } });
    });
  });

  it('distinguishes "clear the expiry" (explicit null) from "leave it alone" (omitted)', async () => {
    const withExpiry = () => grantRow({ expiresAt: new Date('2026-12-31T00:00:00Z') });

    const cleared = await makeService({ grants: [withExpiry()] }).service.supersede(OWNER, 'grant-1', {
      expiresAt: null,
    });
    expect(cleared.expiresAt).toBeNull();

    const untouched = await makeService({ grants: [withExpiry()] }).service.supersede(OWNER, 'grant-1', {
      mode: 'review',
    });
    expect(untouched.expiresAt).toEqual(new Date('2026-12-31T00:00:00Z'));
  });

  it('SECURITY: cascades like a revoke — asks riding the OLD grant lose their pre-authorization', async () => {
    const stranded = askRow();
    const { service } = makeService({ asks: [stranded] });

    await service.supersede(OWNER, 'grant-1', { mode: 'block' });

    expect(stranded.consentBasis).toBeNull();
    expect(stranded.status).toBe('under_review');
  });

  it('refuses to change a grant that is already revoked or lapsed', async () => {
    const revoked = makeService({ grants: [grantRow({ revokedAt: NOW })] });
    await expect(revoked.service.supersede(OWNER, 'grant-1', { mode: 'review' })).rejects.toThrow(
      /no longer active/,
    );

    const lapsed = makeService({ grants: [grantRow({ expiresAt: new Date('2020-01-01T00:00:00Z') })] });
    await expect(lapsed.service.supersede(OWNER, 'grant-1', { mode: 'review' })).rejects.toThrow(
      /no longer active/,
    );
  });

  it('rejects an expiry in the past rather than letting the DB CHECK 500', async () => {
    const { service } = makeService();

    await expect(
      service.supersede(OWNER, 'grant-1', { expiresAt: new Date('2020-01-01T00:00:00Z') }),
    ).rejects.toThrow(/must be in the future/);
  });
});

// DEFECT 5 — revoked grants were unreachable through every read path.
describe('GrantService read paths', () => {
  it('listForOwner stays active-only, and now excludes LAPSED grants too', async () => {
    const rows = [
      grantRow({ id: 'live' }),
      grantRow({ id: 'lapsed', expiresAt: new Date('2020-01-01T00:00:00Z') }),
    ];
    const { service } = makeService({ grants: rows });

    const listed = await service.listForOwner(OWNER);

    expect(listed.map((g) => g.id)).toEqual(['live']);
  });

  it('listHistoryForOwner returns revoked grants — History has to be resolvable', async () => {
    const rows = [
      grantRow({ id: 'live' }),
      grantRow({ id: 'gone', revokedAt: NOW, revocationReason: 'revoked' }),
    ];
    const { service, grantRepository } = makeService({ grants: rows });

    const history = await service.listHistoryForOwner(OWNER);

    expect(history.map((g) => g.id)).toEqual(['live', 'gone']);
    // No liveness clause at all — that is what makes it history.
    expect(grantRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerUserId: 'owner-1' } }),
    );
  });

  it('findByIdForOwner resolves a REVOKED grant, so a disclosure can name its basis', async () => {
    const { service } = makeService({ grants: [grantRow({ revokedAt: NOW, revocationReason: 'revoked' })] });

    const found = await service.findByIdForOwner(OWNER, 'grant-1');

    expect(found?.id).toBe('grant-1');
    expect(found?.revocationReason).toBe('revoked');
  });
});
