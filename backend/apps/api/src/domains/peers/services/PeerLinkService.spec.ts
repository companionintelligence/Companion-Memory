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
});
