import { type UserServiceContext } from '@ci/common/context';

import { type Ask } from '../entities/AskEntity';
import type { CreateAskDto } from '../types';

import { AskService } from './AskService';

const CTX: UserServiceContext = { userId: 'asker-1' };

const DTO: CreateAskDto = {
  responderUserId: 'responder-1',
  query: { queryType: 'photos', prompt: 'do you have photos of us?' },
};

function fakeAsk(overrides: Partial<Ask> = {}): Ask {
  return {
    id: 'ask-1',
    askerUserId: 'asker-1',
    responderUserId: 'responder-1',
    query: DTO.query,
    status: 'delivered',
    consentBasis: null,
    disclosureCeiling: null,
    createdAt: new Date('2026-07-15T00:00:00Z'),
    updatedAt: new Date('2026-07-15T00:00:00Z'),
    expiresAt: null,
    ...overrides,
  } as Ask;
}

/**
 * Construct AskService naming only the collaborators a test actually exercises.
 *
 * Positional DI past three or four dependencies is easy to get silently wrong —
 * a swapped pair still compiles behind `as never` and only shows up as a weird
 * failure elsewhere. Every call site names what it supplies; everything else is
 * an inert stub.
 *
 * `users` defaults to "the responder exists", because that is the precondition
 * of nearly every test here and not the thing under test.
 */
function buildService(
  parts: {
    repo?: unknown;
    users?: unknown;
    grantService?: unknown;
    auditService?: unknown;
    answerService?: unknown;
    dataSource?: unknown;
  } = {},
): AskService {
  return new AskService(
    (parts.repo ?? {}) as never,
    (parts.users ?? { countBy: jest.fn().mockResolvedValue(1) }) as never,
    (parts.grantService ?? {}) as never,
    (parts.auditService ?? {}) as never,
    (parts.answerService ?? {}) as never,
    (parts.dataSource ?? {}) as never,
    { setContext: jest.fn() } as never,
  );
}

function makeService() {
  const grantService = { evaluate: jest.fn() };
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };
  // repository omitted — create/systemTransition/setConsentBasis are spied.
  const service = buildService({ grantService, auditService });

  return { service, grantService, auditService };
}

describe('AskService.submit — grant decision wiring', () => {
  it('auto-declines and audits when a block grant denies the ask', async () => {
    const { service, grantService, auditService } = makeService();
    grantService.evaluate.mockResolvedValue({ decision: 'deny', grantId: 'grant-block' });
    jest.spyOn(service, 'create').mockResolvedValue(fakeAsk());
    const declined = fakeAsk({ status: 'declined', consentBasis: 'grant-block' });
    const sysSpy = jest.spyOn(service, 'systemTransition').mockResolvedValue(declined);

    const result = await service.submit(CTX, DTO);

    expect(sysSpy).toHaveBeenCalledWith('ask-1', 'declined', { consentBasis: 'grant-block' });
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ askId: 'ask-1', outcome: 'declined', consentBasis: 'grant-block' }),
    );
    expect(result).toEqual({ ask: declined, decision: 'deny' });
  });

  it('records the consent basis AND its ceiling, leaving the ask delivered when auto-authorized', async () => {
    const { service, grantService, auditService } = makeService();
    grantService.evaluate.mockResolvedValue({
      decision: 'auto',
      grantId: 'grant-auto',
      maxDisclosure: 'count',
    });
    jest.spyOn(service, 'create').mockResolvedValue(fakeAsk());
    const preauth = fakeAsk({ consentBasis: 'grant-auto' });
    const consentSpy = jest.spyOn(service, 'setConsentBasis').mockResolvedValue(preauth);
    const sysSpy = jest.spyOn(service, 'systemTransition');

    const result = await service.submit(CTX, DTO);

    // Basis and ceiling are stamped TOGETHER. A basis with no ceiling is the
    // shape the answer path used to reconstruct from live grants, and
    // reconstructing it is what let a revocation widen the answer.
    expect(consentSpy).toHaveBeenCalledWith('ask-1', 'grant-auto', 'count');
    expect(sysSpy).not.toHaveBeenCalled(); // stays delivered for the executor
    expect(auditService.record).not.toHaveBeenCalled(); // no terminal outcome yet
    expect(result).toEqual({ ask: preauth, decision: 'auto' });
  });

  it('routes to the owner review inbox when no grant matches', async () => {
    const { service, grantService, auditService } = makeService();
    grantService.evaluate.mockResolvedValue({ decision: 'review' });
    jest.spyOn(service, 'create').mockResolvedValue(fakeAsk());
    const inboxed = fakeAsk({ status: 'under_review' });
    const sysSpy = jest.spyOn(service, 'systemTransition').mockResolvedValue(inboxed);

    const result = await service.submit(CTX, DTO);

    expect(sysSpy).toHaveBeenCalledWith('ask-1', 'under_review');
    expect(auditService.record).not.toHaveBeenCalled();
    expect(result).toEqual({ ask: inboxed, decision: 'review' });
  });
});

function mutableEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ask-1',
    askerUserId: 'asker-1',
    responderUserId: 'responder-1',
    query: DTO.query,
    status: 'answering',
    consentBasis: null,
    createdAt: new Date('2026-07-15T00:00:00Z'),
    updatedAt: new Date('2026-07-15T00:00:00Z'),
    expiresAt: null,
    ...overrides,
  };
}

function makeServiceWithRepo(entity: Record<string, unknown>, consentStanding = true) {
  const repo = {
    findOne: jest.fn().mockResolvedValue(entity),
    save: jest.fn().mockImplementation((e: unknown) => Promise.resolve(e)),
  };
  const grantService = {
    evaluate: jest.fn(),
    isConsentStanding: jest.fn().mockResolvedValue(consentStanding),
  };
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };
  const service = buildService({ repo, grantService, auditService });

  return { service, repo, auditService, grantService };
}

const OWNER: UserServiceContext = { userId: 'responder-1' };

describe('AskService.complete', () => {
  it('finalizes an owner-approved ask to answered and audits it', async () => {
    const entity = mutableEntity({ status: 'answering' });
    const { service, auditService } = makeServiceWithRepo(entity);

    const result = await service.complete(OWNER, 'ask-1', ['e1', 'e2']);

    expect(result.status).toBe('answered');
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'answered', disclosedEntities: ['e1', 'e2'] }),
      undefined,
    );
  });

  it('audits the backing set under its OWN name, never as the disclosure', async () => {
    const entity = mutableEntity({ status: 'answering' });
    const { service, auditService } = makeServiceWithRepo(entity);

    // The shape a clamped answer produces: nothing itemized to the asker, four
    // entities read to compute it. Writing the four into `disclosedEntities` is
    // what made the audit and ci.ask_answers disagree about the same event.
    await service.complete(OWNER, 'ask-1', [], { backingEntityIds: ['e1', 'e2', 'e3', 'e4'] });

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        disclosedEntities: [],
        backingEntities: ['e1', 'e2', 'e3', 'e4'],
      }),
      undefined,
    );
  });

  it('finalizes an auto-authorized (delivered + consent) ask as auto_answered', async () => {
    const entity = mutableEntity({ status: 'delivered', consentBasis: 'grant-auto' });
    const { service, auditService } = makeServiceWithRepo(entity);

    const result = await service.complete(OWNER, 'ask-1', []);

    expect(result.status).toBe('answered'); // delivered → answering → answered
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'auto_answered' }),
      undefined,
    );
  });

  it('refuses to complete an ask that is not yet answerable', async () => {
    const entity = mutableEntity({ status: 'under_review' });
    const { service, auditService } = makeServiceWithRepo(entity);

    await expect(service.complete(OWNER, 'ask-1', [])).rejects.toThrow();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  // DEFECT 2 — revocation must reach an ALREADY-authorized ask.
  //
  // `submit` stamps consentBasis at submit time and `isAnswerable` trusts the
  // stamp, so before this an ask pre-authorized under a grant stayed answerable
  // for as long as it lived, no matter what the owner did to the grant
  // afterwards. The UI promises "revocable in one tap"; a user reads that as
  // "stops future disclosure", not "stops future asks only".
  it('SECURITY: refuses to answer an auto-authorized ask whose grant is no longer in force', async () => {
    const entity = mutableEntity({ status: 'delivered', consentBasis: 'grant-auto' });
    const { service, auditService, grantService } = makeServiceWithRepo(entity, false);

    await expect(service.complete(OWNER, 'ask-1', ['e1'])).rejects.toThrow(/no longer in force/);

    expect(grantService.isConsentStanding).toHaveBeenCalled();
    // Nothing is finalized and nothing is audited as answered — the ask stays
    // where it was, for the owner to decide on personally.
    expect(entity.status).toBe('delivered');
    expect(auditService.record).not.toHaveBeenCalled();
  });

  // The other half of the same rule: an ask the owner personally approved is
  // authorized by that decision, not by a standing grant, so the grant re-check
  // must not run and must not be able to break it.
  it('does NOT re-check grants for an ask the owner approved personally', async () => {
    const entity = mutableEntity({ status: 'answering', consentBasis: null });
    const { service, grantService } = makeServiceWithRepo(entity, false);

    const result = await service.complete(OWNER, 'ask-1', ['e1']);

    expect(result.status).toBe('answered');
    expect(grantService.isConsentStanding).not.toHaveBeenCalled();
  });
});

