import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { BrowserActivityEntity } from '@ci/domains/browser-activity';
import { ContentEntity } from '@ci/domains/memory';
import { UserEntity } from '@ci/domains/user';

import { syntheticTestUserEmail } from '../../../domains/__tests__/support/applianceUser';
import {
  databaseAvailability,
  resolveConnection,
} from '../../../domains/__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../domains/__tests__/support/schemaLock';
import { EventEntity } from '../../../domains/memory/entities/EventEntity';
import { bulkInsertIdempotent } from '../bulkUpsert';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `inserted`, AGAINST A REAL RETURNING CLAUSE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The unit tests could not have caught the bug this guards, and it is worth
 * being precise about why.
 *
 * The helper built its RETURNING clause with `.returning([databaseName])`.
 * TypeORM's ARRAY form takes PROPERTY names and silently discards anything it
 * cannot resolve, falling back to its own default set — so for every entity
 * whose column differs from its property the primary key was simply absent from
 * the returned rows, `insertedPks` stayed empty, and NOTHING was ever reported
 * as inserted. `ci.events` keys on `event_id` and `ci.objects` on `object_id`;
 * `ci.content` keys on `id`, where property and column coincide, so it worked
 * and hid the rest.
 *
 * The fake repository in bulkUpsert.test.ts declares `primaryColumns:
 * [{ databaseName: 'id' }]` and implements `returning` as `() => iqb` — it
 * ignores the argument entirely. Every entity in that suite is the case that
 * happened to work, and the one call that mattered was a no-op. Only a real
 * driver disagrees.
 *
 * So these two cases are deliberately paired: an entity whose pk column differs
 * from its property, and one where they match.
 */

const ENV = {
  urlEnvVar: 'IMPORT_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'IMPORT_TEST_PROBE_TIMEOUT_MS',
};

