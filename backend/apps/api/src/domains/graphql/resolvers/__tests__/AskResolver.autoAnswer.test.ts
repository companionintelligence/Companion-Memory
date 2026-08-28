import { type RequestContext } from '@ci/common/context';
import { type Ask, type AskAnswer } from '@ci/domains/asks';

import { AskStatusEnum } from '../../types/AskType';
import { GlobalUID } from '../../types/GlobalUID';
import { AskResolver } from '../AskResolver';

/**
 * ═══ A STANDING `auto` GRANT USED TO BUY NOTHING ON THE LOCAL PATH ═══
 *
 * `AskService.submit` returns `auto` when the owner's grant matrix
 * pre-authorized an ask; it stamps the deciding grant as the consent basis and
 * the ceiling that grant imposed, and leaves the ask `delivered`. Nothing then
 * produced an answer, because `runAsk` was the ONLY answer-producing call site
 * in the codebase and it is an owner mutation. So the pre-authorized ask landed
 * in the owner's review inbox with an "Answer now" button beside it — exactly
 * where an unauthorized one lands — while the federated auto path answered end
 * to end.
 *
 * These tests pin both halves of the fix: that the auto path now answers, and
 * that it answers through the SAME clamp `runAsk` uses, so no disclosure is
 * possible here that an owner tapping "Answer now" would not already have
 * produced.
 */

const RESPONDER = 'responder-1';
const ASKER = 'asker-1';

const asAsker = { userId: ASKER } as unknown as RequestContext;
const asResponder = { userId: RESPONDER } as unknown as RequestContext;

const THREE_MATCHES = [
  { id: 'e1', type: 'file' },
  { id: 'e2', type: 'file' },
  { id: 'e3', type: 'file' },
];

function fakeAsk(overrides: Partial<Ask> = {}): Ask {
  return {
    id: 'ask-1',
    askerUserId: ASKER,
    responderUserId: RESPONDER,
    peerLinkId: null,
    direction: 'local',
    query: { queryType: 'content', dataClass: 'photos', prompt: 'photos of the lake trip?' },
    // The shape a standing `auto` grant leaves behind: delivered, with a basis.
    status: 'delivered',
    consentBasis: 'grant-abc',
    disclosureCeiling: null,
    createdAt: new Date('2026-08-21T00:00:00Z'),
    updatedAt: new Date('2026-08-21T00:00:00Z'),
    expiresAt: new Date('2026-08-24T00:00:00Z'),
    ...overrides,
  } as Ask;
}

