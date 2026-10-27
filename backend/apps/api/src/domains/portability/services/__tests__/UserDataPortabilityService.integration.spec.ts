import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import type { UserDataArchive } from '../../types';
import { UserDataPortabilityService } from '../UserDataPortabilityService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DOES THE ROLLBACK ACTUALLY ROLL BACK, AGAINST A REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `importArchive`/`importNdjsonStream` run a transactional
 * delete-every-discovered-table-then-restore-from-archive across a user's
 * entire personal database. The unit tests (UserDataPortabilityService.test.ts)
 * pin the SERVICE's call sequence with a mocked QueryRunner — commit only on
 * success, rollback and rethrow on failure, delete-before-insert. What a mock
 * cannot prove is the thing that actually matters in production: that
 * `queryRunner.rollbackTransaction()` genuinely undoes the delete on a real
 * connection. A mock's `rollbackTransaction` is a no-op jest.fn(); this test
 * is the one place that calls the real one and then reads the table back.
 *
 * Every discovered table also gets deleted-for-this-user once as a side
 * effect of running `importArchive` at all (discoverUserTables enumerates
 * every ci/ci_search/hbpe table with a user_id/owner_user_id column, and the
 * service deletes across ALL of them, not just the ones under test) — for a
 * disposable user id with zero rows anywhere else, every one of those is a
 * real no-op DELETE against the live schema, incidentally proving the
 * dynamically-quoted `"${schema}"."${table}"` SQL is valid for the whole
 * table set, the same class of drift CrossTableHydrationService's
 * integration spec exists to catch in personalization's hand-written SQL.
 */

const PORTABILITY_DATABASE_ENV = {
  urlEnvVar: 'PORTABILITY_TEST_DATABASE_URL',
  probeTimeoutEnvVar: 'PORTABILITY_TEST_PROBE_TIMEOUT_MS',
};

