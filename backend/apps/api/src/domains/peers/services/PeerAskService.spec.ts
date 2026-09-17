import { ConflictException } from '@nestjs/common';

import { AskEntity, GrantService, TERMINAL_ASK_STATUSES } from '@ci/domains/asks';

import { PEER_ASK_NO_ANSWER_REASON, PEER_ASK_PENDING, type PeerAskBody } from '../protocol';

import { requestDigest } from './PeerAskCorrelationService';
import { PeerAskService, clampAvailability, toAskQuery, toWireAnswer } from './PeerAskService';

const PEER = { issuer: 'https://hub.test', subject: 'peer-sub' };

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    ownerUserId: 'owner-1',
    peerHandle: 'devon',
    displayName: 'Devon',
    memoryEndpoint: 'https://devon.box/agent/v1',
    peerIssuer: PEER.issuer,
    peerSubject: PEER.subject,
    personEntityId: null,
    trustTier: 'trusted',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    revokedAt: null,
    ...overrides,
  } as never;
}

function body(request: PeerAskBody['request']): PeerAskBody {
  return { askId: 'ask-corr-1', askerHandle: 'devon', prompt: 'q?', request };
}

/** One persisted write, with the transaction context it was made in. */
interface RecordedWrite {
  target: 'answer' | 'ask' | 'audit';
  /** Was the caller inside `manager.transaction` when this ran? */
  transacted: boolean;
  /** The EntityManager the write was enrolled in, if any. */
  manager: unknown;
}

function makeService(
  opts: {
    links?: unknown[];
    decision?: string;
    maxDisclosure?: string;
    events?: unknown[];
    consentStanding?: boolean;
    /** A correlation already on file for this (link, askId) — the replay case. */
    correlation?: { askId: string; requestDigest: string } | null;
    /** What `AskAnswerService.findByAskId` returns when a replay reads it back. */
    storedAnswer?: unknown;
    /** The status the persisted ask row starts at (a replay reads it). */
    askStatus?: string;
  } = {},
) {
  const peerLinkService = {
    findActiveByPeerIdentity: jest.fn().mockResolvedValue(opts.links ?? [link()]),
  };
  const baseAsk = {
    id: 'ask-1',
    askerUserId: null,
    responderUserId: 'owner-1',
    peerLinkId: 'link-1',
    direction: 'inbound',
    consentBasis: null as string | null,
    disclosureCeiling: null as string | null,
    status: 'delivered',
    query: { queryType: 'content', prompt: 'q?' },
  };
  // THE PERSISTED ROW, kept distinct from the egress copies the service passes
  // around. `terminalize` reads the ask back inside the transaction rather than
  // trusting the handle it was given, so a mock that only returned fresh
  // objects could not show whether the terminal status was ever WRITTEN — which
  // is the whole defect.
  const askRow = { ...baseAsk };
  // The ask ECHOES the query it was created with, rather than pinning a content
  // one for every archetype. The tier ceiling is resolved from
  // `ask.query.dataClass`, so a mock that flattened the three archetypes into
  // one would hide exactly the per-archetype ceiling bug these tests cover.
  let created = baseAsk;
  const askService = {
    // A replay reads the row back rather than trusting anything it was handed —
    // the recorded outcome is the only thing that knows whether the owner has
    // answered since.
    findById: jest.fn().mockImplementation(() => Promise.resolve({ ...created, status: askRow.status })),
    create: jest.fn().mockImplementation((_ctx: unknown, data: { query: unknown }) => {
      created = { ...baseAsk, query: data.query as typeof baseAsk.query };
      askRow.query = created.query;

      return Promise.resolve(created);
    }),
    // The lifecycle must actually be persisted — a denied peer ask that stays
    // `delivered` would remain actionable in the owner's inbox.
    systemTransition: jest
      .fn()
      .mockImplementation((_id: string, to: string, options: { consentBasis?: string | null } = {}) => {
        askRow.status = to;

        if (options.consentBasis !== undefined) {
          askRow.consentBasis = options.consentBasis;
        }

        created = { ...created, status: to, consentBasis: askRow.consentBasis };

        return Promise.resolve(created);
      }),
    setConsentBasis: jest
      .fn()
      .mockImplementation((_id: string, basis: string | null, ceiling: string | null) => {
        askRow.consentBasis = basis;
        askRow.disclosureCeiling = ceiling;
        created = { ...created, consentBasis: basis };

        return Promise.resolve(created);
      }),
  };
  const grantService = {
    evaluate: jest.fn().mockResolvedValue({
      decision: opts.decision ?? 'auto',
      grantId: 'g1',
      ...(opts.maxDisclosure ? { maxDisclosure: opts.maxDisclosure } : {}),
    }),
    isConsentStanding: jest.fn().mockResolvedValue(opts.consentStanding ?? true),
  };
  const executorService = { execute: jest.fn().mockResolvedValue([{ id: 'e1', type: 'file' }]) };

  const writes: RecordedWrite[] = [];
  let transacting = false;
  const askRepository = {
    findOne: jest
      .fn()
      .mockImplementation(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          where.id === askRow.id && where.responderUserId === askRow.responderUserId ? askRow : null,
        ),
      ),
    save: jest.fn().mockImplementation((entity: unknown) => {
      writes.push({ target: 'ask', transacted: transacting, manager });

      return Promise.resolve(entity);
    }),
  };
  const manager = { getRepository: jest.fn().mockReturnValue(askRepository) };
  // `PeerAskService` reaches the correlation table through the injected
  // repository's MANAGER rather than through a constructor dependency, so that
  // the several places that build this service by hand (including the DB-backed
  // suites) do not break every time it grows one. The mock has to model that.
  const correlationRepository = {
    findOne: jest.fn().mockResolvedValue(opts.correlation === undefined ? null : opts.correlation),
    create: jest.fn().mockImplementation((row: unknown) => row),
    save: jest.fn().mockImplementation((row: unknown) => Promise.resolve(row)),
  };
  const eventRepository = {
    find: jest.fn().mockResolvedValue(opts.events ?? []),
    manager: {
      getRepository: jest.fn().mockReturnValue(correlationRepository),
      transaction: jest.fn().mockImplementation(async (work: (m: unknown) => Promise<unknown>) => {
        transacting = true;
        try {
          return await work(manager);
        } finally {
          transacting = false;
        }
      }),
    },
  };
  const answerService = {
    create: jest.fn().mockImplementation((_dto: unknown, enrolled: unknown) => {
      writes.push({ target: 'answer', transacted: transacting, manager: enrolled });

      return Promise.resolve({});
    }),
    findByAskId: jest.fn().mockResolvedValue(opts.storedAnswer ?? null),
  };
  const auditService = {
    record: jest.fn().mockImplementation((_dto: unknown, enrolled: unknown) => {
      writes.push({ target: 'audit', transacted: transacting, manager: enrolled });

      return Promise.resolve(undefined);
    }),
  };
  const logger = { setContext: jest.fn(), warn: jest.fn(), log: jest.fn() };

  if (opts.askStatus) {
    askRow.status = opts.askStatus;
  }

  const service = new PeerAskService(
    peerLinkService as never,
    askService as never,
    grantService as never,
    executorService as never,
    answerService as never,
    auditService as never,
    eventRepository as never,
    logger as never,
  );

  return {
    service,
    peerLinkService,
    askService,
    grantService,
    executorService,
    answerService,
    auditService,
    eventRepository,
    askRepository,
    correlationRepository,
    askRow,
    manager,
    writes,
  };
}