function makeResolver(
  ask: Ask,
  options: {
    decision?: 'auto' | 'review' | 'deny';
    /** What the owner's standing grants say when re-evaluated at answer time. */
    evaluation?: unknown;
    matches?: { id: string; type: string }[];
    peerLink?: unknown;
    /** Is the grant that pre-authorized this ask still in force at answer time? */
    consentStanding?: boolean;
    /** Make the run-as-owner executor blow up, to exercise the best-effort path. */
    executorThrows?: boolean;
  } = {},
) {
  const executorService = {
    execute: options.executorThrows
      ? jest.fn().mockRejectedValue(new Error('search index unavailable'))
      : jest.fn().mockResolvedValue(options.matches ?? THREE_MATCHES),
  };

  const askService = {
    submit: jest.fn().mockResolvedValue({ ask, decision: options.decision ?? 'auto' }),
    approve: jest.fn(),
    decline: jest.fn(),
    findById: jest.fn().mockResolvedValue(ask),
    listInbox: jest.fn(),
    listOutbox: jest.fn(),
    // Stands in for the real transactional service: hands back the answer it
    // was asked to persist, so a test can read the disclosure that crossed.
    completeWithAnswer: jest.fn(
      async (_ctx: unknown, id: string, disclosure: { answer: Record<string, unknown> }) => ({
        ask: fakeAsk({ ...ask, status: 'answered' }),
        answer: {
          id: 'answer-1',
          askId: id,
          answerSource: 'self',
          createdAt: new Date('2026-08-21T00:00:00Z'),
          ...disclosure.answer,
          disclosedEntities: disclosure.answer.items,
        } as unknown as AskAnswer,
      }),
    ),
  };

  const grantService = {
    create: jest.fn(),
    revoke: jest.fn(),
    listForOwner: jest.fn(),
    evaluate: jest.fn().mockResolvedValue(options.evaluation ?? { decision: 'review' }),
    isConsentStanding: jest.fn().mockResolvedValue(options.consentStanding ?? true),
  };

  const resolver = new AskResolver(
    askService as never,
    grantService as never,
    { listForResponder: jest.fn() } as never,
    { consume: jest.fn() } as never,
    executorService as never,
    { create: jest.fn(), findByAskId: jest.fn() } as never,
    { findById: jest.fn().mockResolvedValue(options.peerLink ?? null) } as never,
    { send: jest.fn() } as never,
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

  return { resolver, askService, grantService, executorService };
}

const input = {
  responderId: GlobalUID.encode('user', RESPONDER),
  query: { queryType: 'content', dataClass: 'photos', prompt: 'photos of the lake trip?' },
};

/** The disclosure the resolver actually persisted. */
function persisted(askService: { completeWithAnswer: jest.Mock }) {
  return askService.completeWithAnswer.mock.calls[0][2].answer;
}

describe('createAsk — a pre-authorized ask is ANSWERED, not filed for review', () => {
  it('produces and persists the answer in the same call', async () => {
    const { resolver, askService, executorService } = makeResolver(fakeAsk());

    const result = await resolver.createAsk(asAsker, input);

    // THE FIX. Before it, this assertion failed on every line: the executor
    // never ran, nothing was persisted, and the ask came back `delivered` for
    // the owner to answer by hand — despite their standing "yes, always".
    expect(executorService.execute).toHaveBeenCalledTimes(1);
    expect(askService.completeWithAnswer).toHaveBeenCalledTimes(1);
    expect(result.ask?.status).toBe(AskStatusEnum.answered);
  });

  /**
   * The pipeline reads the RESPONDER's memory and every write in it is
   * responder-scoped (`AskService.responderOwned`). The caller here is the
   * ASKER, so a context built from the caller would either read the wrong
   * person's memory or fail the ownership check — and the first of those is
   * the one that would not have failed loudly.
   */
  it('runs as the RESPONDER, never as the caller', async () => {
    const { resolver, askService } = makeResolver(fakeAsk());

    await resolver.createAsk(asAsker, input);

    expect(askService.completeWithAnswer.mock.calls[0][0]).toEqual({ userId: RESPONDER });
    expect(askService.completeWithAnswer.mock.calls[0][0]).not.toEqual({ userId: ASKER });
  });

  it.each(['review', 'deny'] as const)(
    'does NOT answer, and never touches the owner’s memory, when the decision was %s',
    async (decision) => {
      const { resolver, askService, executorService } = makeResolver(
        fakeAsk({ status: 'under_review', consentBasis: null }),
        { decision },
      );

      const result = await resolver.createAsk(asAsker, input);

      expect(executorService.execute).not.toHaveBeenCalled();
      expect(askService.completeWithAnswer).not.toHaveBeenCalled();
      // Collapsed for the asker either way; the point is that nothing was read.
      expect(result.ask?.status).toBe(AskStatusEnum.delivered);
    },
  );

  /**
   * The receipt is unchanged. `createAsk` used to hand the asker the
   * responder's `auto` | `review` | `deny` posture, which combined with the
   * rate limit is a probe against the grant matrix; that is why the decision
   * became the constant `accepted`. Auto-answering must not put it back.
   */
  it.each(['auto', 'review', 'deny'] as const)(
    'still returns the same constant receipt for %s',
    async (decision) => {
      const { resolver } = makeResolver(fakeAsk(), { decision });

      const result = await resolver.createAsk(asAsker, input);

      expect(result.decision).toBe('accepted');
      expect(['auto', 'review', 'deny']).not.toContain(result.decision);
    },
  );
});

describe('createAsk — the auto answer is held to every limit the owner’s own tap is', () => {
  /**
   * The ceiling CAPTURED when consent was given caps the auto answer. This is
   * the limit that exists because re-deriving from live grants is how revoking
   * one used to make the answer bigger.
   */
  it('clamps to the ceiling stamped on the ask at submit time', async () => {
    const { resolver, askService } = makeResolver(fakeAsk({ disclosureCeiling: 'count' }), {
      evaluation: { decision: 'auto', grantId: 'grant-abc' },
    });

    await resolver.createAsk(asAsker, input);

    const answer = persisted(askService);
    // `count` discloses the number and no references at all.
    expect(answer.items).toEqual([]);
    expect(answer.summary).toBe('3 matching items.');
  });

  /** A block written AFTER consent tightens the auto answer to nothing. */
  it('discloses nothing when the live grants now say deny', async () => {
    const { resolver, askService } = makeResolver(fakeAsk(), {
      evaluation: { decision: 'deny', grantId: 'block-1' },
    });

    await resolver.createAsk(asAsker, input);

    const answer = persisted(askService);
    expect(answer.items).toEqual([]);
    expect(answer.disclosedCount).toBe(0);
    expect(answer.summary).toBe('Nothing was shared.');
  });

  /**
   * The audit records what CROSSED, and keeps the candidate set under its own
   * name. Auditing the backing set as a disclosure made the audit and
   * `ci.ask_answers` disagree about the same event, always in the direction of
   * over-reporting.
   */
  it('separates what was disclosed from what the answer was computed over', async () => {
    const { resolver, askService } = makeResolver(fakeAsk({ disclosureCeiling: 'boolean' }), {
      evaluation: { decision: 'auto', grantId: 'grant-abc' },
    });

    await resolver.createAsk(asAsker, input);

    const disclosure = askService.completeWithAnswer.mock.calls[0][2] as unknown as {
      disclosedEntityIds: string[];
      backingEntityIds: string[];
    };
    expect(disclosure.disclosedEntityIds).toEqual([]);
    expect(disclosure.backingEntityIds).toEqual(['e1', 'e2', 'e3']);
  });
});

describe('createAsk — a failing auto answer falls back to the owner, silently', () => {
  /**
   * A throw would be wrong twice over. Functionally, the ask is already created
   * and already answerable by `runAsk`, so the owner answers it themselves —
   * strictly LESS disclosure with a human in the loop. And as a side channel,
   * only the auto path can fail this way, so an error the ASKER can observe is
   * a probe for "does a standing grant cover me?".
   */
  it('still acknowledges the ask, and leaves it exactly as submit made it', async () => {
    const { resolver, askService } = makeResolver(fakeAsk(), { executorThrows: true });

    const result = await resolver.createAsk(asAsker, input);

    expect(result.success).toBe(true);
    expect(result.decision).toBe('accepted');
    expect(askService.completeWithAnswer).not.toHaveBeenCalled();
    // Still `delivered` with its consent basis, so the owner sees it and
    // `runAsk` can still answer it.
    expect(result.ask?.status).toBe(AskStatusEnum.delivered);
  });

  /**
   * The pull-side check, in front of every read. `submit` decided `auto` from a
   * grant it evaluated microseconds ago; if the owner revoked it in between,
   * the ask goes to review WITHOUT the owner's memory having been touched.
   */
  it('never reads the owner’s memory when the deciding grant is no longer in force', async () => {
    const { resolver, askService, executorService, grantService } = makeResolver(fakeAsk(), {
      consentStanding: false,
    });

    const result = await resolver.createAsk(asAsker, input);

    expect(grantService.isConsentStanding).toHaveBeenCalledTimes(1);
    expect(executorService.execute).not.toHaveBeenCalled();
    expect(askService.completeWithAnswer).not.toHaveBeenCalled();
    expect(result.ask?.status).toBe(AskStatusEnum.delivered);
  });

  it('never answers an ask the lifecycle says is not answerable', async () => {
    // A `delivered` ask with NO consent basis is what a revoked pre-authorization
    // leaves behind. `submit` would not call it auto, but if anything ever did,
    // the gate inside the shared pipeline refuses before the search runs.
    const { resolver, askService, executorService } = makeResolver(fakeAsk({ consentBasis: null }));

    await resolver.createAsk(asAsker, input);

    expect(executorService.execute).not.toHaveBeenCalled();
    expect(askService.completeWithAnswer).not.toHaveBeenCalled();
  });
});

/**
 * The auto path and the owner's own "Answer now" must be the SAME code, not two
 * copies of it. A copy is a second place for the archetype clamp, the tier
 * ceiling and the captured-vs-live grant ceiling to drift apart — and the copy
 * that drifts is the one nobody is looking at.
 */
describe('the auto path and runAsk produce the identical disclosure', () => {
  it.each([
    ['no ceiling at all', null],
    ['a summary ceiling', 'summary'],
    ['a boolean ceiling', 'boolean'],
  ] as const)('agree under %s', async (_label, ceiling) => {
    const evaluation = { decision: 'auto', grantId: 'grant-abc' };
    const ask = fakeAsk({ disclosureCeiling: ceiling });

    const auto = makeResolver(ask, { evaluation });
    await auto.resolver.createAsk(asAsker, input);

    const owner = makeResolver(ask, { evaluation });
    await owner.resolver.runAsk(asResponder, GlobalUID.encode('ask', 'ask-1'));

    expect(persisted(auto.askService)).toEqual(persisted(owner.askService));
  });
});

/**
 * The sensitive-class floor, pinned on the shared pipeline itself.
 *
 * `health`, `financial`, `location` and their siblings clamp to `none` for
 * every tier below `family`, whatever the grant says — the whole reason the
 * tier ceiling is enforced separately from the grant that authorized the ask.
 * A local ask is `household` and is deliberately exempt, so this is asserted
 * through the peer-linked path, which reaches the same {@link disclose}.
 */
describe('the shared pipeline applies the tier’s sensitive-class floor', () => {
  it('discloses nothing to a `peer` about a health ask, even under a full grant', async () => {
    const ask = fakeAsk({
      status: 'answering',
      consentBasis: null,
      peerLinkId: 'link-1',
      query: { queryType: 'content', dataClass: 'health', prompt: 'any cardiology results?' },
    });
    const { resolver, askService } = makeResolver(ask, {
      evaluation: { decision: 'auto', grantId: 'grant-abc', maxDisclosure: 'full' },
      peerLink: { id: 'link-1', peerHandle: 'nadia@example.test', trustTier: 'peer' },
    });

    await resolver.runAsk(asResponder, GlobalUID.encode('ask', 'ask-1'));

    const answer = persisted(askService);
    expect(answer.items).toEqual([]);
    expect(answer.disclosedCount).toBe(0);
    expect(answer.summary).toBe('Nothing was shared.');
  });
});
