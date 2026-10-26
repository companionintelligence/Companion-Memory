import { ConflictException } from '@nestjs/common';
import { FindOperator } from 'typeorm';

import { type PeerLinkEntity } from '../entities/PeerLinkEntity';

import { PeerLinkService } from './PeerLinkService';

function makeService() {
  const repository = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation((row: unknown) => row),
    save: jest.fn().mockImplementation((row: unknown) => Promise.resolve({ ...(row as object) })),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn() };
  const service = new PeerLinkService(repository as never, logger as never);

  return { service, repository };
}

const CTX = { userId: 'owner-1' };
const DTO = { peerHandle: 'devon', memoryEndpoint: 'https://devon.example.com/agent/v1' };

/**
 * `ci.peer_links.trust_tier` CHECKs four values. A fifth, `household`, exists in
 * the `TrustTier` union and is the LOCAL tier — the widest ceiling in
 * `TIER_CEILINGS` and the only one exempt from the sensitive-class floor. The
 * type already excludes it at COMPILE time, but this method's input arrives from
 * a Portal directory descriptor and from GraphQL, where a type is only a
 * promise: unguarded, the CHECK fires as a `23514` the driver raises AFTER the
 * statement, which surfaces to a caller as a bare `500 Internal server error`.
 */
describe('PeerLinkService.upsert — the trust tier is validated before the write', () => {
  it('refuses `household` by name, in front of the insert', async () => {
    const { service, repository } = makeService();

    await expect(service.upsert(CTX as never, { ...DTO, trustTier: 'household' as never })).rejects.toThrow(
      /Unknown peer trust tier: household/,
    );
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('refuses anything else the CHECK would reject', async () => {
    const { service, repository } = makeService();

    for (const bad of ['admin', 'FAMILY', '']) {
      await expect(service.upsert(CTX as never, { ...DTO, trustTier: bad as never })).rejects.toThrow(
        /Unknown peer trust tier/,
      );
    }

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('accepts every tier the CHECK admits', async () => {
    for (const tier of ['family', 'trusted', 'peer', 'stranger'] as const) {
      const { service, repository } = makeService();

      await service.upsert(CTX as never, { ...DTO, trustTier: tier });

      expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ trustTier: tier }));
    }
  });

  it('still defaults to `peer` when the caller says nothing', async () => {
    const { service, repository } = makeService();

    await service.upsert(CTX as never, DTO);

    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ trustTier: 'peer' }));
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE (iss, sub) BINDING — VALIDATED IN FRONT OF THE WRITE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `peerIssuer` / `peerSubject` decide WHICH REMOTE IDENTITY MAY ACT AS THIS
 * PEER: an inbound token bearing that pair resolves to this link and inherits
 * its `trustTier`, the ceiling on everything the box will disclose. Two ways to
 * get that wrong that a type cannot catch, both refused here for the same
 * reason the trust tier is:
 *
 *   * HALF A PAIR. `findActiveByPeerIdentity` filters on BOTH columns, so a
 *     link carrying one alone can never match anything. It is inert while
 *     looking bound — the worst of both, because the owner believes federation
 *     is configured and every inbound ask 403s with "No peer link".
 *   * A BLANK HALF. `PortalTokenService.verifyClaims` returns null unless both
 *     claims are non-empty, so `''` is the same inert state wearing a value.
 *
 * The duplicate-identity rule is NOT here: it cannot be, because a
 * read-then-write check races. It lives in `peer_links_owner_identity_live_uniq`
 * and is proved in `PeerLinkIdentityBinding.integration.spec.ts`; what this
 * block pins is the translation of that index's `23505` into a `409` rather
 * than a bare `500`.
 */
describe('PeerLinkService.upsert — the peer identity binding', () => {
  const IDENTITY_DTO = { peerIssuer: 'https://portal.example', peerSubject: 'devon-sub' };

  it('writes both halves when both are given', async () => {
    const { service, repository } = makeService();

    await service.upsert(CTX as never, { ...DTO, ...IDENTITY_DTO });

    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining(IDENTITY_DTO));
  });

  it('trims surrounding whitespace rather than storing a value that cannot match', async () => {
    const { service, repository } = makeService();

    await service.upsert(CTX as never, {
      ...DTO,
      peerIssuer: '  https://portal.example  ',
      peerSubject: '\tdevon-sub\n',
    });

    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining(IDENTITY_DTO));
  });

  it('leaves both NULL when the caller says nothing — an unfederated link is the normal case', async () => {
    const { service, repository } = makeService();

    await service.upsert(CTX as never, DTO);

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ peerIssuer: null, peerSubject: null }),
    );
  });

  it('refuses half a pair, in front of the insert', async () => {
    for (const half of [{ peerIssuer: 'https://portal.example' }, { peerSubject: 'devon-sub' }]) {
      const { service, repository } = makeService();

      await expect(service.upsert(CTX as never, { ...DTO, ...half })).rejects.toThrow(/must be set together/);
      expect(repository.save).not.toHaveBeenCalled();
    }
  });

  it('refuses a blank half by name, so `--peer-issuer ""` cannot look like it worked', async () => {
    for (const [field, dto] of [
      ['peerIssuer', { ...IDENTITY_DTO, peerIssuer: '   ' }],
      ['peerSubject', { ...IDENTITY_DTO, peerSubject: '' }],
    ] as const) {
      const { service, repository } = makeService();

      await expect(service.upsert(CTX as never, { ...DTO, ...dto })).rejects.toThrow(
        new RegExp(`${field} must not be blank`),
      );
      expect(repository.save).not.toHaveBeenCalled();
    }
  });

  it('accepts one half that COMPLETES an existing binding', async () => {
    // The rule is about the merged ROW, not the input: re-pointing only the
    // subject of an already-bound link is a legitimate write.
    const { service, repository } = makeService();

    repository.findOne.mockResolvedValue({
      id: 'link-1',
      ownerUserId: 'owner-1',
      peerHandle: 'devon',
      peerIssuer: 'https://portal.example',
      peerSubject: 'old-sub',
    });

    await service.upsert(CTX as never, { ...DTO, peerSubject: 'devon-sub' });

    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining(IDENTITY_DTO));
  });

  it('lets an unrelated edit through on a link whose columns were left half-set by hand', async () => {
    // Hand-written SQL was the ONLY way to set these columns before this change
    // (docs/peer-federation.md), so half-set rows exist in the wild. Refusing
    // every later rename or re-tier of such a row would turn a legacy
    // inconsistency into an outage — the rule applies to writes that TOUCH the
    // identity, not to every write that passes near one.
    const { service, repository } = makeService();

    repository.findOne.mockResolvedValue({
      id: 'link-1',
      ownerUserId: 'owner-1',
      peerHandle: 'devon',
      peerIssuer: 'https://portal.example',
      peerSubject: null,
    });

    await service.upsert(CTX as never, { ...DTO, trustTier: 'family' });

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ trustTier: 'family', peerIssuer: 'https://portal.example' }),
    );
  });

  it('reports the duplicate-identity index as a 409, not a bare 500', async () => {
    const { service, repository } = makeService();

    repository.save.mockRejectedValue(
      Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint: 'peer_links_owner_identity_live_uniq',
      }),
    );

    await expect(service.upsert(CTX as never, { ...DTO, ...IDENTITY_DTO })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('reads a 23505 with no constraint name as the identity clash — poolers drop the field', async () => {
    const { service, repository } = makeService();

    repository.save.mockRejectedValue(
      Object.assign(new Error('duplicate key'), { driverError: { code: '23505' } }),
    );

    await expect(service.upsert(CTX as never, { ...DTO, ...IDENTITY_DTO })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rethrows a 23505 naming ANOTHER constraint — a handle collision is not an identity clash', async () => {
    const { service, repository } = makeService();
    const handleClash = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'peer_links_owner_handle_uniq',
    });

    repository.save.mockRejectedValue(handleClash);

    await expect(service.upsert(CTX as never, { ...DTO, ...IDENTITY_DTO })).rejects.toBe(handleClash);
  });

  it('rethrows the identity conflict untranslated when the write never touched the identity', async () => {
    // A rename that trips a unique index did not "claim someone else's
    // identity", and saying so would be a lie the caller cannot act on.
    const { service, repository } = makeService();
    const err = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'peer_links_owner_identity_live_uniq',
    });

    repository.save.mockRejectedValue(err);

    await expect(service.upsert(CTX as never, { ...DTO, displayName: 'Devon' })).rejects.toBe(err);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REVOCATION IS IMMEDIATE — THE FILTER THAT MAKES IT TRUE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `docs/peer-federation.md` lists "revocation is immediate" as a SECURITY
 * PROPERTY, and `PeerLinkResolver.revokePeerLink`'s docstring names the exact
 * mechanism that delivers it:
 *
 *   > `findActiveByPeerIdentity` filters on `revokedAt IS NULL`, so the next
 *   > inbound token from that peer fails to resolve a link and the ask is
 *   > refused before any policy runs.
 *
 * Until this block existed, that promise was pinned by NOTHING. Deleting
 * `status: 'active', revokedAt: IsNull()` from either finder left the whole
 * backend suite green, because the only other tests that touch these methods
 * (`PeerAskService.spec.ts`, `PeerAskLifecycle.integration.spec.ts`,
 * `AskDisclosureCeiling.integration.spec.ts`) all MOCK `findActiveByPeerIdentity`
 * outright. A mock returning `[link]` models the answer, never the query.
 *
 * A revoked peer that still resolves is not a stale read: `resolveLink` is the
 * ONLY gate in front of `PeerAskService`, so the peer keeps authenticating and
 * keeps receiving answers the owner believes they cut off.
 *
 * ═══ WHY A FAKE THAT EVALUATES THE CLAUSE, NOT A `toHaveBeenCalledWith` ═══
 *
 * Asserting the literal `where` object pins the SPELLING of the filter, and
 * goes red on a refactor that preserves the behaviour exactly. This fake
 * applies the clause it is handed to real rows, so what is pinned is the
 * OUTCOME — a revoked row does not come back — under any spelling. It goes red
 * only when a revoked peer actually becomes reachable again.
 */