describe('PeerAskService.handle', () => {
  it('refuses an unlinked peer', async () => {
    const { service, askService } = makeService({ links: [] });

    await expect(
      service.handle(PEER, body({ archetype: 'relationship', subject: 'Carol' })),
    ).rejects.toThrow();
    // Nothing is recorded for a stranger — no ask row, no probing signal.
    expect(askService.create).not.toHaveBeenCalled();
  });

  it('refuses when the peer matches more than one household member', async () => {
    const { service } = makeService({ links: [link(), link({ id: 'link-2' })] });

    await expect(
      service.handle(PEER, body({ archetype: 'relationship', subject: 'Carol' })),
    ).rejects.toThrow();
  });

  it('creates the ask as INBOUND with no local asker, attributed to the peer link', async () => {
    const { service, askService } = makeService();

    await service.handle(PEER, body({ archetype: 'content', subject: 'beach photos' }));

    expect(askService.create).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      expect.objectContaining({
        responderUserId: 'owner-1',
        peerLinkId: 'link-1',
        direction: 'inbound',
      }),
    );
  });

  it('declines when a grant blocks, and the decline carries no detail', async () => {
    const { service, auditService } = makeService({ decision: 'deny' });

    const result = await service.handle(PEER, body({ archetype: 'content', subject: 'x' }));

    expect(result.status).toBe(PEER_ASK_PENDING);
    expect(result.answer).toBeUndefined();
    // No EntityManager: a decline writes ONE row and has nothing to be atomic
    // with. Only the answer path carries a transaction.
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'declined',
        peerLinkId: 'link-1',
        consentBasis: 'g1',
        disclosedCount: 0,
      }),
      undefined,
    );
  });

  it('SECURITY: a block and an ask awaiting a human are the SAME reply, field for field', async () => {
    const { service: blocking } = makeService({ decision: 'deny' });
    const { service: reviewing } = makeService({ decision: 'review' });

    const blocked = await blocking.handle(PEER, body({ archetype: 'content', subject: 'x' }));
    const pending = await reviewing.handle(PEER, body({ archetype: 'content', subject: 'x' }));

    // The wire used to say `declined` / 'Not permitted' versus `pending_review`
    // / 'Awaiting owner review'. Everything BELOW the status word was already
    // identical, so the word itself was a one-bit read on the responder's grant
    // matrix — mappable at 10 asks a minute by varying queryType and dataClass.
    // #2210/#2216 closed exactly this for a LOCAL asker and left the federated
    // path emitting it.
    expect(blocked).toEqual(pending);
    expect(blocked.reason).toBe(PEER_ASK_NO_ANSWER_REASON);
  });

  it('SECURITY: a revoked pre-authorization is that same reply too', async () => {
    const { service: reviewing } = makeService({ decision: 'review' });
    const { service: withdrawn } = makeService({ consentStanding: false });

    const pending = await reviewing.handle(PEER, body({ archetype: 'content', subject: 'x' }));
    const revoked = await withdrawn.handle(PEER, body({ archetype: 'content', subject: 'x' }));

    // "Your grant was revoked" would hand the peer the owner's consent posture
    // as a side channel, one step removed.
    expect(revoked).toEqual(pending);
  });

  it('SECURITY: a denied ask is transitioned to declined, not left actionable in the inbox', async () => {
    const { service, askService } = makeService({ decision: 'deny' });

    await service.handle(PEER, body({ archetype: 'content', subject: 'x' }));

    // Left at `delivered`, listInbox would surface it as approvable — letting
    // the owner override their own block grant without realising it.
    expect(askService.systemTransition).toHaveBeenCalledWith('ask-1', 'declined', {
      consentBasis: 'g1',
    });
  });

  it('queues for owner review when no standing grant matches', async () => {
    const { service, executorService, askService } = makeService({ decision: 'review' });

    const result = await service.handle(PEER, body({ archetype: 'content', subject: 'x' }));

    expect(result.status).toBe(PEER_ASK_PENDING);
    // Nothing executed against the owner's memory without consent.
    expect(executorService.execute).not.toHaveBeenCalled();
    // And it is moved into the review queue rather than left in limbo.
    expect(askService.systemTransition).toHaveBeenCalledWith('ask-1', 'under_review');
  });

  it('records which grant auto-authorized an ask, AND the ceiling it imposed', async () => {
    const { service, askService } = makeService({ decision: 'auto', maxDisclosure: 'count' });

    await service.handle(PEER, body({ archetype: 'content', subject: 'x' }));

    // The ceiling is stamped WITH the basis. Re-deriving it later is what let a
    // revoked grant widen an answer on the local path; the same stamp keeps a
    // re-run of this ask capped at what the owner consented to.
    expect(askService.setConsentBasis).toHaveBeenCalledWith('ask-1', 'g1', 'count');
  });

  it('answers a relationship ask as a boolean with NO item references', async () => {
    const { service } = makeService();

    const result = await service.handle(PEER, body({ archetype: 'relationship', subject: 'Carol' }));

    expect(result.status).toBe('answered');
    expect(result.answer?.form).toBe('boolean');
    expect(result.answer?.items).toEqual([]);
  });

  it('SECURITY: a boolean answer carries no cardinality (no keyword-count oracle)', async () => {
    const { service, executorService } = makeService();
    // Several matches behind a yes/no question.
    executorService.execute.mockResolvedValue([
      { id: 'e1', type: 'file' },
      { id: 'e2', type: 'file' },
      { id: 'e3', type: 'event' },
    ]);

    const result = await service.handle(PEER, body({ archetype: 'relationship', subject: 'Carol' }));

    // Emitting 3 here would let a peer re-ask with varied terms and read match
    // counts back out of the responder's whole corpus.
    expect(result.answer?.disclosedCount).toBeUndefined();
    expect(result.answer?.withheldCount).toBeUndefined();
    expect(JSON.stringify(result.answer)).not.toContain('e1');
  });

  it('an existence answer DOES carry a count — that is what the form means', async () => {
    const { service, executorService } = makeService();
    executorService.execute.mockResolvedValue([
      { id: 'e1', type: 'file' },
      { id: 'e2', type: 'file' },
    ]);

    const result = await service.handle(PEER, body({ archetype: 'content', subject: 'beach' }));

    expect(result.answer?.form).toBe('existence');
    expect(result.answer?.disclosedCount).toBe(2);
  });

  it('answers an availability ask from the calendar without touching the search index', async () => {
    // A FAMILY link, so the answer is unclamped and the busy interval below is
    // a real assertion about the calendar having been read. The fixture default
    // is `trusted`, whose calendar ceiling is `redacted` — which now drops the
    // busy intervals (D2). This test is about the SOURCE of an availability
    // answer, not its rung; pinning it to a tier that discloses fully keeps it
    // testing the thing its name claims.
    const { service, executorService, eventRepository } = makeService({
      links: [link({ trustTier: 'family' })],
    });
    eventRepository.find.mockResolvedValue([
      { startTime: new Date('2026-08-07T10:00:00Z'), endTime: new Date('2026-08-07T11:00:00Z') },
    ]);

    const result = await service.handle(
      PEER,
      body({
        archetype: 'availability',
        from: '2026-08-07T09:00:00.000Z',
        to: '2026-08-07T17:00:00.000Z',
        minMinutes: 60,
        purpose: 'lunch',
      }),
    );

    expect(result.answer?.form).toBe('availability');
    expect(result.answer?.busy).toEqual([
      { start: '2026-08-07T10:00:00.000Z', end: '2026-08-07T11:00:00.000Z' },
    ]);
    expect(result.answer?.items).toBeUndefined();
    // Availability never runs the memory search executor.
    expect(executorService.execute).not.toHaveBeenCalled();
  });

  it('marks the owner busy for an occurrence of a recurring series', async () => {
    // `ci.events` holds ONE row per series, and this row's own span is in June.
    // Without read-time RRULE expansion the box answered "free" for every
    // occurrence after the first — so a peer was handed a slot the owner has
    // stood in a standup for, every Monday, for years.
    const { service, eventRepository } = makeService({ links: [link({ trustTier: 'family' })] });
    eventRepository.find.mockResolvedValue([
      {
        id: '0198f0a0-0000-7000-8000-000000000001',
        startTime: new Date('2026-06-01T16:00:00Z'),
        endTime: new Date('2026-06-01T16:30:00Z'),
        isAllDay: false,
        isRecurring: true,
        metadata: {
          recurrenceRule: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
          recurrenceTimeZone: 'America/Los_Angeles',
        },
        recurrencePattern: null,
        sourceSystem: 'calendar',
        sourceId: 'standup@google.com',
      },
    ]);

    const result = await service.handle(
      PEER,
      body({
        archetype: 'availability',
        // 2026-08-03 is a Monday; 09:00 Pacific is 16:00Z.
        from: '2026-08-03T15:00:00.000Z',
        to: '2026-08-03T20:00:00.000Z',
        purpose: 'lunch',
      }),
    );

    expect(result.answer?.busy).toEqual([
      { start: '2026-08-03T16:00:00.000Z', end: '2026-08-03T16:30:00.000Z' },
    ]);
  });

  it('asks for recurring masters on a third where arm, matched on start alone', async () => {
    const { service, eventRepository } = makeService();

    await service.handle(
      PEER,
      body({
        archetype: 'availability',
        from: '2026-08-03T15:00:00.000Z',
        to: '2026-08-03T20:00:00.000Z',
      }),
    );

    const [{ where, select }] = eventRepository.find.mock.calls[0] as [
      { where: Record<string, unknown>[]; select: Record<string, unknown> },
    ];
    // A series master's own DTSTART is almost never inside the window, so
    // neither overlap arm reaches it. This arm is the only one that does.
    expect(where[2]).toEqual(
      expect.objectContaining({ isRecurring: true, isDeleted: false, startTime: expect.anything() }),
    );
    expect(where[2]).not.toHaveProperty('endTime');
    // The rule text, and the identity the override suppression is keyed on.
    expect(select).toEqual(
      expect.objectContaining({ metadata: true, sourceSystem: true, sourceId: true, isRecurring: true }),
    );
  });
});

