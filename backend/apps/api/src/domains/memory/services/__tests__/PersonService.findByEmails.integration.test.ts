import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { PersonEntity } from '../../entities/PersonEntity';
import { PersonService } from '../PersonService';

/**
 * `PersonService.findByEmails`, proved against a real Postgres.
 *
 * The ETL connection syncs resolve every participant of a page through this
 * one query (PromoteService.resolvePeople), where they used to run
 * `search({ properties: { email } })` once per participant per message. What
 * a mock cannot show: that the `properties->>'email' IN (...)` clause finds
 * the rows, scopes them to the owner, and orders them oldest-first so a
 * duplicated address resolves to the same person on every page.
 *
 * Opt-in like its neighbours: skips with a reason when nothing is listening at
 * `DATABASE_URL` / `MEMORY_TEST_DATABASE_URL`; `make test-db` provides one.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[PersonService.findByEmails.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(
  `PersonService.findByEmails — one query per page of participants (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let schemaLock: SchemaLock | null = null;
    let service: PersonService;
    let ownerA: string;
    let ownerB: string;
    let olderBobId: string;
    let newerBobId: string;

    const noopLogger = {
      setContext: () => undefined,
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as unknown as LoggerService;

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
        entities: [BaseEntity, PersonEntity],
        synchronize: false,
        extra: { options: '-c search_path=ci,public' },
      });

      await dataSource.initialize();
      schemaLock = await acquireSchemaWriteLock(dataSource, 'PersonService.findByEmails');

      const query = (sql: string, params?: unknown[]) => dataSource.query(sql, params);
      ownerA = await createSyntheticTestUser(query, 'PersonService-findByEmails-A');
      ownerB = await createSyntheticTestUser(query, 'PersonService-findByEmails-B');

      service = new PersonService(dataSource.getRepository(PersonEntity), noopLogger, {
        send: async () => [],
      } as unknown as EventService);

      const repo = dataSource.getRepository(PersonEntity);
      const person = (userId: string, name: string, email: string) =>
        repo.save(repo.create({ id: uuidv7(), name, userId, properties: { email } }));

      await person(ownerA, 'Alice', 'alice@example.invalid');
      // Two rows for one address — the duplicate a pre-batch sync could mint —
      // in creation order, so the test can tell which one comes back first.
      olderBobId = (await person(ownerA, 'Bob (older)', 'bob@example.invalid')).id;
      newerBobId = (await person(ownerA, 'Bob (newer)', 'bob@example.invalid')).id;
      // Owner B knows an "alice" too; it must never resolve for owner A.
      await person(ownerB, "B's Alice", 'alice@example.invalid');
    });

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [
          [ownerA, ownerB],
        ]);
        await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [[ownerA, ownerB]]);
        await schemaLock?.release();
        await dataSource.destroy();
      }
    });

    it("finds every match for the owner's addresses, oldest first, and nobody else's", async () => {
      const people = await service.findByEmails({ userId: ownerA } as UserServiceContext, [
        'alice@example.invalid',
        'bob@example.invalid',
        'nobody@example.invalid',
      ]);

      expect(people.map((person) => person.email).sort()).toEqual([
        'alice@example.invalid',
        'bob@example.invalid',
        'bob@example.invalid',
      ]);
      expect(people.every((person) => person.userId === ownerA)).toBe(true);

      // uuid v7 ids are time-ordered, so "ORDER BY id" is creation order: the
      // row PromoteService picks for a duplicated address is the older one.
      const bobs = people
        .filter((person) => person.email === 'bob@example.invalid')
        .map((person) => person.id);
      expect(bobs).toEqual([olderBobId, newerBobId]);
    });

    it('returns nothing for an empty list without asking the database', async () => {
      const spy = jest.spyOn(dataSource, 'query');

      expect(await service.findByEmails({ userId: ownerA } as UserServiceContext, [])).toEqual([]);
      expect(spy).not.toHaveBeenCalled();

      spy.mockRestore();
    });
  },
);
