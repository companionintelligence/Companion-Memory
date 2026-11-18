import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { HbpeNotifyService } from '@ci/common/hbpe';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { CommunicationBaseEntity } from '../../entities/CommunicationBaseEntity';
import { CommunicationEntity } from '../../entities/CommunicationEntity';
import { CommunicationType, type CreateCommunicationDto } from '../../types';
import { CommunicationService } from '../CommunicationService';
import { GraphDeltaWriter } from '../GraphDeltaWriter';

/**
 * A message's one-line preview on a re-import, against real Postgres.
 *
 * The importer sends `preview` only when its clip differs from the text, so a
 * message that became one short line arrives with none. Under the plain
 * "new value unless null" refresh the stored preview of the OLD text stayed
 * along with the message's name (`labelFor`), while the content moved on. The
 * `preview` column is now a 'derived' merge kind: the same producer's null
 * clears it, another producer still only fills an empty one.
 */

const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/CommunicationService.reingestPreview.integration] SKIPPED - ${availability.reason}`);
}

jest.setTimeout(120_000);

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

/** The importer's and a connection's `source_type`, as their mappers write them. */
const IMPORTER = 'ci-import-tools';
const CONNECTION = 'ETL';

const LONG_TEXT = 'Shopping list for the cabin:\n- bread\n- coffee\n- firewood';
const LONG_CLIP = 'Shopping list for the cabin: - bread - coffee - firewood';
const SHORT_TEXT = 'Shopping list: bread and coffee <This message was edited>';

describeWithDb(`A re-imported message's preview, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let communications: CommunicationService;

  const ownerId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [BaseEntity, UserEntity, CommunicationBaseEntity, CommunicationEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/reingestPreview');
    await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'ReingestPreview', ownerId);

    communications = new CommunicationService(
      dataSource.getRepository(CommunicationEntity),
      { send: jest.fn(async () => []) } as unknown as EventService,
      logger(),
      dataSource,
      new GraphDeltaWriter(dataSource, logger()),
      { notifyCommunications: jest.fn(async () => undefined) } as unknown as HbpeNotifyService,
    );
  });

  afterEach(async () => {
    for (const sql of [
      'DELETE FROM ci.graph_deltas WHERE owner_user_id = $1',
      'DELETE FROM ci.record_sources WHERE user_id = $1',
      'DELETE FROM ci.communications WHERE user_id = $1',
      'DELETE FROM ci.entities WHERE owner_user_id = $1',
    ]) {
      await dataSource.query(sql, [ownerId]);
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = $1', [ownerId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ownerId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ownerId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  /** One message as a producer sends it; `preview` omitted is what the importer does for a one-line text. */
  const send = async (sourceType: string, content: string, preview?: string) =>
    (
      await communications.createManyDetailed(owner, [
        {
          time: new Date('2026-11-14T10:02:00Z'),
          communication_type: CommunicationType.CHAT,
          direction: 'inbound',
          content,
          ...(preview !== undefined && { preview }),
          source_type: sourceType,
          source_system: 'whatsapp',
          source_id: 'whatsapp:Lake cabin:2026-11-14T10:02:00.000Z:1',
        } as CreateCommunicationDto,
      ])
    )[0];

  /** What is stored, what readers are given and the message's name. */
  const read = async () => {
    const rows: Array<{ id: string; content: string; preview: string | null; name: string | null }> =
      await dataSource.query(
        `SELECT c.id, c.content, c.preview, e.name
           FROM ci.communications c JOIN ci.entities e ON e.entity_id = c.id
          WHERE c.user_id = $1`,
        [ownerId],
      );
    expect(rows).toHaveLength(1);
    const egress = await communications.findById(owner, rows[0].id);

    return { ...rows[0], shown: egress?.preview ?? null };
  };

  it('drops the old preview when a re-import turns a long text into one short line', async () => {
    await send(IMPORTER, LONG_TEXT, LONG_CLIP);
    expect(await read()).toMatchObject({ preview: LONG_CLIP, name: LONG_CLIP });

    const again = await send(IMPORTER, SHORT_TEXT);

    expect(again.inserted).toBe(false);
    expect(await read()).toMatchObject({
      content: SHORT_TEXT,
      preview: null,
      name: SHORT_TEXT,
      shown: SHORT_TEXT,
    });
  });

  it('repairs a message stored with a stale preview on the next re-import of the same text', async () => {
    // The state the old rule left behind: the new text with the old preview.
    await send(IMPORTER, SHORT_TEXT, LONG_CLIP);
    expect(await read()).toMatchObject({ content: SHORT_TEXT, name: LONG_CLIP, shown: LONG_CLIP });

    await send(IMPORTER, SHORT_TEXT);

    expect(await read()).toMatchObject({ preview: null, name: SHORT_TEXT, shown: SHORT_TEXT });
  });

  it('still takes a new preview the same producer sends (a mail connection re-syncing its snippet)', async () => {
    await send(CONNECTION, 'Body one', 'Snippet one');
    await send(CONNECTION, 'Body two', 'Snippet two');

    expect(await read()).toMatchObject({ content: 'Body two', preview: 'Snippet two', name: 'Snippet two' });
  });

  it('leaves a producer that never sends a preview (a chat connection) as it was', async () => {
    await send(CONNECTION, 'See you at the pier');
    await send(CONNECTION, 'See you at the pier');

    expect(await read()).toMatchObject({
      preview: null,
      name: 'See you at the pier',
      shown: 'See you at the pier',
    });
  });

  it('lets another producer fill an empty preview but never replace or clear the stored one', async () => {
    await send(IMPORTER, LONG_TEXT, LONG_CLIP);
    await send(CONNECTION, LONG_TEXT, 'A snippet from the connection');
    expect((await read()).preview).toBe(LONG_CLIP);

    await send(CONNECTION, LONG_TEXT);
    expect((await read()).preview).toBe(LONG_CLIP);

    await dataSource.query('DELETE FROM ci.communications WHERE user_id = $1', [ownerId]);
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ownerId]);

    await send(IMPORTER, 'See you at the pier');
    await send(CONNECTION, 'See you at the pier', 'A snippet from the connection');
    expect((await read()).preview).toBe('A snippet from the connection');
  });

  // The cost of the rule, pinned so it stays a decision: the row does not say
  // who wrote its preview, so the first writer's next re-import clears one
  // another producer filled in. Readers then show the clip of the text.
  it("clears a preview another producer filled when the row's first writer imports again", async () => {
    await send(IMPORTER, 'See you at the pier');
    await send(CONNECTION, 'See you at the pier', 'A snippet from the connection');

    await send(IMPORTER, 'See you at the pier');

    expect(await read()).toMatchObject({ preview: null, shown: 'See you at the pier' });
  });
});