describe('availability window', () => {
  const WINDOW = { from: '2026-08-07T12:00:00.000Z', to: '2026-08-07T13:00:00.000Z' };

  it('SECURITY: selects OVERLAPPING events, not just ones starting inside the window', async () => {
    const { service, eventRepository } = makeService();

    await service.handle(PEER, body({ archetype: 'availability', ...WINDOW }));

    // A 09:00–17:00 meeting starts before this window. Filtering on
    // `startTime BETWEEN from AND to` would miss it entirely and report the
    // owner free straight through a four-hour meeting.
    const where = eventRepository.find.mock.calls[0][0].where;
    expect(Array.isArray(where)).toBe(true);
    expect(where[0]).toEqual(
      expect.objectContaining({ startTime: expect.anything(), endTime: expect.anything() }),
    );
    // and the query is capped
    expect(eventRepository.find.mock.calls[0][0].take).toBeGreaterThan(0);
  });

  it('rejects an inverted window', async () => {
    const { service } = makeService();

    await expect(
      service.handle(PEER, body({ archetype: 'availability', from: WINDOW.to, to: WINDOW.from })),
    ).rejects.toThrow();
  });

  it('rejects an unbounded window (a peer cannot make us merge a whole calendar)', async () => {
    const { service } = makeService();

    await expect(
      service.handle(
        PEER,
        body({
          archetype: 'availability',
          from: '1970-01-01T00:00:00.000Z',
          to: '2100-01-01T00:00:00.000Z',
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('toAskQuery', () => {
  it('maps each archetype into the local ask vocabulary', () => {
    expect(toAskQuery(body({ archetype: 'relationship', subject: 'Carol' })).queryType).toBe('relationship');
    expect(toAskQuery(body({ archetype: 'content', subject: 'photos', dataClass: 'photos' }))).toMatchObject({
      queryType: 'content',
      dataClass: 'photos',
    });
    expect(
      toAskQuery(
        body({ archetype: 'availability', from: '2026-08-07T09:00:00.000Z', to: '2026-08-07T17:00:00.000Z' }),
      ),
    ).toMatchObject({ queryType: 'availability', dataClass: 'calendar' });
  });
});

/**
 * ═══ THE AVAILABILITY ARCHETYPE BYPASSED BOTH CEILINGS ═══
 *
 * `answerFor` computed the tier ceiling and the grant ceiling on its
 * relationship/content path — AFTER the availability branch had already
 * returned. So the one archetype that answers straight out of the owner's
 * calendar was the one archetype no ceiling applied to.
 *
 * Reproduced against Postgres: `trustTier: 'stranger'` (tier ceiling `boolean`)
 * together with a grant carrying `maxDisclosure: 'none'` still handed the peer
 * the owner's real busy interval 12:00–13:00 and both free windows, and wrote
 * no `ci.ask_answers` row at all. The CONTENT archetype under the identical
 * `none` ceiling correctly returned "Nothing was shared."
 */
describe('PeerAskService — availability is subject to the same ceilings as everything else', () => {
  const WINDOW = {
    archetype: 'availability',
    from: '2026-09-01T09:00:00Z',
    to: '2026-09-01T17:00:00Z',
  } as const;
  const BUSY_NOON = [
    { startTime: new Date('2026-09-01T12:00:00Z'), endTime: new Date('2026-09-01T13:00:00Z') },
  ];

  async function availability(opts: { trustTier?: string; maxDisclosure?: string }) {
    const harness = makeService({
      links: [link({ trustTier: opts.trustTier ?? 'trusted' })],
      decision: 'auto',
      maxDisclosure: opts.maxDisclosure,
      events: BUSY_NOON,
    });
    const result = await harness.service.handle(PEER, body({ ...WINDOW }));

    return { ...harness, answer: result.answer! };
  }

  it('discloses NOTHING under a grant capped at none, whatever the calendar says', async () => {
    const { answer } = await availability({ trustTier: 'stranger', maxDisclosure: 'none' });

    // The exact bypass: the owner's real meeting used to come back here.
    expect(answer.busy).toEqual([]);
    expect(answer.free).toEqual([]);
    expect(answer.summary).toBe('Nothing was shared.');
  });

  it('gives a stranger a yes/no, not the owner’s meeting times', async () => {
    // The tier ceiling ALONE, with no grant cap at all — proving the tier half
    // of the bypass is closed independently of the grant half.
    const { answer } = await availability({ trustTier: 'stranger' });

    expect(answer.busy).toEqual([]);
    expect(answer.free).toEqual([]);
    expect(answer.summary).toMatch(/have some free time/);
  });

  /**
   * Retitled, not rewritten. This asserted `family` behaviour under a `trusted`
   * name (threat-model D3), and `trusted` is the tier that actually matters
   * here: its calendar ceiling is `redacted`, which is the rung that used to
   * return `full`'s answer verbatim. The two now differ, so the misnaming
   * stopped being cosmetic — it named the one case the suite did not cover.
   */
  it('gives a FAMILY peer the actual intervals — the ceiling is not a blanket', async () => {
    const { answer } = await availability({ trustTier: 'family' });

    expect(answer.busy).toEqual([{ start: '2026-09-01T12:00:00.000Z', end: '2026-09-01T13:00:00.000Z' }]);
    expect(answer.free).toHaveLength(2);
  });

  /**
   * D2, end to end and through a real tier rather than a hand-passed rung.
   *
   * `trusted` lands on `redacted` for a calendar, and `redacted` used to share
   * a switch branch with `full` — so this peer received the owner's real
   * meeting boundaries, auto-answered, under a ceiling that said otherwise.
   */
  it('does NOT give a trusted peer the owner’s meeting times', async () => {
    const { answer } = await availability({ trustTier: 'trusted' });

    // The busy intervals are the direct answer to "when do you have meetings",
    // and they are what a ceiling below `full` exists to stop.
    expect(answer.busy).toEqual([]);
    // Free slots still cross — `redacted` is not `summary`, and an asker has to
    // be able to schedule against something.
    expect(answer.free?.length ?? 0).toBeGreaterThan(0);
  });

  it('records what it disclosed — the availability branch wrote no answer row at all', async () => {
    const { answerService } = await availability({ trustTier: 'stranger', maxDisclosure: 'none' });

    // Stored under `attribute`: the ask_answers CHECK admits the five local
    // forms, and `availability` is a WIRE form, not a storage one.
    expect(answerService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        askId: 'ask-1',
        answer: expect.objectContaining({ form: 'attribute', items: [], summary: 'Nothing was shared.' }),
      }),
      expect.anything(),
    );
  });

  /**
   * The remaining half of the same defect. `disclosed_entities` is correctly
   * empty — free/busy crosses as interval boundaries, never as entity
   * references — but the audit recorded no BACKING entities either, so the
   * owner's history could not say which of their meetings a peer's "are you
   * free?" had actually consulted. Every other archetype records its candidate
   * set there.
   */
  it('records WHICH calendar events the availability answer was computed over', async () => {
    const harness = makeService({
      links: [link({ trustTier: 'family' })],
      decision: 'auto',
      events: [
        {
          id: 'ev-1',
          startTime: new Date('2026-09-01T12:00:00Z'),
          endTime: new Date('2026-09-01T13:00:00Z'),
        },
        {
          id: 'ev-2',
          startTime: new Date('2026-09-01T15:00:00Z'),
          endTime: new Date('2026-09-01T16:00:00Z'),
        },
      ],
    });

    const result = await harness.service.handle(PEER, body({ ...WINDOW }));

    expect(harness.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'auto_answered',
        // Nothing itemized crossed…
        disclosedEntities: [],
        // …but the box read two of the owner's events to answer, and that is
        // the owner's own record, not the peer's.
        backingEntities: ['ev-1', 'ev-2'],
      }),
      expect.anything(),
    );
    // Backing entities are owner-only. An event id reaching the wire would turn
    // an availability answer into a calendar-enumeration oracle.
    expect(JSON.stringify(result.answer)).not.toContain('ev-1');
  });

  it('loads the event id so the audit can name it — the select used to omit it', async () => {
    const { service, eventRepository } = makeService({ events: BUSY_NOON });

    await service.handle(PEER, body({ ...WINDOW }));

    expect(eventRepository.find.mock.calls[0][0].select).toEqual(expect.objectContaining({ id: true }));
  });
});

/**
 * ═══ THE FEDERATED PATH ANSWERED, THEN LEFT THE ASK WHERE IT STARTED ═══
 *
 * `answerFor` wrote an answer row and an audit row and stopped. The ask stayed
 * `delivered` with its consent basis intact — indistinguishable, in the table,
 * from an ask that is pre-authorized and has NOT been answered yet. Everything
 * downstream reads that shape and reads it wrong.
 */
describe('PeerAskService — a federated answer reaches a terminal state', () => {
  it('SECURITY: drives the ask to `answered`, and PERSISTS it', async () => {
    const { service, askRow } = makeService();

    await service.handle(PEER, body({ archetype: 'content', subject: 'x' }));

    expect(askRow.status).toBe('answered');
    expect(TERMINAL_ASK_STATUSES).toContain(askRow.status);
  });

  it('terminalizes the availability archetype too — it has its own answer branch', async () => {
    const { service, askRow } = makeService({
      events: [{ id: 'ev-1', startTime: new Date('2026-09-01T12:00:00Z'), endTime: null }],
    });

    await service.handle(
      PEER,
      body({ archetype: 'availability', from: '2026-09-01T09:00:00Z', to: '2026-09-01T17:00:00Z' }),
    );

    expect(askRow.status).toBe('answered');
  });

  it('takes the legal `delivered → answering → answered` route, not a direct assignment', async () => {
    const { service, askRow } = makeService();

    // `delivered → answered` is not an edge of the state machine. If this ever
    // starts throwing IllegalAskTransitionError the shared lifecycle changed
    // under the federated path — which is the failure mode this whole file is
    // about.
    await expect(service.handle(PEER, body({ archetype: 'content', subject: 'x' }))).resolves.toMatchObject({
      status: 'answered',
    });
    expect(askRow.status).toBe('answered');
  });

  /**
   * The consequence with teeth. `GrantService.withdrawPreAuthorization` selects
   * `{ responderUserId, consentBasis: <grant>, status: 'delivered' }` — and an
   * answered-but-still-`delivered` federated ask matched it exactly, so
   * revoking the grant RETROACTIVELY EDITED a disclosure that had already
   * crossed to the peer: status back to `under_review`, basis nulled. The
   * audit log said the disclosure happened; the ask said it was still awaiting
   * review.
   *
   * Run against the REAL GrantService, so it is the actual revocation code
   * deciding whether this ask is in its set — not a restatement of the filter.
   */
  it('SECURITY: revoking the authorizing grant cannot rewrite a completed federated disclosure', async () => {
    const { service, askRow } = makeService();
    await service.handle(PEER, body({ archetype: 'content', subject: 'x' }));

    const grant = {
      id: 'g1',
      ownerUserId: 'owner-1',
      revokedAt: null as Date | null,
      revocationReason: null as string | null,
      expiresAt: null as Date | null,
    };
    const grantRepository = {
      findOne: jest.fn().mockResolvedValue(grant),
      save: jest.fn().mockResolvedValue(grant),
    };
    // A faithful stand-in for the equality WHERE in `withdrawPreAuthorization`.
    const askRepository = {
      find: jest
        .fn()
        .mockImplementation(({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(
            [askRow].filter(
              (row) =>
                row.responderUserId === where.responderUserId &&
                row.consentBasis === where.consentBasis &&
                row.status === where.status,
            ),
          ),
        ),
      save: jest.fn().mockImplementation((rows: unknown) => Promise.resolve(rows)),
    };
    const grantService = new GrantService(
      grantRepository as never,
      askRepository as never,
      { setContext: jest.fn(), log: jest.fn() } as never,
    );

    await grantService.revoke({ userId: 'owner-1' }, 'g1');

    // Untouched: the disclosure is history, and history is not rewritten.
    expect(askRow.status).toBe('answered');
    expect(askRow.consentBasis).toBe('g1');
    expect(askRepository.save).not.toHaveBeenCalled();
  });
});

/**
 * ═══ THE ANSWER AND ITS AUDIT WERE WRITTEN ON SEPARATE CONNECTIONS ═══
 *
 * The local path wraps them (`AskService.completeWithAnswer`); this one did
 * not. A failure between the two leaves a `ci.ask_answers` row with no audit
 * row — and permanently, because `AskAnswerService.create` is insert-only, so
 * the retry raises a conflict instead of writing the missing audit.
 */
describe('PeerAskService — the disclosure and its audit are atomic', () => {
  it('writes the answer, the terminal status, and the audit in ONE transaction', async () => {
    const { service, writes, manager, eventRepository } = makeService();

    await service.handle(PEER, body({ archetype: 'content', subject: 'x' }));

    expect(eventRepository.manager.transaction).toHaveBeenCalledTimes(1);
    expect(writes.map((write) => write.target)).toEqual(['answer', 'ask', 'audit']);
    // Every one of them inside the transaction…
    expect(writes.every((write) => write.transacted)).toBe(true);
    // …and enrolled in it. A write that merely HAPPENS during a transaction it
    // was not handed the manager for still commits on its own connection.
    expect(writes.every((write) => write.manager === manager)).toBe(true);
  });

  it('does the same on the availability branch', async () => {
    const { service, writes, manager } = makeService({
      events: [{ id: 'ev-1', startTime: new Date('2026-09-01T12:00:00Z'), endTime: null }],
    });

    await service.handle(
      PEER,
      body({ archetype: 'availability', from: '2026-09-01T09:00:00Z', to: '2026-09-01T17:00:00Z' }),
    );

    expect(writes.map((write) => write.target)).toEqual(['answer', 'ask', 'audit']);
    expect(writes.every((write) => write.transacted && write.manager === manager)).toBe(true);
  });

  it('reads the ask back INSIDE the transaction, scoped to the link owner', async () => {
    const { service, askRepository, manager } = makeService();

    await service.handle(PEER, body({ archetype: 'content', subject: 'x' }));

    expect(manager.getRepository).toHaveBeenCalledWith(AskEntity);
    expect(askRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'ask-1', responderUserId: 'owner-1' },
    });
  });

  it('nothing is persisted when the answer insert fails', async () => {
    const { service, answerService, auditService, askRow } = makeService();
    answerService.create.mockRejectedValueOnce(new ConflictException('already has an answer'));

    await expect(service.handle(PEER, body({ archetype: 'content', subject: 'x' }))).rejects.toThrow();

    // The audit never runs, and the ask is left where the transaction found it
    // rather than terminalized against an answer that does not exist.
    expect(auditService.record).not.toHaveBeenCalled();
    expect(askRow.status).toBe('delivered');
  });
});

/**
 * ═══ RETROACTIVE REVOCATION DID NOT REACH THE FEDERATED PATH ═══
 *
 * The local answer path re-checks the standing grant before it discloses
 * (`AskService.complete` → `isConsentStanding`). The federated path went
 * straight from `evaluate` to disclosure, so the grant read at routing time was
 * the only thing between a withdrawn consent and a peer.
 */
describe('PeerAskService — consent is re-checked before anything is read', () => {
  it('SECURITY: refuses to answer when the authorizing grant is no longer in force', async () => {
    const { service, executorService, answerService, auditService } = makeService({
      consentStanding: false,
    });

    const result = await service.handle(PEER, body({ archetype: 'content', subject: 'x' }));

    expect(result.status).toBe(PEER_ASK_PENDING);
    expect(result.answer).toBeUndefined();
    // Nothing read, nothing written, nothing disclosed.
    expect(executorService.execute).not.toHaveBeenCalled();
    expect(answerService.create).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('sends the withdrawn ask back to the owner with its basis cleared', async () => {
    const { service, askService, askRow } = makeService({ consentStanding: false });

    await service.handle(PEER, body({ archetype: 'content', subject: 'x' }));

    // Exactly where `withdrawPreAuthorization` puts a revoked pre-authorization
    // on the local path.
    expect(askService.systemTransition).toHaveBeenCalledWith('ask-1', 'under_review', {
      consentBasis: null,
    });
    expect(askRow.status).toBe('under_review');
    expect(askRow.consentBasis).toBeNull();
  });

  it('SECURITY: does not read the calendar either — availability is gated by the same check', async () => {
    const { service, eventRepository } = makeService({ consentStanding: false });

    await service.handle(
      PEER,
      body({ archetype: 'availability', from: '2026-09-01T09:00:00Z', to: '2026-09-01T17:00:00Z' }),
    );

    expect(eventRepository.find).not.toHaveBeenCalled();
  });

  it('ORDERING: the check runs AFTER the basis is stamped, or it passes vacuously', async () => {
    const { service, grantService } = makeService();

    await service.handle(PEER, body({ archetype: 'content', subject: 'x' }));

    // `isConsentStanding` returns true for an ask with no basis — there is no
    // standing grant to check. Called before `setConsentBasis`, the check that
    // exists to catch a revoked grant would wave every ask through.
    expect(grantService.isConsentStanding).toHaveBeenCalledWith(
      expect.objectContaining({ consentBasis: 'g1' }),
    );
  });
});

/**
 * ═══ THE FEDERATED AUDIT UNDER-REPORTED WHAT CROSSED ═══
 *
 * `ci.ask_audit.disclosed_count` exists because `disclosed_entities` is EMPTY
 * for every form but `retrieval`, so deriving the count from it audits a real
 * count/boolean disclosure as "nothing was shared". The LOCAL path forwards it
 * (`AskService.completeWithAnswer` → `complete`'s `disclosedCount`); this one
 * did not, because `recordAudit` had no such parameter at all.
 *
 * Reproduced against two real boxes: the peer was told "1 matching item" and
 * the audit row recorded 0; an availability answer said "4 free slots",
 * `ci.ask_answers.disclosed_count` said 4, and the audit row said 0.
 */
describe('PeerAskService — the audit records the MAGNITUDE that crossed', () => {
  it('forwards the disclosed count of an existence answer', async () => {
    const { service, executorService, auditService } = makeService();
    executorService.execute.mockResolvedValue([
      { id: 'e1', type: 'file' },
      { id: 'e2', type: 'file' },
    ]);

    const result = await service.handle(PEER, body({ archetype: 'content', subject: 'beach' }));

    expect(result.answer?.disclosedCount).toBe(2);
    // Not `disclosedEntities.length` — that is 0 here, which is precisely the
    // fallback that made the owner's history under-report the disclosure.
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ disclosedCount: 2, disclosedEntities: [] }),
      expect.anything(),
    );
  });

  it('forwards it on the availability branch too, which itemizes nothing at all', async () => {
    const { service, auditService, eventRepository } = makeService();
    eventRepository.find.mockResolvedValue([
      { id: 'ev-1', startTime: new Date('2026-09-15T16:00:00Z'), endTime: new Date('2026-09-15T16:30:00Z') },
    ]);

    const result = await service.handle(
      PEER,
      body({
        archetype: 'availability',
        from: '2026-09-15T15:00:00.000Z',
        to: '2026-09-15T23:59:00.000Z',
        minMinutes: 45,
      }),
    );

    const free = result.answer?.free?.length ?? 0;
    expect(free).toBeGreaterThan(0);
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ disclosedCount: free }),
      expect.anything(),
    );
  });

  it('records 0 for a decline, explicitly rather than by falling back', async () => {
    const { service, auditService } = makeService({ decision: 'deny' });

    await service.handle(PEER, body({ archetype: 'content', subject: 'x' }));

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ disclosedCount: 0 }),
      undefined,
    );
  });
});

