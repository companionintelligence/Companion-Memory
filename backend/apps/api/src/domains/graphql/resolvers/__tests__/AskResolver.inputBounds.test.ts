import { type RequestContext } from '@ci/common/context';
import { MAX_ASK_PROMPT_LENGTH } from '@ci/domains/asks';

import { GlobalUID } from '../../types/GlobalUID';
import { AskResolver } from '../AskResolver';

/**
 * The input rules exist in `asks/askInput.ts` and are unit-tested there. THIS
 * file pins that the two mutations which accept attacker-controlled strings
 * actually RUN them.
 *
 * Both halves are needed and neither implies the other. `askInput.spec.ts`
 * proves the parser refuses `photos`; deleting the call from the resolver body
 * leaves every one of those tests green while the surface goes back to
 * accepting any word at all. That is exactly how `queryType` came to be matched
 * raw on one side of the consent gate and canonicalized on the other.
 *
 * MUTATION-TESTED: drop either `parseAskQueryInput` or `parseGrantQueryType`
 * from AskResolver and this suite goes red.
 */

const CTX = { userId: 'asker-1' } as unknown as RequestContext;

function makeResolver() {
  const askService = {
    submit: jest.fn().mockResolvedValue({
      ask: {
        id: 'ask-1',
        askerUserId: 'asker-1',
        responderUserId: 'responder-1',
        query: { queryType: 'content', prompt: 'photos of us?' },
        status: 'under_review',
        consentBasis: null,
        createdAt: new Date('2026-08-21T00:00:00Z'),
        updatedAt: new Date('2026-08-21T00:00:00Z'),
        expiresAt: new Date('2026-08-24T00:00:00Z'),
      },
      decision: 'review',
    }),
  };
  const grantService = { create: jest.fn().mockResolvedValue({ id: 'grant-1', scope: null }) };
  const peerLinkService = { findById: jest.fn().mockResolvedValue(null) };

  const resolver = new AskResolver(
    askService as never,
    grantService as never,
    {} as never,
    { consume: jest.fn() } as never,
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
    { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as never,
  );

  return { resolver, askService, grantService };
}

const responderId = GlobalUID.encode('user', 'responder-1');

describe('createAsk bounds the two fields the asker fully controls', () => {
  it('refuses a queryType outside the archetype vocabulary, before anything is stored', async () => {
    const { resolver, askService } = makeResolver();

    await expect(
      resolver.createAsk(CTX, { responderId, query: { queryType: 'photos', prompt: 'photos of us?' } }),
    ).rejects.toThrow(/queryType must be one of/);

    // Nothing was created. The gate has to be in FRONT of the insert: an ask
    // row exists the moment `submit` runs, and a refusal afterwards strands it.
    expect(askService.submit).not.toHaveBeenCalled();
  });

  it('refuses an over-long prompt rather than truncating it', async () => {
    const { resolver, askService } = makeResolver();

    await expect(
      resolver.createAsk(CTX, {
        responderId,
        query: { queryType: 'content', prompt: 'a'.repeat(MAX_ASK_PROMPT_LENGTH + 1) },
      }),
    ).rejects.toThrow(/prompt must be at most/);
    expect(askService.submit).not.toHaveBeenCalled();
  });

  it('submits the NORMALIZED query, not the raw input object', async () => {
    const { resolver, askService } = makeResolver();

    await resolver.createAsk(CTX, {
      responderId,
      query: {
        queryType: '  CONTENT ',
        dataClass: ' Photos ',
        // U+200B between "pho" and "tos": renders identically to the plain word.
        prompt: 'pho​tos  of us?',
      },
    });

    expect(askService.submit).toHaveBeenCalledWith(
      { userId: 'asker-1' },
      {
        responderUserId: 'responder-1',
        query: {
          queryType: 'content',
          dataClass: 'Photos',
          prompt: 'photos of us?',
          // The stripped U+200B is recorded so the owner's card can say so.
          promptHiddenCharactersRemoved: true,
        },
      },
    );
  });
});

describe('createAskGrant holds the owner to the same vocabulary', () => {
  /**
   * The WRITING end. An owner who writes `block` on a word no ask can carry has
   * written nothing, while the Grant Manager shows it back to them as live
   * protection — so leaving this end open makes "I blocked this" and "this is
   * blocked" two different statements.
   */
  it('refuses a grant whose queryType no ask could ever match', async () => {
    const { resolver, grantService } = makeResolver();

    await expect(
      resolver.createAskGrant(CTX, {
        granteeId: GlobalUID.encode('user', 'grantee-1'),
        queryType: 'photos',
        mode: 'block',
      } as never),
    ).rejects.toThrow(/queryType must be one of/);

    expect(grantService.create).not.toHaveBeenCalled();
  });

  it('stores the canonical archetype, so a spelling variant cannot make a second dead row', async () => {
    const { resolver, grantService } = makeResolver();

    await resolver.createAskGrant(CTX, {
      granteeId: GlobalUID.encode('user', 'grantee-1'),
      queryType: '  Content  ',
      mode: 'block',
    } as never);

    expect(grantService.create.mock.calls[0][1]).toMatchObject({ queryType: 'content' });
  });
});
