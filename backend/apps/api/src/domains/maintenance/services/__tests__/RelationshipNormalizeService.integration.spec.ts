import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { RelationshipNormalizeService } from '../RelationshipNormalizeService';

/**
 * The counts `POST /maintenance/normalize-relationships` reports, checked
 * against the rows it actually changed.
 *
 * Three of the four used to be constants. `swapped`, `deletedIs` and
 * `bidirectionalStamped` were `.length` of statements whose OUTER command is
 * an UPDATE, which TypeORM resolves to the pair `[rows, rowCount]` — so the
 * endpoint said 6, 2 and 2 on every call, a replay over an already-normalized
 * graph included. The fixture below is sized so that no count equals the
 * constant it used to report.
 *
 * The rename passes had two defects of their own. Two aliases of ONE canonical
 * type between the same pair (PARTNER and ROMANTIC_PARTNER) were both renamed,
 * and the second rename violated `relationships_unique_directed_idx` — the
 * whole normalize rolled back, on every call, for any user holding such a
 * pair. And they selected aliases whether or not they were active, so every
 * replay re-deactivated, and re-counted, the duplicates the first run retired.
 *
 * There are no foreign keys from `ci.relationships` to `ci.entities`, so the
 * endpoints are bare ids. Fixtures are committed (the service opens its own
 * transaction) and deleted by owner afterwards.
 */