/**
 * ═══ AN APPROVED ANSWER NEVER CROSSED BACK ═══
 *
 * `POST /agent/v1/ask`'s synchronous reply was the only channel that existed.
 * `askId` was documented as an idempotency key and read by nothing, so a
 * re-ask minted a NEW `ci.asks` row and was re-evaluated from scratch — it
 * landed in review a second time and the answer a human had approved stayed on
 * the responder's box forever.
 */
describe('PeerAskService — the correlation id is a real idempotency key', () => {
  const CONTENT = { archetype: 'content', subject: 'quarterly review deck', dataClass: 'documents' } as const;

  it('a repeat does not create a second ask, and does not re-evaluate anything', async () => {
    const { service, askService, grantService, executorService } = makeService({
      decision: 'review',
      correlation: { askId: 'ask-1', requestDigest: requestDigest(body(CONTENT)) },
      askStatus: 'under_review',
    });

    const again = await service.handle(PEER, body(CONTENT));

    expect(askService.create).not.toHaveBeenCalled();
    expect(grantService.evaluate).not.toHaveBeenCalled();
    expect(executorService.execute).not.toHaveBeenCalled();
    expect(again.status).toBe(PEER_ASK_PENDING);
  });

  it('a repeat DOES deliver the answer once the owner has approved it', async () => {
    const { service } = makeService({
      correlation: { askId: 'ask-1', requestDigest: requestDigest(body(CONTENT)) },
      askStatus: 'answered',
      storedAnswer: {
        form: 'existence',
        summary: 'They have 1 matching item.',
        disclosedEntities: [],
        disclosedCount: 1,
        withheldCount: 0,
      },
    });

    const again = await service.handle(PEER, body(CONTENT));

    expect(again.status).toBe('answered');
    expect(again.answer?.summary).toBe('They have 1 matching item.');
    expect(again.answer?.disclosedCount).toBe(1);
  });

  it('records the correlation on the FIRST ask, before the grant is even evaluated', async () => {
    const { service, correlationRepository, grantService } = makeService({ decision: 'review' });

    await service.handle(PEER, body(CONTENT));

    expect(correlationRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ peerLinkId: 'link-1', correlationId: 'ask-corr-1', askId: 'ask-1' }),
    );
    // Written before the decision, so an ask that lands in the owner's inbox —
    // the ONLY kind a poll exists for — is collectable the moment they approve.
    expect(correlationRepository.save.mock.invocationCallOrder[0]).toBeLessThan(
      grantService.evaluate.mock.invocationCallOrder[0],
    );
  });

  it('SECURITY: one key can never answer a DIFFERENT question', async () => {
    const { service } = makeService({
      correlation: { askId: 'ask-1', requestDigest: 'a-digest-for-some-other-question' },
      askStatus: 'answered',
    });

    // Reusing a key for another ask would hand back the first one's answer —
    // no new disclosure, but an answer to a question nobody asked.
    await expect(service.handle(PEER, body(CONTENT))).rejects.toThrow(/Malformed ask/);
  });

  it('SECURITY: a replay of a non-answered ask is the SAME reply a stranger gets', async () => {
    const { service } = makeService({
      correlation: { askId: 'ask-1', requestDigest: requestDigest(body(CONTENT)) },
      askStatus: 'declined',
    });

    const replayed = await service.handle(PEER, body(CONTENT));

    expect(replayed).toEqual({
      askId: 'ask-corr-1',
      status: PEER_ASK_PENDING,
      reason: PEER_ASK_NO_ANSWER_REASON,
    });
  });
});

