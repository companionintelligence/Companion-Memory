import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { CrossTableHydrationService } from '../CrossTableHydrationService';

/**
 * CrossTableHydrationService's raw SQL, EXECUTED against the real schema.
 *
 * `hydrateThings` read `SELECT i.item_id, i.name, i.description FROM ci.items`.
 * There is no `ci.items` — owned things live in `ci.objects`, and it has none of
 * those three columns. Every call threw `relation "ci.items" does not exist`, so
 * the objects half of hydration had never once run; a live appliance
 * dead-lettered on exactly that message. The unit tests all passed, because they
 * mock the DataSource and a mock cannot know a table is missing.
 *
 * This is the second instance of the same failure in this domain — see
 * LifeContextService.integration.spec.ts, which exists because five nonexistent
 * columns shipped the same way. Raw SQL in a service needs a test that a real
 * Postgres answers, or it is only checked in production.
 *
 * Executing each query once with a random user id is enough: no row can match,
 * but Postgres validates tables, columns and casts long before it cares.
 */

const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[personalization/CrossTableHydrationService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(
  `CrossTableHydrationService SQL agrees with the live schema (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let service: CrossTableHydrationService;

    beforeAll(async () => {
      const connection = resolveConnection();

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

      // Only `dataSource` participates in the SQL under test. The collaborators are
      // stubbed rather than wired, so this stays a schema test and does not quietly
      // become an end-to-end personalization test. Both reads return no rows for a
      // random user, so nothing downstream of the query is exercised anyway.
      service = new CrossTableHydrationService(
        dataSource,
        { ingest: async () => ({ entities: [], errors: [] }) } as never,
        { getProfile: async () => ({ trustMode: 'balanced' }) } as never,
        { extract: async () => null } as never,
        {
          setContext: () => undefined,
          log: () => undefined,
          debug: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        } as never,
      );
    });

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        await dataSource.destroy();
      }
    });

    it('hydrateThings executes — ci.objects and its columns all resolve', async () => {
      const result = await service.hydrateThings({ userId: randomUUID() } as never);

      expect(result.sampledRecords).toBe(0);
    });

    it('hydrateAnswers executes — the answers/questions join resolves', async () => {
      // The sibling query, checked in the same pass: fixing one broken read and
      // leaving its neighbour unexecuted is how the LifeContextService bug hid a
      // second one behind the first.
      const result = await service.hydrateAnswers({ userId: randomUUID() } as never);

      expect(result.sampledRecords).toBe(0);
    });

    it('names a table that exists, and not the one that never did', async () => {
      // A direct guard on the specific drift. If `ci.items` is ever introduced as
      // a real table this test should be revisited, not deleted — the point is
      // that things are read from wherever they actually live.
      const [{ objects, items }] = (await dataSource.query(
        `SELECT to_regclass('ci.objects')::text AS objects, to_regclass('ci.items')::text AS items`,
      )) as { objects: string | null; items: string | null }[];

      expect(objects).toBe('ci.objects');
      expect(items).toBeNull();
    });
  },
);
