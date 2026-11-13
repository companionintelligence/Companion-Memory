import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import {
  BaseEntity,
  ContentBaseEntity,
  ContentEntity,
  ContentService,
  EventBaseEntity,
  EventEntity,
  GraphDeltaWriter,
} from '@ci/domains/memory';
import { NoteEntity } from '@ci/domains/notes';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { NoteContentFoldService } from '../NoteContentFoldService';

/**
 * `fold-notes` gives every note a Content row with the note's own id and its
 * stored HTML as text. The Memory list already shows the note, so the browse
 * leaves that mirror out (`excludeNoteMirrors`), and counts the same rows it
 * fetches. Real SQL: the exclusion is a `NOT EXISTS` over `ci.notes`.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[maintenance/NoteContentFold.browse.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

describeWithDb(`a folded note's Content mirror in the browse (${availability.target})`, () => {
  let dataSource: DataSource;
  let contents: ContentService;
  let fold: NoteContentFoldService;

  const ownerId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [BaseEntity, ContentEntity, ContentBaseEntity, EventEntity, EventBaseEntity, NoteEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'NoteFoldBrowse', ownerId);

    const deltaWriter = new GraphDeltaWriter(dataSource, logger());

    contents = new ContentService(
      dataSource.getRepository(ContentEntity),
      dataSource.getRepository(ContentBaseEntity),
      dataSource.getRepository(EventEntity),
      { send: jest.fn(async () => []) } as unknown as EventService,
      deltaWriter,
    );
    fold = new NoteContentFoldService(dataSource, logger(), deltaWriter);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = $1', [ownerId]);
      await dataSource.query('DELETE FROM ci.content WHERE user_id = $1', [ownerId]);
      await dataSource.query('DELETE FROM ci.notes WHERE user_id = $1', [ownerId]);
      await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = $1', [ownerId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ownerId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ownerId]);
      await dataSource.destroy();
    }
  });

  it('lists a folded note once, and counts what it lists', async () => {
    const noteId = uuidv7();
    const textId = uuidv7();

    await dataSource.query(`INSERT INTO ci.notes (id, user_id, title, content) VALUES ($1, $2, $3, $4)`, [
      noteId,
      ownerId,
      'Trip ideas',
      '<h3>Trip ideas</h3><p>Lisbon in spring</p>',
    ]);
    // An ordinary Content row beside it, which the browse must keep.
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Content', 'Packing list', '{}'::jsonb, $2, 'content', $1)`,
      [textId, ownerId],
    );
    await dataSource.query(`INSERT INTO ci.content (id, type, text, user_id) VALUES ($1, 'text', 'socks', $2)`, [
      textId,
      ownerId,
    ]);

    expect(await fold.fold(ownerId)).toEqual({ notesFolded: 1 });

    const all = await contents.getEntitiesForContents(owner, {});
    const browsed = await contents.getEntitiesForContents(owner, { excludeNoteMirrors: true });

    // The mirror exists, with the note's id...
    expect(all.map(({ id }) => id).sort()).toEqual([noteId, textId].sort());
    // ...and the browse leaves it out, keeping the ordinary row.
    expect(browsed).toEqual([{ id: textId, type: 'content' }]);
    expect(await contents.countEntitiesForContents(owner, { excludeNoteMirrors: true })).toBe(1);
    expect(await contents.countEntitiesForContents(owner, {})).toBe(2);
  });
});