describe('PeerAskService.result — the collect route', () => {
  it('hands back an answer the owner approved after the ask was queued', async () => {
    const { service } = makeService({
      correlation: { askId: 'ask-1', requestDigest: 'anything' },
      askStatus: 'answered',
      storedAnswer: {
        form: 'existence',
        summary: 'They have 1 matching item.',
        disclosedEntities: [],
        disclosedCount: 1,
        withheldCount: 0,
      },
    });

    const collected = await service.result(PEER, 'ask-corr-1');

    expect(collected.status).toBe('answered');
    expect(collected.askId).toBe('ask-corr-1');
  });

  it('creates nothing, evaluates nothing and audits nothing — it is a READ', async () => {
    const { service, askService, grantService, executorService, auditService, answerService } = makeService({
      correlation: { askId: 'ask-1', requestDigest: 'anything' },
      askStatus: 'answered',
      storedAnswer: {
        form: 'existence',
        summary: 's',
        disclosedEntities: [],
        disclosedCount: 1,
        withheldCount: 0,
      },
    });

    await service.result(PEER, 'ask-corr-1');

    expect(askService.create).not.toHaveBeenCalled();
    expect(grantService.evaluate).not.toHaveBeenCalled();
    expect(executorService.execute).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
    expect(answerService.create).not.toHaveBeenCalled();
  });

  it('SECURITY: an UNKNOWN correlation id is not a 404 — it is the ordinary non-answer', async () => {
    const { service } = makeService({ correlation: null });

    const collected = await service.result(PEER, 'never-seen-this-one');

    // A 404 here would answer "has this peer ever asked me that?" for free, and
    // separate it from "asked, and refused".
    expect(collected).toEqual({
      askId: 'never-seen-this-one',
      status: PEER_ASK_PENDING,
      reason: PEER_ASK_NO_ANSWER_REASON,
    });
  });

  it('SECURITY: an answer row on a NON-answered ask is still not readable', async () => {
    const { service } = makeService({
      correlation: { askId: 'ask-1', requestDigest: 'anything' },
      askStatus: 'under_review',
      storedAnswer: {
        form: 'existence',
        summary: 'leaked',
        disclosedEntities: [],
        disclosedCount: 9,
        withheldCount: 0,
      },
    });

    const collected = await service.result(PEER, 'ask-corr-1');

    // The gate is the ask's STATUS, not the existence of a row — the same
    // ground `AskResolver.askAnswer` refuses on for a local asker.
    expect(collected.status).toBe(PEER_ASK_PENDING);
    expect(JSON.stringify(collected)).not.toContain('leaked');
  });

  it('refuses an unlinked peer exactly as `handle` does', async () => {
    const { service } = makeService({ links: [] });

    await expect(service.result(PEER, 'ask-corr-1')).rejects.toThrow();
  });
});

