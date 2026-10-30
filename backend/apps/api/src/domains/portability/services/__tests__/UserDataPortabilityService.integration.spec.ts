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
      await dataSource.query('DELETE FROM ci.objects WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.receipts WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.product_models WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.federated_identities WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.mcp_server_configs WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.messages WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.threads WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.agent_jobs WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.content WHERE user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.events WHERE user_id = ANY($1::uuid[])', [users]);
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

    it('restores an object and the receipt line it was minted from, though each names the other', async () => {
      // ci.objects.acquisition_line_item_id and ci.receipt_line_items.minted_object_id
      // are both checked at once, so whichever table goes first names a row
      // that is not in yet. Every receipt-minted object has both.
      const receiptId = randomUUID();
      const lineItemId = randomUUID();
      const objectId = randomUUID();

      await service.importArchive(
        { userId: testUserId } as never,
        {
          version: 1,
          exportedAt: new Date().toISOString(),
          userId: testUserId,
          profile: null,
          tables: {
            'ci.entities': [{ entity_id: objectId, entity_type: 'Item', name: 'Kettle' }],
            'ci.receipts': [{ receipt_id: receiptId }],
            'ci.receipt_line_items': [
              {
                line_item_id: lineItemId,
                receipt_id: receiptId,
                line_number: 1,
                description: 'Kettle',
                minted_object_id: objectId,
              },
            ],
            'ci.objects': [{ object_id: objectId, acquisition_line_item_id: lineItemId }],
          },
          fileBlobs: [],
        } as UserDataArchive,
      );

      const [object] = await dataSource.query(
        'SELECT acquisition_line_item_id FROM ci.objects WHERE object_id = $1::uuid',
        [objectId],
      );
      const [line] = await dataSource.query(
        'SELECT minted_object_id FROM ci.receipt_line_items WHERE line_item_id = $1::uuid',
        [lineItemId],
      );

      expect(object.acquisition_line_item_id).toBe(lineItemId);
      expect(line.minted_object_id).toBe(objectId);
    });

    describe('rows of one table that point at each other', () => {
      // An export lists rows in storage order. Edit a message after it was
      // answered and its row moves after the reply, so the reply comes first and
      // names a parent the import has not inserted yet.
      const threadId = randomUUID();
      const parentId = randomUUID();
      const replyId = randomUUID();

      beforeEach(() => {
        noopServices.userService.findById = jest.fn().mockResolvedValue({ email: 'jane@example.com' });
      });

      const parentOf = async (messageId: string): Promise<string | null> => {
        const [row] = await dataSource.query(
          'SELECT parent_message_id FROM ci.messages WHERE message_id = $1::uuid',
          [messageId],
        );

        return row?.parent_message_id ?? null;
      };

      it('restores a reply listed before the message it answers, with the link', async () => {
        const result = await service.importNdjsonStream(
          { userId: testUserId } as never,
          streamOf([
            manifest(),
            { type: 'row', table: 'ci.threads', row: { thread_id: threadId, title: 'Trip' } },
            {
              type: 'row',
              table: 'ci.messages',
              row: {
                message_id: replyId,
                thread_id: threadId,
                role: 'assistant',
                content: 'a',
                parent_message_id: parentId,
              },
            },
            {
              type: 'row',
              table: 'ci.messages',
              row: { message_id: parentId, thread_id: threadId, role: 'user', content: 'q, edited' },
            },
          ]),
          'jane@example.com',
        );

        expect(result.rowsImported).toBe(3);
        expect(await parentOf(replyId)).toBe(parentId);
      });

      it('restores two places of one name under different parents', async () => {
        // entities_admin_place_uniq keys on COALESCE(parent_place_id, ...), so
        // two Springfields with their parents emptied on insert collide.
        const regions = [randomUUID(), randomUUID()];
        const cities = [randomUUID(), randomUUID()];
        const place = (entityId: string, name: string, placeKind: string, parentPlaceId: string | null) => ({
          entity_id: entityId,
          entity_type: 'Location',
          name,
          place_kind: placeKind,
          parent_place_id: parentPlaceId,
        });

        await service.importArchive(
          { userId: testUserId } as never,
          {
            version: 1,
            exportedAt: new Date().toISOString(),
            userId: testUserId,
            profile: null,
            tables: {
              'ci.entities': [
                place(regions[0], 'Illinois', 'region', null),
                place(regions[1], 'Missouri', 'region', null),
                place(cities[0], 'Springfield', 'city', regions[0]),
                place(cities[1], 'Springfield', 'city', regions[1]),
              ],
            },
            fileBlobs: [],
          } as UserDataArchive,
        );

        const rows = (await dataSource.query(
          'SELECT entity_id, parent_place_id FROM ci.entities WHERE entity_id = ANY($1::uuid[])',
          [cities],
        )) as Array<{ entity_id: string; parent_place_id: string }>;

        expect(Object.fromEntries(rows.map((row) => [row.entity_id, row.parent_place_id]))).toEqual({
          [cities[0]]: regions[0],
          [cities[1]]: regions[1],
        });
      });

      it('restores two places of one name listed before their parents', async () => {
        // Updating a region moves it after the cities in it. Inserted with
        // their parents empty, the two Springfields would collide.
        const regions = [randomUUID(), randomUUID()];
        const cities = [randomUUID(), randomUUID()];
        const place = (entityId: string, name: string, placeKind: string, parentPlaceId: string | null) => ({
          entity_id: entityId,
          entity_type: 'Location',
          name,
          place_kind: placeKind,
          parent_place_id: parentPlaceId,
        });

        await service.importArchive(
          { userId: testUserId } as never,
          {
            version: 1,
            exportedAt: new Date().toISOString(),
            userId: testUserId,
            profile: null,
            tables: {
              'ci.entities': [
                place(cities[0], 'Springfield', 'city', regions[0]),
                place(cities[1], 'Springfield', 'city', regions[1]),
                place(regions[0], 'Illinois', 'region', null),
                place(regions[1], 'Missouri', 'region', null),
              ],
            },
            fileBlobs: [],
          } as UserDataArchive,
        );

        const rows = (await dataSource.query(
          'SELECT entity_id, parent_place_id FROM ci.entities WHERE entity_id = ANY($1::uuid[])',
          [cities],
        )) as Array<{ entity_id: string; parent_place_id: string }>;

        expect(Object.fromEntries(rows.map((row) => [row.entity_id, row.parent_place_id]))).toEqual({
          [cities[0]]: regions[0],
          [cities[1]]: regions[1],
        });
      });

      it('restores a merged product model listed before the model it was merged into', async () => {
        // product_models_brand_model_uniq covers only unmerged models; with the
        // merge link empty on insert the two would hold the same key.
        const survivor = randomUUID();
        const merged = randomUUID();
        const model = (productId: string, mergedInto: string | null) => ({
          product_id: productId,
          owner_user_id: testUserId,
          title: 'Kettle',
          brand: 'Acme',
          model_number: 'K1',
          merged_into_product_id: mergedInto,
        });

        await service.importNdjsonStream(
          { userId: testUserId } as never,
          streamOf([
            manifest(),
            { type: 'row', table: 'ci.product_models', row: model(merged, survivor) },
            { type: 'row', table: 'ci.product_models', row: model(survivor, null) },
          ]),
          'jane@example.com',
        );

        const [row] = await dataSource.query(
          'SELECT merged_into_product_id FROM ci.product_models WHERE product_id = $1::uuid',
          [merged],
        );

        expect(row.merged_into_product_id).toBe(survivor);
      });

      it("refuses an archive that links a row to another account's row of the same table", async () => {
        const theirThread = randomUUID();
        const theirMessage = randomUUID();

        await dataSource.query(
          'INSERT INTO ci.threads (thread_id, user_id, title) VALUES ($1::uuid, $2::uuid, $3)',
          [theirThread, otherUserId, 'theirs'],
        );
        await dataSource.query(
          `INSERT INTO ci.messages (message_id, user_id, thread_id, role, content) VALUES ($1::uuid, $2::uuid, $3::uuid, 'user', 'theirs')`,
          [theirMessage, otherUserId, theirThread],
        );

        await expect(
          service.importArchive(
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
                    message_id: replyId,
                    thread_id: threadId,
                    role: 'user',
                    content: 'mine',
                    parent_message_id: theirMessage,
                  },
                ],
              },
              fileBlobs: [],
            } as UserDataArchive,
          ),
        ).rejects.toThrow(
          `The archive links ci.messages.parent_message_id to ${theirMessage}, a row of ci.messages that belongs to another account or to none, so it was refused.`,
        );

        expect(
          await dataSource.query('SELECT 1 FROM ci.messages WHERE message_id = $1::uuid', [replyId]),
        ).toHaveLength(0);
        const [theirs] = await dataSource.query(
          'SELECT user_id, content FROM ci.messages WHERE message_id = $1::uuid',
          [theirMessage],
        );
        expect(theirs).toEqual({ user_id: otherUserId, content: 'theirs' });
      });
    });

    describe("links to another account's rows", () => {
      // The archive is the importer's to write. A foreign key only asks that the
      // row it names exists, so naming someone else's thread or place by id used
      // to link it into this account.
      const mine = randomUUID();
      const theirs = randomUUID();
      const relationshipId = randomUUID();

      const seedTheirPlace = () =>
        dataSource.query(
          `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1::uuid, 'Location', $2::uuid, 'Their home')`,
          [theirs, otherUserId],
        );

      const archiveWith = (tables: UserDataArchive['tables']): UserDataArchive => ({
        version: 1,
        exportedAt: new Date().toISOString(),
        userId: testUserId,
        profile: null,
        tables,
        fileBlobs: [],
      });

      const me = { entity_id: mine, entity_type: 'Person', name: 'Me' };
      const knows = (toEntityId: string) => ({
        relationship_id: relationshipId,
        from_entity_id: mine,
        to_entity_id: toEntityId,
        from_entity_type: 'Person',
        to_entity_type: 'Location',
        relationship_type: 'LIVES_AT',
      });

      beforeEach(() => {
        noopServices.userService.findById = jest.fn().mockResolvedValue({ email: 'jane@example.com' });
      });

      it("refuses a message in another account's thread and keeps what the account had", async () => {
        const theirThread = randomUUID();
        const kept = randomUUID();

        await dataSource.query(
          'INSERT INTO ci.threads (thread_id, user_id, title) VALUES ($1::uuid, $2::uuid, $3)',
          [theirThread, otherUserId, 'theirs'],
        );
        await dataSource.query('INSERT INTO ci.notes (id, user_id, title) VALUES ($1::uuid, $2::uuid, $3)', [
          kept,
          testUserId,
          'before the import',
        ]);

        await expect(
          service.importNdjsonStream(
            { userId: testUserId } as never,
            streamOf([
              manifest(),
              {
                type: 'row',
                table: 'ci.messages',
                row: { message_id: randomUUID(), thread_id: theirThread, role: 'user', content: 'planted' },
              },
            ]),
            'jane@example.com',
          ),
        ).rejects.toThrow(
          `The archive links ci.messages.thread_id to ${theirThread}, a row of ci.threads that belongs to another account or to none, so it was refused.`,
        );

        expect(await notesFor()).toEqual([{ id: kept, title: 'before the import' }]);
        const planted = await dataSource.query('SELECT 1 FROM ci.messages WHERE thread_id = $1::uuid', [
          theirThread,
        ]);
        expect(planted).toHaveLength(0);
      });

      it("refuses a relationship to another account's place, though the graph has no foreign key", async () => {
        await seedTheirPlace();

        await expect(
          service.importArchive(
            { userId: testUserId } as never,
            archiveWith({ 'ci.entities': [me], 'ci.relationships': [knows(theirs)] }),
          ),
        ).rejects.toThrow(
          `The archive links ci.relationships.to_entity_id to ${theirs}, a row of ci.entities that belongs to another account or to none, so it was refused.`,
        );

        const linked = await dataSource.query(
          'SELECT 1 FROM ci.relationships WHERE to_entity_id = $1::uuid',
          [theirs],
        );
        expect(linked).toHaveLength(0);
      });

      it('refuses a relationship to a place no account owns, as a deleted account leaves its rows', async () => {
        const leftBehind = randomUUID();

        // owner_user_id is ON DELETE SET NULL: what a purge missed keeps its row and loses its owner.
        await dataSource.query(
          `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1::uuid, 'Location', NULL, 'Left behind')`,
          [leftBehind],
        );

        try {
          await expect(
            service.importArchive(
              { userId: testUserId } as never,
              archiveWith({ 'ci.entities': [me], 'ci.relationships': [knows(leftBehind)] }),
            ),
          ).rejects.toThrow(
            `The archive links ci.relationships.to_entity_id to ${leftBehind}, a row of ci.entities that belongs to another account or to none, so it was refused.`,
          );
        } finally {
          await dataSource.query('DELETE FROM ci.entities WHERE entity_id = $1::uuid', [leftBehind]);
        }
      });

      it('refuses a place inside a place no account owns, a link set once every row is in', async () => {
        const leftBehind = randomUUID();
        const town = randomUUID();

        await dataSource.query(
          `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1::uuid, 'Location', NULL, 'Left behind')`,
          [leftBehind],
        );

        try {
          await expect(
            service.importArchive(
              { userId: testUserId } as never,
              archiveWith({
                'ci.entities': [
                  { entity_id: town, entity_type: 'Location', name: 'Town', parent_place_id: leftBehind },
                ],
              }),
            ),
          ).rejects.toThrow(
            `The archive links ci.entities.parent_place_id to ${leftBehind}, a row of ci.entities that belongs to another account or to none, so it was refused.`,
          );
        } finally {
          await dataSource.query('DELETE FROM ci.entities WHERE entity_id = $1::uuid', [leftBehind]);
        }
      });

      it("refuses an agent job on another account's thread, though that column has no key", async () => {
        const theirThread = randomUUID();

        await dataSource.query(
          'INSERT INTO ci.threads (thread_id, user_id, title) VALUES ($1::uuid, $2::uuid, $3)',
          [theirThread, otherUserId, 'theirs'],
        );

        await expect(
          service.importArchive(
            { userId: testUserId } as never,
            archiveWith({ 'ci.agent_jobs': [{ id: randomUUID(), thread_id: theirThread }] }),
          ),
        ).rejects.toThrow(
          `The archive links ci.agent_jobs.thread_id to ${theirThread}, a row of ci.threads that belongs to another account or to none, so it was refused.`,
        );
      });

      it("refuses a product model whose picture is another account's content, though that column has no key", async () => {
        const theirPhoto = randomUUID();

        // A content row stands on its entity (content_id_entities_fk).
        await dataSource.query(
          `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1::uuid, 'Content', $2::uuid, 'Their photo')`,
          [theirPhoto, otherUserId],
        );
        await dataSource.query('INSERT INTO ci.content (id, user_id) VALUES ($1::uuid, $2::uuid)', [
          theirPhoto,
          otherUserId,
        ]);

        await expect(
          service.importArchive(
            { userId: testUserId } as never,
            archiveWith({
              'ci.product_models': [
                {
                  product_id: randomUUID(),
                  owner_user_id: testUserId,
                  title: 'Kettle',
                  image_content_id: theirPhoto,
                },
              ],
            }),
          ),
        ).rejects.toThrow(
          `The archive links ci.product_models.image_content_id to ${theirPhoto}, a row of ci.content that belongs to another account or to none, so it was refused.`,
        );
      });

      it("refuses an event whose participants include another account's person", async () => {
        await seedTheirPlace();

        await expect(
          service.importArchive(
            { userId: testUserId } as never,
            archiveWith({
              'ci.entities': [me],
              'ci.events': [
                {
                  event_id: randomUUID(),
                  start_time: new Date().toISOString(),
                  participant_entity_ids: `{${mine},${theirs}}`,
                },
              ],
            }),
          ),
        ).rejects.toThrow(
          `The archive links ci.events.participant_entity_ids to ${theirs}, a row of ci.entities that belongs to another account or to none, so it was refused.`,
        );
      });

      it("imports the account's own links and one to an id that names no row", async () => {
        const place = { entity_id: theirs, entity_type: 'Location', name: 'My home' };

        await service.importArchive(
          { userId: testUserId } as never,
          archiveWith({ 'ci.entities': [me, place], 'ci.relationships': [knows(theirs)] }),
        );
        expect(
          await dataSource.query(
            'SELECT to_entity_id FROM ci.relationships WHERE relationship_id = $1::uuid',
            [relationshipId],
          ),
        ).toEqual([{ to_entity_id: theirs }]);

        // A column with no key can hold an id whose row is gone; that is no one else's row.
        const gone = randomUUID();

        await service.importArchive(
          { userId: testUserId } as never,
          archiveWith({ 'ci.entities': [me], 'ci.relationships': [knows(gone)] }),
        );
        expect(
          await dataSource.query(
            'SELECT to_entity_id FROM ci.relationships WHERE relationship_id = $1::uuid',
            [relationshipId],
          ),
        ).toEqual([{ to_entity_id: gone }]);
      });
    });

    describe('links that hang off the account rows without a user column', () => {
      // A tag on an event (ci_search.entity_tag) and HBPE's cluster of it
      // (hbpe.l1_event_cluster) both refuse the delete of what they point at,
      // and an archive carries neither.
      const eventId = randomUUID();
      const tagId = randomUUID();
      const clusterId = randomUUID();
      const eventRows = {
        'ci.entities': [{ entity_id: eventId, entity_type: 'Event', name: 'Trip to Leeds' }],
        'ci.events': [{ event_id: eventId, start_time: new Date().toISOString() }],
        'ci_search.tags': [{ id: tagId, label: 'travel' }],
        'hbpe.l1_clusters': [{ cluster_id: clusterId, l0_class: 'calendar', label: 'trips' }],
      };

      const links = async () =>
        Promise.all([
          dataSource.query('SELECT entity_id::text FROM ci_search.entity_tag WHERE tag_id = $1::uuid', [
            tagId,
          ]),
          dataSource.query('SELECT cluster_id::text FROM hbpe.l1_event_cluster WHERE event_id = $1::uuid', [
            eventId,
          ]),
        ]);

      beforeEach(async () => {
        noopServices.userService.findById = jest.fn().mockResolvedValue({ email: 'jane@example.com' });
        await dataSource.query(
          `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1::uuid, 'Event', $2::uuid, 'Trip to Leeds')`,
          [eventId, testUserId],
        );
        await dataSource.query(
          'INSERT INTO ci.events (event_id, user_id, start_time) VALUES ($1::uuid, $2::uuid, NOW())',
          [eventId, testUserId],
        );
        await dataSource.query(
          `INSERT INTO ci_search.tags (id, user_id, label) VALUES ($1::uuid, $2::uuid, 'travel')`,
          [tagId, testUserId],
        );
        await dataSource.query(
          `INSERT INTO ci_search.entity_tag (entity_type, entity_id, tag_id) VALUES ('Event', $1::uuid, $2::uuid)`,
          [eventId, tagId],
        );
        await dataSource.query(
          `INSERT INTO hbpe.l1_clusters (cluster_id, user_id, l0_class, label) VALUES ($1::uuid, $2::uuid, 'calendar', 'trips')`,
          [clusterId, testUserId],
        );
        await dataSource.query(
          'INSERT INTO hbpe.l1_event_cluster (event_id, cluster_id, similarity) VALUES ($1::uuid, $2::uuid, 0.9)',
          [eventId, clusterId],
        );
      });

      afterEach(async () => {
        await dataSource.query('DELETE FROM ci_search.entity_tag WHERE tag_id = $1::uuid', [tagId]);
        await dataSource.query('DELETE FROM hbpe.l1_event_cluster WHERE event_id = $1::uuid', [eventId]);
        await dataSource.query('DELETE FROM hbpe.l1_clusters WHERE cluster_id = $1::uuid', [clusterId]);
        await dataSource.query('DELETE FROM ci_search.tags WHERE id = $1::uuid', [tagId]);
        await dataSource.query('DELETE FROM ci.events WHERE event_id = $1::uuid', [eventId]);
      });

      it('imports an export of the same account and keeps the tag and the cluster', async () => {
        await service.importNdjsonStream(
          { userId: testUserId } as never,
          streamOf([
            manifest(),
            ...Object.entries(eventRows).flatMap(([table, rows]) =>
              rows.map((row) => ({ type: 'row', table, row })),
            ),
          ]),
          'jane@example.com',
        );

        expect(await links()).toEqual([[{ entity_id: eventId }], [{ cluster_id: clusterId }]]);
      });

      it('reports no left-out links when every one came back', async () => {
        const warn = jest.fn();
        const quiet = noopServices.logger.warn;
        noopServices.logger.warn = warn;

        try {
          await service.importArchive(
            { userId: testUserId } as never,
            {
              version: 1,
              exportedAt: new Date().toISOString(),
              userId: testUserId,
              profile: null,
              tables: eventRows,
              fileBlobs: [],
            } as UserDataArchive,
          );
        } finally {
          noopServices.logger.warn = quiet;
        }

        expect(await links()).toEqual([[{ entity_id: eventId }], [{ cluster_id: clusterId }]]);
        expect(warn).not.toHaveBeenCalled();
      });

      it("keeps a chat message's attachment, which the delete would take by cascade", async () => {
        const threadId = randomUUID();
        const messageId = randomUUID();
        const fileId = randomUUID();

        await dataSource.query(
          'INSERT INTO ci.threads (thread_id, user_id, title) VALUES ($1::uuid, $2::uuid, $3)',
          [threadId, testUserId, 'Trip'],
        );
        await dataSource.query(
          `INSERT INTO ci.messages (message_id, user_id, thread_id, role, content) VALUES ($1::uuid, $2::uuid, $3::uuid, 'user', 'see attached')`,
          [messageId, testUserId, threadId],
        );
        await dataSource.query(
          `INSERT INTO ci.files (id, user_id, content_type, filename) VALUES ($1::uuid, $2::uuid, 'image/png', 'ticket.png')`,
          [fileId, testUserId],
        );
        await dataSource.query(
          'INSERT INTO ci.message_files (message_id, file_id) VALUES ($1::uuid, $2::uuid)',
          [messageId, fileId],
        );

        try {
          await service.importNdjsonStream(
            { userId: testUserId } as never,
            streamOf([
              manifest(),
              { type: 'row', table: 'ci.threads', row: { thread_id: threadId, title: 'Trip' } },
              {
                type: 'row',
                table: 'ci.messages',
                row: { message_id: messageId, thread_id: threadId, role: 'user', content: 'see attached' },
              },
              {
                type: 'row',
                table: 'ci.files',
                row: { id: fileId, content_type: 'image/png', filename: 'ticket.png' },
              },
            ]),
            'jane@example.com',
          );

          const attachments = await dataSource.query(
            'SELECT file_id::text FROM ci.message_files WHERE message_id = $1::uuid',
            [messageId],
          );
          expect(attachments).toEqual([{ file_id: fileId }]);
        } finally {
          await dataSource.query('DELETE FROM ci.message_files WHERE message_id = $1::uuid', [messageId]);
          await dataSource.query('DELETE FROM ci.files WHERE id = $1::uuid', [fileId]);
        }
      });

      it('leaves out the links whose rows the archive does not bring back (legacy path)', async () => {
        await service.importArchive(
          { userId: testUserId } as never,
          {
            version: 1,
            exportedAt: new Date().toISOString(),
            userId: testUserId,
            profile: null,
            // The event and its tag are back; the cluster is not.
            tables: {
              'ci.entities': eventRows['ci.entities'],
              'ci.events': eventRows['ci.events'],
              'ci_search.tags': eventRows['ci_search.tags'],
            },
            fileBlobs: [],
          } as UserDataArchive,
        );

        expect(await links()).toEqual([[{ entity_id: eventId }], []]);
      });
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

      it('ignores a profile entityId that is not a string on the legacy path', async () => {
        await service.importArchive(
          { userId: testUserId } as never,
          {
            version: 1,
            exportedAt: new Date().toISOString(),
            userId: testUserId,
            profile: { entityId: { not: 'an id' } } as never,
            tables: { 'ci.entities': [selfRow] },
            fileBlobs: [],
          } as UserDataArchive,
        );

        // The previous pointer is the fallback, and the archive brought that person back.
        expect(await selfPointer()).toBe(selfId);
      });

      it('ignores a profile entityId that is not a uuid instead of failing the import', async () => {
        await service.importArchive(
          { userId: testUserId } as never,
          {
            version: 1,
            exportedAt: new Date().toISOString(),
            userId: testUserId,
            profile: { entityId: 'not-a-uuid' } as never,
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
