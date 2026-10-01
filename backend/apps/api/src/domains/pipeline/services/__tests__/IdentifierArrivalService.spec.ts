import { CLAIM_LEASE_SECONDS, STAGE_IDS } from '../../constants';
import { DuplicateDetectStage } from '../../stages/clean/DuplicateDetectStage';
import { PersonSelfClaimStage } from '../../stages/enrich/PersonSelfClaimStage';
import type { Stage } from '../../types';
import { IDENTIFIER_ARRIVAL_BATCH, IdentifierArrivalService } from '../IdentifierArrivalService';

const USER = '00000000-0000-4000-8000-00000000aaaa';

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/**
 * The REAL stages, so the service reads their actual declarations — above all
 * the ledger `entity_type` each records under, which is not the same for the
 * two (a copied constant is how the detector leg once probed a type no ledger
 * row carries).
 */
const selfClaimStage = new PersonSelfClaimStage({} as never, makeLogger() as never);
const detectStage = new DuplicateDetectStage({} as never, makeLogger() as never);
const STAGES = new Map<string, Stage>([
  [selfClaimStage.id, selfClaimStage],
  [detectStage.id, detectStage],
]);

/**
 * `rows` answers the identifier lookup. `survivors` answers the merge-log
 * query per stage id (its third parameter): the survivors to re-open, or an
 * Error for that stage to throw.
 */
function make(
  rows: Array<{ subject_type: string; subject_id: string }>,
  survivors: Record<string, string[] | Error> = {},
) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (raw: string, params: unknown[] = []) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    statements.push({ sql, params });

    if (sql.includes('FROM ci.entity_merges')) {
      const answer = survivors[params[2] as string] ?? [];

      if (answer instanceof Error) {
        throw answer;
      }

      return answer.map((entityId) => ({ entity_id: entityId }));
    }

    return rows;
  });
  const reopen = jest.fn(async (_type: string, _stage: string, ids: string[]) => ids.length);
  const logger = makeLogger();
  const registry = {
    get: jest.fn((stageId: string) => {
      const stage = STAGES.get(stageId);

      if (stage == null) {
        throw new Error(`Unknown pipeline stage "${stageId}"`);
      }

      return stage;
    }),
  };
  const service = new IdentifierArrivalService(
    { query } as never,
    { reopen } as never,
    registry as never,
    logger as never,
  );

  const matching = (fragment: string) => statements.filter(({ sql }) => sql.includes(fragment));

  return { service, statements, matching, reopen, logger };
}

describe('IdentifierArrivalService.reopenForUser', () => {
  it('asks the identifier table which unresolved claims it can now answer, newest evidence only', async () => {
    const { service, matching } = make([]);

    await expect(service.reopenForUser(USER)).resolves.toBe(0);

    const lookups = matching('FROM ci.entity_identifiers');
    expect(lookups).toHaveLength(1);
    const { sql, params } = lookups[0];

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
    const { service, statements, matching } = make([]);

    await service.reopenForUser(USER, 50);

    expect(statements[0].params).toEqual([USER, 50]);
    for (const { params } of matching('FROM ci.entity_merges')) {
      expect(params[4]).toBe(50);
    }
  });
});