/**
 * A replay projects a STORED row back onto the wire, and the stored row is not
 * automatically peer-shaped: an owner-approved federated ask is answered by the
 * LOCAL pipeline, which has a `retrieval` form that itemizes real entity
 * references. The peer protocol exposes no retrieval archetype at all.
 */
describe('toWireAnswer', () => {
  it('SECURITY: never emits item references, even from a `retrieval` row', () => {
    const wire = toWireAnswer({
      form: 'retrieval',
      summary: '2 items.',
      disclosedEntities: [
        { id: 'entity-1', type: 'file' },
        { id: 'entity-2', type: 'file' },
      ],
      disclosedCount: 2,
      withheldCount: 0,
    } as never);

    expect(wire.items).toEqual([]);
    expect(JSON.stringify(wire)).not.toContain('entity-1');
  });

  it('SECURITY: a boolean replay carries no cardinality, same as a live one', () => {
    const wire = toWireAnswer({
      form: 'boolean',
      summary: 'Yes.',
      disclosedEntities: [],
      disclosedCount: 7,
      withheldCount: 0,
    } as never);

    // Otherwise a replay is a keyword-frequency oracle the live answer refuses
    // to be.
    expect(wire.disclosedCount).toBeUndefined();
    expect(wire.withheldCount).toBeUndefined();
  });

  it('an existence replay does carry it — that is what the form means', () => {
    const wire = toWireAnswer({
      form: 'existence',
      summary: '3 items.',
      disclosedEntities: [],
      disclosedCount: 3,
      withheldCount: 1,
    } as never);

    expect(wire.disclosedCount).toBe(3);
    expect(wire.withheldCount).toBe(1);
  });
});

