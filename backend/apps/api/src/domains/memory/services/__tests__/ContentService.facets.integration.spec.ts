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
 * The content library's facets, read along the indexes of
 * 20260922180450_add_content_facet_indexes (contentFacetsSql.ts).
 *
 * What the pickers must and must not offer:
 *
 *  - every distinct type / mimetype / platform the owner's rows carry, sorted;
 *  - NOT a value that exists only on media of a soft-deleted event — the
 *    library hides that media, so offering its value would filter to nothing;
 *  - a value that a deleted event's media carries AND a live row carries, since
 *    the live row is what the filter would show;
 *  - the row's own `source_system` for a row the ledger never saw, and for a
 *    row whose ledger rows all carry a NULL platform (the sibling spec,
 *    ContentService.platformFacet, pins the ledger-vs-column rule itself).
 *
 * The unledgered arm is remembered per user for a few minutes; the last case
 * pins that, and the way to drop it.
 *
 * Opt-in like its siblings: needs `MEMORY_TEST_DATABASE_URL` or the discrete
 * `DATABASE_*` variables pointing at a migrated database.
 */
const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/ContentService.facets.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`ContentService.getFacets reads along indexes (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let contentService: ContentService;

  const ownerCtx: UserServiceContext = { userId: uuidv7() } as UserServiceContext;
  const liveEventId = uuidv7();
  const deadEventId = uuidv7();
  let liveVideoId = '';

  const send = jest.fn<Promise<string[]>, [unknown, unknown]>(async () => []);
  const signalling = { send } as unknown as SignallingEventService;

  async function seedContent(args: {
    type: string;
    mimetype: string | null;
    sourceSystem: string;
    eventId?: string | null;
    /** `undefined`: no ledger row at all. `null`: a ledger row with no platform. */
    platform?: string | null;
  }): Promise<string> {
    const id = uuidv7();
    const sourceId = `facets-spec-${id}`;

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Content', $2, '{}'::jsonb, $3, 'content', $1)`,
      [id, `facets fixture ${args.type}`, ownerCtx.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.content (id, type, mimetype, user_id, source_type, source_system, source_id, event_id)
       VALUES ($1, $2, $3, $4, 'ci-import-tools', $5, $6, $7)`,
      [id, args.type, args.mimetype, ownerCtx.userId, args.sourceSystem, sourceId, args.eventId ?? null],
    );

    if (args.platform !== undefined) {
      await dataSource.query(
        `INSERT INTO ci.record_sources (user_id, record_table, record_id, source_type, source_system, source_id, platform)
         VALUES ($1, 'content', $2, 'ci-import-tools', $3, $4, $5)`,
        [ownerCtx.userId, id, args.sourceSystem, sourceId, args.platform],
      );
    }

    return id;
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
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/ContentService.facets.integration');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [ownerCtx.userId, 'facets fixture owner', `facets.${ownerCtx.userId}@example.invalid`],
    );

    for (const [eventId, isDeleted] of [
      [liveEventId, false],
      [deadEventId, true],
    ] as const) {
      // CTI: an event is a ci.entities base row plus its detail row.
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
         VALUES ($1, 'Event', $2, '{}'::jsonb, $3, 'events', $1)`,
        [eventId, isDeleted ? 'facets fixture deleted event' : 'facets fixture live event', ownerCtx.userId],
      );
      await dataSource.query(
        `INSERT INTO ci.events (event_id, user_id, start_time, category, is_deleted, source_type, source_system, source_id)
         VALUES ($1, $2, now(), 'capture', $3, 'ci-import-tools', 'facets_spec', $4)`,
        [eventId, ownerCtx.userId, isDeleted, `facets-spec-${eventId}`],
      );
    }

    // A live photo: its type, mimetype and platform are all offered.
    await seedContent({
      type: 'media',
      mimetype: 'image/jpeg',
      sourceSystem: 'file',
      eventId: liveEventId,
      platform: 'google_photos',
    });
    // A video on the deleted event: `media` and `google_photos` survive via the
    // photo above; `video/mp4` exists nowhere else and must go.
    await seedContent({
      type: 'media',
      mimetype: 'video/mp4',
      sourceSystem: 'file',
      eventId: deadEventId,
      platform: 'google_photos',
    });
    // A document only the deleted event carries: nothing of it is offered.
    await seedContent({
      type: 'ghost',
      mimetype: 'application/pdf',
      sourceSystem: 'dropbox',
      eventId: deadEventId,
      platform: 'dropbox',
    });
    // A note the ledger never saw: its own column is its platform.
    await seedContent({ type: 'note', mimetype: 'text/plain', sourceSystem: 'file' });
    // A like whose ledger row names no platform, and no mimetype at all.
    await seedContent({ type: 'like', mimetype: null, sourceSystem: 'spotify', platform: null });
    // A watch record: `media` with a mimetype no kind claims — offered as bare `media`.
    await seedContent({
      type: 'media',
      mimetype: 'application/json',
      sourceSystem: 'netflix',
      platform: 'netflix',
    });
    // A Reddit GIF typed `video` outright: folds into the `video` option with the video files.
    await seedContent({ type: 'video', mimetype: null, sourceSystem: 'reddit', platform: 'reddit' });
    // A live video file, so `video` is offered despite the one on the deleted event.
    liveVideoId = await seedContent({
      type: 'media',
      mimetype: 'video/mp4',
      sourceSystem: 'file',
      eventId: liveEventId,
      platform: 'google_photos',
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
      const users = [ownerCtx.userId];
      await dataSource.query('DELETE FROM ci.record_sources WHERE user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.content WHERE user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.events WHERE user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [users]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('offers every value a live row carries, sorted, and nothing found only on deleted-event media', async () => {
    const facets = await contentService.getFacets(ownerCtx);

    // `media` rows are offered by kind: image and video (a live one exists) but no
    // audio; the watch record is the bare `media`; `ghost` and `application/pdf`
    // live only on the deleted event.
    expect(facets.types).toEqual(['image', 'like', 'media', 'note', 'video']);
    expect(facets.mimetypes).toEqual(['application/json', 'image/jpeg', 'text/plain', 'video/mp4']);
    expect(facets.sourceSystems).toEqual(['file', 'google_photos', 'netflix', 'reddit', 'spotify']);
  });

  it('selects by kind: "video" is the video files and the row typed video, "media" is what no kind claims', async () => {
    const videos = await contentService.findPage(ownerCtx, { first: 10 }, { types: ['video'] });
    const videoRows = videos.entities.map((row) => `${row.type}:${row.mimetype ?? ''}`).sort();

    expect(videoRows).toEqual(['media:video/mp4', 'video:']);
    expect(videos.entities.map((row) => row.id)).toContain(liveVideoId);

    const bare = await contentService.findPage(ownerCtx, { first: 10 }, { types: ['media'] });

    expect(bare.entities.map((row) => `${row.type}:${row.mimetype ?? ''}`)).toEqual([
      'media:application/json',
    ]);

    const images = await contentService.findPage(ownerCtx, { first: 10 }, { types: ['image', 'note'] });

    expect(images.entities.map((row) => `${row.type}:${row.mimetype ?? ''}`).sort()).toEqual([
      'media:image/jpeg',
      'note:text/plain',
    ]);
  });

  it('remembers the unledgered arm per user until it is forgotten', async () => {
    await contentService.getFacets(ownerCtx);
    await seedContent({ type: 'note', mimetype: 'text/plain', sourceSystem: 'dropzone' });

    // Indexed arms see the new row at once; the remembered anti-join does not.
    const stale = await contentService.getFacets(ownerCtx);
    expect(stale.sourceSystems).not.toContain('dropzone');

    contentService.forgetUnledgeredSourceSystems(ownerCtx.userId);

    const fresh = await contentService.getFacets(ownerCtx);
    expect(fresh.sourceSystems).toEqual([
      'dropzone',
      'file',
      'google_photos',
      'netflix',
      'reddit',
      'spotify',
    ]);
  });
});
