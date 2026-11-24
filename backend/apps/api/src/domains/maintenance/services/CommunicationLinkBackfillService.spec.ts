import { CommunicationLinkBackfillService } from './CommunicationLinkBackfillService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const FROM_ENTITY = '00000000-0000-0000-0000-0000000000b1';
const TO_ENTITY_1 = '00000000-0000-0000-0000-0000000000c1';
const TO_ENTITY_2 = '00000000-0000-0000-0000-0000000000c2';

// A single 7-day window so each test drives exactly one SELECT pass. The
// service walks newest-first; with start == end - 7d there is one window.
const END = new Date('2026-01-08T00:00:00.000Z');
const START = new Date('2026-01-01T00:00:00.000Z');

interface FakeRow {
  id: string;
  time: Date;
  user_id: string;
  from_entity_id: string | null;
  to_entity_ids: string[] | null;
  participants_metadata: Record<string, unknown> | null;
}

/**
 * Build a DataSource whose `query` serves the window SELECT once, then returns
 * [] for any later window, and records UPDATE calls. Bounds are caller-supplied
 * (START/END) so the MIN/MAX branch is skipped.
 */
function makeDataSource(rows: FakeRow[]) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  // Every statement and re-open in order, so a spec can assert what ran inside
  // which transaction and in what sequence.
  const calls: string[] = [];
  let selectServed = false;

  const query = jest.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('UPDATE ci.communications')) {
      updates.push({ sql, params });
      calls.push('update');

      return [];
    }

    if (sql.includes('FROM ci.communications')) {
      // Serve candidate rows for the first (newest) window only.
      if (!selectServed) {
        selectServed = true;

        return rows;
      }

      return [];
    }

    return [];
  });

  // The service wraps each page's UPDATE and its edge re-open in
  // dataSource.transaction(); route the entity manager's query() back to the
  // same mock so the UPDATE lands here, and record the order.
  const managers: Array<{ query: typeof query }> = [];
  const transaction = jest.fn(async (cb: (em: { query: typeof query }) => Promise<unknown>) => {
    const em = { query };
    managers.push(em);
    calls.push('begin');
    const result = await cb(em);
    calls.push('commit');

    return result;
  });

  return { dataSource: { query, transaction }, updates, query, calls, managers };
}

/**
 * The pipeline's `EDGE_PROJECTION_REOPENER` binding, as the lazily-resolving
 * ModuleRef hands it back. Reports one re-opened row per id, the most a
 * re-open can move.
 */
function makeReopener(calls?: string[]) {
  const reopener = {
    reopen: jest.fn(async (_source: string, ids: readonly string[], _manager: unknown) => {
      calls?.push('reopen');

      return ids.length;
    }),
  };
  const moduleRef = { get: jest.fn(() => reopener) };

  return { reopener, moduleRef };
}

function makeIdentifierService(map: Record<string, string>) {
  return {
    findEntityIdsByIdentifiers: jest.fn(
      async (_userId: string, keys: Array<{ kind: string; valueNormalized: string }>) => {
        const out = new Map<string, string>();
        for (const key of keys) {
          const composite = `${key.kind}:${key.valueNormalized}`;
          if (map[composite]) {
            out.set(composite, map[composite]);
          }
        }

        return out;
      },
    ),
  };
}

function makeService(rows: FakeRow[], identifierMap: Record<string, string>) {
  const ds = makeDataSource(rows);
  const ids = makeIdentifierService(identifierMap);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const { reopener, moduleRef } = makeReopener(ds.calls);

  const service = new CommunicationLinkBackfillService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ds.dataSource as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ids as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    moduleRef as any,
  );

  return { service, ds, ids, reopener };
}

