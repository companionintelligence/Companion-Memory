import type { UserServiceContext } from '@ci/common/context';
import { RelationshipType, SINGLE_VALUED_RELATIONSHIP_TYPES } from '@ci/domains/graph';

import {
  CLEAN_SINGLE_VALUED_EDGE_AUDIT_STAGE_ID,
  CONFLICT_ALERT_REPEAT_DAYS,
  CONFLICT_REASON,
  MAX_ALERTS_PER_SLICE,
  SINGLE_VALUED_AUDIT_VERSION,
  SINGLE_VALUED_EDGE_AUDIT_SOURCE,
  type SingleValuedEdge,
  SingleValuedEdgeAuditStage,
  conflictAlertKey,
  findContradictions,
  overlaps,
  singleValuedEdgeAuditStageVersion,
} from '../clean/SingleValuedEdgeAuditStage';

/**
 * `clean.single_valued_edge_audit` — a DETECTOR, and the tests are about the
 * two things a detector can get wrong: reporting a contradiction that is not
 * one, and failing to report one that is.
 *
 * The pure half (`overlaps`, `findContradictions`) is a function of its
 * arguments and is tested as one. The `run()` half is tested against a fake
 * `DataSource` that answers the two statements by their text — not to prove
 * SQL correct (that needs Postgres) but to prove the OUTCOME MAPPING, which is
 * where the count this PR exists to produce actually comes from: a
 * contradiction has to land as `done` + `reason`, because `StageResult.detail`
 * is dropped by `PipelineStateService.complete` and a number written there is
 * a number nobody can ever read back.
 */

const USER = '00000000-0000-4000-8000-0000000000aa';
const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

const SELF = '00000000-0000-4000-8000-100000000001';
const OTHER = '00000000-0000-4000-8000-100000000002';
const HOME_A = '00000000-0000-4000-8000-200000000001';
const HOME_B = '00000000-0000-4000-8000-200000000002';
const HOME_C = '00000000-0000-4000-8000-200000000003';

let edgeSeq = 0;

function edge(over: Partial<SingleValuedEdge> = {}): SingleValuedEdge {
  edgeSeq += 1;

  return {
    from_entity_id: SELF,
    relationship_type: 'LIVES_IN',
    to_entity_id: HOME_A,
    relationship_id: `00000000-0000-4000-8000-3${String(edgeSeq).padStart(11, '0')}`,
    start_date: null,
    end_date: null,
    ...over,
  };
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

interface Harness {
  stage: SingleValuedEdgeAuditStage;
  statements: Array<{ sql: string; params: unknown[] }>;
  created: Array<{ title: string; text: string; source?: string; metadata?: Record<string, unknown> }>;
  logger: ReturnType<typeof makeLogger>;
}

function makeHarness(opts: {
  subjects: string[];
  edges: SingleValuedEdge[];
  /** Alert keys the user was already told about inside the repeat window. */
  recentAlertKeys?: string[];
  actionsEnabled?: boolean;
  /** Throw from `ActionService.create` for these dedupe keys. */
  failCreateForKeys?: string[];
}): Harness {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const created: Harness['created'] = [];

  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });

    if (sql.includes('FROM ci.entities')) {
      const ids = params[0] as string[];

      return opts.subjects.filter((id) => ids.includes(id)).map((entity_id) => ({ entity_id }));
    }

    if (sql.includes('FROM ci.relationships')) {
      const ids = params[0] as string[];

      return opts.edges.filter((row) => ids.includes(row.from_entity_id));
    }

    if (sql.includes('FROM ci.actions')) {
      return (opts.recentAlertKeys ?? []).includes(params[1] as string) ? [{ '?column?': 1 }] : [];
    }

    return [];
  });

  const actionService = {
    create: jest.fn(async (_ctx: unknown, data: Harness['created'][number]) => {
      const key = String((data.metadata ?? {}).key);

      if ((opts.failCreateForKeys ?? []).includes(key)) {
        throw new Error(`card write refused for ${key}`);
      }

      created.push(data);

      return { id: 'x' };
    }),
  };

  const featureService = {
    isFeatureEnabled: jest.fn(async () => opts.actionsEnabled ?? true),
  };

  const logger = makeLogger();

  const stage = new SingleValuedEdgeAuditStage(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { query } as any,
    actionService as never,
    featureService as never,
    logger as never,
  );

  return { stage, statements, created, logger };
}

