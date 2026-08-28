import { type RequestContext } from '@ci/common/context';
import { type AskGrant } from '@ci/domains/asks';

import { GlobalUID } from '../../types/GlobalUID';
import { AskResolver } from '../AskResolver';

/**
 * The Grant Manager's GraphQL surface: changing a grant, and reading grant
 * history.
 *
 * Kept in its own file rather than folded into AskResolver.test.ts so the two
 * can be edited independently — the ask/answer half of this resolver is under
 * concurrent change.
 */

const CTX = { userId: 'owner-1' } as unknown as RequestContext;
const NOW = new Date('2026-07-15T00:00:00Z');

function fakeGrant(overrides: Partial<AskGrant> = {}): AskGrant {
  return {
    id: 'grant-2',
    ownerUserId: 'owner-1',
    granteeUserId: 'asker-1',
    granteePeerLinkId: null,
    queryType: 'photos',
    dataClass: 'beach',
    scope: null,
    mode: 'review',
    purpose: null,
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
    expiresAt: null,
    revocationReason: null,
    version: 2,
    supersedesGrantId: 'grant-1',
    ...overrides,
  } as AskGrant;
}

function makeResolver(enabled = true) {
  const grantService = {
    create: jest.fn().mockResolvedValue(fakeGrant()),
    revoke: jest.fn(),
    supersede: jest.fn().mockResolvedValue(fakeGrant()),
    listForOwner: jest.fn().mockResolvedValue([]),
    listHistoryForOwner: jest.fn().mockResolvedValue([fakeGrant({ id: 'grant-1', revokedAt: NOW })]),
    findByIdForOwner: jest.fn().mockResolvedValue(fakeGrant({ id: 'grant-1', revokedAt: NOW })),
  };
  const featureService = { isFeatureEnabled: jest.fn().mockResolvedValue(enabled) };

  const resolver = new AskResolver(
    {} as never,
    grantService as never,
    // The audit service, for grant USAGE. `myAskGrants` joins "how often has
    // this fired" onto every row, so a bare {} here fails at the call rather
    // than silently reporting every grant dormant.
    { usageByGrant: jest.fn().mockResolvedValue(new Map()) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      tierFor: jest.fn().mockResolvedValue('household'),
      listForOwner: jest.fn(),
      setTier: jest.fn(),
    } as never,
    { listForAsker: jest.fn(), asksForBroadcasts: jest.fn(), create: jest.fn() } as never,
    featureService as never,
  );

  return { resolver, grantService };
}

const GRANT_GID = GlobalUID.encode('ask-grant', 'grant-1');

/**
 * ═══ THE DISCLOSURE CEILING HAD THREE READERS AND NO WRITER ═══
 *
 * `scope.maxDisclosure` is read by the grant evaluator, by the local answer
 * path and by the federated one — and was written by nothing. Both grant
 * mutations hard-coded `scope` to `{ dataClasses }` or `null`, there was no
 * input field, no default and no seed, so "digest only" was a posture the owner
 * could not express and every clamp built on it was inert.
 */
describe('AskResolver grant mutations write the disclosure ceiling', () => {
  it('createAskGrant persists maxDisclosure into the grant scope', async () => {
    const { resolver, grantService } = makeResolver();

    await resolver.createAskGrant(CTX, {
      granteeId: GlobalUID.encode('user', 'asker-1'),
      queryType: 'content',
      dataClasses: ['beach'],
      maxDisclosure: 'summary',
      mode: 'auto',
    } as never);

    expect(grantService.create).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      expect.objectContaining({ scope: { dataClasses: ['beach'], maxDisclosure: 'summary' } }),
    );
  });

  it('createAskGrant still stores a NULL scope when no dimension is supplied', async () => {
    // Not `{}` — an empty object would claim the grant carries a scope.
    const { resolver, grantService } = makeResolver();

    await resolver.createAskGrant(CTX, {
      granteeId: GlobalUID.encode('user', 'asker-1'),
      queryType: 'content',
      mode: 'auto',
    } as never);

    expect(grantService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: null }),
    );
  });

  it('a ceiling can be set WITHOUT restating the class list', async () => {
    // The half that used to be inexpressible: `scope` was built from
    // `dataClasses` alone, so there was no way to say "cap this" at all.
    const { resolver, grantService } = makeResolver();

    await resolver.updateAskGrant(CTX, GRANT_GID, { maxDisclosure: 'boolean' } as never);

    expect(grantService.supersede).toHaveBeenCalledWith(
      expect.anything(),
      'grant-1',
      expect.objectContaining({ scope: { maxDisclosure: 'boolean' } }),
    );
  });

  it('narrowing dataClasses passes ONLY that dimension, leaving the ceiling for the merge', async () => {
    // The resolver must not reconstruct the whole scope from the input, or it
    // would re-create the wholesale replacement that deleted `maxDisclosure`.
    // It sends the dimensions the caller touched; `GrantService.supersede`
    // folds them onto the previous scope.
    const { resolver, grantService } = makeResolver();

    await resolver.updateAskGrant(CTX, GRANT_GID, { dataClasses: ['beach'] } as never);

    expect(grantService.supersede).toHaveBeenCalledWith(
      expect.anything(),
      'grant-1',
      expect.objectContaining({ scope: { dataClasses: ['beach'] } }),
    );
  });

  it('an EMPTY dataClasses list is a real instruction, not an absence', async () => {
    // "No classes permitted" is a posture an owner can hold, and `[]` is
    // falsy — the presence test has to be `!= null` or this reads as "omitted"
    // and silently inherits the previous list instead.
    const { resolver, grantService } = makeResolver();

    await resolver.updateAskGrant(CTX, GRANT_GID, { dataClasses: [] } as never);

    expect(grantService.supersede).toHaveBeenCalledWith(
      expect.anything(),
      'grant-1',
      expect.objectContaining({ scope: { dataClasses: [] } }),
    );
  });
});

