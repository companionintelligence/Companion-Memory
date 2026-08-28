import { type UserServiceContext } from '@ci/common/context';

import type { DisclosedAnswer } from '../../types';
import { AskAuditService } from '../AskAuditService';
import { AskService } from '../AskService';

/**
 * ═══ THE REVIEW PATH LOST THE PEER, ON THE ONE DISCLOSURE A HUMAN APPROVED ═══
 *
 * A federated ask can reach `answered` two ways. A standing `auto` grant is
 * answered by `PeerAskService`, which writes its OWN audit row and stamps both
 * `peer_link_id` and `peer_handle`. Anything else lands in the owner's review
 * queue, and once approved it is answered by `runAsk` →
 * `AskService.completeWithAnswer` → `complete`, whose audit row was built from
 * the ask alone — so `peer_handle` came out NULL.
 *
 * Observed against two real boxes in the federation harness (scenario (b)): the
 * auto path recorded `ada`, the reviewed one recorded nobody. The owner's
 * disclosure history could name the peer for every answer they had NOT looked
 * at, and not for the one they had.
 *
 * These run the REAL {@link AskAuditService} against a fake repository, and
 * inspect the row it writes, because the defect was precisely that two layers
 * agreed on a shape with no room for the peer in it. A `jest.fn()` stand-in for
 * the audit service would have accepted the broken shape just as happily.
 */

const OWNER: UserServiceContext = { userId: 'responder-1' };

/** Peer link ids as they appear on `ci.asks.peer_link_id`. */
const LINK = 'link-ada';

const RETRIEVAL_ANSWER: DisclosedAnswer = {
  form: 'retrieval',
  items: [{ id: 'e1', type: 'file' }],
  disclosedCount: 1,
  withheldCount: 0,
  summary: 'They shared 1 item.',
  consentBasis: null,
};

/**
 * The stack `runAsk` drives on the review path: an ask the owner has already
 * approved (`answering`, no consent basis — a human said yes, not a grant).
 */
function makeStack(askOverrides: Record<string, unknown> = {}) {
  const askEntity = {
    id: 'ask-1',
    // An INBOUND peer ask has no local asker: the asker is the peer, named by
    // `peerLinkId`. That is exactly why the handle matters — there is no user
    // row to fall back on.
    askerUserId: null,
    peerLinkId: LINK,
    direction: 'inbound',
    responderUserId: 'responder-1',
    query: { queryType: 'photos', prompt: 'the quarterly review deck?' },
    status: 'answering',
    consentBasis: null,
    disclosureCeiling: null,
    createdAt: new Date('2026-08-20T00:00:00Z'),
    updatedAt: new Date('2026-08-20T00:00:00Z'),
    expiresAt: null,
    ...askOverrides,
  };

  const askRepo = {
    findOne: jest.fn().mockResolvedValue(askEntity),
    save: jest.fn().mockImplementation((entity: unknown) => Promise.resolve(entity)),
  };

  const auditRows: Record<string, unknown>[] = [];
  const auditRepo = {
    create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
    save: jest.fn(async (row: Record<string, unknown>) => {
      auditRows.push(row);

      return { ...row, createdAt: new Date('2026-08-20T00:00:00Z') };
    }),
  };
  const auditService = new AskAuditService(auditRepo as never, { setContext: jest.fn() } as never);

  // The real manager keys `getRepository` on the entity class; here the two
  // callers ask for different entities, so dispatch on which one.
  const manager = {
    getRepository: jest.fn((entity: { name?: string }) =>
      entity?.name === 'AskAuditEntity' ? auditRepo : askRepo,
    ),
  };
  const dataSource = {
    transaction: jest.fn(async (work: (m: unknown) => Promise<unknown>) => work(manager)),
  };
  const answerService = { create: jest.fn().mockResolvedValue({ id: 'answer-1' }) };

  const service = new AskService(
    askRepo as never,
    { countBy: jest.fn().mockResolvedValue(1) } as never,
    { isConsentStanding: jest.fn().mockResolvedValue(true) } as never,
    auditService,
    answerService as never,
    dataSource as never,
    { setContext: jest.fn() } as never,
  );

  return { service, auditRows, askEntity };
}

describe('a reviewed federated disclosure is attributable to its peer', () => {
  it('stamps the peer link AND the handle on the audit row', async () => {
    const { service, auditRows } = makeStack();

    await service.completeWithAnswer(OWNER, 'ask-1', {
      answer: RETRIEVAL_ANSWER,
      disclosedEntityIds: ['e1'],
      backingEntityIds: ['e1'],
      peerHandle: 'ada',
    });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      outcome: 'answered',
      peerLinkId: LINK,
      peerHandle: 'ada',
    });
  });

  it('records the link even when the handle could not be resolved', async () => {
    // A peer link deleted between the answer and the audit resolves to no
    // handle. The row still has to say WHICH peer, because the link id is the
    // durable half — it is on the ask row, not looked up.
    const { service, auditRows } = makeStack();

    await service.completeWithAnswer(OWNER, 'ask-1', {
      answer: RETRIEVAL_ANSWER,
      disclosedEntityIds: ['e1'],
      backingEntityIds: ['e1'],
      peerHandle: null,
    });

    expect(auditRows[0]).toMatchObject({ peerLinkId: LINK, peerHandle: null });
  });

  it('attributes an owner DECLINE of a federated ask too', async () => {
    // `PeerAskService` stamps the peer on the auto-decline a `block` grant
    // produces. A refusal the owner made by hand went through `decline`, which
    // built its row from the ask alone and left the same NULL behind.
    const { service, auditRows } = makeStack({ status: 'under_review' });

    await service.decline(OWNER, 'ask-1', { peerHandle: 'ada' });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      outcome: 'declined',
      peerLinkId: LINK,
      peerHandle: 'ada',
    });
  });

  it('SECURITY: a LOCAL disclosure cannot be pinned on a peer by passing a handle', async () => {
    // The link id is read off the ask row and the handle is honoured only when
    // that row carries one, so a caller that supplies a handle for a household
    // ask cannot manufacture a federated-looking entry in the owner's history.
    const { service, auditRows } = makeStack({
      peerLinkId: null,
      direction: 'local',
      askerUserId: 'asker-1',
    });

    await service.completeWithAnswer(OWNER, 'ask-1', {
      answer: RETRIEVAL_ANSWER,
      disclosedEntityIds: ['e1'],
      backingEntityIds: ['e1'],
      peerHandle: 'ada',
    });

    expect(auditRows[0]).toMatchObject({ peerLinkId: null, peerHandle: null });
  });
});