type FakeRow = PeerLinkEntity;

/** The subset of TypeORM's `where` grammar these two finders use. */
function rowMatches(row: FakeRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, expected]) => {
    const actual = (row as unknown as Record<string, unknown>)[field];

    if (expected instanceof FindOperator) {
      if (expected.type === 'isNull') {
        return actual == null;
      }

      // Loud rather than silently true: an unmodelled operator would otherwise
      // make this fake agree with any filter, which is the failure mode the
      // whole block exists to prevent.
      throw new Error(`rowMatches does not model FindOperator "${expected.type}" — teach it before using it`);
    }

    return actual === expected;
  });
}

function link(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: 'link-1',
    ownerUserId: 'owner-1',
    peerHandle: 'devon',
    displayName: 'Devon',
    memoryEndpoint: 'https://devon.example.com/agent/v1',
    peerIssuer: 'https://portal.example.com',
    peerSubject: 'devon-sub',
    personEntityId: null,
    trustTier: 'peer',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    revokedAt: null,
    ...overrides,
  } as FakeRow;
}

/** A service over rows the fake repository really filters. */
function makeServiceOverRows(rows: FakeRow[]) {
  const repository = {
    find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.filter((row) => rowMatches(row, where))),
    ),
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.find((row) => rowMatches(row, where)) ?? null),
    ),
    create: jest.fn().mockImplementation((row: unknown) => row),
    save: jest.fn().mockImplementation((row: FakeRow) => Promise.resolve(row)),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn() };

  return { service: new PeerLinkService(repository as never, logger as never), repository, rows };
}

