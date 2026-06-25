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
  let selectServed = false;

  const query = jest.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('UPDATE ci.communications')) {
      updates.push({ sql, params });

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

  return { dataSource: { query }, updates, query };
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

  const service = new CommunicationLinkBackfillService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ds.dataSource as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ids as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { service, ds, ids };
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
    expect(sql).toContain('time = $2');
    expect(params[0]).toBe(USER);
    expect(params[2]).toBe('row-1');
    expect(params[3]).toBe(FROM_ENTITY);
    expect(params[4]).toEqual([TO_ENTITY_1, TO_ENTITY_2]);
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

    const { service, ds } = makeService(rows, {});

    const result = await service.backfill(USER, { startTime: START, endTime: END });

    expect(result.examined).toBe(1);
    expect(result.fromLinked).toBe(0);
    expect(result.toLinked).toBe(0);
    expect(ds.updates).toHaveLength(0); // no stub creation, no write
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
    expect(params[3]).toBeNull(); // fromId not resolved (was already set)
    expect(params[4]).toEqual([TO_ENTITY_1]);
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
    expect(ds.updates[0].params[4]).toEqual([TO_ENTITY_1]);
  });

  it('returns an empty result and runs no windows when bounds are inverted', async () => {
    const { service, ds, ids } = makeService([], {});

    const result = await service.backfill(USER, { startTime: END, endTime: START });

    expect(result).toEqual({ examined: 0, fromLinked: 0, toLinked: 0, windows: 0, range: null });
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

        return [{ min_time: new Date('2026-01-07T00:00:00.000Z'), max_time: new Date('2026-01-07T00:00:00.000Z') }];
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

    const ids = makeIdentifierService({ 'email:sender@example.com': FROM_ENTITY });
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
