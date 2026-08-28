import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { EntityMergeBlockEntity } from '../../entities/EntityMergeBlockEntity';
import { ItemEntity } from '../../entities/ItemEntity';
import { EntityMergeBlockService } from '../EntityMergeBlockService';
import { ObjectDuplicateService } from '../ObjectDuplicateService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SLICE FILTER AND THE TRUNCATED MEMBER LIST HAVE TO AGREE. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `findDuplicateGroups` selects groups with `bool_or(object_id = ANY($7))` over
 * the WHOLE group and returns members truncated to `MAX_GROUP_SIZE`. Those are
 * two different sets, and the sibling spec's stubbed `manager.query` cannot see
 * the difference: it hands back member arrays this file would have had to write
 * itself. Only real rows decide which six of eight survive the cut.
 *
 * What breaks when they disagree is not cosmetic. `clean.object_duplicate_detect`
 * asks for the groups ONE SLICE of units is in, turns the returned membership
 * into pairs, and then records every swept unit as examined at the current
 * detector version. A unit that selected a group but was truncated out of it
 * contributes no pair, is filed as "examined, no duplicate", and the ledger
 * does not ask again until a version bump.
 *
 * Opt-in exactly like its neighbours: set `MEMORY_TEST_DATABASE_URL` (or the
 * `DATABASE_*` variables) to a database with the migrations applied. The suite
 * SKIPS legibly when nothing is reachable rather than failing on connect.
 *
 *   DATABASE_PORT=57122 yarn workspace @ci/be-api jest ObjectDuplicateService.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/ObjectDuplicateService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

/** `MAX_GROUP_SIZE` in the service; private there, and the whole point here. */
const MAX_GROUP_SIZE = 6;

describeWithDb(`ObjectDuplicateService — slice filter vs truncation (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: ObjectDuplicateService;

  const ctx = { userId: uuidv7() } as UserServiceContext;

  /**
   * Eight units carrying ONE shared code, two above `MAX_GROUP_SIZE`.
   *
   * Sorted, because `array_agg` orders by the uuid and the truncation keeps the
   * first six: `late` is the id that falls off the end, which is precisely the
   * unit a slice can select a group with and never get back.
   */
  const ids = [...Array(8)].map(() => uuidv7()).sort();
  const late = ids[ids.length - 1];

  const SHARED_CODE = 'B07SHARED9';

  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as LoggerService;

  /** An owned unit plus the CTI base row the detector's join requires. */
  async function insertUnit(objectId: string, index: number): Promise<void> {
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, linked_table, linked_id)
       VALUES ($1::uuid, 'Item', $2, $3::uuid, 'objects', $1::uuid)`,
      [objectId, `Shared-code unit ${index}`, ctx.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.objects (object_id, user_id, owner_user_id, entity_type, identifier_codes)
       VALUES ($1::uuid, $2::uuid, $2::uuid, 'Item', $3::jsonb)`,
      [objectId, ctx.userId, JSON.stringify({ asin: SHARED_CODE })],
    );
  }

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });

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
      entities: [ItemEntity, BaseEntity, EntityMergeBlockEntity],
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/ObjectDuplicateService.integration');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [ctx.userId, 'Object duplicate spec fixture', `objdupe.${ctx.userId}@example.invalid`],
    );

    for (const [index, id] of ids.entries()) {
      await insertUnit(id, index);
    }

    service = new ObjectDuplicateService(
      dataSource.getRepository(ItemEntity),
      new EntityMergeBlockService(dataSource.getRepository(EntityMergeBlockEntity), noopLogger),
      noopLogger,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.objects WHERE user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('returns the requested unit in the group its own id selected, past the truncation', async () => {
    const page = await service.findDuplicateGroups(ctx, { objectIds: [late] });

    expect(page.groups).toHaveLength(1);

    const members = page.groups[0].items.map((item) => item.id);

    // Without slice-aware ordering `late` sorts eighth of eight, so the group
    // qualifies on it and comes back describing six OTHER units.
    expect(members).toContain(late);
    // The bound still bounds: a slice does not buy an unbounded group.
    expect(members).toHaveLength(MAX_GROUP_SIZE);
    expect(page.groups[0].totalItems).toBe(ids.length);
  });

  it('leaves the unfiltered UI read ordered by id, capped, and honest about the total', async () => {
    const page = await service.findDuplicateGroups(ctx, {});

    expect(page.groups).toHaveLength(1);
    expect(page.groups[0].items.map((item) => item.id)).toEqual(ids.slice(0, MAX_GROUP_SIZE));
    expect(page.groups[0].totalItems).toBe(ids.length);
  });
});
