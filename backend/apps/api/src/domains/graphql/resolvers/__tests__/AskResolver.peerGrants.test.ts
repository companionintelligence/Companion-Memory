import { type RequestContext } from '@ci/common/context';
import { type AskGrant } from '@ci/domains/asks';

import { GlobalUID } from '../../types/GlobalUID';
import { AskResolver } from '../AskResolver';

/**
 * ═══ A GRANT ADDRESSED TO A PEER WAS UNREACHABLE FROM THE API ═══
 *
 * Everything below GraphQL has supported it since the peer-links migration:
 * `CreateAskGrantDto` carries `granteePeerLinkId`, `GrantService.create` writes
 * it and enforces exactly-one-of, and `ask_grants_grantee_chk` backs the same
 * rule in the database. `createAskGrant` took only a user `granteeId` and
 * hard-coded `granteeUserId`, so an owner could not pre-authorize a linked peer
 * at all — the two-box federation harness had to insert every peer grant as raw
 * SQL, and so did anyone else.
 *
 * The exactly-one-of rule is enforced HERE rather than left to the CHECK: the
 * constraint is the right backstop, but it arrives as a 500 carrying a
 * constraint name.
 */

const CTX = { userId: 'owner-1' } as unknown as RequestContext;
const NOW = new Date('2026-08-20T00:00:00Z');
const USER_GID = GlobalUID.encode('user', 'asker-1');
const GRANT_GID = GlobalUID.encode('ask-grant', 'grant-1');

function fakeGrant(overrides: Partial<AskGrant> = {}): AskGrant {
  return {
    id: 'grant-2',
    ownerUserId: 'owner-1',
    granteeUserId: null,
    granteePeerLinkId: 'link-ada',
    queryType: 'photos',
    dataClass: null,
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
  } as AskGrant;
}

function makeResolver(options: { links?: Record<string, unknown>[] } = {}) {
  const links = options.links ?? [
    { id: 'link-ada', ownerUserId: 'owner-1', peerHandle: 'ada', trustTier: 'trusted' },
  ];

  const grantService = {
    create: jest.fn().mockResolvedValue(fakeGrant()),
    supersede: jest
      .fn()
      .mockResolvedValue(fakeGrant({ id: 'grant-3', version: 2, supersedesGrantId: 'grant-1' })),
  };
  // Owner-scoped, as the real service is.
  const peerLinkService = {
    findById: jest.fn(
      async (context: { userId: string }, id: string) =>
        links.find((link) => link.id === id && link.ownerUserId === context.userId) ?? null,
    ),
  };
  const featureService = { isFeatureEnabled: jest.fn().mockResolvedValue(true) };

  const resolver = new AskResolver(
    {} as never,
    grantService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    peerLinkService as never,
    {} as never,
    {
      // The household-tier service. `resolveTier` consults it for a LOCAL
      // asker; undefined member means the default (`household`) still applies.
      tierFor: jest.fn().mockResolvedValue('household'),
      listForOwner: jest.fn().mockResolvedValue([]),
      setTier: jest.fn(),
    } as never,
    {
      // The broadcast service. `createAskBroadcast` / `myAskBroadcasts` are the
      // only callers; every other operation here never touches it.
      create: jest.fn(),
      listForAsker: jest.fn().mockResolvedValue([]),
      asksForBroadcasts: jest.fn().mockResolvedValue(new Map()),
      findForAsker: jest.fn(),
    } as never,
    featureService as never,
  );

  return { resolver, grantService, peerLinkService };
}

describe('createAskGrant can address a peer link', () => {
  it('writes granteePeerLinkId and leaves granteeUserId null', async () => {
    const { resolver, grantService } = makeResolver();

    const result = await resolver.createAskGrant(CTX, {
      granteePeerLinkId: 'link-ada',
      queryType: 'content',
      mode: 'auto',
    } as never);

    expect(grantService.create).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      expect.objectContaining({ granteeUserId: null, granteePeerLinkId: 'link-ada' }),
    );
    expect(result.grant?.granteePeerLinkId).toBe('link-ada');
    expect(result.grant?.granteeId).toBeNull();
  });

  it('still writes a USER grant the way it always did', async () => {
    const { resolver, grantService, peerLinkService } = makeResolver();

    await resolver.createAskGrant(CTX, {
      granteeId: USER_GID,
      queryType: 'content',
      mode: 'review',
    } as never);

    expect(grantService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ granteeUserId: 'asker-1', granteePeerLinkId: null }),
    );
    // No peers involved, so no peer read.
    expect(peerLinkService.findById).not.toHaveBeenCalled();
  });

  it('a peer grant still carries the disclosure ceiling and the rest of the scope', async () => {
    const { resolver, grantService } = makeResolver();

    await resolver.createAskGrant(CTX, {
      granteePeerLinkId: 'link-ada',
      queryType: 'content',
      dataClasses: ['beach'],
      maxDisclosure: 'count',
      mode: 'auto',
    } as never);

    expect(grantService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: { dataClasses: ['beach'], maxDisclosure: 'count' } }),
    );
  });
});

