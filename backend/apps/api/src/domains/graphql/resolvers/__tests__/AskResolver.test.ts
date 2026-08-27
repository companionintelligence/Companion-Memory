import { type RequestContext } from '@ci/common/context';
import { type Ask } from '@ci/domains/asks';

import { GlobalUID } from '../../types/GlobalUID';
import { AskResolver } from '../AskResolver';

const CTX = { userId: 'user-1' } as unknown as RequestContext;

function fakeAsk(): Ask {
  return {
    id: 'ask-1',
    askerUserId: 'user-1',
    responderUserId: 'responder-1',
    query: { queryType: 'photos', prompt: 'do you have photos of us?' },
    status: 'under_review',
    consentBasis: null,
    createdAt: new Date('2026-07-15T00:00:00Z'),
    updatedAt: new Date('2026-07-15T00:00:00Z'),
    expiresAt: null,
  } as Ask;
}

function makeResolver(enabled: boolean) {
  const askService = {
    submit: jest.fn().mockResolvedValue({ ask: fakeAsk(), decision: 'review' }),
    approve: jest.fn(),
    decline: jest.fn(),
    findById: jest.fn(),
    complete: jest.fn(),
    completeWithAnswer: jest.fn(),
    listInbox: jest.fn().mockResolvedValue([fakeAsk()]),
    listOutbox: jest.fn().mockResolvedValue([]),
  };
  const grantService = {
    create: jest.fn(),
    revoke: jest.fn(),
    listForOwner: jest.fn().mockResolvedValue([]),
    // No matching grant → review, and therefore no grant-imposed ceiling.
    evaluate: jest.fn().mockResolvedValue({ decision: 'review' }),
  };
  const auditService = { listForResponder: jest.fn().mockResolvedValue({ rows: [], truncated: false }) };
  const rateLimitService = { consume: jest.fn() };
  const executorService = { execute: jest.fn().mockResolvedValue([{ id: 'e1', type: 'file' }]) };
  const answerService = {
    create: jest.fn().mockImplementation((dto: { answer: unknown }) =>
      Promise.resolve({
        id: 'answer-1',
        askId: 'ask-1',
        answerSource: 'peer',
        createdAt: new Date('2026-07-15T00:00:00Z'),
        ...(dto.answer as object),
        disclosedEntities: (dto.answer as { items: unknown[] }).items,
      }),
    ),
    findByAskId: jest.fn(),
  };
  // Mirror the real service: `completeWithAnswer` persists the answer and
  // finalizes the ask in one transaction. Delegating to the two underlying
  // mocks keeps every assertion below pointed at the half it is about.
  askService.completeWithAnswer = jest.fn(
    async (
      ctx: unknown,
      id: string,
      disclosure: { answer: unknown; disclosedEntityIds: string[]; backingEntityIds: string[] },
    ) => ({
      ask: await askService.complete(ctx, id, disclosure.disclosedEntityIds, {
        backingEntityIds: disclosure.backingEntityIds,
      }),
      answer: await answerService.create({ askId: id, answer: disclosure.answer }),
    }),
  );

  const peerLinkService = { findById: jest.fn().mockResolvedValue(null) };
  const outboundAskService = { send: jest.fn() };
  const featureService = { isFeatureEnabled: jest.fn().mockResolvedValue(enabled) };

  const resolver = new AskResolver(
    askService as never,
    grantService as never,
    auditService as never,
    rateLimitService as never,
    executorService as never,
    answerService as never,
    peerLinkService as never,
    outboundAskService as never,
    {
      // The household-tier service. `resolveTier` consults it for a LOCAL
      // asker; undefined member means the default (`household`) still applies.
      tierFor: jest.fn().mockResolvedValue('household'),
      listForOwner: jest.fn().mockResolvedValue([]),
      setTier: jest.fn(),
    } as never,
    featureService as never,
  );

  return {
    resolver,
    askService,
    grantService,
    rateLimitService,
    executorService,
    answerService,
    peerLinkService,
    outboundAskService,
    featureService,
  };
}

describe('AskResolver — feature-flag gating', () => {
  it('is dark when `ask` is disabled: mutations report failure, queries are empty, services untouched', async () => {
    const { resolver, askService, grantService, rateLimitService } = makeResolver(false);

    const created = await resolver.createAsk(CTX, {
      responderId: GlobalUID.encode('user', 'responder-1'),
      query: { queryType: 'photos', prompt: 'hi' },
    });
    expect(created).toEqual({ success: false });
    expect(askService.submit).not.toHaveBeenCalled();
    expect(rateLimitService.consume).not.toHaveBeenCalled(); // no rate budget spent while dark

    expect(await resolver.askInbox(CTX)).toEqual([]);
    expect(askService.listInbox).not.toHaveBeenCalled();
    expect(await resolver.myAskGrants(CTX)).toEqual([]);
    expect(grantService.listForOwner).not.toHaveBeenCalled();
  });
});

