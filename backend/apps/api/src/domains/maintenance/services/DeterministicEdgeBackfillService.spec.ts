import { DeterministicEdgeBackfillService } from './DeterministicEdgeBackfillService';
import { DETERMINISTIC_EDGE_RULES } from './deterministicEdgeMatrix';

const USER = '00000000-0000-0000-0000-0000000000aa';
const PERSON = '00000000-0000-0000-0000-0000000000b1';
const COMM = '00000000-0000-0000-0000-0000000000c1';
const EDGE = '00000000-0000-0000-0000-0000000000d1';

// A single 30-day window so each rule drives exactly one INSERT pass.
const END = new Date('2026-01-31T00:00:00.000Z');
const START = new Date('2026-01-01T00:00:00.000Z');

interface InsertedRow {
  relationship_id: string;
  from_entity_id: string;
  to_entity_id: string;
}

/**
 * Build a DataSource whose transaction() hands back an entity manager that
 * serves the windowed INSERT ... RETURNING from `insertedByType` (keyed by the
 * relationship-type bind, $4) and records every call. Bounds are
 * caller-supplied (START/END) in most tests so the MIN/MAX branch is skipped.
 */
function makeDataSource(
  insertedByType: Record<string, InsertedRow[][]>,
  bounds?: { min: Date | null; max: Date | null },
) {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const served: Record<string, number> = {};

  const managerQuery = jest.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('INSERT INTO ci.relationships')) {
      inserts.push({ sql, params });
      // The scope params vary (time window = 2, id slice = 1) but the tail is
      // always [type, strength, properties].
      const type = String(params[params.length - 3]);
      const passes = insertedByType[type] ?? [];
      const index = served[type] ?? 0;
      served[type] = index + 1;

      return passes[index] ?? [];
    }

    return [];
  });

  const query = jest.fn(async (sql: string) => {
    if (sql.includes('SELECT MIN(')) {
      return [{ min_time: bounds?.min ?? null, max_time: bounds?.max ?? null }];
    }

    return [];
  });

  const manager = { query: managerQuery };
  const transaction = jest.fn(async (cb: (em: typeof manager) => Promise<unknown>) => cb(manager));

  return { dataSource: { query, transaction }, inserts, manager };
}

