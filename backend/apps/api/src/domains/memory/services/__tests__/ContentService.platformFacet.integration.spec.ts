import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { EventService as SignallingEventService } from '@ci/domains/events';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { ContentBaseEntity } from '../../entities/ContentBaseEntity';
import { ContentEntity } from '../../entities/ContentEntity';
import { EventBaseEntity } from '../../entities/EventBaseEntity';
import { EventEntity } from '../../entities/EventEntity';
import { ContentService } from '../ContentService';
import type { GraphDeltaWriter } from '../GraphDeltaWriter';

/**
 * The content library's How facet reads the delivering PLATFORM, not the raw
 * `source_system` column.
 *
 * A federated row (a photo keyed on its bytes) says `file` in the column
 * whichever importer delivered it; the platform is in `ci.record_sources`.
 * Before this, every Google Photos, WhatsApp and folder photo was one `file`
 * option (19,135 + 172 + 1,713 rows, measured live 2026-09-21). These tests
 * pin the two halves against Postgres, because both are SQL: the facet list
 * offers the ledger platform, and the filter selects by the same value —
 * exclusively, so "file" no longer sweeps in rows a platform has claimed.
 *
 * Opt-in like its sibling: needs `MEMORY_TEST_DATABASE_URL` or the discrete
 * `DATABASE_*` variables pointing at a migrated database.
 */
const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/ContentService.platformFacet.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`ContentService How facet reads the provenance ledger (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let contentService: ContentService;

  const ownerCtx: UserServiceContext = { userId: uuidv7() } as UserServiceContext;
  const strangerId = uuidv7();
  const googlePhotoId = uuidv7();
  const folderPhotoId = uuidv7();
  const spotifyPlayId = uuidv7();
  const strangerPhotoId = uuidv7();

  const send = jest.fn<Promise<string[]>, [unknown, unknown]>(async () => []);
  const signalling = { send } as unknown as SignallingEventService;

  async function seedContent(args: {
    contentId: string;
    ownerId: string;
    name: string;
    sourceSystem: string;
    sourceId: string;
  }): Promise<void> {
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Content', $2, '{}'::jsonb, $3, 'content', $1)`,
      [args.contentId, args.name, args.ownerId],
    );
    await dataSource.query(
      `INSERT INTO ci.content (id, type, mimetype, user_id, source_type, source_system, source_id)
       VALUES ($1, 'media', 'image/jpeg', $2, 'ci-import-tools', $3, $4)`,
      [args.contentId, args.ownerId, args.sourceSystem, args.sourceId],
    );
  }

  async function seedLedger(args: {
    contentId: string;
    ownerId: string;
    sourceSystem: string;
    sourceId: string;
    platform: string | null;
  }): Promise<void> {
    await dataSource.query(
      `INSERT INTO ci.record_sources (user_id, record_table, record_id, source_type, source_system, source_id, platform)
       VALUES ($1, 'content', $2, 'ci-import-tools', $3, $4, $5)`,
      [args.ownerId, args.contentId, args.sourceSystem, args.sourceId, args.platform],
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
      entities: [BaseEntity, UserEntity, ContentBaseEntity, ContentEntity, EventBaseEntity, EventEntity],
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/ContentService.platformFacet.integration');

    for (const [id, name] of [
      [ownerCtx.userId, 'Owner'],
      [strangerId, 'Stranger'],
    ] as const) {
      await dataSource.query(
        `INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [id, `${name} platform-facet fixture`, `${name.toLowerCase()}.${id}@example.invalid`],
      );
    }

    // A Takeout photo: `file` in the column, `google_photos` in the ledger.
    await seedContent({
      contentId: googlePhotoId,
      ownerId: ownerCtx.userId,
      name: 'Squirrel on the fence',
      sourceSystem: 'file',
      sourceId: 'sha256:aaaa',
    });
    await seedLedger({
      contentId: googlePhotoId,
      ownerId: ownerCtx.userId,
      sourceSystem: 'file',
      sourceId: 'sha256:aaaa',
      platform: 'google_photos',
    });

    // A folder photo nobody claimed: `file` with no ledger row at all.
    await seedContent({
      contentId: folderPhotoId,
      ownerId: ownerCtx.userId,
      name: 'Unclaimed photo',
      sourceSystem: 'file',
      sourceId: 'sha256:bbbb',
    });

    // A platform-keyed row whose ledger entry carries no platform: falls back
    // to the column, which for a platform-keyed row IS the platform.
    await seedContent({
      contentId: spotifyPlayId,
      ownerId: ownerCtx.userId,
      name: 'A track',
      sourceSystem: 'spotify',
      sourceId: 'spotify:track:1',
    });
    await seedLedger({
      contentId: spotifyPlayId,
      ownerId: ownerCtx.userId,
      sourceSystem: 'spotify',
      sourceId: 'spotify:track:1',
      platform: null,
    });

    // Another user's Google photo: must not leak into the owner's facets.
    await seedContent({
      contentId: strangerPhotoId,
      ownerId: strangerId,
      name: 'Not yours',
      sourceSystem: 'file',
      sourceId: 'sha256:cccc',
    });
    await seedLedger({
      contentId: strangerPhotoId,
      ownerId: strangerId,
      sourceSystem: 'file',
      sourceId: 'sha256:cccc',
      platform: 'apple_photos',
    });

    contentService = new ContentService(
      dataSource.getRepository(ContentEntity),
      dataSource.getRepository(ContentBaseEntity),
      dataSource.getRepository(EventEntity),
      signalling,
      {
        entityCreated: async () => undefined,
        entityUpdated: async () => undefined,
      } as unknown as GraphDeltaWriter,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      const users = [ownerCtx.userId, strangerId];
      await dataSource.query('DELETE FROM ci.record_sources WHERE user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [users]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('offers the ledger platform where one was recorded, else the column', async () => {
    const facets = await contentService.getFacets(ownerCtx);

    expect(facets.sourceSystems).toEqual(['file', 'google_photos', 'spotify']);
    expect(facets.sourceSystems).not.toContain('apple_photos');
  });

  it('filters by ledger platform', async () => {
    const page = await contentService.findPage(ownerCtx, { first: 10 }, { sourceSystems: ['google_photos'] });

    expect(page.entities.map((c) => c.id)).toEqual([googlePhotoId]);
    expect(page.totalCount).toBe(1);
  });

  it('keeps "file" for rows no platform claimed, and only those', async () => {
    const page = await contentService.findPage(ownerCtx, { first: 10 }, { sourceSystems: ['file'] });

    expect(page.entities.map((c) => c.id)).toEqual([folderPhotoId]);
  });

  it('falls back to the column when the ledger entry has no platform', async () => {
    const page = await contentService.findPage(ownerCtx, { first: 10 }, { sourceSystems: ['spotify'] });

    expect(page.entities.map((c) => c.id)).toEqual([spotifyPlayId]);
  });

  it('accepts several platforms at once', async () => {
    const page = await contentService.findPage(
      ownerCtx,
      { first: 10 },
      { sourceSystems: ['google_photos', 'file'] },
    );

    expect(page.entities.map((c) => c.id).sort()).toEqual([googlePhotoId, folderPhotoId].sort());
    expect(page.totalCount).toBe(2);
  });
});