const availability = databaseAvailability(ENV);
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[persistence/bulkUpsert.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`bulkInsertIdempotent against real Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  const userId = randomUUID();

  beforeAll(async () => {
    const connection = resolveConnection(ENV);

    if (connection == null) {
      throw new Error('availability said yes but no connection resolved');
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
      entities: [EventEntity, ContentEntity, BrowserActivityEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });

    await dataSource.initialize();

    // SHARED: this suite commits real `ci.users` / `ci.events` / `ci.content`
    // rows, which is the DML half of the deadlock documented in
    // `domains/__tests__/support/schemaLock.ts`.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'bulkUpsert.integration');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email) VALUES ($1::uuid, 'bulkUpsert spec', $2)
       ON CONFLICT (id) DO NOTHING`,
      // The email is the marker that keeps other suites off this row while it
      // exists — see `domains/__tests__/support/applianceUser.ts`.
      [userId, syntheticTestUserEmail('bulk-upsert', userId)],
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // Independent steps, first error rethrown at the end: a failure in the
      // events or content delete must not skip the user delete, because a
      // leaked `ci.users` row is durable, invisible, and exactly what the specs
      // that pick a user out of `ci.users` can latch onto. Same reasoning, and
      // the same shape, as the import staging harness's teardown.
      //
      // Order is the foreign keys': the CTI detail rows reference their base in
      // ci.entities, and the base references the user.
      const failures: unknown[] = [];

      for (const [sql, params] of [
        [`DELETE FROM ci.browser_activity WHERE user_id = $1::uuid`, [userId]],
        [`DELETE FROM ci.events WHERE user_id = $1::uuid`, [userId]],
        [`DELETE FROM ci.content WHERE user_id = $1::uuid`, [userId]],
        [`DELETE FROM ci.entities WHERE owner_user_id = $1::uuid`, [userId]],
        [`DELETE FROM ci.users WHERE id = $1::uuid`, [userId]],
      ] as Array<[string, unknown[]]>) {
        try {
          await dataSource.query(sql, params);
        } catch (err: unknown) {
          failures.push(err);
        }
      }

      await schemaLock?.release();
      await dataSource.destroy();

      if (failures.length > 0) {
        throw failures[0];
      }
    }
  });

  /**
   * The CTI base row every detail row now hangs off.
   *
   * `ci.events` and `ci.content` became detail tables of `ci.entities`, and
   * their composite foreign keys are DEFERRABLE INITIALLY DEFERRED — which is
   * how `CalendarEventService` gets away with inserting the detail rows first and the
   * bases afterwards inside ONE transaction. This suite calls
   * `bulkInsertIdempotent` directly, so each statement is its own implicit
   * transaction and the deferred check fires at the end of it. Seeding the base
   * first is the honest equivalent, and it keeps the subject of these tests the
   * `inserted` flag rather than the aggregate write path.
   */
  async function seedBase(id: string, entityType: 'Event' | 'Content'): Promise<string> {
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name)
            VALUES ($1::uuid, $2, $3::uuid, 'bulk upsert spec')
       ON CONFLICT (entity_id) DO NOTHING`,
      [id, entityType, userId],
    );

    return id;
  }

  /** The provenance triple both tables dedupe on. */
  function triple(entity: {
    sourceType?: string | null;
    sourceSystem?: string | null;
    sourceId?: string | null;
  }) {
    return {
      sourceType: entity.sourceType,
      sourceSystem: entity.sourceSystem,
      sourceId: entity.sourceId,
    };
  }

  async function insertEvent(sourceId: string) {
    const repository = dataSource.getRepository(EventEntity);
    const id = await seedBase(randomUUID(), 'Event');

    return bulkInsertIdempotent({
      repository,
      entities: [
        repository.create({
          id,
          userId,
          eventType: 'spec',
          startTime: new Date(),
          sourceType: 'spec',
          sourceSystem: 'spec',
          sourceId,
        }),
      ],
      primaryKey: 'id',
      getTriple: triple,
      scope: { userId },
      conflictTarget: '(user_id, source_system, source_id) WHERE source_id IS NOT NULL',
      identityColumns: ['source_system', 'source_id'],
      conflictUpdateColumns: [],
    });
  }

  async function insertContent(sourceId: string) {
    const repository = dataSource.getRepository(ContentEntity);
    const id = await seedBase(randomUUID(), 'Content');

    return bulkInsertIdempotent({
      repository,
      entities: [
        repository.create({
          id,
          userId,
          type: 'spec',
          sourceType: 'spec',
          sourceSystem: 'spec',
          sourceId,
        }),
      ],
      primaryKey: 'id',
      getTriple: triple,
      scope: { userId },
      conflictTarget: '(user_id, source_system, source_id) WHERE source_id IS NOT NULL',
      identityColumns: ['source_system', 'source_id'],
      conflictUpdateColumns: [],
    });
  }

  it('reports inserted for an entity whose pk COLUMN differs from its property', async () => {
    // ci.events: property `id`, column `event_id`. This returned false on a
    // genuine first write, which made the importer report zero events written
    // on a run that wrote 7,656 of them.
    const sourceId = `spec-${randomUUID()}`;

    expect((await insertEvent(sourceId))[0].inserted).toBe(true);
  });

  it('reports NOT inserted when that same row is written again', async () => {
    const sourceId = `spec-${randomUUID()}`;

    await insertEvent(sourceId);

    expect((await insertEvent(sourceId))[0].inserted).toBe(false);
  });

  it('still reports correctly for an entity whose pk column and property match', async () => {
    // ci.content: property and column are both `id` — the case that worked, kept
    // as the control so a fix for one cannot silently break the other.
    const sourceId = `spec-${randomUUID()}`;

    expect((await insertContent(sourceId))[0].inserted).toBe(true);
    expect((await insertContent(sourceId))[0].inserted).toBe(false);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE CONFLICT ACTION, AGAINST REAL POSTGRES.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * conflictUpdateSetClause emits a CASE per column that only Postgres can
   * evaluate — EXCLUDED, jsonb `||`, the target-table reference inside
   * ON CONFLICT DO UPDATE. The unit fake mimics the policy; this proves it.
   * ci.browser_activity is the subject because it is the table where the
   * policy was measured to matter (a Brave history delivered by both the
   * History-file importer and the browser extension) and it has one column of
   * each merge kind: nullable scalars, NOT NULL flags, an object jsonb bag.
   */
  describe('same producer refreshes, another producer fills gaps', () => {
    const REFRESH = [
      'action_type',
      'properties',
      'duration_seconds',
      'scroll_depth_percent',
      'is_incognito',
      'contains_sensitive',
    ];
    const KINDS = { properties: 'json', is_incognito: 'flag', contains_sensitive: 'flag' } as const;

    async function writeVisit(
      sourceId: string,
      sourceType: 'ci-import-tools' | 'capture',
      fields: Partial<BrowserActivityEntity>,
    ) {
      const repository = dataSource.getRepository(BrowserActivityEntity);

      return bulkInsertIdempotent({
        repository,
        entities: [
          repository.create({
            id: randomUUID(),
            user_id: userId,
            time: new Date('2026-06-10T12:00:00.123Z'),
            url: 'https://example.com/',
            action_type: 'visit',
            properties: {},
            source_type: sourceType,
            source_system: 'chromium',
            source_id: sourceId,
            ...fields,
          }),
        ],
        primaryKey: 'id',
        getTriple: (e) => ({
          sourceType: e.source_type,
          sourceSystem: e.source_system,
          sourceId: e.source_id,
        }),
        scope: { user_id: userId },
        conflictTarget: '(user_id, source_system, source_id) WHERE source_id IS NOT NULL',
        identityColumns: ['source_system', 'source_id'],
        conflictUpdateColumns: REFRESH,
        conflictMergeKinds: KINDS,
      });
    }

    async function readVisit(sourceId: string) {
      const [row] = await dataSource.query<
        Array<{
          duration_seconds: number | null;
          scroll_depth_percent: number | null;
          properties: Record<string, unknown>;
          is_incognito: boolean;
          contains_sensitive: boolean;
          source_type: string;
        }>
      >(
        `SELECT duration_seconds, scroll_depth_percent, properties, is_incognito, contains_sensitive, source_type
           FROM ci.browser_activity WHERE user_id = $1::uuid AND source_id = $2`,
        [userId, sourceId],
      );

      return row;
    }

    it('another producer keeps the existing values, fills the nulls, merges the bag and ORs the flags', async () => {
      const sourceId = `visit:${randomUUID()}`;

      // The History file first: Chrome's own dwell time, the importer's bag.
      await writeVisit(sourceId, 'ci-import-tools', {
        duration_seconds: 12,
        properties: { Title: 'Example', Source: 'Chromium' },
      });
      // Then the extension: its 30-second default dwell, a measured scroll
      // depth, its own bag (one shared key, one new), and it KNOWS incognito.
      const [second] = await writeVisit(sourceId, 'capture', {
        duration_seconds: 30,
        scroll_depth_percent: 80,
        properties: { Title: 'Example (tab title)', observed_at: '2026-06-10T12:00:05Z' },
        is_incognito: true,
      });

      expect(second.inserted).toBe(false);
      const row = await readVisit(sourceId);
      expect(row.duration_seconds).toBe(12); // first writer's value stands
      expect(row.scroll_depth_percent).toBe(80); // gap filled
      expect(row.properties).toEqual({
        Title: 'Example', // shared key: existing wins
        Source: 'Chromium',
        observed_at: '2026-06-10T12:00:05Z', // new key merged in
      });
      expect(row.is_incognito).toBe(true); // OR across producers
      expect(row.contains_sensitive).toBe(false);
      expect(row.source_type).toBe('ci-import-tools'); // provenance columns never refreshed
    });

    it('the same producer refreshes its values but never nulls what another producer filled', async () => {
      const sourceId = `visit:${randomUUID()}`;

      await writeVisit(sourceId, 'ci-import-tools', {
        duration_seconds: 0,
        properties: { Title: 'Example' },
      });
      await writeVisit(sourceId, 'capture', { scroll_depth_percent: 80, properties: { observed_at: 'x' } });
      // The History file copied again after the tab closed: real dwell now,
      // still no scroll depth (the importer never has one).
      await writeVisit(sourceId, 'ci-import-tools', {
        duration_seconds: 45,
        scroll_depth_percent: null as unknown as undefined,
        properties: { Title: 'Example, retitled' },
      });

      const row = await readVisit(sourceId);
      expect(row.duration_seconds).toBe(45); // refreshed
      expect(row.scroll_depth_percent).toBe(80); // the extension's fill-in survives
      expect(row.properties).toEqual({ Title: 'Example, retitled', observed_at: 'x' }); // own key refreshed, other kept
    });

    it('a flag set by the same producer can be cleared by it, but not by another producer', async () => {
      const sourceId = `visit:${randomUUID()}`;

      await writeVisit(sourceId, 'capture', { is_incognito: true });
      await writeVisit(sourceId, 'ci-import-tools', { is_incognito: false });
      expect((await readVisit(sourceId)).is_incognito).toBe(true); // OR: the importer cannot unsay it

      await writeVisit(sourceId, 'capture', { is_incognito: false });
      expect((await readVisit(sourceId)).is_incognito).toBe(false); // same producer: its new word stands
    });

    it('writes one row however many producers deliver the visit', async () => {
      const sourceId = `visit:${randomUUID()}`;

      await writeVisit(sourceId, 'capture', {});
      await writeVisit(sourceId, 'ci-import-tools', {});
      await writeVisit(sourceId, 'capture', {});

      const [{ count }] = await dataSource.query<Array<{ count: string }>>(
        `SELECT count(*) AS count FROM ci.browser_activity WHERE user_id = $1::uuid AND source_id = $2`,
        [userId, sourceId],
      );
      expect(Number(count)).toBe(1);
    });
  });

  it('writes exactly one row for a repeated triple', async () => {
    // The flag must describe what the table actually holds.
    const sourceId = `spec-${randomUUID()}`;

    await insertEvent(sourceId);
    await insertEvent(sourceId);

    const [{ count }] = await dataSource.query<Array<{ count: string }>>(
      `SELECT count(*) AS count FROM ci.events WHERE user_id = $1::uuid AND source_id = $2`,
      [userId, sourceId],
    );

    expect(Number(count)).toBe(1);
  });
});
