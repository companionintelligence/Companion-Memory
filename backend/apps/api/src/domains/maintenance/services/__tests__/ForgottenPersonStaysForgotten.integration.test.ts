import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import {
  EntityIdentifierEntity,
  EntityIdentifierService,
  GraphIngestService,
  NodeEntity,
  RelationshipEntity,
} from '@ci/domains/graph';
import { BaseEntity, GraphDeltaWriter, PersonEntity, PersonService } from '@ci/domains/memory';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { wipeGraphEntities } from '../../../__tests__/support/graphEntityFootprint';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { CommunicationParticipantLinkListener } from '../../listeners/CommunicationParticipantLinkListener';
import { PersonStubBackfillService } from '../PersonStubBackfillService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A FORGOTTEN PERSON IS NOT CREATED AGAIN FROM THE MAIL THAT STILL NAMES THEM. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Forgetting a person deletes their identifiers, and the identifier index is the only thing that makes
 * the two paths that mint a stub Person from a message participant recognise an address:
 * `PersonStubBackfillService`, which runs after every bulk import of communications, and
 * `CommunicationParticipantLinkListener`, which runs for every new message. Both skip an identifier the
 * index covers. Measured on this database with the real services, the first backfill pass after a
 * delete-only forget created an active Person for the same address (new id), and the person-link stage then
 * re-pointed every old claim at it: the forget had undone itself, with the whole history re-attached.
 *
 * `PersonService.purge` therefore leaves a record of the identifiers it frees
 * (`ci.forgotten_identifiers`), and both paths skip those. This suite runs the REAL purge and then the REAL
 * minting services over a mailbox that still names the person, and checks that:
 *
 *  - the record is what stops it: the same run, with the record taken away, creates the person again;
 *  - everybody else on the same mail is created as before;
 *  - it is the owner's record: another account that has the same address on its mail is unaffected;
 *  - a person known only by a display name can come back, because names are not recorded;
 *  - the limit that is documented: a contact card imported again is a source arriving again.
 *
 * Opt-in like its neighbours: set `MEMORY_TEST_DATABASE_URL` to a migrated database of your OWN, or run
 * `make test-db`, which provides one.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[maintenance/ForgottenPersonStaysForgotten.integration] SKIPPED — ${availability.reason}`);
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

describeWithDb(`a forgotten person stays forgotten against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let people: PersonService;
  let graph: GraphIngestService;
  let stubs: PersonStubBackfillService;
  let listener: CommunicationParticipantLinkListener;

  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;

  let seeded: string[] = [];

  const query = (sql: string, params?: unknown[]) => dataSource.query(sql, params);

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [
        BaseEntity,
        UserEntity,
        PersonEntity,
        NodeEntity,
        RelationshipEntity,
        EntityIdentifierEntity,
      ],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'maintenance/ForgottenPersonStaysForgotten');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser(
        (sql, params) => dataSource.query(sql, params),
        'ForgottenPerson',
        userId,
      );
    }

    const signalling = { send: jest.fn(async () => []) } as unknown as EventService;
    const identifiers = new EntityIdentifierService(
      dataSource.getRepository(EntityIdentifierEntity),
      logger(),
    );

    graph = new GraphIngestService(
      dataSource.getRepository(NodeEntity),
      dataSource.getRepository(RelationshipEntity),
      identifiers,
      logger(),
      new GraphDeltaWriter(dataSource, logger()),
    );
    people = new PersonService(dataSource.getRepository(PersonEntity), logger(), signalling);

    const trust = { getTrustMode: jest.fn(async () => 'balanced' as const) };

    stubs = new PersonStubBackfillService(dataSource, graph, identifiers, trust, logger());

    // The listener finds the row it writes by its `time`, which the application stores to the millisecond, so
    // the messages here do too. It reads the message it is told about from the communication service, and re-opens the edge leg's
    // decision in the transaction that writes the links. Neither is what this is about, so both are minimal fakes.
    const communications = {
      findById: jest.fn(async (_context: unknown, id: string) => {
        const [row] = await dataSource.query(
          `SELECT id, user_id, time, participants_metadata, from_entity_id, to_entity_ids
             FROM ci.communications WHERE id = $1`,
          [id],
        );

        return row === undefined
          ? null
          : {
              id: row.id,
              userId: row.user_id,
              time: row.time,
              participantsMetadata: row.participants_metadata,
              fromEntityId: row.from_entity_id,
              toEntityIds: row.to_entity_ids,
            };
      }),
    };
    const reopener = { reopen: jest.fn(async () => 0) };

    listener = new CommunicationParticipantLinkListener(
      communications as never,
      identifiers,
      graph,
      trust,
      dataSource,
      logger(),
      { get: jest.fn(() => reopener) } as never,
    );
  });

  async function wipe(): Promise<void> {
    const users = [ownerId, strangerId];

    await dataSource.query('DELETE FROM ci.record_sources WHERE user_id = ANY($1::uuid[])', [users]);
    await wipeGraphEntities(query, users, seeded);
    // The base rows take the detail rows of the messages with them.
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.entities WHERE entity_id = ANY($1::uuid[])', [seeded]);
    seeded = [];
  }

  afterEach(wipe);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [[ownerId, strangerId]]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  // ── Fixtures ──────────────────────────────────────────────────────────────

  const email = (who: string) => `${who}@example.invalid`;

  /** Contacts, the way a card import leaves them: a node, and the address and name it is known by. */
  async function importContact(context: UserServiceContext, who: string, name: string): Promise<string> {
    const result = await graph.ingest(context, {
      entities: [
        {
          key: `contact:${who}`,
          entityType: 'Person',
          name,
          sourceSystem: 'vcard',
          properties: { emails: [email(who)], names: [name] },
        },
      ],
      relationships: [],
    });

    expect(result.errors).toEqual([]);

    return result.entities[0].entityId;
  }

  /** A message as an import leaves it: its participants named in the metadata, and no one linked yet. */
  async function message(
    forUser: string,
    participants: { from: string; to?: string[]; cc?: string[] },
    linked: { from?: string; to?: string[] } = {},
    minutesAgo = 10,
  ): Promise<string> {
    const id = uuidv7();

    seeded.push(id);
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Communication', 'a message', '{}'::jsonb, $2)`,
      [id, forUser],
    );
    await dataSource.query(
      `INSERT INTO ci.communications
         (id, time, user_id, communication_type, direction, content, participants_metadata, from_entity_id, to_entity_ids)
       VALUES ($1, date_trunc('milliseconds', now() - ($3 || ' minutes')::interval), $2, 'email', 'inbound', 'hello', $4::jsonb, $5, $6)`,
      [id, forUser, String(minutesAgo), JSON.stringify(participants), linked.from ?? null, linked.to ?? null],
    );

    return id;
  }

  /** Every Person the owner has whose identifiers include this address. */
  async function peopleKnownBy(forUser: string, address: string): Promise<string[]> {
    const rows: Array<{ entity_id: string }> = await dataSource.query(
      `SELECT i.entity_id
         FROM ci.entity_identifiers i
         JOIN ci.entities e ON e.entity_id = i.entity_id AND e.entity_type = 'Person'
        WHERE i.owner_user_id = $1 AND i.kind = 'email' AND i.value_normalized = $2`,
      [forUser, address],
    );

    return rows.map((row) => row.entity_id);
  }

  async function personNamed(forUser: string, name: string): Promise<string[]> {
    const rows: Array<{ entity_id: string }> = await dataSource.query(
      `SELECT entity_id FROM ci.entities WHERE owner_user_id = $1 AND entity_type = 'Person' AND name = $2`,
      [forUser, name],
    );

    return rows.map((row) => row.entity_id);
  }

  /**
   * The mailbox the other cases share: Dana and Sam are contacts, and three messages name Dana (as sender, as
   * recipient and as a carbon copy) and Sam, and one stranger to the address book. The ones the importer linked
   * carry their pointers. The third has no recipients linked, which is the ordinary state of most mail.
   */
  async function mailbox() {
    const dana = await importContact(owner, 'dana', 'Dana Quill');
    const sam = await importContact(owner, 'sam', 'Sam Rowe');

    await message(
      ownerId,
      { from: `Dana Quill <${email('dana')}>`, to: [email('sam')] },
      { from: dana, to: [sam] },
      30,
    );
    await message(ownerId, { from: email('sam'), to: [email('dana')] }, { from: sam, to: [dana] }, 20);
    await message(ownerId, { from: email('third'), to: [email('sam')], cc: [email('dana')] }, {}, 10);

    return { dana, sam };
  }

  // ── Cases ─────────────────────────────────────────────────────────────────

  it('creates the person again on the first backfill pass when the forget did not remember them, which is what the record is for', async () => {
    const { dana } = await mailbox();

    // Dana's card carried an address and a name; only the address is recorded.
    expect((await people.purge(owner, [dana])).blockedIdentifiers).toBe(1);
    expect(await peopleKnownBy(ownerId, email('dana'))).toEqual([]);

    // The control: a forget that deleted the person and nothing else, which is what the generic delete does.
    await dataSource.query('DELETE FROM ci.forgotten_identifiers WHERE owner_user_id = $1', [ownerId]);

    const result = await stubs.backfill(ownerId);

    const reborn = await peopleKnownBy(ownerId, email('dana'));

    expect(reborn).toHaveLength(1);
    expect(reborn[0]).not.toBe(dana);
    expect(result.identifiersForgotten).toBe(0);
  });

  it('does not create the person again on a backfill pass, and creates everybody else on the same mail', async () => {
    const { dana } = await mailbox();

    await people.purge(owner, [dana]);

    const result = await stubs.backfill(ownerId);

    // Dana's address is on three messages and is not minted. The stranger to the address book on one of them is.
    expect(await peopleKnownBy(ownerId, email('dana'))).toEqual([]);
    expect(await personNamed(ownerId, 'Dana Quill')).toEqual([]);
    expect(await peopleKnownBy(ownerId, email('third'))).toHaveLength(1);
    expect(result).toMatchObject({
      examined: 3,
      identifiersSeen: 3,
      identifiersExisting: 1,
      identifiersForgotten: 1,
      peopleCreated: 1,
      errors: [],
    });
  });

  it('keeps not creating them on later passes, and never links the old mail to anybody', async () => {
    const { dana } = await mailbox();

    await people.purge(owner, [dana]);
    await stubs.backfill(ownerId);
    await stubs.backfill(ownerId);

    expect(await peopleKnownBy(ownerId, email('dana'))).toEqual([]);
    // Nothing points at a person that is gone, and nothing points at a new one: the pointers were cleared.
    const pointed = await dataSource.query(
      `SELECT count(*)::int AS n FROM ci.communications WHERE user_id = $1 AND (from_entity_id = $2 OR to_entity_ids @> ARRAY[$2]::uuid[])`,
      [ownerId, dana],
    );

    expect(pointed).toEqual([{ n: 0 }]);
  });

  it('does not create them again from a new message either, and still links everybody else on it', async () => {
    const { dana, sam } = await mailbox();

    await people.purge(owner, [dana]);

    // A message arrives from Dana, to Sam and to somebody new. This is the path every single-row create takes.
    const arrived = await message(ownerId, {
      from: `Dana Quill <${email('dana')}>`,
      to: [email('sam'), email('fresh')],
    });

    await listener.handleCreated({ communicationId: arrived } as never);

    expect(await peopleKnownBy(ownerId, email('dana'))).toEqual([]);
    expect(await personNamed(ownerId, 'Dana Quill')).toEqual([]);

    const [fresh] = await peopleKnownBy(ownerId, email('fresh'));

    expect(fresh).toBeDefined();

    // The sender stays unresolved, because nobody is there to resolve to. The rest of the message is linked.
    expect(
      await dataSource.query('SELECT from_entity_id, to_entity_ids FROM ci.communications WHERE id = $1', [
        arrived,
      ]),
    ).toEqual([{ from_entity_id: null, to_entity_ids: [sam, fresh] }]);
  });

  it('would create them again from a new message when the forget did not remember them', async () => {
    const { dana } = await mailbox();

    await people.purge(owner, [dana]);
    await dataSource.query('DELETE FROM ci.forgotten_identifiers WHERE owner_user_id = $1', [ownerId]);

    const arrived = await message(ownerId, { from: `Dana Quill <${email('dana')}>`, to: [email('sam')] });

    await listener.handleCreated({ communicationId: arrived } as never);

    const reborn = await peopleKnownBy(ownerId, email('dana'));

    expect(reborn).toHaveLength(1);
    expect(reborn[0]).not.toBe(dana);
  });

  it('is the owner’s record: another account with the same address on its mail is unaffected', async () => {
    const { dana } = await mailbox();

    await people.purge(owner, [dana]);

    // Somebody else's mailbox names the same address. They never asked for it to be forgotten.
    await message(strangerId, { from: email('dana'), to: [email('their-friend')] });

    const result = await stubs.backfill(strangerId);

    expect(await peopleKnownBy(strangerId, email('dana'))).toHaveLength(1);
    expect(result.identifiersForgotten).toBe(0);
    // And the owner's stays forgotten.
    await stubs.backfill(ownerId);
    expect(await peopleKnownBy(ownerId, email('dana'))).toEqual([]);
  });

  it('can create a person known only by their name again, because a name is shared by many people', async () => {
    const { dana } = await mailbox();

    await people.purge(owner, [dana]);

    // A chat export with no addresses: the participant is just "Dana Quill".
    await message(ownerId, { from: 'Dana Quill', to: ['Sam Rowe'] });

    await stubs.backfill(ownerId);

    expect(await personNamed(ownerId, 'Dana Quill')).toHaveLength(1);
  });

  it('creates them again from a contact card imported again, which is a source arriving again', async () => {
    const { dana } = await mailbox();

    await people.purge(owner, [dana]);

    // The documented limit. The record stops the paths that mint a person from a message; a card the user
    // imports is a deliberate act, and it registers the address under the person it creates.
    const reimported = await importContact(owner, 'dana', 'Dana Quill');

    expect(reimported).not.toBe(dana);
    expect(await peopleKnownBy(ownerId, email('dana'))).toEqual([reimported]);
  });

  it('does not touch anyone who was not forgotten', async () => {
    const { dana, sam } = await mailbox();

    await people.purge(owner, [dana]);
    await stubs.backfill(ownerId);

    expect(await peopleKnownBy(ownerId, email('sam'))).toEqual([sam]);
    expect(
      await dataSource.query(
        'SELECT count(*)::int AS n FROM ci.forgotten_identifiers WHERE owner_user_id = $1',
        [ownerId],
      ),
    ).toEqual([{ n: 1 }]);
  });
});