describe('the version', () => {
  it('is a positive integer, as versions.ts requires', () => {
    expect(Number.isInteger(SINGLE_VALUED_AUDIT_VERSION)).toBe(true);
    expect(SINGLE_VALUED_AUDIT_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('accepts a STAGE_VERSIONS map with no entry for it yet', () => {
    expect(singleValuedEdgeAuditStageVersion({})).toBe(SINGLE_VALUED_AUDIT_VERSION);
  });

  it('throws when versions.ts disagrees, naming both numbers', () => {
    expect(() =>
      singleValuedEdgeAuditStageVersion({
        [CLEAN_SINGLE_VALUED_EDGE_AUDIT_STAGE_ID]: SINGLE_VALUED_AUDIT_VERSION + 5,
      }),
    ).toThrow(/update versions\.ts in the same commit/);
  });
});

describe('the declared type set', () => {
  /**
   * The point of the whole PR: a wrongly-declared single-valued type would
   * later have a superseder CLOSE a true edge. So the set starts at the one
   * type with a measured, reachable defect behind it, and grows only when this
   * detector's numbers say it should.
   */
  it('declares LIVES_IN and nothing that is plausibly multi-valued', () => {
    expect([...SINGLE_VALUED_RELATIONSHIP_TYPES]).toEqual([RelationshipType.LIVES_IN]);

    for (const multi of [
      RelationshipType.PARENT_OF,
      RelationshipType.MEMBER_OF,
      RelationshipType.WORKS_AT,
      RelationshipType.VISITED,
    ]) {
      expect(SINGLE_VALUED_RELATIONSHIP_TYPES.has(multi)).toBe(false);
    }
  });

  it('never declares a symmetric type — a symmetric edge is not one subject’s answer', () => {
    for (const type of SINGLE_VALUED_RELATIONSHIP_TYPES) {
      expect(RelationshipType[type as keyof typeof RelationshipType]).toBeDefined();
    }
  });
});

describe('the candidate set', () => {
  /**
   * THE ONE RULE. This stage's applicability predicate reaches into
   * `ci.relationships`, which LOOKS like the ratchet — so the thing that makes
   * it safe has to be pinned: the stage writes nothing there, so no row can
   * leave the candidate set because the stage succeeded.
   */
  it('never consults the ledger — that is the sweep’s job, not the predicate’s', () => {
    expect(SINGLE_VALUED_EDGE_AUDIT_SOURCE.predicate).not.toMatch(/pipeline_state|\bp\./);
  });

  it('sweeps entities, keyed and scoped by the columns ci.entities actually has', () => {
    expect(SINGLE_VALUED_EDGE_AUDIT_SOURCE.schema).toBe('ci');
    expect(SINGLE_VALUED_EDGE_AUDIT_SOURCE.table).toBe('entities');
    expect(SINGLE_VALUED_EDGE_AUDIT_SOURCE.idColumn).toBe('entity_id');
    expect(SINGLE_VALUED_EDGE_AUDIT_SOURCE.userColumn).toBe('owner_user_id');
  });

  it('narrows to subjects that hold a declared edge, scoped to the same owner', () => {
    expect(SINGLE_VALUED_EDGE_AUDIT_SOURCE.predicate).toContain("'LIVES_IN'");
    expect(SINGLE_VALUED_EDGE_AUDIT_SOURCE.predicate).toContain('r.owner_user_id = s.owner_user_id');
    expect(SINGLE_VALUED_EDGE_AUDIT_SOURCE.predicate).toContain('r.is_active = TRUE');
  });

  it('does not scope by subject entity_type — single-valuedness belongs to the TYPE', () => {
    // The reachable LIVES_IN case is held by a `User` self entity; a future
    // WORKS_AT would be held by a `Person`. A subject-type filter here would
    // silently scope the audit to whichever the first entry happened to be.
    expect(SINGLE_VALUED_EDGE_AUDIT_SOURCE.predicate).not.toContain('entity_type');
  });
});

describe('overlaps', () => {
  it('treats two undated edges as overlapping — an unbounded interval covers everything', () => {
    expect(overlaps(edge(), edge({ to_entity_id: HOME_B }))).toBe(true);
  });

  it('separates a closed range from a later open one', () => {
    const past = edge({ start_date: '2019-01-01', end_date: '2021-06-30' });
    const present = edge({ to_entity_id: HOME_B, start_date: '2021-07-01', end_date: null });

    expect(overlaps(past, present)).toBe(false);
    expect(overlaps(present, past)).toBe(false);
  });

  it('is inclusive at the boundary — two answers on the shared day is two answers', () => {
    const a = edge({ start_date: '2019-01-01', end_date: '2021-06-30' });
    const b = edge({ to_entity_id: HOME_B, start_date: '2021-06-30', end_date: null });

    expect(overlaps(a, b)).toBe(true);
  });

  it('overlaps an open-start range with anything that has not ended before it', () => {
    const openStart = edge({ start_date: null, end_date: '2020-01-01' });
    const later = edge({ to_entity_id: HOME_B, start_date: '2019-12-31', end_date: null });

    expect(overlaps(openStart, later)).toBe(true);
  });

  it('is symmetric for every pair it is asked about', () => {
    const pairs: Array<[SingleValuedEdge, SingleValuedEdge]> = [
      [edge({ start_date: '2020-01-01' }), edge({ to_entity_id: HOME_B, end_date: '2019-12-31' })],
      [edge({ end_date: '2020-01-01' }), edge({ to_entity_id: HOME_B, start_date: '2020-01-01' })],
      [edge(), edge({ to_entity_id: HOME_B, start_date: '2020-01-01', end_date: '2020-02-01' })],
    ];

    for (const [a, b] of pairs) {
      expect(overlaps(a, b)).toBe(overlaps(b, a));
    }
  });
});

describe('findContradictions', () => {
  it('reports nothing for a subject with a single active edge', () => {
    expect(findContradictions([edge()])).toStrictEqual([]);
  });

  it('reports two simultaneous undated homes — the KnownPlacesService case', () => {
    const found = findContradictions([edge(), edge({ to_entity_id: HOME_B })]);

    expect(found).toHaveLength(1);
    expect(found[0].fromEntityId).toBe(SELF);
    expect(found[0].relationshipType).toBe('LIVES_IN');
    expect(found[0].members).toHaveLength(2);
    expect(found[0].members.map((member) => member.toEntityId)).toStrictEqual([HOME_A, HOME_B]);
  });

  /**
   * The honesty flag, and the reason this PR's number needs reading twice.
   * Every writer but `KnownPlacesService` omits `start_date`/`end_date`
   * entirely, so on this corpus "the ranges overlap" almost always means "both
   * ranges are absent".
   */
  it('marks a finding undated when NO member carries a date', () => {
    expect(findContradictions([edge(), edge({ to_entity_id: HOME_B })])[0].undated).toBe(true);
  });

  it('does NOT mark it undated when any member carries a date', () => {
    const found = findContradictions([edge({ start_date: '2020-01-01' }), edge({ to_entity_id: HOME_B })]);

    expect(found).toHaveLength(1);
    expect(found[0].undated).toBe(false);
  });

  /**
   * A person who lived somewhere and then moved is a HISTORY, not a
   * contradiction. This is the branch that keeps the audit from reporting one
   * as the other, and it is the only thing the temporal half of the rule buys.
   */
  it('does not report a home the subject moved out of before moving in elsewhere', () => {
    expect(
      findContradictions([
        edge({ start_date: '2015-01-01', end_date: '2019-12-31' }),
        edge({ to_entity_id: HOME_B, start_date: '2020-01-01', end_date: null }),
      ]),
    ).toStrictEqual([]);
  });

  it('reports only the members that actually overlap, dropping the settled past', () => {
    const found = findContradictions([
      edge({ to_entity_id: HOME_C, start_date: '2010-01-01', end_date: '2014-12-31' }),
      edge({ to_entity_id: HOME_A, start_date: '2020-01-01', end_date: null }),
      edge({ to_entity_id: HOME_B, start_date: '2021-01-01', end_date: null }),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0].members).toHaveLength(2);
    expect(found[0].members.map((member) => member.toEntityId).sort()).toStrictEqual([HOME_A, HOME_B].sort());
  });

  it('keeps groups apart by subject — two people with one home each is not a conflict', () => {
    expect(findContradictions([edge(), edge({ from_entity_id: OTHER, to_entity_id: HOME_B })])).toStrictEqual(
      [],
    );
  });

  it('keeps groups apart by type — one LIVES_IN and one WORKS_AT is not a conflict', () => {
    expect(
      findContradictions([edge(), edge({ relationship_type: 'WORKS_AT', to_entity_id: HOME_B })]),
    ).toStrictEqual([]);
  });

  it('reports one finding per (subject, type), not one per overlapping pair', () => {
    const found = findContradictions([
      edge({ to_entity_id: HOME_A }),
      edge({ to_entity_id: HOME_B }),
      edge({ to_entity_id: HOME_C }),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0].members).toHaveLength(3);
  });

  /**
   * `relationships_unique_directed_idx` makes two active rows to the SAME
   * target unrepresentable, which is why a `>1` group is a contradiction and
   * not a duplicate. The de-duplication is defence against a reader catching a
   * writer mid-transaction; this pins that it does not turn one target into a
   * finding.
   */
  it('does not report a duplicate target as a contradiction', () => {
    expect(
      findContradictions([edge({ to_entity_id: HOME_A }), edge({ to_entity_id: HOME_A })]),
    ).toStrictEqual([]);
  });
});

describe('conflictAlertKey', () => {
  it('is stable per (type, subject) so the repeat window can suppress it', () => {
    const [found] = findContradictions([edge(), edge({ to_entity_id: HOME_B })]);

    expect(conflictAlertKey(found)).toBe(`${CONFLICT_REASON}:LIVES_IN:${SELF}`);
  });
});

describe('run — the ledger mapping', () => {
  it('reports its declared id and version', () => {
    const { stage } = makeHarness({ subjects: [], edges: [] });

    expect(stage.id).toBe(CLEAN_SINGLE_VALUED_EDGE_AUDIT_STAGE_ID);
    expect(stage.version).toBe(SINGLE_VALUED_AUDIT_VERSION);
  });

  /**
   * THE ASSERTION THIS PR IS FOR. `PipelineStateService.complete` drops
   * `detail` — the table has no column for it — and persists `reason` for every
   * outcome. A detector that reported its finding only in `detail` would leave
   * no countable trace at all, which is the exact failure mode `ci.facts` died
   * of: schema for a fact nobody could read back.
   */
  it('records a contradiction as done + the countable reason', async () => {
    const { stage } = makeHarness({
      subjects: [SELF],
      edges: [edge(), edge({ to_entity_id: HOME_B })],
    });

    const results = await stage.run(CONTEXT, [SELF]);

    expect(results.get(SELF)?.outcome).toBe('done');
    expect(results.get(SELF)?.reason).toBe(CONFLICT_REASON);
  });

  it('records an audited-and-clean subject as done with NO reason — the denominator', async () => {
    const { stage } = makeHarness({ subjects: [SELF], edges: [edge()] });

    const results = await stage.run(CONTEXT, [SELF]);

    expect(results.get(SELF)?.outcome).toBe('done');
    expect(results.get(SELF)?.reason).toBeUndefined();
  });

  it('skips a subject whose last declared edge vanished between sweep and slice', async () => {
    const { stage } = makeHarness({ subjects: [SELF], edges: [] });

    expect(await stage.run(CONTEXT, [SELF])).toStrictEqual(
      new Map([[SELF, { outcome: 'skipped', reason: 'no_single_valued_edges' }]]),
    );
  });

  it('skips a subject deleted or merged away between sweep and slice', async () => {
    const { stage } = makeHarness({ subjects: [], edges: [] });

    expect(await stage.run(CONTEXT, [SELF])).toStrictEqual(
      new Map([[SELF, { outcome: 'skipped', reason: 'source_row_missing' }]]),
    );
  });

  it('returns nothing at all for an empty slice', async () => {
    const { stage, statements } = makeHarness({ subjects: [], edges: [] });

    expect(await stage.run(CONTEXT, [])).toStrictEqual(new Map());
    expect(statements).toHaveLength(0);
  });

  it('answers every id in the slice — silence is never treated as success', async () => {
    const { stage } = makeHarness({
      subjects: [SELF, OTHER],
      edges: [edge(), edge({ to_entity_id: HOME_B }), edge({ from_entity_id: OTHER })],
    });

    const results = await stage.run(CONTEXT, [SELF, OTHER]);

    expect([...results.keys()].sort()).toStrictEqual([SELF, OTHER].sort());
  });

  it('scopes both statements to the caller’s user', async () => {
    const { stage, statements } = makeHarness({ subjects: [SELF], edges: [edge()] });

    await stage.run(CONTEXT, [SELF]);

    const entities = statements.find(({ sql }) => sql.includes('FROM ci.entities'));
    const relationships = statements.find(({ sql }) => sql.includes('FROM ci.relationships'));

    expect(entities?.params[1]).toBe(USER);
    expect(relationships?.params[1]).toBe(USER);
    expect(relationships?.sql).toContain('r.owner_user_id = $2::uuid');
  });

  /**
   * `DATE` comes back from node-postgres as a host-local `Date`; the overlap
   * test compares strings and is only exact for `YYYY-MM-DD`.
   */
  it('reads the dates as text so the string comparison is the chronological one', async () => {
    const { stage, statements } = makeHarness({ subjects: [SELF], edges: [edge()] });

    await stage.run(CONTEXT, [SELF]);

    const relationships = statements.find(({ sql }) => sql.includes('FROM ci.relationships'));

    expect(relationships?.sql).toContain('r.start_date::text');
    expect(relationships?.sql).toContain('r.end_date::text');
  });
});

describe('run — the cards', () => {
  it('raises one card per contradiction, deduped on a stable key', async () => {
    const { stage, created } = makeHarness({
      subjects: [SELF],
      edges: [edge(), edge({ to_entity_id: HOME_B })],
    });

    await stage.run(CONTEXT, [SELF]);

    expect(created).toHaveLength(1);
    expect(created[0].metadata?.key).toBe(`${CONFLICT_REASON}:LIVES_IN:${SELF}`);
    // NOT 'anomaly'/'suggestion': those share a three-per-day cap the Brief's
    // engines are counting on, and an infrastructure report must not spend it.
    expect(created[0].source).toBe('legacy');
    expect(created[0].metadata?.members).toHaveLength(2);
  });

  it('says nothing twice inside the repeat window', async () => {
    const { stage, created } = makeHarness({
      subjects: [SELF],
      edges: [edge(), edge({ to_entity_id: HOME_B })],
      recentAlertKeys: [`${CONFLICT_REASON}:LIVES_IN:${SELF}`],
    });

    await stage.run(CONTEXT, [SELF]);

    expect(created).toStrictEqual([]);
  });

  it('probes the repeat window with the configured number of days', async () => {
    const { stage, statements } = makeHarness({
      subjects: [SELF],
      edges: [edge(), edge({ to_entity_id: HOME_B })],
    });

    await stage.run(CONTEXT, [SELF]);

    const probe = statements.find(({ sql }) => sql.includes('FROM ci.actions'));

    expect(probe?.params[2]).toBe(CONFLICT_ALERT_REPEAT_DAYS);
  });

  /**
   * MEASURING is unconditional, ALERTING is flagged — `RetrievalHealthCron`'s
   * split. A flag that turned the count off would recreate the blind spot the
   * stage exists to remove.
   */
  it('still records the count when the actions feature is off', async () => {
    const { stage, created } = makeHarness({
      subjects: [SELF],
      edges: [edge(), edge({ to_entity_id: HOME_B })],
      actionsEnabled: false,
    });

    const results = await stage.run(CONTEXT, [SELF]);

    expect(created).toStrictEqual([]);
    expect(results.get(SELF)?.reason).toBe(CONFLICT_REASON);
  });

  it('caps the cards one slice may raise, and still counts every contradiction', async () => {
    const subjects = Array.from(
      { length: MAX_ALERTS_PER_SLICE + 3 },
      (_unused, index) => `00000000-0000-4000-8000-4${String(index).padStart(11, '0')}`,
    );
    const edges = subjects.flatMap((subject) => [
      edge({ from_entity_id: subject, to_entity_id: HOME_A }),
      edge({ from_entity_id: subject, to_entity_id: HOME_B }),
    ]);

    const { stage, created } = makeHarness({ subjects, edges });

    const results = await stage.run(CONTEXT, subjects);

    expect(created).toHaveLength(MAX_ALERTS_PER_SLICE);

    for (const subject of subjects) {
      expect(results.get(subject)?.reason).toBe(CONFLICT_REASON);
    }
  });

  it('fails only the subject whose card could not be written', async () => {
    const { stage } = makeHarness({
      subjects: [SELF, OTHER],
      edges: [
        edge({ from_entity_id: SELF, to_entity_id: HOME_A }),
        edge({ from_entity_id: SELF, to_entity_id: HOME_B }),
        edge({ from_entity_id: OTHER, to_entity_id: HOME_A }),
        edge({ from_entity_id: OTHER, to_entity_id: HOME_C }),
      ],
      failCreateForKeys: [`${CONFLICT_REASON}:LIVES_IN:${SELF}`],
    });

    const results = await stage.run(CONTEXT, [SELF, OTHER]);

    expect(results.get(SELF)?.outcome).toBe('failed');
    expect(results.get(SELF)?.reason).toBe('conflict_alert_failed');
    expect(results.get(OTHER)?.outcome).toBe('done');
    expect(results.get(OTHER)?.reason).toBe(CONFLICT_REASON);
  });

  it('writes no card at all when nothing contradicts', async () => {
    const { stage, created, statements } = makeHarness({ subjects: [SELF], edges: [edge()] });

    await stage.run(CONTEXT, [SELF]);

    expect(created).toStrictEqual([]);
    expect(statements.some(({ sql }) => sql.includes('FROM ci.actions'))).toBe(false);
  });
});
