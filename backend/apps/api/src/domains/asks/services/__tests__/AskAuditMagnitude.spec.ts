import { type UserServiceContext } from '@ci/common/context';

import type { DisclosedAnswer } from '../../types';
import { AskAuditService } from '../AskAuditService';
import { AskService } from '../AskService';

/**
 * The magnitude has to survive the whole path, not just the last hop.
 *
 * `AskAuditService` can only write what it is handed, and the disclosure it
 * describes is produced two layers up: `completeWithAnswer` holds the
 * {@link DisclosedAnswer}, `complete` writes the audit, and the only thing that
 * used to travel between them was the ITEMIZED id list — empty for every form
 * but `retrieval`. So an `existence` answer over four items reached the
 * audit as an empty disclosure no matter what the audit layer did with it.
 *
 * This runs the real `AskAuditService` against a fake repository rather than a
 * `jest.fn()` stand-in, because the defect is precisely that the two halves
 * agreed on a shape that dropped the number.
 */

const OWNER: UserServiceContext = { userId: 'responder-1' };

/**
 * An `existence` answer: four items matched, NOTHING itemized to the asker.
 * `formDisclosesItems` is false for it, so `items` is empty by construction —
 * which is exactly the shape that audited as a disclosure of nothing.
 */
const EXISTENCE_ANSWER: DisclosedAnswer = {
  form: 'existence',
  items: [],
  disclosedCount: 4,
  withheldCount: 1,
  summary: 'They have 4 matching items.',
  consentBasis: 'grant-auto',
};

function makeStack() {
  const askEntity = {
    id: 'ask-1',
    askerUserId: 'asker-1',
    peerLinkId: null,
    direction: 'local',
    responderUserId: 'responder-1',
    query: { queryType: 'photos', prompt: 'how many photos of us?' },
    status: 'answering',
    consentBasis: 'grant-auto',
    disclosureCeiling: 'count',
    createdAt: new Date('2026-08-20T00:00:00Z'),
    updatedAt: new Date('2026-08-20T00:00:00Z'),
    expiresAt: null,
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

  // `getRepository` is keyed on the entity class in the real manager; here the
  // two callers ask for different entities, so dispatch on which one.
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

  return { service, auditRows };
}

describe('the audited magnitude survives completeWithAnswer → complete → the audit row', () => {
  it('records the count the asker actually received for a non-itemizing form', async () => {
    const { service, auditRows } = makeStack();

    await service.completeWithAnswer(OWNER, 'ask-1', {
      answer: EXISTENCE_ANSWER,
      // Empty, and correctly so: a non-itemizing form names nothing. This is the
      // field the audit used to be derived from.
      disclosedEntityIds: [],
      backingEntityIds: ['e1', 'e2', 'e3', 'e4', 'e5'],
    });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      outcome: 'answered',
      disclosedEntities: [],
      disclosedCount: 4,
    });
  });

  it('still agrees with the itemized list for a retrieval answer', async () => {
    const retrieval: DisclosedAnswer = {
      ...EXISTENCE_ANSWER,
      form: 'retrieval',
      items: [
        { id: 'e1', type: 'file' },
        { id: 'e2', type: 'file' },
      ],
      disclosedCount: 2,
    };
    const { service, auditRows } = makeStack();

    await service.completeWithAnswer(OWNER, 'ask-1', {
      answer: retrieval,
      disclosedEntityIds: ['e1', 'e2'],
      backingEntityIds: ['e1', 'e2'],
    });

    expect(auditRows[0]).toMatchObject({ disclosedEntities: ['e1', 'e2'], disclosedCount: 2 });
  });
});
