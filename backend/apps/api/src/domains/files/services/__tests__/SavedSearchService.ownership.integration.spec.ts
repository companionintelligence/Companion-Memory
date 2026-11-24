import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import type { EventService } from '@ci/domains/events';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { SavedSearchEntity } from '../../entities/SavedSearchEntity';
import { SavedSearchService } from '../SavedSearchService';

/**
 * A client-chosen saved-search id, AGAINST REAL POSTGRES.
 *
 * `createSavedSearch` takes an id from the client, so a phone's offline replica
 * can create a row and replay the create later under the same id. It used to
 * `save()` that id, which UPDATES whichever row already holds it: an account
 * that knew another account's saved-search id could replace that search and take
 * it over (the row's `user_id` became the caller's). The unit tests show what the
 * service asks the repository for; only the database shows that the update really
 * is scoped to the caller and that the insert really is refused for a taken id.
 */

const DATABASE_ENV = {
  urlEnvVar: 'SAVED_SEARCH_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'SAVED_SEARCH_TEST_PROBE_TIMEOUT_MS',
};
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[files/SavedSearchService.ownership.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const signalling = { send: jest.fn(async () => []) } as unknown as EventService;

describeWithDb(
  `SavedSearchService.create with a client id, against Postgres (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let schemaLock: SchemaLock | null = null;
    let service: SavedSearchService;
    let owner: string;
    let other: string;

    const query = (sql: string, params?: unknown[]): Promise<unknown> => dataSource.query(sql, params);
    const ctx = (userId: string) => ({ userId }) as UserServiceContext;
    const row = async (id: string) =>
      (
        (await query('SELECT user_id, name, query FROM ci.saved_searches WHERE id = $1', [id])) as Array<{
          user_id: string;
          name: string;
          query: string;
        }>
      )[0];

    beforeAll(async () => {
      dataSource = new DataSource({
        type: 'postgres',
        ...dataSourceConnection(DATABASE_ENV),
        entities: [SavedSearchEntity],
        synchronize: false,
        extra: { options: '-c search_path=ci,public' },
      });
      await dataSource.initialize();
      schemaLock = await acquireSchemaWriteLock(dataSource, 'files/SavedSearchService.ownership');

      owner = await createSyntheticTestUser(query, 'SavedSearchOwner');
      other = await createSyntheticTestUser(query, 'SavedSearchOther');
      service = new SavedSearchService(dataSource.getRepository(SavedSearchEntity), signalling);
    });

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        try {
          await query('DELETE FROM ci.saved_searches WHERE user_id = ANY($1::uuid[])', [[owner, other]]);
          await query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [[owner, other]]);
        } finally {
          await schemaLock?.release();
          await dataSource.destroy();
        }
      }
    });

    it("refuses another account's id and leaves that account's search as it was", async () => {
      const id = randomUUID();
      await service.create(ctx(owner), { id, name: 'Mine', query: 'paris' });

      await expect(service.create(ctx(other), { id, name: 'Taken', query: 'stolen' })).rejects.toThrow(
        'That saved search id is already in use',
      );

      expect(await row(id)).toEqual({ user_id: owner, name: 'Mine', query: 'paris' });
    });

    it("replaces the caller's own row when a replica replays its create", async () => {
      const id = randomUUID();
      await service.create(ctx(owner), { id, name: 'First', query: 'one' });

      const replayed = await service.create(ctx(owner), { id, name: 'Replayed', query: 'two' });

      expect(replayed.name).toBe('Replayed');
      expect(await row(id)).toEqual({ user_id: owner, name: 'Replayed', query: 'two' });
      const count = (await query('SELECT count(*)::int AS n FROM ci.saved_searches WHERE id = $1', [
        id,
      ])) as Array<{
        n: number;
      }>;
      expect(count[0].n).toBe(1);
    });

    it('creates a row under a new client id, and one under its own id without one', async () => {
      const id = randomUUID();

      const withId = await service.create(ctx(other), { id, name: 'Offline', query: 'q' });
      const without = await service.create(ctx(other), { name: 'Online', query: 'q' });

      expect(withId.id).toBe(id);
      expect(await row(id)).toEqual({ user_id: other, name: 'Offline', query: 'q' });
      expect(without.id).toEqual(expect.any(String));
      expect(without.id).not.toBe(id);
    });
  },
);