describe('IdentifierArrivalService.reopenForUser — people merged into since', () => {
  const legs = [selfClaimStage, detectStage].map((stage) => ({
    stageId: stage.id,
    ledgerType: stage.entityTypes[0],
    predicate: stage.source.predicate,
  }));

  it('asks the merge log, once per stage, which survivors were decided before a merge into them', async () => {
    const { service, matching } = make([]);

    await service.reopenForUser(USER);

    const asked = matching('FROM ci.entity_merges m');
    expect(asked.map(({ params }) => params[2])).toEqual(legs.map(({ stageId }) => stageId));

    asked.forEach(({ sql, params }, index) => {
      expect(params).toEqual([
        USER,
        'Person',
        legs[index].stageId,
        CLAIM_LEASE_SECONDS,
        IDENTIFIER_ARRIVAL_BATCH,
        'blocksCarried',
        legs[index].ledgerType,
      ]);
      expect(sql).toMatch(/m\.owner_user_id = \$1::uuid AND m\.entity_type = \$2/);

      // Only a merge that carried its evidence: one recorded before merges
      // re-pointed claims and carried blocks moved nothing onto the survivor,
      // and re-examining it could re-propose a pair a human ruled out.
      expect(sql).toContain("AND (m.details -> 'counts') ? $6::text");

      // The survivor must still be a row the stage sweeps: its own predicate,
      // over the source alone, or a re-opened row nobody will ever pick up
      // would read as stale in coverage() forever.
      expect(sql).toMatch(
        /EXISTS \( SELECT 1 FROM "ci"\."entities" s WHERE s\."entity_id" = m\.target_entity_id/,
      );
      expect(sql).toContain(`AND (${legs[index].predicate}))`);

      // Only a decision already recorded, at a live version, from before the
      // merge — with a lease's worth of margin for a slice that read the
      // survivor while the merge was still committing. The ledger row is
      // probed under the stage's OWN entity_type ($7), never the merge log's.
      expect(sql).toMatch(/p\.entity_type = \$7 AND p\.entity_id = m\.target_entity_id AND p\.stage = \$3/);
      expect(sql).toMatch(/p\.status IN \('done', 'skipped'\) AND p\.stage_version > 0/);
      expect(sql).toMatch(/p\.updated_at < m\.created_at \+ make_interval\(secs => \$4::float8\)/);
    });
  });

  it("probes and re-opens the detector's ledger under 'entity', the type it records under — not the merge log's 'Person'", async () => {
    // The slice listener refuses a slice whose type the stage does not
    // declare, so every clean.duplicate_detect row carries 'entity'. A leg
    // that assumed 'Person' would match none of them and re-open nothing.
    expect(detectStage.entityTypes).toEqual(['entity']);
    expect(selfClaimStage.entityTypes).toEqual(['Person']);

    const { service, matching, reopen } = make([], { [STAGE_IDS.CLEAN_DUPLICATE_DETECT]: [id(20)] });

    await service.reopenForUser(USER);

    const [detectProbe] = matching('FROM ci.entity_merges m').filter(
      ({ params }) => params[2] === STAGE_IDS.CLEAN_DUPLICATE_DETECT,
    );
    expect(detectProbe.params[1]).toBe('Person');
    expect(detectProbe.params[6]).toBe('entity');
    expect(reopen).toHaveBeenCalledWith('entity', STAGE_IDS.CLEAN_DUPLICATE_DETECT, [id(20)]);
  });

  it("re-opens each stage's survivors on its own ledger, and counts them with the identifier re-opens", async () => {
    const { service, reopen, logger } = make([{ subject_type: 'communication', subject_id: id(1) }], {
      [STAGE_IDS.ENRICH_PERSON_SELF_CLAIM]: [id(20)],
      [STAGE_IDS.CLEAN_DUPLICATE_DETECT]: [id(20), id(21)],
    });

    await expect(service.reopenForUser(USER)).resolves.toBe(4);

    expect(reopen).toHaveBeenCalledWith('Person', STAGE_IDS.ENRICH_PERSON_SELF_CLAIM, [id(20)]);
    expect(reopen).toHaveBeenCalledWith('entity', STAGE_IDS.CLEAN_DUPLICATE_DETECT, [id(20), id(21)]);
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/merged into/), {
      userId: USER,
      stage: STAGE_IDS.CLEAN_DUPLICATE_DETECT,
      survivors: 2,
      reopened: 2,
    });
  });

  it('re-opens nothing when no merge postdates a survivor decision', async () => {
    const { service, reopen } = make([]);

    await expect(service.reopenForUser(USER)).resolves.toBe(0);

    expect(reopen).not.toHaveBeenCalled();
  });

  it('contains a failing stage: the other stage and the identifier re-opens still land', async () => {
    const { service, reopen, logger } = make([{ subject_type: 'event', subject_id: id(3) }], {
      [STAGE_IDS.ENRICH_PERSON_SELF_CLAIM]: new Error('relation "ci.entity_merges" does not exist'),
      [STAGE_IDS.CLEAN_DUPLICATE_DETECT]: [id(20)],
    });

    await expect(service.reopenForUser(USER)).resolves.toBe(2);

    expect(reopen).toHaveBeenCalledWith('event', STAGE_IDS.ENRICH_EVENT_PERSON_LINK, [id(3)]);
    expect(reopen).toHaveBeenCalledWith('entity', STAGE_IDS.CLEAN_DUPLICATE_DETECT, [id(20)]);
    expect(reopen).not.toHaveBeenCalledWith(
      expect.anything(),
      STAGE_IDS.ENRICH_PERSON_SELF_CLAIM,
      expect.anything(),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(STAGE_IDS.ENRICH_PERSON_SELF_CLAIM),
      expect.any(Error),
    );
  });
});