function makeServiceForCreate() {
  const repo = {
    create: jest.fn().mockImplementation((data: Record<string, unknown>) => data),
    save: jest.fn().mockImplementation((entity: Record<string, unknown>) => Promise.resolve(entity)),
  };
  const users = { countBy: jest.fn().mockResolvedValue(1) };
  const service = buildService({ repo, users });

  return { service, repo, users };
}

describe('AskService.create — the self-ask guard', () => {
  it('refuses an ask a user directs at themselves', async () => {
    const { service, repo } = makeServiceForCreate();
    const self: UserServiceContext = { userId: 'user-1' };

    await expect(service.create(self, { ...DTO, responderUserId: 'user-1' })).rejects.toThrow(
      'An ask must be directed at another user',
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('allows an ask directed at a different user', async () => {
    const { service } = makeServiceForCreate();

    await expect(service.create(CTX, DTO)).resolves.toMatchObject({
      askerUserId: 'asker-1',
      responderUserId: 'responder-1',
      status: 'delivered',
    });
  });

  /**
   * The account-enumeration oracle. `create` used to do no existence check at
   * all, so an unknown responder id fell through to Postgres and came back as
   * the `asks_responder_user_id_fkey` violation — a different, recognizable
   * failure from every other refusal. Any signed-in user could then test
   * arbitrary ids for the existence of an account.
   *
   * The property is not "unknown ids are refused" (they always were, by the FK)
   * but that the refusal is INDISTINGUISHABLE from the one a self-ask gets.
   */
  it('refuses an unknown responder with the SAME failure as a self-ask, never the FK error', async () => {
    const { service, repo, users } = makeServiceForCreate();
    users.countBy.mockResolvedValue(0); // no such account

    const unknown = service.create(CTX, { ...DTO, responderUserId: 'ghost-1' });
    await expect(unknown).rejects.toThrow('An ask must be directed at another user');
    // Never reaches the database, so the constraint name never reaches the caller.
    expect(repo.save).not.toHaveBeenCalled();

    // Byte-for-byte the same message the self-ask guard raises.
    const self = service.create({ userId: 'user-1' }, { ...DTO, responderUserId: 'user-1' });
    const [unknownError, selfError] = await Promise.all([
      unknown.catch((error: Error) => error.message),
      self.catch((error: Error) => error.message),
    ]);
    expect(unknownError).toBe(selfError);
  });

  it('does not probe for a local account on an OUTBOUND ask, whose responder is a peer', async () => {
    const { service, users } = makeServiceForCreate();

    await expect(
      service.create(CTX, { ...DTO, responderUserId: null, direction: 'outbound', peerLinkId: 'link-1' }),
    ).resolves.toMatchObject({ responderUserId: null });
    expect(users.countBy).not.toHaveBeenCalled();
  });
});

/**
 * The answer row and the audit row are ONE disclosure written twice. Split
 * across two connections, a failure between them is permanent rather than
 * transient: `AskAnswerService.create` is insert-only, so the retry hits the
 * conflict instead of writing the audit that is missing.
 */
describe('AskService.completeWithAnswer — the disclosure and its audit are atomic', () => {
  const DISCLOSED = {
    answer: {
      form: 'retrieval' as const,
      items: [{ id: 'e1', type: 'file' }],
      disclosedCount: 1,
      withheldCount: 0,
      summary: 'They shared 1 item.',
      consentBasis: null,
    },
    disclosedEntityIds: ['e1'],
    backingEntityIds: ['e1', 'e2'],
  };

  function makeTransactionalService(options: { failAudit?: boolean } = {}) {
    const entity = mutableEntity({ status: 'answering' });
    const repo = {
      findOne: jest.fn().mockResolvedValue(entity),
      save: jest.fn().mockImplementation((e: unknown) => Promise.resolve(e)),
    };
    const auditService = {
      record: options.failAudit
        ? jest.fn().mockRejectedValue(new Error('audit write failed'))
        : jest.fn().mockResolvedValue(undefined),
    };
    const answerService = { create: jest.fn().mockResolvedValue({ id: 'answer-1' }) };

    // A faithful-enough stand-in: it hands the callback a manager and, like a
    // real transaction, does NOT swallow a rejection — the rollback is the
    // caller's error propagating rather than each write having already
    // committed on its own connection.
    const manager = { getRepository: jest.fn().mockReturnValue(repo) };
    const dataSource = {
      transaction: jest.fn(async (work: (m: unknown) => Promise<unknown>) => work(manager)),
    };
    const service = buildService({ repo, auditService, answerService, dataSource });

    return { service, dataSource, manager, auditService, answerService };
  }

  it('writes the answer and the audit inside ONE transaction, both bound to its manager', async () => {
    const { service, dataSource, manager, auditService, answerService } = makeTransactionalService();

    const result = await service.completeWithAnswer(OWNER, 'ask-1', DISCLOSED);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    // Both writes must be enrolled — an unenrolled one commits independently and
    // reintroduces exactly the split this closes.
    expect(answerService.create).toHaveBeenCalledWith({ askId: 'ask-1', answer: DISCLOSED.answer }, manager);
    expect(auditService.record).toHaveBeenCalledWith(expect.any(Object), manager);
    expect(result.ask.status).toBe('answered');
    expect(result.answer).toEqual({ id: 'answer-1' });
  });

  it('propagates a failed audit write instead of leaving the answer behind', async () => {
    const { service } = makeTransactionalService({ failAudit: true });

    await expect(service.completeWithAnswer(OWNER, 'ask-1', DISCLOSED)).rejects.toThrow('audit write failed');
  });

  it('runs the lifecycle gate INSIDE the transaction, so a refusal takes the answer with it', async () => {
    const entity = mutableEntity({ status: 'under_review' });
    const repo = {
      findOne: jest.fn().mockResolvedValue(entity),
      save: jest.fn(),
    };
    const manager = { getRepository: jest.fn().mockReturnValue(repo) };
    const dataSource = {
      transaction: jest.fn(async (work: (m: unknown) => Promise<unknown>) => work(manager)),
    };
    const answerService = { create: jest.fn().mockResolvedValue({ id: 'answer-1' }) };
    const service = buildService({ repo, answerService, dataSource, auditService: { record: jest.fn() } });

    await expect(service.completeWithAnswer(OWNER, 'ask-1', DISCLOSED)).rejects.toThrow(
      /not ready to answer/,
    );
    // The answer write happened first — which is precisely why it has to be
    // inside the transaction that then aborts.
    expect(answerService.create).toHaveBeenCalledWith(expect.any(Object), manager);
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });
});

/**
 * A minimal, FAITHFUL in-memory stand-in for the TypeORM repository — not a
 * hand-picked fixture per test. `findOne`/`find` implement the actual semantics
 * of the `where` shape AskService passes (an array of clauses is OR'd, an
 * object's keys are AND'd), the same way TypeORM itself interprets it. That
 * makes this a real test of the tenancy predicate AskService builds — a swapped
 * field, a missing OR branch, or an AND where an OR belongs would misbehave
 * here exactly as it would against Postgres, rather than only against whatever
 * a narrower mock was told to return.
 */
interface FakeRow {
  id: string;
  askerUserId: string;
  responderUserId: string;
  status: string;
  createdAt: Date;
  [key: string]: unknown;
}

function matchesClause(row: FakeRow, clause: Record<string, unknown>): boolean {
  return Object.entries(clause).every(([key, value]) => row[key] === value);
}

function matchesWhere(row: FakeRow, where: Record<string, unknown> | Record<string, unknown>[]): boolean {
  return Array.isArray(where)
    ? where.some((clause) => matchesClause(row, clause))
    : matchesClause(row, where);
}

function fakeAskRepository(rows: FakeRow[]) {
  return {
    findOne: jest.fn(
      async ({ where }: { where: Record<string, unknown> | Record<string, unknown>[] }) =>
        rows.find((row) => matchesWhere(row, where)) ?? null,
    ),
    find: jest.fn(
      async ({
        where,
        order,
      }: {
        where: Record<string, unknown> | Record<string, unknown>[];
        order?: Record<string, 'ASC' | 'DESC'>;
      }) => {
        const matched = rows.filter((row) => matchesWhere(row, where));

        return order?.createdAt === 'DESC'
          ? [...matched].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          : matched;
      },
    ),
  };
}

function fakeAskRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: 'ask-x',
    askerUserId: 'asker',
    responderUserId: 'responder',
    query: DTO.query,
    status: 'delivered',
    consentBasis: null,
    disclosureCeiling: null,
    createdAt: new Date('2026-07-15T00:00:00Z'),
    updatedAt: new Date('2026-07-15T00:00:00Z'),
    expiresAt: null,
    ...overrides,
  };
}

// The tenancy/privacy boundary the audit flagged: "an ask is visible to its
// asker and its responder only". A regression here lets an unrelated third
// user read another pair's ask, so the case that matters is not "the right
// user gets it" but "everyone else does NOT".
describe('AskService.findById — participant-only visibility', () => {
  it('is visible to the asker', async () => {
    const ask = fakeAskRow({ id: 'ask-1', askerUserId: 'alice', responderUserId: 'bob' });
    const repo = fakeAskRepository([ask]);
    const service = buildService({ repo });

    await expect(service.findById({ userId: 'alice' }, 'ask-1')).resolves.toMatchObject({ id: 'ask-1' });
  });

  it('is visible to the responder', async () => {
    const ask = fakeAskRow({ id: 'ask-1', askerUserId: 'alice', responderUserId: 'bob' });
    const repo = fakeAskRepository([ask]);
    const service = buildService({ repo });

    await expect(service.findById({ userId: 'bob' }, 'ask-1')).resolves.toMatchObject({ id: 'ask-1' });
  });

  it('is NOT visible to an unrelated third user, even one who is a participant on a DIFFERENT ask', async () => {
    const ask = fakeAskRow({ id: 'ask-1', askerUserId: 'alice', responderUserId: 'bob' });
    // 'carol' is a legitimate participant, just on an unrelated ask — proves the
    // check is scoped to THIS ask's id, not merely "is carol a participant of
    // anything".
    const otherAsk = fakeAskRow({ id: 'ask-2', askerUserId: 'carol', responderUserId: 'dave' });
    const repo = fakeAskRepository([ask, otherAsk]);
    const service = buildService({ repo });

    await expect(service.findById({ userId: 'carol' }, 'ask-1')).resolves.toBeNull();
    await expect(service.findById({ userId: 'dave' }, 'ask-1')).resolves.toBeNull();
    await expect(service.findById({ userId: 'someone-else' }, 'ask-1')).resolves.toBeNull();
  });
});

describe('AskService.listInbox — responder-scoped review queue', () => {
  it("lists only the responder's own delivered / under_review asks, newest first", async () => {
    const mine1 = fakeAskRow({
      id: 'inbox-1',
      responderUserId: 'bob',
      status: 'delivered',
      createdAt: new Date('2026-07-15T00:00:00Z'),
    });
    const mine2 = fakeAskRow({
      id: 'inbox-2',
      responderUserId: 'bob',
      status: 'under_review',
      createdAt: new Date('2026-07-16T00:00:00Z'),
    });
    // Terminal — must NOT appear in the review inbox even though bob responds.
    const answered = fakeAskRow({ id: 'inbox-3', responderUserId: 'bob', status: 'answered' });
    // A DIFFERENT responder's pending ask — the tenancy case: must not leak
    // into bob's inbox.
    const someoneElses = fakeAskRow({ id: 'inbox-4', responderUserId: 'carol', status: 'delivered' });

    const repo = fakeAskRepository([mine1, mine2, answered, someoneElses]);
    const service = buildService({ repo });

    const inbox = await service.listInbox({ userId: 'bob' });

    expect(inbox.map((a) => a.id)).toEqual(['inbox-2', 'inbox-1']); // newest first
  });
});

describe('AskService.listOutbox — asker-scoped sent history', () => {
  it("lists only the asker's own asks, regardless of status", async () => {
    const mine = fakeAskRow({ id: 'out-1', askerUserId: 'alice', status: 'answered' });
    // Someone else's ask, even to the same responder — must not leak.
    const someoneElses = fakeAskRow({
      id: 'out-2',
      askerUserId: 'eve',
      responderUserId: mine.responderUserId,
    });

    const repo = fakeAskRepository([mine, someoneElses]);
    const service = buildService({ repo });

    const outbox = await service.listOutbox({ userId: 'alice' });

    expect(outbox.map((a) => a.id)).toEqual(['out-1']);
  });
});

/**
 * ═══ THE CEILING IS CAPTURED WHEN THE OWNER CONSENTS, NOT WHEN THE ANSWER RUNS ═══
 *
 * `AskResolver` used to re-derive the deciding grant's `maxDisclosure` at
 * answer time. Every SQL read path filters `revoked_at IS NULL`, so a revoked
 * or lapsed grant is INVISIBLE there — the re-evaluation found nothing,
 * returned no ceiling, and the ask ran under the tier ceiling alone. On an ask
 * the owner had already approved (status `answering`, deliberately exempt from
 * retroactive withdrawal per #2211) the answer therefore GREW when consent was
 * withdrawn: reproduced against Postgres as `items: []` / "3 matching items."
 * with the grant in force, and three readable entity references with it
 * revoked.
 *
 * `approve` is one of the two moments consent is given, so it is one of the two
 * places the ceiling is stamped (the other is the `auto` branch of `submit`).
 */
describe('AskService.approve — capturing the disclosure ceiling', () => {
  function approvable(overrides: Partial<Ask> = {}) {
    const entity = { ...fakeAsk({ status: 'under_review', ...overrides }) } as Record<string, unknown>;
    const repo = {
      findOne: jest.fn().mockResolvedValue(entity),
      save: jest.fn().mockImplementation((row: unknown) => Promise.resolve(row)),
    };
    const grantService = { evaluate: jest.fn() };

    return { entity, repo, grantService, service: buildService({ repo, grantService }) };
  }

  const OWNER: UserServiceContext = { userId: 'responder-1' };

  it("stamps the deciding grant's maxDisclosure onto the ask", async () => {
    const { service, grantService, entity } = approvable();
    grantService.evaluate.mockResolvedValue({ decision: 'review', grantId: 'g1', maxDisclosure: 'count' });

    const approved = await service.approve(OWNER, 'ask-1');

    expect(approved.status).toBe('answering');
    expect(approved.disclosureCeiling).toBe('count');
    expect(entity.disclosureCeiling).toBe('count');
  });

  it('stamps `none` when a block grant covers the ask at approval time', async () => {
    // The owner's tap must not be able to push anything past their own block.
    const { service, grantService } = approvable();
    grantService.evaluate.mockResolvedValue({ decision: 'deny', grantId: 'blk' });

    expect((await service.approve(OWNER, 'ask-1')).disclosureCeiling).toBe('none');
  });

  it('stamps NULL when no grant capped the ask — no cap is not the same as a typo', async () => {
    const { service, grantService } = approvable();
    grantService.evaluate.mockResolvedValue({ decision: 'review' });

    expect((await service.approve(OWNER, 'ask-1')).disclosureCeiling).toBeNull();
  });

  /**
   * The loop-closing case. `withdrawPreAuthorization` sends a revoked ask back
   * to review with its basis cleared and its ceiling INTACT, so the ceiling the
   * owner originally consented under survives as a floor — approving the ask
   * afterwards cannot disclose more than it would have before the revoke.
   */
  it('never RAISES a ceiling already stamped on the ask', async () => {
    const { service, grantService } = approvable({ disclosureCeiling: 'count' });
    // The grant that capped it is gone, so the live evaluation finds nothing…
    grantService.evaluate.mockResolvedValue({ decision: 'review' });

    expect((await service.approve(OWNER, 'ask-1')).disclosureCeiling).toBe('count');

    // …and a MORE generous replacement cannot raise it either.
    const wider = approvable({ disclosureCeiling: 'count' });
    wider.grantService.evaluate.mockResolvedValue({
      decision: 'auto',
      grantId: 'g2',
      maxDisclosure: 'full',
    });

    expect((await wider.service.approve(OWNER, 'ask-1')).disclosureCeiling).toBe('count');
  });

  it('still lets a LOWER live ceiling tighten one already stamped', async () => {
    const { service, grantService } = approvable({ disclosureCeiling: 'full' });
    grantService.evaluate.mockResolvedValue({ decision: 'review', grantId: 'g3', maxDisclosure: 'boolean' });

    expect((await service.approve(OWNER, 'ask-1')).disclosureCeiling).toBe('boolean');
  });
});
