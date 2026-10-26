import { DataSource, type QueryRunner } from 'typeorm';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { COMMUNICATION_SUBJECT, EVENT_SUBJECT } from '../enrich/PersonLinkStage';

/**
 * When `enrich.person_link` moves a message's sender (or an event's organizer)
 * to a different person, the edge the deterministic edge rule drew from the old
 * one has to go with it: the edge projection only ever inserts. K-303: a mail
 * from a display-name lookalike was first filed as the owner's, and after the
 * stage moved it to the real sender the owner's page still said "You sent this".
 *
 * Runs the stage's own projection statement on real Postgres, in one
 * transaction rolled back in `afterAll`. Opt-in like its neighbours: set
 * `MEMORY_TEST_DATABASE_URL` (or `DATABASE_URL`) to a migrated database of your
 * own.
 */

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/PersonLinkStage.supersededEdges.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(
  `the person-link projection retracts a replaced sender's edge (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let runner: QueryRunner;
    let userId: string;

    const q = <T>(text: string, params?: unknown[]): Promise<T> => runner.query(text, params) as Promise<T>;

    async function person(name: string): Promise<string> {
      const [{ entity_id }] = await q<Array<{ entity_id: string }>>(
        `INSERT INTO ci.entities (entity_type, owner_user_id, name, properties)
       VALUES ('Person', $1, $2, '{}'::jsonb) RETURNING entity_id`,
        [userId, name],
      );

      return entity_id;
    }

    async function message(senderId: string): Promise<string> {
      const [{ entity_id }] = await q<Array<{ entity_id: string }>>(
        `INSERT INTO ci.entities (entity_type, owner_user_id, name) VALUES ('Communication', $1, 'A mail') RETURNING entity_id`,
        [userId],
      );
      await q(
        `INSERT INTO ci.communications (id, time, user_id, communication_type, direction, content, from_entity_id)
       VALUES ($1, now(), $2, 'email', 'inbound', 'hello', $3)`,
        [entity_id, userId, senderId],
      );

      return entity_id;
    }

    async function edge(from: string, to: string, type: string, rule: string | null): Promise<void> {
      await q(
        `INSERT INTO ci.relationships (from_entity_id, to_entity_id, relationship_type, owner_user_id, properties)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [from, to, type, userId, JSON.stringify(rule ? { rule } : { source: 'hand' })],
      );
    }

    async function edgesTo(id: string): Promise<Array<{ from_entity_id: string; rule: string | null }>> {
      return q(
        `SELECT from_entity_id, properties ->> 'rule' AS rule FROM ci.relationships WHERE to_entity_id = $1 ORDER BY 2`,
        [id],
      );
    }

    beforeAll(async () => {
      const connection = resolveConnection({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' })!;
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
        synchronize: false,
        logging: false,
        extra: { max: 1 },
      });
      await dataSource.initialize();
      runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      userId = await createSyntheticTestUser((sql, params) => q(sql, params), 'PersonLinkSuperseded');
    });

    afterAll(async () => {
      if (runner != null) {
        await runner.rollbackTransaction();
        await runner.release();
      }

      if (dataSource?.isInitialized) {
        await dataSource.destroy();
      }
    });

    it('moves the sender and deletes only the old sender’s communication.sent edge', async () => {
      const owner = await person('Owner');
      const stranger = await person('Stranger');
      const mail = await message(owner);
      await edge(owner, mail, 'SENT', 'communication.sent');
      // Something a person or another rule wrote between the same two nodes.
      await edge(owner, mail, 'MENTIONED_IN', null);

      await q(COMMUNICATION_SUBJECT.projectSql, [userId, [mail], [stranger], [null]]);

      const [{ from_entity_id }] = await q<Array<{ from_entity_id: string }>>(
        `SELECT from_entity_id FROM ci.communications WHERE id = $1`,
        [mail],
      );
      expect(from_entity_id).toBe(stranger);
      expect(await edgesTo(mail)).toEqual([{ from_entity_id: owner, rule: null }]);
    });

    it('keeps the edge when the projection confirms the same sender, or says nothing', async () => {
      const sender = await person('Sender');
      const other = await person('Other');
      const confirmed = await message(sender);
      const silent = await message(sender);
      await edge(sender, confirmed, 'SENT', 'communication.sent');
      await edge(sender, silent, 'SENT', 'communication.sent');

      await q(COMMUNICATION_SUBJECT.projectSql, [
        userId,
        [confirmed, silent],
        [sender, null],
        [null, JSON.stringify([other])],
      ]);

      expect(await edgesTo(confirmed)).toEqual([{ from_entity_id: sender, rule: 'communication.sent' }]);
      expect(await edgesTo(silent)).toEqual([{ from_entity_id: sender, rule: 'communication.sent' }]);
    });

    it('does the same for an event organizer', async () => {
      const was = await person('Was organizer');
      const now = await person('Is organizer');
      const [{ entity_id: eventId }] = await q<Array<{ entity_id: string }>>(
        `INSERT INTO ci.entities (entity_type, owner_user_id, name) VALUES ('Event', $1, 'Standup') RETURNING entity_id`,
        [userId],
      );
      await q(
        `INSERT INTO ci.events (event_id, user_id, start_time, organizer_entity_id) VALUES ($1, $2, now(), $3)`,
        [eventId, userId, was],
      );
      await edge(was, eventId, 'PARTICIPATED_IN', 'event.organized');

      await q(EVENT_SUBJECT.projectSql, [userId, [eventId], [now], [null]]);

      expect(await edgesTo(eventId)).toEqual([]);
    });
  },
);
