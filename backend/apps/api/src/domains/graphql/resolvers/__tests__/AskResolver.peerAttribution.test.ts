import { type RequestContext } from '@ci/common/context';
import { type Ask } from '@ci/domains/asks';

import { GlobalUID } from '../../types/GlobalUID';
import { AskResolver } from '../AskResolver';

/**
 * The GraphQL half of peer attribution: who resolves the handle, and where it
 * ends up.
 *
 * `AskService` can only stamp a handle it is handed, and the handle lives in the
 * peers domain — so the resolver is the layer that has to look it up. Two
 * separate things were dropping it:
 *
 *   - `runAsk` never passed one to `completeWithAnswer`, so the disclosure the
 *     owner personally approved audited with `peer_handle` NULL while the auto
 *     path (which `PeerAskService` audits itself) recorded the peer fine;
 *   - `AskType.toType` hard-coded `peerHandle: null` on EVERY path, though the
 *     field is declared and the sibling `AskAuditType` carries it — so a
 *     federated ask rendered in the review queue as if it came from nobody.
 *
 * Kept in its own file rather than folded into AskResolver.test.ts, which is
 * under concurrent change.
 */

const CTX = { userId: 'owner-1' } as unknown as RequestContext;
const ASK_GID = GlobalUID.encode('ask', 'ask-1');

/** An inbound peer ask the owner has already approved — the review path. */
function inboundAsk(overrides: Partial<Ask> = {}): Ask {
  return {
    id: 'ask-1',
    askerUserId: null,
    peerLinkId: 'link-ada',
    direction: 'inbound',
    responderUserId: 'owner-1',
    query: { queryType: 'photos', prompt: 'the quarterly review deck?' },
    status: 'answering',
    consentBasis: null,
    disclosureCeiling: null,
    createdAt: new Date('2026-08-20T00:00:00Z'),
    updatedAt: new Date('2026-08-20T00:00:00Z'),
    expiresAt: null,
    ...overrides,
  } as Ask;
}

function peerLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-ada',
    ownerUserId: 'owner-1',
    peerHandle: 'ada',
    trustTier: 'trusted',
    status: 'active',
    ...overrides,
  };
}

function makeResolver(options: { links?: Record<string, unknown>[] } = {}) {
  const links = options.links ?? [peerLink()];

  const askService = {
    findById: jest.fn().mockResolvedValue(inboundAsk()),
    decline: jest.fn().mockResolvedValue(inboundAsk({ status: 'declined' })),
    approve: jest.fn().mockResolvedValue(inboundAsk()),
    listInbox: jest.fn().mockResolvedValue([]),
    listOutbox: jest.fn().mockResolvedValue([]),
    completeWithAnswer: jest.fn().mockResolvedValue({
      ask: inboundAsk({ status: 'answered' }),
      answer: {
        id: 'answer-1',
        askId: 'ask-1',
        form: 'retrieval',
        items: [],
        disclosedCount: 1,
        withheldCount: 0,
        summary: 'They shared 1 item.',
        consentBasis: null,
        // The persisted column name; `AskAnswerType.toType` reads it, not `items`.
        disclosedEntities: [{ id: 'e1', type: 'file' }],
        createdAt: new Date('2026-08-20T00:00:00Z'),
      },
    }),
  };
  // No matching grant → review, and therefore no grant-imposed ceiling.
  const grantService = { evaluate: jest.fn().mockResolvedValue({ decision: 'review' }) };
  const executorService = { execute: jest.fn().mockResolvedValue([{ id: 'e1', type: 'file' }]) };
  // Faithful to `PeerLinkService.findById`, which is OWNER-SCOPED — the where
  // clause is `{ id, ownerUserId }`, not `{ id }`. A mock that ignored the owner
  // would hide the one case this projection has to fail closed on.
  const peerLinkService = {
    findById: jest.fn(
      async (context: { userId: string }, id: string) =>
        links.find((link) => link.id === id && link.ownerUserId === context.userId) ?? null,
    ),
  };
  const featureService = { isFeatureEnabled: jest.fn().mockResolvedValue(true) };

  const resolver = new AskResolver(
    askService as never,
    grantService as never,
    {} as never,
    {} as never,
    executorService as never,
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
    featureService as never,
  );

  return { resolver, askService, peerLinkService };
}