/**
 * ═══ THE COUNT AN AVAILABILITY ANSWER DISCLOSES IS NOT `free.length` ═══
 *
 * `clampAvailability` empties BOTH interval arrays at every rung below
 * `redacted`, so reading the disclosed count off its result recorded 0 for
 * exactly the rungs where a number is the only thing that crossed. Reproduced
 * across two real boxes: a peer was told "4 free slots" under a `count` ceiling
 * while `ci.ask_answers.disclosed_count` and `ci.ask_audit.disclosed_count` both
 * said 0.
 */
describe('clampAvailability — the magnitude it reports', () => {
  const freeBusy = {
    busy: [{ start: '2026-09-15T16:00:00.000Z', end: '2026-09-15T16:30:00.000Z' }],
    free: [
      { start: '2026-09-15T15:00:00.000Z', end: '2026-09-15T16:00:00.000Z' },
      { start: '2026-09-15T16:30:00.000Z', end: '2026-09-15T19:00:00.000Z' },
      { start: '2026-09-15T20:00:00.000Z', end: '2026-09-15T22:00:00.000Z' },
    ],
  } as never;

  it.each(['full', 'redacted', 'summary', 'count'] as const)(
    'reports the real slot count at `%s`, whether or not the intervals crossed',
    (rung) => {
      const clamped = clampAvailability(freeBusy, rung, 'They');

      expect(clamped.disclosedCount).toBe(3);
    },
  );

  it('drops the intervals at `summary` and `count` while still reporting the magnitude', () => {
    for (const rung of ['summary', 'count'] as const) {
      const clamped = clampAvailability(freeBusy, rung, 'They');

      expect(clamped.free).toEqual([]);
      expect(clamped.busy).toEqual([]);
      // The array is empty and the disclosure is not. That gap is the defect.
      expect(clamped.disclosedCount).toBe(3);
    }
  });

  it('reports NOTHING at `boolean` — a yes/no carries no cardinality', () => {
    const clamped = clampAvailability(freeBusy, 'boolean', 'They');

    expect(clamped.summary).toMatch(/some free time/);
    // Recording 3 here would over-report as badly as `free.length` under-reports
    // the rungs above: the peer was told there is *some*, not how much.
    expect(clamped.disclosedCount).toBe(0);
  });

  it('reports nothing at `none`', () => {
    expect(clampAvailability(freeBusy, 'none', 'They').disclosedCount).toBe(0);
  });
});

describe('toAskQuery — the stated purpose reaches the consent evaluator', () => {
  const base = { askId: 'abc12345', askerHandle: 'ana', prompt: 'hi' };

  /**
   * THE BUG THIS CLOSES. `scopeCoversQuery` reads `filters.purpose`, and
   * nothing ever wrote one: availability folded its purpose into the PROMPT and
   * the other two archetypes had no field at all. So a purpose-limited grant
   * matched NO inbound peer ask, ever — failing closed (downgraded to review,
   * never widened), so nothing leaked; the feature was simply dead across
   * boxes, silently, with no signal to the owner who set it.
   */
  it.each(['relationship', 'content'] as const)(
    'carries a body-level purpose on the %s archetype',
    (archetype) => {
      const request =
        archetype === 'relationship'
          ? { archetype, subject: 'David Miller' }
          : { archetype, subject: 'the deck' };

      const query = toAskQuery({ ...base, purpose: 'wedding invites', request } as never);

      expect(query.filters?.purpose).toBe('wedding invites');
    },
  );

  it('carries a body-level purpose on availability too', () => {
    const query = toAskQuery({
      ...base,
      purpose: 'lunch',
      request: {
        archetype: 'availability',
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-02T00:00:00.000Z',
      },
    } as never);

    expect(query.filters?.purpose).toBe('lunch');
  });

  it('falls back to availability’s own purpose, so an older peer still binds', () => {
    const query = toAskQuery({
      ...base,
      request: {
        archetype: 'availability',
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-02T00:00:00.000Z',
        purpose: 'lunch at Zuni',
      },
    } as never);

    expect(query.filters?.purpose).toBe('lunch at Zuni');
  });

  it('sets no purpose key at all when none was stated', () => {
    const query = toAskQuery({
      ...base,
      request: { archetype: 'relationship', subject: 'David Miller' },
    } as never);

    // Absent rather than empty-string: `scopeCoversQuery` distinguishes "stated
    // nothing" from "stated something blank", and only the first is honest.
    expect(query.filters).not.toHaveProperty('purpose');
  });
});

