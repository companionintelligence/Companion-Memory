import { type UserServiceContext } from '@ci/common/context';

import { SummaryEntity } from '../entities/SummaryEntity';

import { SummaryService } from './SummaryService';

const USER = '00000000-0000-0000-0000-0000000000aa';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

function makeStoredSummary(overrides: Record<string, unknown> = {}): SummaryEntity {
  return Object.assign(new SummaryEntity(), {
    summaryId: 'sum-1',
    userId: USER,
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    periodEnd: new Date('2026-08-02T00:00:00.000Z'),
    periodType: 'daily',
    timezone: 'UTC',
    sourceTypes: ['note'],
    title: 'Original title',
    content: { summary_text: 'hello' },
    structuredContext: null,
    tags: null,
    participants: null,
    confidenceScore: null,
    metadata: null,
    seen: false,
    dismissed: false,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  });
}

function makeService(findOneResult: SummaryEntity | null = null) {
  const findOne = jest.fn(async () => findOneResult);
  const save = jest.fn(async (entity: SummaryEntity) => entity);

  const repository = { findOne, save };
  const send = jest.fn(async () => undefined);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new SummaryService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { service, repository, send };
}

// ---------------------------------------------------------------------------
// Absent vs. `undefined` vs. `null`.
//
// SummaryResolver's only two callers (markSummarySeen/markSummaryDismissed)
// pass single-key literals (`{ seen: true }`, `{ dismissed: true }`) that can
// never carry an undefined-valued key, so this bug is latent rather than live
// today. UpdateSummaryDto has 8 optional fields, and nothing stops a future
// summary-edit mutation from building its DTO the same always-every-key-
// present way NoteResolver.updateNote and RelationshipResolver.
// updateRelationship do — reproduced below rather than passing a sparse
// object, since a sparse `{ seen: true }` in a test would not catch a
// regression of this fix. `Object.assign` must not let an untouched
// `undefined` key clobber the entity's current value; an explicit `null`
// must still clear it (the same class of bug fixed in TaskService by #2703,
// closed off here before a live caller ever exercises it).
// ---------------------------------------------------------------------------
describe('SummaryService update', () => {
  it('leaves an untouched field alone when the caller sends every key, undefined for the ones it did not set', async () => {
    const { service } = makeService(makeStoredSummary({ title: 'Original title', seen: false }));

    const result = await service.update(CONTEXT, 'sum-1', {
      seen: true,
      dismissed: undefined,
      title: undefined,
      content: undefined,
      structuredContext: undefined,
      tags: undefined,
      participants: undefined,
      confidenceScore: undefined,
      metadata: undefined,
    });

    expect(result?.seen).toBe(true);
    expect(result?.title).toBe('Original title');
  });

  it('still clears a field when the caller sends an explicit null', async () => {
    const { service } = makeService(makeStoredSummary({ title: 'Original title' }));

    const result = await service.update(CONTEXT, 'sum-1', { title: null });

    expect(result?.title).toBeNull();
  });
});