describe('CommunicationLinkBackfillService.backfill', () => {
  it('resolves from + to and writes both via a bounded UPDATE', async () => {
    const rows: FakeRow[] = [
      {
        id: 'row-1',
        time: new Date('2026-01-07T00:00:00.000Z'),
        user_id: USER,
        from_entity_id: null,
        to_entity_ids: null,
        participants_metadata: {
          from: 'Sender@Example.com',
          to: ['+1 (415) 555-0100', 'other@example.com'],
        },
      },
    ];

    const { service, ds, ids } = makeService(rows, {
      'email:sender@example.com': FROM_ENTITY,
      'phone:4155550100': TO_ENTITY_1,
      'email:other@example.com': TO_ENTITY_2,
    });

    const result = await service.backfill(USER, { startTime: START, endTime: END });

    expect(result.examined).toBe(1);
    expect(result.fromLinked).toBe(1);
    expect(result.toLinked).toBe(1);

    // One batched identifier lookup for the window.
    expect(ids.findEntityIdsByIdentifiers).toHaveBeenCalledTimes(1);

    // One UPDATE, scoped by partition key (user_id, time, id), with resolved ids.
    expect(ds.updates).toHaveLength(1);
    const { sql, params } = ds.updates[0];
    expect(sql).toContain('UPDATE ci.communications');
    expect(sql).toContain('c.id = u.id');
    // Batched: params are parallel per-page arrays — [userId, ids[], times[], fromIds[], toJson[]].
    // to_ids ride as jsonb strings (a uuid[][] can't be unnested element-wise).
    expect(params[0]).toBe(USER);
    expect(params[1]).toEqual(['row-1']);
    expect(params[3]).toEqual([FROM_ENTITY]);
    expect(params[4]).toEqual([JSON.stringify([TO_ENTITY_1, TO_ENTITY_2])]);
  });

  it("re-opens the edge leg's decision for the rows it wrote, inside the write's transaction", async () => {
    // The row the reference appliance stranded 16,000 times: its sender was
    // linked at ingest, so the edge leg projected it (SENT) and recorded `done`
    // before anything linked its recipient. Filling the recipient here must
    // re-open that decision, or its RECEIVED edge never exists.
    const rows: FakeRow[] = [
      {
        id: 'row-1',
        time: new Date('2026-01-07T00:00:00.000Z'),
        user_id: USER,
        from_entity_id: FROM_ENTITY,
        to_entity_ids: [],
        participants_metadata: { from: 'sender@example.com', to: ['+14155550100'] },
      },
      {
        id: 'row-2',
        time: new Date('2026-01-06T00:00:00.000Z'),
        user_id: USER,
        from_entity_id: null,
        to_entity_ids: null,
        participants_metadata: { from: 'nobody@example.com' },
      },
    ];

    const { service, ds, reopener } = makeService(rows, { 'phone:4155550100': TO_ENTITY_1 });

    const result = await service.backfill(USER, { startTime: START, endTime: END });

    // Only the row this page wrote; the unresolved one was never touched.
    expect(reopener.reopen).toHaveBeenCalledTimes(1);
    expect(reopener.reopen).toHaveBeenCalledWith('communications', ['row-1'], ds.managers[0]);
    // After the UPDATE, before the COMMIT: the write and its re-open are one unit.
    expect(ds.calls).toEqual(['begin', 'update', 'reopen', 'commit']);
    expect(result.edgeDecisionsReopened).toBe(1);
  });

  it('fails the page before it writes anything when no re-opener is bound', async () => {
    const rows: FakeRow[] = [
      {
        id: 'row-1',
        time: new Date('2026-01-07T00:00:00.000Z'),
        user_id: USER,
        from_entity_id: null,
        to_entity_ids: null,
        participants_metadata: { from: 'sender@example.com' },
      },
    ];
    const ds = makeDataSource(rows);
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    // Hand-built with no ModuleRef: a container without PipelineModule.
    const service = new CommunicationLinkBackfillService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ds.dataSource as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeIdentifierService({ 'email:sender@example.com': FROM_ENTITY }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger as any,
    );

    await expect(service.backfill(USER, { startTime: START, endTime: END })).rejects.toThrow(
      /EDGE_PROJECTION_REOPENER/,
    );
    // A link written without its re-open is the defect; better no link at all.
    expect(ds.updates).toHaveLength(0);
    expect(ds.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('leaves links NULL and skips the UPDATE when nothing matches', async () => {
    const rows: FakeRow[] = [
      {
        id: 'row-1',
        time: new Date('2026-01-07T00:00:00.000Z'),
        user_id: USER,
        from_entity_id: null,
        to_entity_ids: null,
        participants_metadata: { from: 'unknown@example.com', to: ['no-match@example.com'] },
      },
    ];

    const { service, ds, reopener } = makeService(rows, {});

    const result = await service.backfill(USER, { startTime: START, endTime: END });

    expect(result.examined).toBe(1);
    expect(result.fromLinked).toBe(0);
    expect(result.toLinked).toBe(0);
    expect(ds.updates).toHaveLength(0); // no stub creation, no write
    // Nothing written, so nothing the edge leg decided is stale.
    expect(reopener.reopen).not.toHaveBeenCalled();
    expect(result.edgeDecisionsReopened).toBe(0);
  });

  it('only fills the missing side (from already set -> resolves to only)', async () => {
    const rows: FakeRow[] = [
      {
        id: 'row-1',
        time: new Date('2026-01-07T00:00:00.000Z'),
        user_id: USER,
        from_entity_id: FROM_ENTITY, // already linked
        to_entity_ids: null,
        participants_metadata: { from: 'sender@example.com', to: ['+14155550100'] },
      },
    ];

    const { service, ds } = makeService(rows, {
      // even though sender maps, from is already set so it must not be re-looked-up
      'email:sender@example.com': 'should-not-be-used',
      'phone:4155550100': TO_ENTITY_1,
    });

    const result = await service.backfill(USER, { startTime: START, endTime: END });

    expect(result.fromLinked).toBe(0);
    expect(result.toLinked).toBe(1);
    expect(ds.updates).toHaveLength(1);
    const { params } = ds.updates[0];
    expect(params[3]).toEqual([null]); // fromId not resolved (was already set)
    expect(params[4]).toEqual([JSON.stringify([TO_ENTITY_1])]);
  });

  it('writes a partial recipient set when only some recipients resolve', async () => {
    const rows: FakeRow[] = [
      {
        id: 'row-1',
        time: new Date('2026-01-07T00:00:00.000Z'),
        user_id: USER,
        from_entity_id: null,
        to_entity_ids: null,
        participants_metadata: { to: ['known@example.com', 'unknown@example.com'] },
      },
    ];

    const { service, ds } = makeService(rows, { 'email:known@example.com': TO_ENTITY_1 });

    const result = await service.backfill(USER, { startTime: START, endTime: END });

    expect(result.toLinked).toBe(1);
    expect(ds.updates).toHaveLength(1);
    expect(ds.updates[0].params[4]).toEqual([JSON.stringify([TO_ENTITY_1])]);
  });

  it('returns an empty result and runs no windows when bounds are inverted', async () => {
    const { service, ds, ids } = makeService([], {});

    const result = await service.backfill(USER, { startTime: END, endTime: START });

    expect(result).toEqual({
      examined: 0,
      fromLinked: 0,
      toLinked: 0,
      edgeDecisionsReopened: 0,
      windows: 0,
      range: null,
    });
    expect(ds.query).not.toHaveBeenCalled();
    expect(ids.findEntityIdsByIdentifiers).not.toHaveBeenCalled();
  });

  it('derives bounds from the data when no range is supplied', async () => {
    const rows: FakeRow[] = [
      {
        id: 'row-1',
        time: new Date('2026-01-07T00:00:00.000Z'),
        user_id: USER,
        from_entity_id: null,
        to_entity_ids: null,
        participants_metadata: { from: 'sender@example.com' },
      },
    ];

    // Custom DataSource: first query is the MIN/MAX bounds probe.
    const updates: Array<unknown[]> = [];
    let boundsServed = false;
    let selectServed = false;
    const query = jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('MIN(time)')) {
        boundsServed = true;

        return [
          { min_time: new Date('2026-01-07T00:00:00.000Z'), max_time: new Date('2026-01-07T00:00:00.000Z') },
        ];
      }

      if (sql.includes('UPDATE ci.communications')) {
        updates.push(params);

        return [];
      }

      if (sql.includes('FROM ci.communications')) {
        if (!selectServed) {
          selectServed = true;

          return rows;
        }

        return [];
      }

      return [];
    });

    // The page's UPDATE and its edge re-open run in one transaction.
    const transaction = jest.fn(async (cb: (em: { query: typeof query }) => Promise<unknown>) =>
      cb({ query }),
    );
    const ids = makeIdentifierService({ 'email:sender@example.com': FROM_ENTITY });
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const service = new CommunicationLinkBackfillService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { query, transaction } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ids as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeReopener().moduleRef as any,
    );

    const result = await service.backfill(USER);

    expect(boundsServed).toBe(true);
    expect(result.range).not.toBeNull();
    expect(result.fromLinked).toBe(1);
    expect(updates).toHaveLength(1);
  });

  it('returns an empty result when there are no candidate rows at all', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('MIN(time)')) {
        return [{ min_time: null, max_time: null }];
      }

      return [];
    });
    const ids = makeIdentifierService({});
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const service = new CommunicationLinkBackfillService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { query } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ids as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger as any,
    );

    const result = await service.backfill(USER);

    expect(result.range).toBeNull();
    expect(result.windows).toBe(0);
  });
});
