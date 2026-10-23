import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { LoggerService } from '@ci/common/logging';
import { buildVectorUpsertStatement } from '@ci/domains/search-ingress';
import { DEVICE_RECORD_VERSION } from '@ci/domains/search-next';

import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { MobileSearchDocumentDetailCron } from '../MobileSearchDocumentDetailCron';

/**
 * The device record's SQL against a real, migrated Postgres: the shared index
 * statement writes `related_id` / `detail` from the source row, and the refresh
 * cron brings rows written before the columns existed up to the current
 * version. Both are pure SQL over the source tables — a mocked DataSource
 * would test nothing.
 *
 * Opt-in like the sibling integration specs: set MAINTENANCE_TEST_DATABASE_URL
 * to a migrated database of your own, or run `make test-db`.
 */
const DATABASE_ENV = { urlEnvVar: 'MAINTENANCE_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[maintenance/MobileSearchDocumentDetailCron] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const noopLogger = {
  setContext: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

describeWithDb(`device records (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  const userId = uuidv7();
  const otherUserId = uuidv7();

  async function index(entityType: string, entityId: string, owner = userId): Promise<void> {
    const { sql, params } = buildVectorUpsertStatement([{ text: `${entityType} ${entityId}`, weight: 10 }], {
      id: uuidv7(),
      entityType,
      entityId,
      userId: owner,
    });

    await dataSource.query(sql, params);
  }

  async function documentFor(entityId: string) {
    const rows: Array<{
      related_id: string | null;
      detail: Record<string, unknown> | null;
      detail_version: number;
    }> = await dataSource.query(
      'SELECT related_id, detail, detail_version FROM ci_search.mobile_search_documents WHERE entity_id = $1',
      [entityId],
    );

    return rows[0];
  }

  async function communication(
    owner: string,
    fields: { source: string; thread: string | null; to?: string[] },
  ) {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id) VALUES ($1, 'Communication', $2)`,
      [id, owner],
    );
    await dataSource.query(
      `INSERT INTO ci.communications (id, time, user_id, communication_type, direction, content, source_system, thread_id, participants_metadata)
       VALUES ($1, now(), $2, 'chat', 'inbound', 'hello', $3, $4, $5)`,
      [id, owner, fields.source, fields.thread, JSON.stringify({ from: 'Ana', to: fields.to ?? ['Kyle'] })],
    );

    return id;
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'maintenance/MobileSearchDocumentDetailCron');

    for (const id of [userId, otherUserId]) {
      await dataSource.query(
        `INSERT INTO ci.users (id, name, email, password, onboarded, timezone) VALUES ($1, 'Device record fixture', $2, 'x', true, 'UTC')`,
        [id, `device-record.${id}@example.test`],
      );
    }
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) {
      return;
    }

    // try/finally: a failing cleanup statement must still release the lock and
    // close the pool, or jest never exits and the run looks hung.
    try {
      // Communications cascade from ci.users; notes do not (notes_user_id_fkey has
      // no ON DELETE), and index rows carry a user_id with no foreign key at all.
      await dataSource.query('DELETE FROM ci_search.vectors WHERE user_id = ANY($1::uuid[])', [
        [userId, otherUserId],
      ]);
      await dataSource.query('DELETE FROM ci.notes WHERE user_id = ANY($1::uuid[])', [[userId, otherUserId]]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [
        [userId, otherUserId],
      ]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [[userId, otherUserId]]);
    } finally {
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('the index statement writes a message’s direction, participants, people, connector and conversation, stamped current', async () => {
    const id = await communication(userId, { source: 'discord', thread: 'Direct Message with ana#0' });
    const sender = uuidv7();
    const recipient = uuidv7();

    await dataSource.query(
      'UPDATE ci.communications SET from_entity_id = $2, to_entity_ids = ARRAY[$3]::uuid[] WHERE id = $1',
      [id, sender, recipient],
    );
    await index('communication', id);

    const doc = await documentFor(id);

    expect(doc.detail).toEqual({
      communication_type: 'chat',
      direction: 'inbound',
      source_system: 'discord',
      from_id: sender,
      to_ids: [recipient],
      participants: { from: 'Ana', to: ['Kyle'] },
    });
    expect(doc.related_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(doc.detail_version).toBe(DEVICE_RECORD_VERSION);
  });

  it('keys a conversation by user, source and thread id: same thread groups, any difference splits', async () => {
    const a = await communication(userId, { source: 'email', thread: '19a987615de1b7f3' });
    const b = await communication(userId, { source: 'email', thread: '19a987615de1b7f3' });
    const otherSource = await communication(userId, { source: 'discord', thread: '19a987615de1b7f3' });
    const otherUser = await communication(otherUserId, { source: 'email', thread: '19a987615de1b7f3' });
    const none = await communication(userId, { source: 'sms_backup_restore', thread: null });

    for (const [id, owner] of [
      [a, userId],
      [b, userId],
      [otherSource, userId],
      [otherUser, otherUserId],
      [none, userId],
    ] as const) {
      await index('communication', id, owner);
    }

    const [docA, docB, docSource, docUser, docNone] = await Promise.all(
      [a, b, otherSource, otherUser, none].map((id) => documentFor(id)),
    );

    expect(docA.related_id).toBe(docB.related_id);
    expect(docSource.related_id).not.toBe(docA.related_id);
    expect(docUser.related_id).not.toBe(docA.related_id);
    // No thread id is no conversation, not a shared "empty" one.
    expect(docNone.related_id).toBeNull();
  });

  it('cuts an oversized participant list to the sender and says so', async () => {
    const crowd = Array.from({ length: 200 }, (_, n) => `Participant number ${n}`);
    const id = await communication(userId, { source: 'facebook_messenger', thread: 'Big group', to: crowd });

    await index('communication', id);

    expect((await documentFor(id)).detail).toMatchObject({
      participants: { from: 'Ana' },
      participants_truncated: true,
    });
  });

  it('an event carries its coordinates, place, people and connector; a place its point', async () => {
    const eventId = uuidv7();
    const placeId = uuidv7();
    const personId = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, location_point)
       VALUES ($1, 'Location', $2, 'Harbour Grill', ST_SetSRID(ST_MakePoint(-117.9, 33.6), 4326)::geography)`,
      [placeId, userId],
    );
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1, 'Person', $2, 'Ana')`,
      [personId, userId],
    );
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1, 'Event', $2, 'Dinner')`,
      [eventId, userId],
    );
    await dataSource.query(
      `INSERT INTO ci.events (event_id, user_id, event_type, start_time, source_system, location_entity_id, location_name,
                              location_coordinates, participant_entity_ids)
       VALUES ($1, $2, 'meal', now(), 'google_calendar', $3, 'Harbour Grill',
               ST_SetSRID(ST_MakePoint(-117.9, 33.6), 4326)::geography, ARRAY[$4]::uuid[])`,
      [eventId, userId, placeId, personId],
    );

    await index('event', eventId);
    await index('place', placeId);

    expect((await documentFor(eventId)).detail).toMatchObject({
      event_type: 'meal',
      source_system: 'google_calendar',
      location_name: 'Harbour Grill',
      location_id: placeId,
      lat: 33.6,
      lng: -117.9,
      people: [personId],
    });
    expect((await documentFor(placeId)).detail).toMatchObject({ lat: 33.6, lng: -117.9 });
  });

  it('a type with no display fields writes NULL detail rather than an empty object', async () => {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.notes (id, title, content, user_id) VALUES ($1, 'Groceries', 'eggs', $2)`,
      [id, userId],
    );
    await index('note', id);

    expect(await documentFor(id)).toMatchObject({
      detail: null,
      related_id: null,
      detail_version: DEVICE_RECORD_VERSION,
    });
  });

  it('the refresh cron re-derives rows below the current version, and then has nothing to do', async () => {
    const id = await communication(userId, { source: 'discord', thread: 'Old conversation' });

    await index('communication', id);
    // A row from before the columns existed: version 0, nothing derived.
    await dataSource.query(
      'UPDATE ci_search.mobile_search_documents SET related_id = NULL, detail = NULL, detail_version = 0 WHERE entity_id = $1',
      [id],
    );

    const cron = new MobileSearchDocumentDetailCron(dataSource, noopLogger);
    const first = await cron.refreshOnce(1000, 1000);

    expect(first.updated).toBeGreaterThanOrEqual(1);
    expect(await documentFor(id)).toMatchObject({
      detail: { direction: 'inbound' },
      detail_version: DEVICE_RECORD_VERSION,
    });
    expect((await documentFor(id)).related_id).not.toBeNull();

    // Converged: a second run touches nothing (the whole database, not just this fixture).
    expect(await cron.refreshOnce(1000, 1000)).toEqual({ updated: 0, batches: 1 });
  });
});