function makeService(
  insertedByType: Record<string, InsertedRow[][]>,
  bounds?: { min: Date | null; max: Date | null },
) {
  const ds = makeDataSource(insertedByType, bounds);
  const deltaWriter = {
    // Params typed so the assertion on mock.calls[0] can destructure them.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    recordMany: jest.fn(async (_deltas: Array<Record<string, unknown>>, _manager?: unknown) => undefined),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new DeterministicEdgeBackfillService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ds.dataSource as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deltaWriter as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { service, ds, deltaWriter };
}

describe('DeterministicEdgeBackfillService.backfill', () => {
  it('materializes a rule into relationships and records a delta per created edge', async () => {
    const { service, ds, deltaWriter } = makeService({
      SENT: [[{ relationship_id: EDGE, from_entity_id: PERSON, to_entity_id: COMM }]],
    });

    const result = await service.backfill(USER, {
      startTime: START,
      endTime: END,
      rules: ['communication.sent'],
    });

    expect(result.edgesCreated).toBe(1);
    expect(result.rules).toEqual([
      {
        rule: 'communication.sent',
        relationshipType: 'SENT',
        edgesCreated: 1,
        windows: 1,
        range: { start: START.toISOString(), end: END.toISOString() },
      },
    ]);

    // Exactly one windowed INSERT, carrying the rule's type/strength binds and
    // the canonical-resolution + idempotency SQL shape.
    expect(ds.inserts).toHaveLength(1);
    const { sql, params } = ds.inserts[0];
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(sql).toContain('merged_into_entity_id');
    expect(sql).toContain('FROM ci.communications c');
    expect(params[0]).toBe(USER);
    expect(params[3]).toBe('SENT');
    expect(params[4]).toBe(0.6);
    expect(JSON.parse(String(params[5]))).toEqual({
      derived_from: 'communications.from_entity_id',
      rule: 'communication.sent',
    });

    // One delta per created edge, inside the SAME transaction (manager passed).
    expect(deltaWriter.recordMany).toHaveBeenCalledTimes(1);
    const [deltas, manager] = deltaWriter.recordMany.mock.calls[0];
    expect(manager).toBe(ds.manager);
    expect(deltas).toEqual([
      expect.objectContaining({
        nodeType: 'relationship',
        changeType: 'created',
        relationshipId: EDGE,
        relationshipType: 'SENT',
        fromEntityId: PERSON,
        toEntityId: COMM,
        ownerUserId: USER,
        changeSource: 'DeterministicEdgeBackfillService',
        changeReason: 'communication.sent',
      }),
    ]);
  });

  it('runs the whole matrix by default, in matrix order', async () => {
    const { service, ds } = makeService({});

    const result = await service.backfill(USER, { startTime: START, endTime: END });

    expect(result.rules.map((r) => r.rule)).toEqual(DETERMINISTIC_EDGE_RULES.map((r) => r.id));
    expect(ds.inserts).toHaveLength(DETERMINISTIC_EDGE_RULES.length);
    expect(result.edgesCreated).toBe(0);
  });

  it('records no deltas when every edge already existed (ON CONFLICT no-op)', async () => {
    const { service, deltaWriter } = makeService({ SENT: [[]] });

    const result = await service.backfill(USER, {
      startTime: START,
      endTime: END,
      rules: ['communication.sent'],
    });

    expect(result.edgesCreated).toBe(0);
    expect(deltaWriter.recordMany).not.toHaveBeenCalled();
  });

  it('walks a multi-window range newest-first and reports progress per window', async () => {
    // 60 days at the default 30-day window = 2 windows for the one rule.
    const wideEnd = new Date('2026-03-02T00:00:00.000Z');
    const wideStart = new Date('2026-01-01T00:00:00.000Z');
    const { service, ds } = makeService({
      SENT: [[{ relationship_id: EDGE, from_entity_id: PERSON, to_entity_id: COMM }], []],
    });

    const progress: Array<{ windowsDone: number; windowsTotal: number; edgesCreated: number }> = [];
    const result = await service.backfill(USER, {
      startTime: wideStart,
      endTime: wideEnd,
      rules: ['communication.sent'],
      onProgress: (p) => progress.push(p),
    });

    expect(result.rules[0].windows).toBe(2);
    expect(result.edgesCreated).toBe(1);
    expect(ds.inserts).toHaveLength(2);

    // Newest window first: the first INSERT's upper bound is the range end.
    expect(ds.inserts[0].params[2]).toBe(wideEnd.toISOString());
    expect(progress.map((p) => p.windowsDone)).toEqual([1, 2]);
    expect(progress.every((p) => p.windowsTotal === 2)).toBe(true);
    expect(progress[1].edgesCreated).toBe(1);
  });

  it('projects an id-scoped slice through every rule of one source table', async () => {
    const { service, ds, deltaWriter } = makeService({
      SENT: [[{ relationship_id: EDGE, from_entity_id: PERSON, to_entity_id: COMM }]],
      RECEIVED: [[]],
    });

    const edges = await service.materializeForSourceIds(USER, 'communications', [COMM]);

    expect(edges).toBe(1);

    // Both communication rules ran, no event rule did, and the scope is the id
    // list rather than a time window.
    const commRules = DETERMINISTIC_EDGE_RULES.filter((r) => r.source === 'communications');
    expect(ds.inserts).toHaveLength(commRules.length);
    for (const { sql, params } of ds.inserts) {
      expect(sql).toContain('= ANY($2::uuid[])');
      expect(sql).not.toContain('>= $2');
      expect(params[1]).toEqual([COMM]);
    }

    // The created edge still records its delta in the same transaction.
    expect(deltaWriter.recordMany).toHaveBeenCalledTimes(1);
    expect(deltaWriter.recordMany.mock.calls[0][1]).toBe(ds.manager);
  });

  it('projects nothing for an empty id slice', async () => {
    const { service, ds } = makeService({});

    const edges = await service.materializeForSourceIds(USER, 'events', []);

    expect(edges).toBe(0);
    expect(ds.inserts).toHaveLength(0);
  });

  it('derives bounds from the candidates and reports a null range when there are none', async () => {
    const { service, ds } = makeService({}, { min: null, max: null });

    const result = await service.backfill(USER, { rules: ['event.happened_at'] });

    expect(result.edgesCreated).toBe(0);
    expect(result.rules).toEqual([
      {
        rule: 'event.happened_at',
        relationshipType: 'LOCATED_AT',
        edgesCreated: 0,
        windows: 0,
        range: null,
      },
    ]);
    expect(ds.inserts).toHaveLength(0);
  });
});