/**
 * D2: `redacted` used to share a switch branch with `full`.
 *
 * The threat model's argument, which `applyDisclosureCeiling` already applies
 * to item references and this clamp did not: a rung that clamps nothing is not
 * a rung, it is a label the owner can pick believing it does something. It is
 * the `trusted` tier's calendar ceiling, so the peers most likely to hold it
 * were receiving the owner's real meeting boundaries under a ceiling that said
 * they would not.
 */
describe('clampAvailability — the `redacted` rung', () => {
  const freeBusy = {
    busy: [{ start: '2026-09-15T16:00:00.000Z', end: '2026-09-15T16:30:00.000Z' }],
    free: [
      // Deliberately off-grid, so quantization has something to do.
      { start: '2026-09-15T15:07:00.000Z', end: '2026-09-15T15:58:00.000Z' },
      { start: '2026-09-15T16:30:00.000Z', end: '2026-09-15T19:00:00.000Z' },
    ],
  } as never;

  it('drops the busy intervals — the direct answer to “when do you have meetings”', () => {
    expect(clampAvailability(freeBusy, 'redacted', 'They').busy).toEqual([]);
    // …while `full` still discloses them, or the rung below would be pointless.
    expect(clampAvailability(freeBusy, 'full', 'They').busy).toHaveLength(1);
  });

  it('coarsens free slots to the grid instead of handing over the instants', () => {
    const clamped = clampAvailability(freeBusy, 'redacted', 'They');

    // 15:07–15:58 spans no half-hour boundary once shrunk inward, so it is
    // dropped rather than widened: narrower is the safe direction.
    // 16:30–19:00 is already aligned and survives intact.
    expect(clamped.free).toEqual([{ start: '2026-09-15T16:30:00.000Z', end: '2026-09-15T19:00:00.000Z' }]);
  });

  it('reports the magnitude that actually crossed, not the pre-clamp count', () => {
    // One of the two slots survived quantization. Reporting 2 would over-report
    // this rung as badly as reading the count off an emptied array under-reports
    // the ones below it.
    expect(clampAvailability(freeBusy, 'redacted', 'They').disclosedCount).toBe(1);
  });

  it('rewrites the summary from the COARSENED set, so it cannot contradict the arrays', () => {
    const clamped = clampAvailability(freeBusy, 'redacted', 'They');

    expect(clamped.summary).toMatch(/1 free slot\b/);
    expect(clamped.summary).not.toMatch(/2 free slots/);
  });
});

/**
 * The structural pin, and the reason this defect should not recur.
 *
 * All three clamps in this codebase have now shipped a rung that silently
 * disclosed as much as the rung above it. Asserting each case in isolation is
 * what allowed that: the bug is never inside one branch, it is in the
 * RELATIONSHIP between two. This walks the whole ladder and requires each step
 * to disclose strictly less than the one above.
 *
 * ═══ INFORMATION CONTENT IS MEASURED, NOT INSPECTED ═══
 *
 * Counting array lengths is not enough, and the first version of this test
 * failed because of it: `summary` and `count` return identical arrays and
 * identical `disclosedCount`, as do `boolean` and `none`. What separates them
 * is what the SENTENCE distinguishes — and a sentence is only disclosive
 * insofar as it changes when the underlying calendar changes.
 *
 * So each axis is measured by DIFFERENTIAL: run the same rung over two
 * calendars that differ in exactly one property and see whether the output
 * tells them apart. That is the actual definition of "this rung reveals X",
 * and unlike a string assertion it keeps working when the wording is reworded.
 */
describe('clampAvailability — the ladder narrows monotonically', () => {
  const slot = (start: string, end: string) => ({ start, end });
  const D = '2026-09-15T';

  /** No free time at all. */
  const NONE_FREE = { busy: [slot(`${D}09:00:00.000Z`, `${D}17:00:00.000Z`)], free: [] } as never;
  /** Two slots. On-grid, so quantization is not what is being measured here. */
  const TWO = {
    busy: [slot(`${D}16:00:00.000Z`, `${D}16:30:00.000Z`)],
    free: [slot(`${D}15:00:00.000Z`, `${D}16:00:00.000Z`), slot(`${D}16:30:00.000Z`, `${D}18:00:00.000Z`)],
  } as never;
  /** Three slots — differs from TWO only in COUNT. */
  const THREE = {
    busy: [slot(`${D}16:00:00.000Z`, `${D}16:30:00.000Z`)],
    free: [
      slot(`${D}15:00:00.000Z`, `${D}16:00:00.000Z`),
      slot(`${D}16:30:00.000Z`, `${D}18:00:00.000Z`),
      slot(`${D}19:00:00.000Z`, `${D}20:00:00.000Z`),
    ],
  } as never;
  /** Two slots again, but one is far longer — differs from TWO only in DURATION. */
  const TWO_LONGER = {
    busy: [slot(`${D}16:00:00.000Z`, `${D}16:30:00.000Z`)],
    free: [slot(`${D}15:00:00.000Z`, `${D}16:00:00.000Z`), slot(`${D}16:30:00.000Z`, `${D}22:00:00.000Z`)],
  } as never;

  type Rung = 'full' | 'redacted' | 'summary' | 'count' | 'boolean' | 'none';

  const summaryOf = (fb: never, rung: Rung) => clampAvailability(fb, rung, 'They').summary;

  /** Everything a rung reveals. Every field is 0/1 or a magnitude; higher is more disclosive. */
  function revealed(rung: Rung) {
    const c = clampAvailability(TWO, rung, 'They');

    return {
      busyIntervals: c.busy.length,
      freeIntervals: c.free.length,
      freeMinutes: c.free.reduce((sum, s) => sum + (Date.parse(s.end) - Date.parse(s.start)) / 60_000, 0),
      reportedCount: c.disclosedCount,
      // Can the asker tell a calendar with free time from one without?
      existence: summaryOf(TWO, rung) === summaryOf(NONE_FREE, rung) ? 0 : 1,
      // Can they tell two slots from three?
      magnitude: summaryOf(TWO, rung) === summaryOf(THREE, rung) ? 0 : 1,
      // Can they tell a short opening from a long one, at the same slot count?
      duration: summaryOf(TWO, rung) === summaryOf(TWO_LONGER, rung) ? 0 : 1,
    };
  }

  const LADDER: Rung[] = ['full', 'redacted', 'summary', 'count', 'boolean', 'none'];
  const AXES = [
    'busyIntervals',
    'freeIntervals',
    'freeMinutes',
    'reportedCount',
    'existence',
    'magnitude',
    'duration',
  ] as const;

  it.each(LADDER.slice(0, -1).map((rung, i) => [rung, LADDER[i + 1]] as const))(
    '`%s` discloses strictly more than `%s`',
    (higher, lower) => {
      const a = revealed(higher);
      const b = revealed(lower);

      // Never MORE on any axis.
      for (const axis of AXES) {
        expect({ axis, value: b[axis] }).toEqual({
          axis,
          value: Math.min(a[axis], b[axis]),
        });
      }

      // And strictly less on at least one. This is the assertion that fails
      // when a rung is a label rather than a clamp — it is what `redacted`
      // could not have passed before this change.
      expect(AXES.some((axis) => b[axis] < a[axis])).toBe(true);
    },
  );
});
