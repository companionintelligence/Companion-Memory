import { STAGE_IDS } from '../../constants';
import { IDENTIFIER_ARRIVAL_BATCH, IdentifierArrivalService } from '../IdentifierArrivalService';

const USER = '00000000-0000-4000-8000-00000000aaaa';

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function make(rows: Array<{ subject_type: string; subject_id: string }>) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (raw: string, params: unknown[] = []) => {
    statements.push({ sql: raw.replace(/\s+/g, ' ').trim(), params });

    return rows;
  });
  const reopen = jest.fn(async (_type: string, _stage: string, ids: string[]) => ids.length);
  const logger = makeLogger();
  const service = new IdentifierArrivalService({ query } as never, { reopen } as never, logger as never);

  return { service, statements, reopen, logger };
}

describe('IdentifierArrivalService.reopenForUser', () => {
  it('asks the identifier table which unresolved claims it can now answer, newest evidence only', async () => {
    const { service, statements } = make([]);

    await expect(service.reopenForUser(USER)).resolves.toBe(0);

    expect(statements).toHaveLength(1);
    const { sql, params } = statements[0];

    // Driven FROM the small table, joined to the partial unresolved-claims index.
    expect(sql).toMatch(/FROM ci\.entity_identifiers ei JOIN ci\.identifier_claims ic/);
    expect(sql).toMatch(/ic\.entity_id IS NULL/);
    // A human's verdict is never re-litigated.
    expect(sql).toMatch(/ic\.disposition IS NULL/);
    // Only evidence that postdates the last adjudication counts, which is what
    // stops a claim that still resolves to nobody from being re-opened forever.
    expect(sql).toMatch(/ei\.created_at > ic\.observed_at/);
    expect(params).toEqual([USER, IDENTIFIER_ARRIVAL_BATCH]);
  });

  it('re-opens each subject on the ledger stage that owns its type', async () => {
    const { service, reopen } = make([
      { subject_type: 'communication', subject_id: id(1) },
      { subject_type: 'communication', subject_id: id(2) },
      { subject_type: 'event', subject_id: id(3) },
    ]);

    await expect(service.reopenForUser(USER)).resolves.toBe(3);

    expect(reopen).toHaveBeenCalledWith('communication', STAGE_IDS.ENRICH_PERSON_LINK, [id(1), id(2)]);
    expect(reopen).toHaveBeenCalledWith('event', STAGE_IDS.ENRICH_EVENT_PERSON_LINK, [id(3)]);
  });

  it('warns about, and does not re-open, a subject type no stage links', async () => {
    const { service, reopen, logger } = make([{ subject_type: 'note', subject_id: id(9) }]);

    await expect(service.reopenForUser(USER)).resolves.toBe(0);

    expect(reopen).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/no stage/), {
      subjectType: 'note',
      subjects: 1,
    });
  });

  it("honours the caller's limit", async () => {
    const { service, statements } = make([]);

    await service.reopenForUser(USER, 50);

    expect(statements[0].params).toEqual([USER, 50]);
  });
});