const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[maintenance/RelationshipNormalizeService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const noopLogger = {
  setContext: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

describeWithDatabase(`RelationshipNormalizeService against the live schema (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: RelationshipNormalizeService;

  const userId = randomUUID();
  const [a, b, c, d, e, f, g, h, j, k, l, m, n, p, q, w, x, y, z] = Array.from({ length: 19 }, () =>
    randomUUID(),
  );

  const insertEdge = async (
    from: string,
    to: string,
    type: string,
    options: {
      fromType?: string;
      toType?: string;
      active?: boolean;
      bidirectional?: boolean;
      createdAt?: string;
    } = {},
  ): Promise<void> => {
    await dataSource.query(
      `INSERT INTO ci.relationships
         (from_entity_id, to_entity_id, relationship_type, owner_user_id,
          from_entity_type, to_entity_type, is_active, is_bidirectional, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, NOW()))`,
      [
        from,
        to,
        type,
        userId,
        options.fromType ?? 'Person',
        options.toType ?? 'Person',
        options.active ?? true,
        options.bidirectional ?? false,
        options.createdAt ?? null,
      ],
    );
  };

  const countEdges = async (where: string): Promise<number> => {
    const [row] = (await dataSource.query(
      `SELECT count(*)::int AS count FROM ci.relationships WHERE owner_user_id = $1 AND ${where}`,
      [userId],
    )) as Array<{ count: number }>;

    return row.count;
  };

  /** As text: a JS `Date` would drop the microseconds a re-touch changes. */
  const latestWrite = async (): Promise<string> => {
    const [row] = (await dataSource.query(
      'SELECT max(updated_at)::text AS at FROM ci.relationships WHERE owner_user_id = $1',
      [userId],
    )) as Array<{ at: string }>;

    return row.at;
  };

  beforeAll(async () => {
    const connection = resolveConnection();

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
    });
    await dataSource.initialize();

    // SHARED: this suite commits ci.users / ci.relationships rows. See
    // domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(
      dataSource,
      'maintenance/RelationshipNormalizeService.integration',
    );

    await createSyntheticTestUser(
      (sql, params) => dataSource.query(sql, params as unknown[]),
      'RelationshipNormalize',
      userId,
    );

    // ── renamed: 6 aliases + 2 PART_OF → 8 ─────────────────────────────────
    await insertEdge(a, b, 'FRIEND'); // → FRIENDS_WITH
    await insertEdge(a, c, 'COLLEAGUE'); // → WORKS_WITH
    await insertEdge(e, l, 'HAPPENED_AT', { fromType: 'Event', toType: 'Location' }); // → LOCATED_AT
    // Its canonical twin already exists, so it is deactivated rather than renamed.
    await insertEdge(a, d, 'ASSOCIATED_WITH');
    await insertEdge(a, d, 'RELATED_TO');
    // Two aliases of PARTNER_OF between one pair: the older is renamed and the
    // other deactivated as its duplicate. Inserted newest first, so the older
    // one winning is the ORDER BY, not the heap order.
    await insertEdge(g, h, 'ROMANTIC_PARTNER', { createdAt: '2021-06-01T00:00:00Z' });
    await insertEdge(g, h, 'PARTNER', { createdAt: '2019-06-01T00:00:00Z' });
    await insertEdge(k, e, 'PART_OF', { fromType: 'Content', toType: 'Event' }); // → DOCUMENTS
    // Its DOCUMENTS twin already exists, so it is deactivated rather than renamed.
    await insertEdge(j, e, 'DOCUMENTS', { fromType: 'Content', toType: 'Event' });
    await insertEdge(j, e, 'PART_OF', { fromType: 'Content', toType: 'Event' });
    // Already inactive: left alone — neither renamed nor stamped.
    await insertEdge(b, d, 'COLLEAGUE', { active: false });

    // ── swapped: 4 aliases retired, 3 canonicals inserted ─────────────────
    await insertEdge(x, y, 'CHILD_OF'); // → y PARENT_OF x
    await insertEdge(z, w, 'CHILD_OF'); // → w PARENT_OF z
    // The canonical already exists: nothing is inserted, the alias still retires.
    await insertEdge(q, p, 'PARENT_OF');
    await insertEdge(p, q, 'CHILD_OF');
    await insertEdge(m, n, 'LEARNED_FROM'); // → n TAUGHT m
    // Already inactive: not a victim.
    await insertEdge(y, x, 'CHILD_OF', { active: false });

    // ── deletedIs: 3 ──────────────────────────────────────────────────────
    await insertEdge(a, f, 'IS');
    await insertEdge(b, f, 'IS');
    await insertEdge(c, f, 'IS');
    await insertEdge(d, f, 'IS', { active: false });

    // ── bidirectionalStamped: FRIENDS_WITH, WORKS_WITH, PARTNER_OF (renamed above) + 3 ─
    await insertEdge(a, f, 'KNOWS');
    await insertEdge(b, c, 'SIBLING_OF');
    await insertEdge(e, f, 'MET_WITH');
    await insertEdge(c, d, 'KNOWS', { bidirectional: true }); // already stamped
    await insertEdge(d, l, 'VISITED', { toType: 'Location' }); // not a symmetric type

    service = new RelationshipNormalizeService(dataSource, noopLogger);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [userId]);
      // Before `destroy()`: the lock is held on a runner from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('reports the rows it changed', async () => {
    await expect(service.normalize(userId)).resolves.toEqual({
      renamed: 8,
      swapped: 4,
      deletedIs: 3,
      bidirectionalStamped: 6,
    });

    // One PARTNER_OF for the pair, and it is the 2019 row.
    expect(await countEdges(`relationship_type = 'PARTNER_OF'`)).toBe(1);
    expect(
      await countEdges(`relationship_type = 'PARTNER_OF' AND is_active AND created_at < '2020-01-01'`),
    ).toBe(1);
    expect(
      await countEdges(
        `relationship_type = 'ROMANTIC_PARTNER' AND NOT is_active
           AND properties->>'normalized_duplicate_of' = 'PARTNER_OF'`,
      ),
    ).toBe(1);
    // RELATED_TO, ROMANTIC_PARTNER and the second PART_OF — and no alias left active.
    expect(await countEdges(`properties ? 'normalized_duplicate_of'`)).toBe(3);
    expect(
      await countEdges(
        `relationship_type IN ('HAPPENED_AT', 'AT_LOCATION', 'RELATED_TO', 'FRIEND', 'COLLEAGUE',
                               'PARTNER', 'ROMANTIC_PARTNER', 'PART_OF')
           AND is_active`,
      ),
    ).toBe(0);
    expect(
      await countEdges(
        `relationship_type = 'COLLEAGUE' AND NOT is_active AND NOT (properties ? 'normalized_duplicate_of')`,
      ),
    ).toBe(1);

    // `swapped` counts the aliases retired, not the canonicals inserted: the
    // one whose canonical already existed is swapped away all the same.
    expect(await countEdges(`relationship_type IN ('CHILD_OF', 'LEARNED_FROM') AND is_active`)).toBe(0);
    expect(await countEdges(`properties ? 'normalized_from'`)).toBe(3);
    expect(await countEdges(`relationship_type = 'IS' AND is_active`)).toBe(0);
    expect(await countEdges(`properties->>'rejected' = 'IS'`)).toBe(3);
    // The six it stamped, and the KNOWS edge that already was.
    expect(await countEdges('is_bidirectional')).toBe(7);
  });

  it('writes nothing when replayed', async () => {
    const before = await latestWrite();

    // The rename passes used to report 1 here, and 2 with the PART_OF twin: they
    // selected aliases whether or not they were active, so each duplicate the
    // first run deactivated was matched, re-deactivated and counted again. The
    // other three used to report 6, 2 and 2.
    await expect(service.normalize(userId)).resolves.toEqual({
      renamed: 0,
      swapped: 0,
      deletedIs: 0,
      bidirectionalStamped: 0,
    });
    expect(await latestWrite()).toBe(before);
  });

  it('folds a duplicate again once a producer re-activates it', async () => {
    // What `createOrUpdateRelationship` does to a re-asserted row: it comes back
    // active with its properties, `normalized_duplicate_of` included, kept. A
    // pass that skipped stamped rows would leave it an alias beside PARTNER_OF.
    await dataSource.query(
      `UPDATE ci.relationships SET is_active = TRUE, updated_at = NOW()
        WHERE owner_user_id = $1 AND relationship_type = 'ROMANTIC_PARTNER'`,
      [userId],
    );
    expect(await countEdges(`relationship_type = 'ROMANTIC_PARTNER' AND is_active`)).toBe(1);

    await expect(service.normalize(userId)).resolves.toEqual({
      renamed: 1,
      swapped: 0,
      deletedIs: 0,
      bidirectionalStamped: 0,
    });
    expect(await countEdges(`relationship_type = 'ROMANTIC_PARTNER' AND is_active`)).toBe(0);
    expect(await countEdges(`relationship_type = 'PARTNER_OF' AND is_active`)).toBe(1);
  });
});
