import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import type { EmbeddingGenerationService } from '@ci/common/embeddings';
import { RETRIEVAL_POLICY_DEFAULTS } from '@ci/domains/retrieval-policy';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { SearchService } from '../SearchService';

/**
 * A photo's time is when it was taken, and a photo search is a search of photo content.
 *
 * Seen 2026-11-11: 1,900 photos imported from Google Drive in one evening. Each content row
 * links the media event its EXIF dated (`ci.content.event_id`), but "most recent" sorted rows by
 * `created_at`, the import time, so 2019 shots came back beside 2026 ones. Real rows, because
 * the time rule is a correlated subquery and the media filter a semi-join: a mocked DataSource
 * would accept either however wrong.
 */

const SEARCH_NEXT_DATABASE_ENV = {
  urlEnvVar: 'SEARCH_NEXT_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'SEARCH_NEXT_TEST_PROBE_TIMEOUT_MS',
};

const availability = databaseAvailability(SEARCH_NEXT_DATABASE_ENV);
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[search-next/SearchService.photoTime.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const FIXED_VECTOR = `[${Array(768).fill('0.1').join(',')}]`;

describeWithDatabase(`SearchService photo time and media scope (${availability.target})`, () => {
  let dataSource: DataSource;
  let service: SearchService;

  const userId = randomUUID();
  const context = { userId } as UserServiceContext;

  // Imported in the opposite order to when they were taken: the newer photo has the older row.
  const newPhoto = randomUUID();
  const oldPhoto = randomUUID();
  const undatedPhoto = randomUUID();
  const driveDoc = randomUUID();
  const person = randomUUID();
  const photoFile = randomUUID();
  const photoFileContent = randomUUID();

  const TAKEN_NEW = '2026-04-18T23:20:58Z';
  const TAKEN_OLD = '2019-05-08T03:51:27Z';

  const seedEvent = async (startTime: string): Promise<string> => {
    const eventId = randomUUID();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, linked_table, linked_id)
       VALUES ($1::uuid, 'Event', 'photo', $2::uuid, 'events', $1::uuid)`,
      [eventId, userId],
    );
    await dataSource.query(
      `INSERT INTO ci.events (event_id, entity_type, user_id, start_time, event_type)
       VALUES ($1, 'Event', $2, $3::timestamptz, 'media')`,
      [eventId, userId, startTime],
    );

    return eventId;
  };

  const seedContent = async (
    id: string,
    options: { type: string; createdAt: string; eventId?: string; fileId?: string },
  ) => {
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, linked_table, linked_id)
       VALUES ($1::uuid, 'Content', 'content', $2::uuid, 'content', $1::uuid)`,
      [id, userId],
    );
    await dataSource.query(
      `INSERT INTO ci.content (id, entity_type, user_id, type, event_id, external_id, external_id_kind, created_at)
       VALUES ($1, 'Content', $2, $3, $4, $5, $6, $7::timestamptz)`,
      [
        id,
        userId,
        options.type,
        options.eventId ?? null,
        options.fileId ?? null,
        options.fileId ? 'file' : null,
        options.createdAt,
      ],
    );
  };

  const seedIndex = async (entityType: string, entityId: string, text: string) => {
    await dataSource.query(
      `INSERT INTO ci_search.vectors (id, entity_type, entity_id, vector, user_id)
       VALUES ($1, $2, $3, setweight(to_tsvector('english', $4), 'A'), $5)`,
      [randomUUID(), entityType, entityId, text, userId],
    );
    await dataSource.query(
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, embedding, user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), entityType, entityId, FIXED_VECTOR, userId],
    );
  };

  beforeAll(async () => {
    const connection = resolveConnection(SEARCH_NEXT_DATABASE_ENV);

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

    service = new SearchService(
      dataSource,
      {
        generateEmbeddingString: jest.fn().mockResolvedValue(FIXED_VECTOR),
      } as unknown as EmbeddingGenerationService,
      { get: jest.fn().mockResolvedValue(RETRIEVAL_POLICY_DEFAULTS) } as never,
      { send: jest.fn().mockResolvedValue([]) } as never,
    );

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [userId, 'Photo time fixture', `phototime.${userId}@example.invalid`],
    );

    await seedContent(newPhoto, {
      type: 'media',
      createdAt: '2026-10-29T22:40:00Z',
      eventId: await seedEvent(TAKEN_NEW),
    });
    await seedContent(oldPhoto, {
      type: 'media',
      createdAt: '2026-10-29T22:50:00Z',
      eventId: await seedEvent(TAKEN_OLD),
    });
    // Imported last of all, so under the import-time rule it was the "most recent" photo.
    await seedContent(undatedPhoto, { type: 'media', createdAt: '2026-10-29T23:00:00Z' });
    await seedContent(driveDoc, { type: 'google_drive_document', createdAt: '2026-10-29T22:45:00Z' });

    await dataSource.query(
      `INSERT INTO ci.files (id, filename, content_type, user_id, created_at)
       VALUES ($1, 'IMG_0644.jpg', 'image/jpeg', $2, '2026-10-29T22:55:00Z'::timestamptz)`,
      [photoFile, userId],
    );
    await seedContent(photoFileContent, {
      type: 'media',
      createdAt: '2026-10-29T22:55:00Z',
      eventId: await seedEvent('2024-07-04T18:00:00Z'),
      fileId: photoFile,
    });

    await seedIndex('content', newPhoto, 'big cat behind a fence');
    await seedIndex('content', oldPhoto, 'two cats on a patio');
    await seedIndex('content', undatedPhoto, 'cat screenshot');
    await seedIndex('content', driveDoc, 'notes about the cat sitter');
    await seedIndex('person', person, 'cat lady from next door');
    await seedIndex('file', photoFile, 'cat on a step');
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci_search.vectors WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci_search.embeddings WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.content WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.files WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [userId]);
      await dataSource.destroy();
    }
  });

  const ids = (items: { id: string }[]) => items.map((item) => item.id);

  describe('mediaContentOnly', () => {
    it('keeps photo content, drops other content, and leaves other types alone (keyword)', async () => {
      const page = await service.searchPage(context, {
        query: 'cat',
        mode: 'keyword',
        excludeTypes: ['message', 'position'],
        mediaContentOnly: true,
      });

      expect(ids(page.items)).toEqual(
        expect.arrayContaining([newPhoto, oldPhoto, undatedPhoto, person, photoFile]),
      );
      expect(ids(page.items)).not.toContain(driveDoc);
      expect(page.totalMatches).toBe(page.items.length);
    });

    it('filters the semantic path the same way', async () => {
      const page = await service.searchPage(context, {
        query: 'cat',
        mode: 'semantic',
        includeTypes: ['content'],
        mediaContentOnly: true,
      });

      // Every embedding is the same vector, so only the type and media filters decide the page.
      expect(ids(page.items).sort()).toEqual([newPhoto, oldPhoto, undatedPhoto].sort());
      expect(ids(page.items)).not.toContain(driveDoc);
    });

    it('counts what the page would return', async () => {
      await expect(
        service.count(context, { query: 'cat', includeTypes: ['content'], mediaContentOnly: true }),
      ).resolves.toBe(3);
      await expect(service.count(context, { query: 'cat', includeTypes: ['content'] })).resolves.toBe(4);
      await expect(
        service.count(context, { includeTypes: ['content'], mediaContentOnly: true }),
      ).resolves.toBe(3);
    });
  });

  describe('sort: recent', () => {
    it('orders photos by when they were taken, not imported, with an undated one last', async () => {
      const page = await service.searchPage(context, {
        query: 'cat',
        mode: 'keyword',
        includeTypes: ['content'],
        mediaContentOnly: true,
        sort: 'recent',
      });

      expect(ids(page.items)).toEqual([newPhoto, oldPhoto, undatedPhoto]);
    });

    it('keeps the import time of content that is not a photo', async () => {
      const page = await service.searchPage(context, {
        query: 'sitter',
        mode: 'keyword',
        includeTypes: ['content'],
        since: new Date('2026-10-29T00:00:00Z'),
      });

      expect(ids(page.items)).toEqual([driveDoc]);
    });

    it('dates a photo file through its content row', async () => {
      const page = await service.searchPage(context, {
        query: 'step',
        mode: 'keyword',
        includeTypes: ['file'],
        until: new Date('2025-01-01T00:00:00Z'),
      });

      // Imported 2026-10-29, taken 2024-07-04: only the taken date is inside the window.
      expect(ids(page.items)).toEqual([photoFile]);
    });
  });

  describe('a since / until window', () => {
    it('reads a photo by when it was taken and leaves an undated one out', async () => {
      const page = await service.searchPage(context, {
        query: 'cat',
        mode: 'keyword',
        includeTypes: ['content'],
        mediaContentOnly: true,
        since: new Date('2026-01-01T00:00:00Z'),
      });

      expect(ids(page.items)).toEqual([newPhoto]);
    });
  });
});
