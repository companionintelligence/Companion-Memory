import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { syntheticTestUserEmail } from '../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock } from '../../__tests__/support/schemaLock';
import { FileEntity } from '../entities/FileEntity';
import { FileService } from '../services/FileService';

/**
 * FileService's `excludeEventLinked` against real Postgres.
 *
 * The timed browse passes it when events share the page, so a photo an event
 * already shows at its taken date is not listed a second time at its row write
 * time. The link from content to file is `content.external_id` holding the file
 * id as text — a join a mocked repository would accept whatever it said.
 */

const describeWithDatabase = databaseAvailability().available ? describe : describe.skip;

if (!databaseAvailability().available) {
  console.warn(
    `[files/FileService.excludeEventLinked.integration] SKIPPED — ${databaseAvailability().reason}`,
  );
}

jest.setTimeout(60_000);

describeWithDatabase('FileService excludeEventLinked (real database)', () => {
  let dataSource: DataSource;
  let service: FileService;
  let schemaLock: { release: () => Promise<void> };

  const userId = randomUUID();
  const eventId = randomUUID();

  const files = {
    /** No event anywhere: stays. */
    undated: randomUUID(),
    /** Wrapped by a content row linked to an event: dropped. */
    viaContent: randomUUID(),
    /** Wrapped by a content row from before the kind column (NULL kind): dropped. */
    viaLegacyContent: randomUUID(),
    /** Stamped with an event directly: dropped. */
    direct: randomUUID(),
    /** Wrapped by content that is NOT event-linked: stays. */
    contentNoEvent: randomUUID(),
    /** Content holds its id but is marked a URI, never a file: stays. */
    uriLookalike: randomUUID(),
  };

  beforeAll(async () => {
    const connection = resolveConnection();

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
      entities: [FileEntity],
      synchronize: false,
    });

    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'file event-linked spec');

    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    service = new FileService(
      dataSource.getRepository(FileEntity),
      { send: jest.fn() } as never,
      logger as never,
    );

    await dataSource.query(`INSERT INTO ci.users (id, name, email) VALUES ($1::uuid, $2, $3)`, [
      userId,
      'file-event-linked',
      syntheticTestUserEmail('file-event-linked', userId),
    ]);
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, linked_table, linked_id)
       VALUES ($1::uuid, 'Event', $2::uuid, 'photo', 'events', $1::uuid)`,
      [eventId, userId],
    );
    await dataSource.query(
      `INSERT INTO ci.events (event_id, user_id, event_type, start_time)
       VALUES ($1::uuid, $2::uuid, 'media', '2026-04-13T16:16:12Z')`,
      [eventId, userId],
    );

    for (const id of Object.values(files)) {
      await dataSource.query(
        `INSERT INTO ci.files (id, content_type, variant, user_id, filename, event_id)
         VALUES ($1::uuid, 'image/jpeg', 'ORIGINAL', $2::uuid, $3, $4::uuid)`,
        [id, userId, `${id}.jpg`, id === files.direct ? eventId : null],
      );
    }

    const wrap = async (fileId: string, kind: string | null, linkedEvent: string | null) => {
      const contentId = randomUUID();

      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, linked_table, linked_id)
         VALUES ($1::uuid, 'Content', $2::uuid, 'photo', 'content', $1::uuid)`,
        [contentId, userId],
      );
      await dataSource.query(
        `INSERT INTO ci.content (id, type, user_id, external_id, external_id_kind, event_id)
         VALUES ($1::uuid, 'media', $2::uuid, $3, $4, $5::uuid)`,
        [contentId, userId, fileId, kind, linkedEvent],
      );
    };

    await wrap(files.viaContent, 'file', eventId);
    await wrap(files.viaLegacyContent, null, eventId);
    await wrap(files.contentNoEvent, 'file', null);
    await wrap(files.uriLookalike, 'external_uri', eventId);
  });

  afterAll(async () => {
    await dataSource.query(`DELETE FROM ci.content WHERE user_id = $1::uuid`, [userId]);
    await dataSource.query(`DELETE FROM ci.files WHERE user_id = $1::uuid`, [userId]);
    await dataSource.query(`DELETE FROM ci.events WHERE user_id = $1::uuid`, [userId]);
    await dataSource.query(`DELETE FROM ci.entities WHERE owner_user_id = $1::uuid`, [userId]);
    await dataSource.query(`DELETE FROM ci.users WHERE id = $1::uuid`, [userId]);
    await schemaLock.release();
    await dataSource.destroy();
  });

  const context = () => ({ userId }) as never;
  const kept = [files.undated, files.contentNoEvent, files.uriLookalike].sort();

  it('drops the files an event already shows, from the page and the count alike', async () => {
    const page = await service.getEntitiesForFiles(context(), { excludeEventLinked: true });

    expect(page.map((row) => row.id).sort()).toEqual(kept);
    expect(await service.countEntitiesForFiles(context(), { excludeEventLinked: true })).toBe(kept.length);
  });

  it('keeps every file without the flag', async () => {
    const page = await service.getEntitiesForFiles(context(), {});

    expect(page).toHaveLength(Object.keys(files).length);
    expect(await service.countEntitiesForFiles(context(), {})).toBe(Object.keys(files).length);
  });
});