const IDENTITY = { issuer: 'https://portal.example.com', subject: 'devon-sub' };

describe('PeerLinkService — a revoked peer does not authenticate', () => {
  describe('findActiveByPeerIdentity — the inbound-ask entry point', () => {
    it('resolves a peer that has NOT been revoked (the fake is not vacuously empty)', async () => {
      const { service } = makeServiceOverRows([link()]);

      const found = await service.findActiveByPeerIdentity(IDENTITY.issuer, IDENTITY.subject);

      expect(found).toHaveLength(1);
      expect(found[0]?.peerHandle).toBe('devon');
    });

    it('does NOT resolve a peer the owner revoked', async () => {
      // Exactly what `revoke()` writes: status flipped AND revokedAt stamped.
      const { service } = makeServiceOverRows([
        link({ status: 'revoked', revokedAt: new Date('2026-02-01T00:00:00Z') }),
      ]);

      await expect(service.findActiveByPeerIdentity(IDENTITY.issuer, IDENTITY.subject)).resolves.toEqual([]);
    });

    /**
     * The two clauses are pinned SEPARATELY below, because a single fixture
     * that sets both is still excluded when only one clause survives — it
     * would let half the filter be deleted silently.
     */
    it('excludes on `revokedAt` alone, even if the status still reads active', async () => {
      const { service } = makeServiceOverRows([
        link({ status: 'active', revokedAt: new Date('2026-02-01T00:00:00Z') }),
      ]);

      await expect(service.findActiveByPeerIdentity(IDENTITY.issuer, IDENTITY.subject)).resolves.toEqual([]);
    });

    it('excludes on `status` alone, even if revokedAt was never stamped', async () => {
      const { service } = makeServiceOverRows([link({ status: 'revoked', revokedAt: null })]);

      await expect(service.findActiveByPeerIdentity(IDENTITY.issuer, IDENTITY.subject)).resolves.toEqual([]);
    });

    it('never returns a `pending` link — a link is not consent until it is active', async () => {
      const { service } = makeServiceOverRows([link({ status: 'pending', revokedAt: null })]);

      await expect(service.findActiveByPeerIdentity(IDENTITY.issuer, IDENTITY.subject)).resolves.toEqual([]);
    });

    it('returns only the surviving link when one of two identical peers is revoked', async () => {
      const { service } = makeServiceOverRows([
        link({ id: 'link-1', ownerUserId: 'owner-1', status: 'revoked', revokedAt: new Date() }),
        link({ id: 'link-2', ownerUserId: 'owner-2' }),
      ]);

      const found = await service.findActiveByPeerIdentity(IDENTITY.issuer, IDENTITY.subject);

      // One row, not two: `resolveLink` refuses on `links.length > 1` as an
      // ambiguous household, so a revoked row leaking back here would not
      // merely widen access — it would DENY the surviving member as well.
      expect(found.map((row) => row.id)).toEqual(['link-2']);
    });
  });

  describe('findActiveByIssuerSubject — the owner-scoped attribution path', () => {
    it('resolves a link that has not been revoked', async () => {
      const { service } = makeServiceOverRows([link()]);

      const found = await service.findActiveByIssuerSubject('owner-1', IDENTITY.issuer, IDENTITY.subject);

      expect(found?.peerHandle).toBe('devon');
    });

    it('does NOT resolve a revoked link', async () => {
      const { service } = makeServiceOverRows([link({ status: 'revoked', revokedAt: new Date() })]);

      await expect(
        service.findActiveByIssuerSubject('owner-1', IDENTITY.issuer, IDENTITY.subject),
      ).resolves.toBeNull();
    });

    it('excludes on `revokedAt` alone', async () => {
      const { service } = makeServiceOverRows([link({ status: 'active', revokedAt: new Date() })]);

      await expect(
        service.findActiveByIssuerSubject('owner-1', IDENTITY.issuer, IDENTITY.subject),
      ).resolves.toBeNull();
    });

    it('excludes on `status` alone', async () => {
      const { service } = makeServiceOverRows([link({ status: 'revoked', revokedAt: null })]);

      await expect(
        service.findActiveByIssuerSubject('owner-1', IDENTITY.issuer, IDENTITY.subject),
      ).resolves.toBeNull();
    });

    it('stays scoped to the owner — another owner’s active link is not attributable', async () => {
      const { service } = makeServiceOverRows([link({ ownerUserId: 'someone-else' })]);

      await expect(
        service.findActiveByIssuerSubject('owner-1', IDENTITY.issuer, IDENTITY.subject),
      ).resolves.toBeNull();
    });
  });

  /**
   * The owner-facing promise, end to end over the same rows: revoke, then ask
   * again as that peer. This is the sentence the owner acts on — "I revoked
   * this peer" — and it must be true of the NEXT call, not of a later sweep.
   */
  it('revoke() makes the peer unresolvable on the very next inbound ask', async () => {
    const rows = [link()];
    const { service } = makeServiceOverRows(rows);

    await expect(service.findActiveByPeerIdentity(IDENTITY.issuer, IDENTITY.subject)).resolves.toHaveLength(
      1,
    );

    await service.revoke({ userId: 'owner-1' } as never, 'devon');

    // `revoke()` mutates and saves the row the fake handed it, so the fake's
    // backing array now holds exactly what Postgres would.
    expect(rows[0]?.status).toBe('revoked');
    expect(rows[0]?.revokedAt).toBeInstanceOf(Date);

    await expect(service.findActiveByPeerIdentity(IDENTITY.issuer, IDENTITY.subject)).resolves.toEqual([]);
  });

  it('SECURITY (G5b): editing a revoked link via upsert without explicit status=active preserves revokedAt', async () => {
    const revokedTimestamp = new Date('2026-02-01T00:00:00Z');
    const rows = [link({ status: 'revoked', revokedAt: revokedTimestamp })];
    const { service } = makeServiceOverRows(rows);

    const updated = await service.upsert(CTX as never, {
      ...DTO,
      displayName: 'Devon (Former)',
      trustTier: 'stranger',
    });

    expect(updated.status).toBe('revoked');
    expect(updated.revokedAt).toEqual(revokedTimestamp);
  });

  it('re-adding a revoked link with status=active makes it live again at the tier given', async () => {
    // What `createPeerLink` sends. The peer resolves again on the next ask,
    // which is what the owner asked for by adding them back.
    const rows = [
      link({ status: 'revoked', revokedAt: new Date('2026-02-01T00:00:00Z'), trustTier: 'peer' }),
    ];
    const { service, repository } = makeServiceOverRows(rows);
    // `upsert` saves a merged copy rather than the row it read, so store it
    // back the way Postgres would before asking again.
    repository.save.mockImplementation((row: FakeRow) => {
      rows[0] = row;

      return Promise.resolve(row);
    });

    const relinked = await service.upsert(CTX as never, { ...DTO, trustTier: 'stranger', status: 'active' });

    expect(relinked).toMatchObject({ status: 'active', revokedAt: null, trustTier: 'stranger' });
    await expect(service.findActiveByPeerIdentity(IDENTITY.issuer, IDENTITY.subject)).resolves.toHaveLength(
      1,
    );
  });

  it('reports a re-activation that clashes on the live identity index as a 409, not a bare 500', async () => {
    // The revoked link still carries its (iss, sub). If another live link took
    // that identity meanwhile, bringing this one back trips the partial index
    // even though the write names no identity.
    const rows = [link({ status: 'revoked', revokedAt: new Date('2026-02-01T00:00:00Z') })];
    const { service, repository } = makeServiceOverRows(rows);

    repository.save.mockRejectedValue(
      Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint: 'peer_links_owner_identity_live_uniq',
      }),
    );

    await expect(service.upsert(CTX as never, { ...DTO, status: 'active' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