describe('exactly one grantee, refused at the input layer', () => {
  it('rejects BOTH with a 400 naming the two fields, not a CHECK violation', async () => {
    const { resolver, grantService } = makeResolver();

    await expect(
      resolver.createAskGrant(CTX, {
        granteeId: USER_GID,
        granteePeerLinkId: 'link-ada',
        queryType: 'photos',
        mode: 'auto',
      } as never),
    ).rejects.toThrow(/exactly one of granteeId \/ granteePeerLinkId/);
    expect(grantService.create).not.toHaveBeenCalled();
  });

  it('rejects NEITHER for the same reason', async () => {
    // Both fields are nullable in the schema now, so "no grantee at all" became
    // expressible and has to be refused here.
    const { resolver, grantService } = makeResolver();

    await expect(
      resolver.createAskGrant(CTX, { queryType: 'photos', mode: 'auto' } as never),
    ).rejects.toThrow(/exactly one of granteeId \/ granteePeerLinkId/);
    expect(grantService.create).not.toHaveBeenCalled();
  });

  it('SECURITY: refuses a link this owner does not have, rather than storing it', async () => {
    // An unknown id would land as an FK violation (a 500); somebody ELSE's link
    // id would be storable, letting an owner write consent against a
    // relationship that is not theirs. The owner-scoped read makes both a 404.
    const { resolver, grantService } = makeResolver({
      links: [{ id: 'link-ada', ownerUserId: 'someone-else', peerHandle: 'ada' }],
    });

    await expect(
      resolver.createAskGrant(CTX, {
        granteePeerLinkId: 'link-ada',
        queryType: 'photos',
        mode: 'auto',
      } as never),
    ).rejects.toThrow(/Peer link link-ada not found/);
    expect(grantService.create).not.toHaveBeenCalled();
  });

  it('stays dark behind the `ask` feature flag before it validates anything', async () => {
    const { grantService } = makeResolver();
    const featureOff = new AskResolver(
      {} as never,
      grantService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        // The household-tier service. `resolveTier` consults it for a LOCAL
        // asker; undefined member means the default (`household`) still applies.
        tierFor: jest.fn().mockResolvedValue('household'),
        listForOwner: jest.fn().mockResolvedValue([]),
        setTier: jest.fn(),
      } as never,
      {
        // The broadcast service. `createAskBroadcast` / `myAskBroadcasts` are the
        // only callers; every other operation here never touches it.
        create: jest.fn(),
        listForAsker: jest.fn().mockResolvedValue([]),
        asksForBroadcasts: jest.fn().mockResolvedValue(new Map()),
        findForAsker: jest.fn(),
      } as never,
      { isFeatureEnabled: jest.fn().mockResolvedValue(false) } as never,
    );

    // Names neither grantee — it would be a 400 if the flag were on.
    await expect(
      featureOff.createAskGrant(CTX, { queryType: 'photos', mode: 'auto' } as never),
    ).resolves.toEqual({
      success: false,
    });
    expect(grantService.create).not.toHaveBeenCalled();
  });
});

describe('updateAskGrant is coherent on a peer grant', () => {
  it('supersedes it without naming a grantee, so the replacement stays a peer grant', async () => {
    // The grantee identifies WHICH grant this is; `GrantService.supersede`
    // copies `granteePeerLinkId` onto the replacement. A change that let the
    // caller restate it could flip a peer grant into a user grant, or produce a
    // row naming both and fail `ask_grants_grantee_chk`.
    const { resolver, grantService } = makeResolver();

    const result = await resolver.updateAskGrant(CTX, GRANT_GID, { mode: 'review' } as never);

    const [, , changes] = grantService.supersede.mock.calls[0];
    expect(changes).not.toHaveProperty('granteeUserId');
    expect(changes).not.toHaveProperty('granteePeerLinkId');
    expect(result.grant?.granteePeerLinkId).toBe('link-ada');
    expect(result.grant?.granteeId).toBeNull();
  });
});
