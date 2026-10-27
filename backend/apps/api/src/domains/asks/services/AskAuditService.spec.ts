import { AskAuditEntity } from '../entities/AskAuditEntity';
import type { AskQuery, RecordAskAuditDto } from '../types';

import { AskAuditService } from './AskAuditService';

const QUERY: AskQuery = { queryType: 'photos', prompt: 'how many photos of us do you have?' };

function makeService() {
  const rows: Record<string, unknown>[] = [];
  const repository = {
    create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
    save: jest.fn(async (row: Record<string, unknown>) => {
      rows.push(row);

      return { ...row, createdAt: new Date('2026-08-20T00:00:00Z') };
    }),
    find: jest.fn().mockResolvedValue([]),
  };
  const service = new AskAuditService(repository as never, { setContext: jest.fn() } as never);

  return { service, repository, rows };
}

function dto(overrides: Partial<RecordAskAuditDto> = {}): RecordAskAuditDto {
  return {
    askId: 'ask-1',
    askerUserId: 'asker-1',
    responderUserId: 'responder-1',
    query: QUERY,
    outcome: 'answered',
    ...overrides,
  };
}

/**
 * ═══ THE AUDIT RECORDED A DISCLOSURE OF NOTHING ═══
 *
 * `disclosed_entities` is itemized references, and by construction only the
 * `retrieval` form has any (see the 20260820224500 migration). Every other form
 * discloses a magnitude or a yes/no and names nothing — so the owner's
 * disclosure history rendered a `count` answer that handed over a real number
 * as an EMPTY disclosure. The number the asker received was on
 * `ci.ask_answers`, a row that is CASCADE-deleted with the ask; the audit
 * outlives the ask and has to carry its own copy.
 */
describe('AskAuditService.record — the magnitude, not just the itemization', () => {
  it('persists the disclosed count for a non-itemizing form', async () => {
    const { service, rows } = makeService();

    // The exact shape of a `count` answer: nothing itemized, four items' worth
    // of magnitude across to the asker.
    await service.record(dto({ disclosedEntities: [], disclosedCount: 4 }));

    expect(rows[0]).toMatchObject({ disclosedEntities: [], disclosedCount: 4 });
  });

  it('surfaces it on the egress type, which is what the history renders', async () => {
    const { service } = makeService();

    const audit = await service.record(dto({ disclosedEntities: [], disclosedCount: 4 }));

    expect(audit.disclosedCount).toBe(4);
  });

  it('falls back to the itemized length when no count is supplied', async () => {
    // The `retrieval` case, and the one where deriving from the ids was always
    // correct — which is exactly why the gap went unnoticed for the others.
    const { service, rows } = makeService();

    await service.record(dto({ disclosedEntities: ['e1', 'e2'] }));

    expect(rows[0]).toMatchObject({ disclosedCount: 2 });
  });

  it('records zero for the outcomes that disclose nothing at all', async () => {
    const { service, rows } = makeService();

    await service.record(dto({ outcome: 'declined' }));
    await service.record(dto({ outcome: 'expired' }));

    expect(rows.map((row) => row.disclosedCount)).toEqual([0, 0]);
  });

  it('an explicit zero is kept, not treated as "unspecified"', async () => {
    // A boolean answer over an empty match set really did disclose nothing, and
    // it must not silently borrow the itemized length of some other field.
    const { service, rows } = makeService();

    await service.record(dto({ disclosedEntities: ['e1'], disclosedCount: 0 }));

    expect(rows[0]).toMatchObject({ disclosedCount: 0 });
  });

  it('keeps the count apart from the backing set, which was never disclosed', async () => {
    const { service, rows } = makeService();

    await service.record(
      dto({ disclosedEntities: [], disclosedCount: 2, backingEntities: ['e1', 'e2', 'e3', 'e4'] }),
    );

    // Two crossed; four were read to compute them. Conflating these is the bug
    // 20260820224500 split apart, and the count must not re-merge them.
    expect(rows[0]).toMatchObject({
      disclosedCount: 2,
      backingEntities: ['e1', 'e2', 'e3', 'e4'],
    });
  });
});

describe('AskAuditEntity.toEgressType', () => {
  it('carries the count through to the owner-facing shape', () => {
    const entity = {
      id: 'audit-1',
      askId: 'ask-1',
      askerUserId: 'asker-1',
      peerLinkId: null,
      peerHandle: null,
      responderUserId: 'responder-1',
      query: QUERY,
      consentBasis: null,
      outcome: 'answered',
      disclosedEntities: [],
      disclosedCount: 7,
      backingEntities: [],
      createdAt: new Date('2026-08-20T00:00:00Z'),
    } as AskAuditEntity;

    expect(AskAuditEntity.toEgressType(entity).disclosedCount).toBe(7);
  });
});

describe('AskAuditService SAID anchoring', () => {
  it('computes and verifies deterministic SAID for an audit record', () => {
    const { service } = makeService();
    const payload = dto({
      askId: 'ask-1',
      askerUserId: 'asker-1',
      disclosedEntities: ['doc-1', 'doc-2'],
      disclosedCount: 2,
    });

    const said = service.computeSaid(payload);
    expect(said).toBeDefined();
    expect(said).toMatch(/^E[A-Za-z0-9_-]{43}$/);

    expect(service.verifySaid(payload, said)).toBe(true);

    // Tampered payload fails verification
    const tampered = { ...payload, disclosedCount: 99 };
    expect(service.verifySaid(tampered, said)).toBe(false);
  });
});