describe('runAsk carries the peer through the review path', () => {
  it('hands the handle to completeWithAnswer, so the approved disclosure is attributable', async () => {
    const { resolver, askService } = makeResolver();

    await resolver.runAsk(CTX, ASK_GID);

    expect(askService.completeWithAnswer).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      'ask-1',
      expect.objectContaining({ peerHandle: 'ada' }),
    );
  });

  it('resolves the link ONCE — the ceiling and the audit must name the same peer', async () => {
    // The tier that caps the answer and the handle that labels it are two reads
    // of the same relationship. A second lookup is a second chance for them to
    // disagree about which peer this disclosure was.
    const { resolver, peerLinkService } = makeResolver();

    await resolver.runAsk(CTX, ASK_GID);

    expect(peerLinkService.findById).toHaveBeenCalledTimes(1);
    expect(peerLinkService.findById).toHaveBeenCalledWith({ userId: 'owner-1' }, 'link-ada');
  });

  it('passes no handle when the link is gone — the tier still falls to `stranger`', async () => {
    // A revoked or deleted link must not resolve to a handle, and must not
    // widen the answer either: `resolveTier` reads the same null.
    const { resolver, askService } = makeResolver({ links: [] });

    const result = await resolver.runAsk(CTX, ASK_GID);

    expect(askService.completeWithAnswer).toHaveBeenCalledWith(
      expect.anything(),
      'ask-1',
      expect.objectContaining({ peerHandle: null }),
    );
    expect(result.ask?.peerHandle).toBeNull();
  });

  it('returns the peer on the ask it projects back', async () => {
    const { resolver } = makeResolver();

    const result = await resolver.runAsk(CTX, ASK_GID);

    expect(result.ask?.peerHandle).toBe('ada');
  });
});

describe('AskType.peerHandle is populated on the read paths, not hard-coded null', () => {
  it('the review inbox names the peer behind each federated ask', async () => {
    const { resolver, askService } = makeResolver();
    askService.listInbox.mockResolvedValue([inboundAsk({ status: 'under_review' })]);

    const [row] = await resolver.askInbox(CTX);

    expect(row.peerHandle).toBe('ada');
  });

  it('resolves one lookup per DISTINCT peer, not per row', async () => {
    // The inbox is the N+1 that matters: an owner with a backlog from one peer
    // would otherwise pay a query per ask.
    const { resolver, askService, peerLinkService } = makeResolver();
    askService.listInbox.mockResolvedValue([
      inboundAsk({ id: 'ask-1' }),
      inboundAsk({ id: 'ask-2' }),
      inboundAsk({ id: 'ask-3' }),
    ]);

    const rows = await resolver.askInbox(CTX);

    expect(rows.map((row) => row.peerHandle)).toEqual(['ada', 'ada', 'ada']);
    expect(peerLinkService.findById).toHaveBeenCalledTimes(1);
  });

  it('costs nothing for a list of purely local asks', async () => {
    const { resolver, askService, peerLinkService } = makeResolver();
    askService.listInbox.mockResolvedValue([
      inboundAsk({ peerLinkId: null, direction: 'local', askerUserId: 'asker-1' }),
    ]);

    const [row] = await resolver.askInbox(CTX);

    expect(row.peerHandle).toBeNull();
    expect(peerLinkService.findById).not.toHaveBeenCalled();
  });

  it('a viewer who does not own the link learns no handle', async () => {
    // `findById` is owner-scoped. The local participant of a federated ask is
    // always the link's owner, so this can only bite an unexpected reader — and
    // it fails closed for them rather than leaking who the owner talks to.
    const { resolver, askService } = makeResolver({ links: [peerLink({ ownerUserId: 'someone-else' })] });
    askService.listInbox.mockResolvedValue([inboundAsk()]);

    const [row] = await resolver.askInbox(CTX);

    expect(row.peerHandle).toBeNull();
  });
});

describe('declineAsk attributes a hand-written refusal', () => {
  it('resolves the peer before the transition and hands the handle to decline', async () => {
    // `decline` writes its audit row itself, so the lookup has to happen first.
    const { resolver, askService } = makeResolver();

    const result = await resolver.declineAsk(CTX, ASK_GID);

    expect(askService.decline).toHaveBeenCalledWith({ userId: 'owner-1' }, 'ask-1', {
      peerHandle: 'ada',
    });
    expect(result.ask?.peerHandle).toBe('ada');
  });

  it('does not turn a missing ask into its own error path', async () => {
    // The pre-read is for attribution only. An ask the caller cannot see must
    // still fail the way `decline` fails it, not with a second wording.
    const { resolver, askService } = makeResolver();
    askService.findById.mockResolvedValue(null);
    askService.decline.mockRejectedValue(new Error('Ask ask-1 not found'));

    await expect(resolver.declineAsk(CTX, ASK_GID)).rejects.toThrow('Ask ask-1 not found');
    expect(askService.decline).toHaveBeenCalledWith(expect.anything(), 'ask-1', { peerHandle: null });
  });
});