describe('AskResolver — enabled', () => {
  it('createAsk rate-limits, decodes the responder id, submits, and acknowledges', async () => {
    const { resolver, askService, rateLimitService } = makeResolver(true);

    const result = await resolver.createAsk(CTX, {
      responderId: GlobalUID.encode('user', 'responder-1'),
      // `queryType` is the ARCHETYPE, not the data class — `photos` was never
      // one, and since `parseAskQueryType` closed the vocabulary it is refused.
      // The class it was standing in for still travels, in `dataClass`.
      query: { queryType: 'content', dataClass: 'beach', prompt: 'beach photos?' },
    });

    expect(rateLimitService.consume).toHaveBeenCalledWith('user-1');
    expect(askService.submit).toHaveBeenCalledWith(
      { userId: 'user-1' },
      {
        responderUserId: 'responder-1',
        query: { queryType: 'content', dataClass: 'beach', prompt: 'beach photos?' },
      },
    );
    expect(result.success).toBe(true);
    // The responder's grant posture is NOT the asker's to read: `auto`,
    // `review` and `deny` all come back as the same acknowledgement.
    expect(result.decision).toBe('accepted');
    // …and neither is the ask's raw STATUS, which carried the same three-way
    // signal one field along (`declined` / `delivered` / `under_review`).
    expect(result.ask?.status).toBe('delivered');
  });

  it('askInbox maps the responder inbox to GraphQL types', async () => {
    const { resolver } = makeResolver(true);
    const inbox = await resolver.askInbox(CTX);

    expect(inbox).toHaveLength(1);
    // ids are re-encoded as opaque global ids
    expect(GlobalUID.parse('ask', inbox[0].id)).toBe('ask-1');
  });

  it('runAsk executes as the responder, produces a disclosure-filtered answer, and completes', async () => {
    const { resolver, askService, executorService, answerService } = makeResolver(true);
    // caller (user-1) IS the responder of this ask
    const ownAsk = { ...fakeAsk(), responderUserId: 'user-1', status: 'answering' } as Ask;
    askService.findById = jest.fn().mockResolvedValue(ownAsk);
    askService.complete = jest.fn().mockResolvedValue({ ...ownAsk, status: 'answered' });

    const result = await resolver.runAsk(CTX, GlobalUID.encode('ask', 'ask-1'));

    expect(executorService.execute).toHaveBeenCalledWith(ownAsk);
    // a 'photos' query is retrieval-form → the one match is disclosed as a reference
    expect(answerService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        askId: 'ask-1',
        answer: expect.objectContaining({ form: 'retrieval', disclosedCount: 1, withheldCount: 0 }),
      }),
    );
    // The audit records what the asker RECEIVED, plus the backing set under its
    // own name. Here they coincide (household tier, retrieval form, nothing
    // clamped); the disclosureIntegrity suite covers the case where they differ.
    expect(askService.completeWithAnswer).toHaveBeenCalledWith({ userId: 'user-1' }, 'ask-1', {
      answer: expect.objectContaining({ form: 'retrieval' }),
      disclosedEntityIds: ['e1'],
      backingEntityIds: ['e1'],
      // A LOCAL ask, so there is no peer to attribute it to. The federated case
      // — where this carries the handle into the audit row — is in
      // AskResolver.peerAttribution.test.ts.
      peerHandle: null,
    });
    expect(result.success).toBe(true);
    expect(result.disclosedCount).toBe(1);
    expect(result.answer?.form).toBe('retrieval');
    expect(result.ask?.status).toBe('answered');
  });

  it('runAsk withholds redacted items ("deny all but X") — counted, never itemized, never audited', async () => {
    const { resolver, askService, executorService, answerService } = makeResolver(true);
    const ownAsk = { ...fakeAsk(), responderUserId: 'user-1', status: 'answering' } as Ask;
    askService.findById = jest.fn().mockResolvedValue(ownAsk);
    askService.complete = jest.fn().mockResolvedValue({ ...ownAsk, status: 'answered' });
    // three matches; owner keeps only e1
    executorService.execute = jest.fn().mockResolvedValue([
      { id: 'e1', type: 'file' },
      { id: 'e2', type: 'file' },
      { id: 'e3', type: 'file' },
    ]);

    const result = await resolver.runAsk(CTX, GlobalUID.encode('ask', 'ask-1'), ['e2', 'e3']);

    expect(answerService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        answer: expect.objectContaining({ disclosedCount: 1, withheldCount: 2 }),
      }),
    );
    // only the kept (non-redacted) entity is audited, as backing AND as disclosed
    expect(askService.completeWithAnswer).toHaveBeenCalledWith(
      { userId: 'user-1' },
      'ask-1',
      expect.objectContaining({ disclosedEntityIds: ['e1'], backingEntityIds: ['e1'] }),
    );
    expect(result.disclosedCount).toBe(1);
    expect(result.withheldCount).toBe(2);
  });

  it('runAsk refuses when the caller is not the responder', async () => {
    const { resolver, askService, executorService } = makeResolver(true);
    // ask is directed at someone else — caller user-1 is the ASKER, not responder
    askService.findById = jest
      .fn()
      .mockResolvedValue({ ...fakeAsk(), askerUserId: 'user-1', responderUserId: 'someone-else' });

    await expect(resolver.runAsk(CTX, GlobalUID.encode('ask', 'ask-1'))).rejects.toThrow();
    expect(executorService.execute).not.toHaveBeenCalled();
  });
});