const availability = databaseAvailability(PORTABILITY_DATABASE_ENV);
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[portability/UserDataPortabilityService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

describeWithDatabase(
  `UserDataPortabilityService transaction boundary against a live Postgres (${availability.target})`,
  () => {
    let dataSource: DataSource;
    let service: UserDataPortabilityService;

    const testUserId = randomUUID();
    // A second account on the same box, for the cross-account cases below.
    const otherUserId = randomUUID();
    const noopServices = {
      fileService: { getFileContent: jest.fn(), putObject: jest.fn() },
      userService: { findById: jest.fn() },
      logger: {
        setContext: () => undefined,
        log: () => undefined,
        warn: () => undefined,
        debug: () => undefined,
        error: () => undefined,
      },
    };

    const notesFor = async (): Promise<Array<{ id: string; title: string }>> =>
      dataSource.query('SELECT id, title FROM ci.notes WHERE user_id = $1::uuid ORDER BY title', [
        testUserId,
      ]);

    beforeAll(async () => {
      const connection = resolveConnection(PORTABILITY_DATABASE_ENV);

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

      service = new UserDataPortabilityService(
        dataSource,
        noopServices.fileService as never,
        noopServices.userService as never,
        noopServices.logger as never,
      );

      // A disposable user, invented for this file alone: `ci.notes.user_id`
      // has an FK into `ci.users`, so the seeded rows below need a real parent.
      await dataSource.query('INSERT INTO ci.users (id) VALUES ($1::uuid), ($2::uuid)', [
        testUserId,
        otherUserId,
      ]);
    });

    const cleanUp = async (): Promise<void> => {
      const users = [testUserId, otherUserId];

      await dataSource.query('DELETE FROM ci.notes WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.receipts WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.federated_identities WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.mcp_server_configs WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.messages WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.threads WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [users]);
    };

    afterAll(async () => {
      if (dataSource?.isInitialized) {
        await cleanUp();
        await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [
          [testUserId, otherUserId],
        ]);
        await dataSource.destroy();
      }
    });

    afterEach(async () => {
      await cleanUp();
    });

    it('commits: delete-then-restore leaves exactly the archived rows behind, nothing stale', async () => {
      const staleId = randomUUID();
      await dataSource.query('INSERT INTO ci.notes (id, title, user_id) VALUES ($1::uuid, $2, $3::uuid)', [
        staleId,
        'stale-before-import',
        testUserId,
      ]);

      const freshId = randomUUID();
      const archive: UserDataArchive = {
        version: 1,
        exportedAt: new Date().toISOString(),
        userId: testUserId,
        profile: null,
        tables: { 'ci.notes': [{ id: freshId, title: 'from-archive', user_id: testUserId }] },
        fileBlobs: [],
      };

      const result = await service.importArchive({ userId: testUserId } as never, archive);

      expect(result.rowsImported).toBeGreaterThanOrEqual(1);

      const rows = await notesFor();
      // The pre-existing row is gone (delete ran) and only the archived row
      // survives (insert ran) — not both, which is what "delete-then-restore"
      // promises and a delete-without-a-matching-insert-scope would break.
      expect(rows).toEqual([{ id: freshId, title: 'from-archive' }]);
    });

    it('rolls back a failed import, leaving the pre-existing row exactly as it was', async () => {
      const keptId = randomUUID();
      await dataSource.query('INSERT INTO ci.notes (id, title, user_id) VALUES ($1::uuid, $2, $3::uuid)', [
        keptId,
        'kept',
        testUserId,
      ]);

      // Two archive rows share the same id: the delete phase removes the
      // pre-existing row, the first insert re-adds a row at that id, and the
      // SECOND insert at the same id hits `notes_pkey` — a real constraint
      // violation partway through the restore, not a simulated one.
      const archive: UserDataArchive = {
        version: 1,
        exportedAt: new Date().toISOString(),
        userId: testUserId,
        profile: null,
        tables: {
          'ci.notes': [
            { id: keptId, title: 'replacement', user_id: testUserId },
            { id: keptId, title: 'duplicate-id-forces-a-real-pg-error', user_id: testUserId },
          ],
        },
        fileBlobs: [],
      };

      await expect(service.importArchive({ userId: testUserId } as never, archive)).rejects.toThrow();

      const rows = await notesFor();

      // If rollback genuinely ran, the ORIGINAL row survives untouched. If it
      // silently didn't — delete committed, insert half-failed, nothing
      // undone — the table would be empty or hold "replacement" instead. This
      // is the exact failure mode the audit flags as the largest data-loss
      // surface in the slice.
      expect(rows).toEqual([{ id: keptId, title: 'kept' }]);
    });

    it('importNdjsonStream — the actual streaming production path — restores rows via the same real transaction', async () => {
      // importArchive above is the "legacy single-json export for small
      // accounts and tests" (see its own doc comment); importNdjsonStream is
      // what real exports/imports use. Both funnel through the same
      // setReplicationRole → delete → insert sequence, but only running this
      // one through a real Postgres proves the streaming entry point wires up
      // to that sequence correctly too, not just its legacy sibling.
      noopServices.userService.findById = jest.fn().mockResolvedValue({ email: 'jane@example.com' });

      const freshId = randomUUID();
      const lines = [
        {
          type: 'manifest',
          version: 1,
          format: 'ndjson',
          exportedAt: new Date().toISOString(),
          userId: testUserId,
          profile: null,
        },
        {
          type: 'row',
          table: 'ci.notes',
          row: { id: freshId, title: 'from-ndjson-stream', user_id: testUserId },
        },
      ];
      const text = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
      const req = {
        setEncoding: () => undefined,

        [Symbol.asyncIterator]: async function* () {
          yield text;
        },
      } as never;

      const result = await service.importNdjsonStream(
        { userId: testUserId } as never,
        req,
        'jane@example.com',
      );

      expect(result.rowsImported).toBeGreaterThanOrEqual(1);

      const rows = await notesFor();
      expect(rows).toEqual([{ id: freshId, title: 'from-ndjson-stream' }]);
    });

    const streamOf = (records: unknown[]): never => {
      const text = `${records.map((line) => JSON.stringify(line)).join('\n')}\n`;

      return {
        setEncoding: () => undefined,

        [Symbol.asyncIterator]: async function* () {
          yield text;
        },
      } as never;
    };

    const manifest = () => ({
      type: 'manifest',
      version: 1,
      format: 'ndjson',
      exportedAt: new Date().toISOString(),
      userId: testUserId,
      profile: null,
    });

    const receiptOwners = async (receiptId: string) =>
      dataSource.query('SELECT user_id, owner_user_id FROM ci.receipts WHERE receipt_id = $1::uuid', [
        receiptId,
      ]) as Promise<Array<{ user_id: string; owner_user_id: string | null }>>;

    it('an imported row names only the importer, even when the archive names another account (both paths)', async () => {
      noopServices.userService.findById = jest.fn().mockResolvedValue({ email: 'jane@example.com' });

      // ci.receipts carries user_id AND owner_user_id. Before, only one of the
      // two was set to the importer and the other came from the archive, so
      // the row could land in otherUserId's account.
      const viaJson = randomUUID();

      await service.importArchive({ userId: testUserId } as never, {
        version: 1,
        exportedAt: new Date().toISOString(),
        userId: testUserId,
        profile: null,
        tables: {
          'ci.receipts': [{ receipt_id: viaJson, user_id: otherUserId, owner_user_id: otherUserId }],
        },
        fileBlobs: [],
      });

      expect(await receiptOwners(viaJson)).toEqual([{ user_id: testUserId, owner_user_id: testUserId }]);

      const viaStream = randomUUID();

      await service.importNdjsonStream(
        { userId: testUserId } as never,
        streamOf([
          manifest(),
          {
            type: 'row',
            table: 'ci.receipts',
            row: { receipt_id: viaStream, user_id: otherUserId, owner_user_id: otherUserId },
          },
        ]),
        'jane@example.com',
      );

      expect(await receiptOwners(viaStream)).toEqual([{ user_id: testUserId, owner_user_id: testUserId }]);
    });

    it("leaves another account's row alone when only its detected owner names the importer", async () => {
      // user_id says whose row it is; owner_user_id is an attribution. The
      // pre-import delete used to run once per column and took this row too.
      const theirs = randomUUID();

      await dataSource.query(
        'INSERT INTO ci.receipts (receipt_id, user_id, owner_user_id) VALUES ($1::uuid, $2::uuid, $3::uuid)',
        [theirs, otherUserId, testUserId],
      );

      await service.importArchive({ userId: testUserId } as never, {
        version: 1,
        exportedAt: new Date().toISOString(),
        userId: testUserId,
        profile: null,
        tables: {},
        fileBlobs: [],
      });

      expect(await receiptOwners(theirs)).toEqual([{ user_id: otherUserId, owner_user_id: testUserId }]);

      noopServices.userService.findById = jest.fn().mockResolvedValue(null);
      const archive = await service.exportArchive({ userId: testUserId } as never);

      expect(archive.tables['ci.receipts']).toEqual([]);
    });

    it('does not restore a sign-in link or an MCP server, and an older archive carrying them still imports', async () => {
      noopServices.userService.findById = jest.fn().mockResolvedValue({ email: 'jane@example.com' });

      const noteId = randomUUID();

      await service.importNdjsonStream(
        { userId: testUserId } as never,
        streamOf([
          manifest(),
          {
            type: 'row',
            table: 'ci.federated_identities',
            row: { user_id: testUserId, issuer: 'https://idp.example.com', subject: `sub-${noteId}` },
          },
          {
            type: 'row',
            table: 'ci.mcp_server_configs',
            row: {
              id: randomUUID(),
              user_id: testUserId,
              name: 'Archived server',
              slug: `archived-${noteId.slice(0, 8)}`,
              transport: 'stdio',
              command: 'true',
              enabled: true,
            },
          },
          { type: 'row', table: 'ci.notes', row: { id: noteId, title: 'kept', user_id: testUserId } },
        ]),
        'jane@example.com',
      );

      const [identities] = await dataSource.query(
        'SELECT count(*)::int AS n FROM ci.federated_identities WHERE user_id = $1::uuid',
        [testUserId],
      );
      const [servers] = await dataSource.query(
        'SELECT count(*)::int AS n FROM ci.mcp_server_configs WHERE user_id = $1::uuid',
        [testUserId],
      );

      expect(identities.n).toBe(0);
      expect(servers.n).toBe(0);
      expect(await notesFor()).toEqual([{ id: noteId, title: 'kept' }]);
    });

    it('restores a row before the rows that reference it, though they sort first', async () => {
      // ci.messages.thread_id -> ci.threads is checked at once, and "messages" < "threads".
      const threadId = randomUUID();
      const messageId = randomUUID();

      await service.importArchive(
        { userId: testUserId } as never,
        {
          version: 1,
          exportedAt: new Date().toISOString(),
          userId: testUserId,
          profile: null,
          tables: {
            'ci.messages': [{ message_id: messageId, thread_id: threadId, role: 'user', content: 'hello' }],
            'ci.threads': [{ thread_id: threadId, title: 'Trip' }],
          },
          fileBlobs: [],
        } as UserDataArchive,
      );

      const [row] = await dataSource.query('SELECT thread_id FROM ci.messages WHERE message_id = $1::uuid', [
        messageId,
      ]);
      expect(row.thread_id).toBe(threadId);
    });

    it('restores a row whose export carries a value for a generated column', async () => {
      // ci.messages.total_tokens is GENERATED ALWAYS; an INSERT that names it is refused.
      const threadId = randomUUID();
      const messageId = randomUUID();

      await service.importArchive(
        { userId: testUserId } as never,
        {
          version: 1,
          exportedAt: new Date().toISOString(),
          userId: testUserId,
          profile: null,
          tables: {
            'ci.threads': [{ thread_id: threadId, title: 'Trip' }],
            'ci.messages': [
              {
                message_id: messageId,
                thread_id: threadId,
                role: 'user',
                content: 'hello',
                total_tokens: 12,
                search_vector: "'hello':1",
              },
            ],
          },
          fileBlobs: [],
        } as UserDataArchive,
      );

      const [row] = await dataSource.query('SELECT content FROM ci.messages WHERE message_id = $1::uuid', [
        messageId,
      ]);
      expect(row.content).toBe('hello');
    });

    describe('the person the account itself is', () => {
      // Every onboarded account has one, and ci.users.entity_id points at it with a
      // NO ACTION foreign key that the app's role cannot defer or switch off.
      const selfId = randomUUID();
      const selfRow = {
        entity_id: selfId,
        entity_type: 'Person',
        owner_user_id: testUserId,
        name: 'Jane',
      };

      const selfPointer = async (): Promise<string | null> => {
        const [row] = await dataSource.query('SELECT entity_id FROM ci.users WHERE id = $1::uuid', [
          testUserId,
        ]);

        return row.entity_id;
      };

      beforeEach(async () => {
        noopServices.userService.findById = jest.fn().mockResolvedValue({ email: 'jane@example.com' });
        await dataSource.query(
          `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1::uuid, 'Person', $2::uuid, 'Jane')`,
          [selfId, testUserId],
        );
        await dataSource.query('UPDATE ci.users SET entity_id = $2::uuid WHERE id = $1::uuid', [
          testUserId,
          selfId,
        ]);
      });

      it('imports an export of the same account and points the account back at that person', async () => {
        const result = await service.importNdjsonStream(
          { userId: testUserId } as never,
          streamOf([
            { ...manifest(), profile: { id: testUserId, entityId: selfId } },
            { type: 'row', table: 'ci.entities', row: selfRow },
          ]),
          'jane@example.com',
        );

        expect(result.rowsImported).toBeGreaterThanOrEqual(1);
        expect(await selfPointer()).toBe(selfId);
      });

      it('does the same on the legacy json path', async () => {
        await service.importArchive(
          { userId: testUserId } as never,
          {
            version: 1,
            exportedAt: new Date().toISOString(),
            userId: testUserId,
            profile: { entityId: selfId } as never,
            tables: { 'ci.entities': [selfRow] },
            fileBlobs: [],
          } as UserDataArchive,
        );

        expect(await selfPointer()).toBe(selfId);
      });

      it('leaves the pointer empty when the archive does not bring that person back', async () => {
        await service.importNdjsonStream(
          { userId: testUserId } as never,
          streamOf([manifest(), { type: 'row', table: 'ci.notes', row: { id: randomUUID(), title: 'n' } }]),
          'jane@example.com',
        );

        expect(await selfPointer()).toBeNull();
      });
    });

    it('keeps the sign-in links the account already has across an import', async () => {
      // Excluded tables are neither deleted nor restored: an import must not
      // sign the owner out of CI-Portal either.
      await dataSource.query(
        'INSERT INTO ci.federated_identities (user_id, issuer, subject) VALUES ($1::uuid, $2, $3)',
        [testUserId, 'https://idp.example.com', `kept-${testUserId}`],
      );

      await service.importArchive({ userId: testUserId } as never, {
        version: 1,
        exportedAt: new Date().toISOString(),
        userId: testUserId,
        profile: null,
        tables: {},
        fileBlobs: [],
      });

      const [identities] = await dataSource.query(
        'SELECT count(*)::int AS n FROM ci.federated_identities WHERE user_id = $1::uuid',
        [testUserId],
      );

      expect(identities.n).toBe(1);
    });
  },
);