// DEFECT 6 — the matrix's core interaction had no backing mutation.
describe('AskResolver.updateAskGrant', () => {
  it('supersedes the grant and returns the replacement', async () => {
    const { resolver, grantService } = makeResolver();

    const result = await resolver.updateAskGrant(CTX, GRANT_GID, { mode: 'review' } as never);

    expect(grantService.supersede).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      'grant-1',
      expect.objectContaining({ mode: 'review' }),
    );
    expect(result.success).toBe(true);
    expect(result.grant?.version).toBe(2);
    expect(result.grant?.supersedesGrantId).toBe(GRANT_GID);
  });

  it('an omitted dataClasses inherits the previous scope rather than clearing it', async () => {
    const { resolver, grantService } = makeResolver();

    await resolver.updateAskGrant(CTX, GRANT_GID, { mode: 'block' } as never);

    expect(grantService.supersede).toHaveBeenCalledWith(
      expect.anything(),
      'grant-1',
      expect.objectContaining({ scope: undefined }),
    );
  });

  it('refuses contradictory expiry instructions instead of guessing', async () => {
    const { resolver, grantService } = makeResolver();

    await expect(
      resolver.updateAskGrant(CTX, GRANT_GID, {
        expiresAt: new Date('2026-12-31T00:00:00Z'),
        clearExpiry: true,
      } as never),
    ).rejects.toThrow(/either expiresAt or clearExpiry/);
    expect(grantService.supersede).not.toHaveBeenCalled();
  });

  it('clearExpiry passes an explicit null (remove), not undefined (inherit)', async () => {
    const { resolver, grantService } = makeResolver();

    await resolver.updateAskGrant(CTX, GRANT_GID, { clearExpiry: true } as never);

    expect(grantService.supersede).toHaveBeenCalledWith(
      expect.anything(),
      'grant-1',
      expect.objectContaining({ expiresAt: null }),
    );
  });

  it('stays dark behind the `ask` feature flag', async () => {
    const { resolver, grantService } = makeResolver(false);

    await expect(resolver.updateAskGrant(CTX, GRANT_GID, { mode: 'review' } as never)).resolves.toEqual({
      success: false,
    });
    expect(grantService.supersede).not.toHaveBeenCalled();
  });
});

// DEFECT 5 — revoked grants were unreachable through every read path.
describe('AskResolver grant history', () => {
  it('myAskGrantHistory surfaces revoked grants (myAskGrants still does not)', async () => {
    const { resolver, grantService } = makeResolver();

    const history = await resolver.myAskGrantHistory(CTX);

    expect(grantService.listHistoryForOwner).toHaveBeenCalled();
    expect(history).toHaveLength(1);
    expect(history[0].revokedAt).toEqual(NOW);
    expect(history[0].active).toBe(false);

    await resolver.myAskGrants(CTX);
    expect(grantService.listForOwner).toHaveBeenCalled();
  });

  it('askGrant resolves a single revoked grant, so a disclosure can name its basis', async () => {
    const { resolver, grantService } = makeResolver();

    const grant = await resolver.askGrant(CTX, GRANT_GID);

    expect(grantService.findByIdForOwner).toHaveBeenCalledWith({ userId: 'owner-1' }, 'grant-1');
    expect(grant?.id).toBe(GRANT_GID);
    expect(grant?.active).toBe(false);
  });

  it('both history reads stay dark behind the `ask` feature flag', async () => {
    const { resolver, grantService } = makeResolver(false);

    await expect(resolver.myAskGrantHistory(CTX)).resolves.toEqual([]);
    await expect(resolver.askGrant(CTX, GRANT_GID)).resolves.toBeNull();
    expect(grantService.listHistoryForOwner).not.toHaveBeenCalled();
    expect(grantService.findByIdForOwner).not.toHaveBeenCalled();
  });
});

// DEFECT 4 — the type had no expiry field at all for GrantRow to render.
describe('AskGrantType lifecycle projection', () => {
  it('exposes expiresAt and a computed `active` that accounts for a lapse', async () => {
    const { resolver, grantService } = makeResolver();
    grantService.findByIdForOwner.mockResolvedValue(
      fakeGrant({ revokedAt: null, expiresAt: new Date('2020-01-01T00:00:00Z') }),
    );

    const grant = await resolver.askGrant(CTX, GRANT_GID);

    expect(grant?.expiresAt).toEqual(new Date('2020-01-01T00:00:00Z'));
    // Not revoked, but lapsed — a client reasoning from `revokedAt == null`
    // alone would call this live.
    expect(grant?.revokedAt).toBeNull();
    expect(grant?.active).toBe(false);
  });
});
