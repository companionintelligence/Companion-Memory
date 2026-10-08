import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import type { DataSource, QueryRunner } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import type { FileService } from '@ci/domains/files';
import type { UserService } from '@ci/domains/user';

import { UserDataPortabilityService } from '../UserDataPortabilityService';

describe('UserDataPortabilityService', () => {
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    query: jest.fn(),
  } as unknown as QueryRunner;

  const dataSource = {
    query: jest.fn(),
    createQueryRunner: jest.fn(() => queryRunner),
  } as unknown as DataSource;

  const fileService = {
    getFileContent: jest.fn(),
    putObject: jest.fn(),
  } as unknown as FileService;

  const userService = {
    findById: jest.fn(),
  } as unknown as UserService;

  const logger = {
    setContext: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as unknown as LoggerService;

  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  let service: UserDataPortabilityService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UserDataPortabilityService(dataSource, fileService, userService, logger);
  });

  it('exports discovered user tables and profile metadata', async () => {
    dataSource.query = jest
      .fn()
      .mockResolvedValueOnce([{ schema: 'ci', table: 'notes', user_column: 'user_id' }])
      .mockResolvedValueOnce([{ id: 'n1', title: 'Hello', user_id: 'user-1' }]);

    userService.findById = jest.fn().mockResolvedValue({
      id: 'user-1',
      name: 'Jane',
      email: 'jane@example.com',
      entityId: null,
      onboarded: true,
      onboardedAt: null,
      timezone: 'UTC',
      timeFormat: 'h23',
      onboardingProgress: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const archive = await service.exportArchive({ userId: 'user-1' } as never);

    expect(archive.version).toBe(1);
    expect(archive.userId).toBe('user-1');
    expect(archive.profile?.email).toBe('jane@example.com');
    expect(archive.profile?.timeFormat).toBe('h23');
    expect(archive.tables['ci.notes']).toEqual([{ id: 'n1', title: 'Hello', user_id: 'user-1' }]);
    expect(archive.fileBlobs).toEqual([]);
  });

  it('rejects archives exported for a different account', async () => {
    await expect(
      service.importArchive({ userId: 'user-1' } as never, {
        version: 1,
        exportedAt: new Date().toISOString(),
        userId: 'other-user',
        profile: null,
        tables: {},
        fileBlobs: [],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('importArchive — transaction boundary', () => {
    /**
     * The transactional commit/rollback semantics themselves (does a real
     * Postgres actually undo the delete on a failed insert) are checked
     * against a live database in UserDataPortabilityService.integration.spec.ts.
     * These tests pin the SERVICE's half of the contract: it must call
     * commit/rollback in the right circumstance and in the right order
     * relative to delete/insert, which a real-DB test alone would not
     * localize a regression to.
     */
    it('deletes discovered tables in reverse order, inserts in forward order, then commits once', async () => {
      dataSource.query = jest.fn().mockResolvedValue([
        { schema: 'ci', table: 'notes', user_column: 'user_id', columns: ['id', 'user_id'] },
        { schema: 'ci', table: 'events', user_column: 'user_id', columns: ['id', 'user_id'] },
      ]);

      const calls: string[] = [];
      queryRunner.query = jest.fn(async (sql: string) => {
        calls.push(sql);

        return undefined;
      }) as unknown as QueryRunner['query'];

      await service.importArchive({ userId: 'user-1' } as never, {
        version: 1,
        exportedAt: new Date().toISOString(),
        userId: 'user-1',
        profile: null,
        tables: {
          'ci.notes': [{ id: 'n1', user_id: 'user-1' }],
          'ci.events': [{ id: 'e1', user_id: 'user-1' }],
        },
        fileBlobs: [],
      });

      const indexOf = (predicate: (sql: string) => boolean) => calls.findIndex(predicate);
      const deleteEvents = indexOf((sql) => sql.startsWith('DELETE') && sql.includes('"events"'));
      const deleteNotes = indexOf((sql) => sql.startsWith('DELETE') && sql.includes('"notes"'));
      const insertNotes = indexOf((sql) => sql.startsWith('INSERT') && sql.includes('"notes"'));
      const insertEvents = indexOf((sql) => sql.startsWith('INSERT') && sql.includes('"events"'));

      expect([deleteEvents, deleteNotes, insertNotes, insertEvents]).not.toContain(-1);
      // Discovery order is [notes, events]. Deletes run in the REVERSE of
      // discovery order (events, then notes) so a table with an FK into an
      // earlier-discovered one is cleared first; inserts restore in
      // discovery order, and both deletes finish before any insert starts.
      expect(deleteEvents).toBeLessThan(deleteNotes);
      expect(deleteNotes).toBeLessThan(insertNotes);
      expect(insertNotes).toBeLessThan(insertEvents);

      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalledTimes(1);
    });

    it('rolls back and rethrows when an insert fails mid-import, and never commits', async () => {
      dataSource.query = jest
        .fn()
        .mockResolvedValue([
          { schema: 'ci', table: 'notes', user_column: 'user_id', columns: ['id', 'user_id'] },
        ]);

      queryRunner.query = jest.fn((sql: string) => {
        if (sql.startsWith('INSERT')) {
          return Promise.reject(new Error('constraint violation'));
        }

        return Promise.resolve(undefined);
      }) as unknown as QueryRunner['query'];

      await expect(
        service.importArchive({ userId: 'user-1' } as never, {
          version: 1,
          exportedAt: new Date().toISOString(),
          userId: 'user-1',
          profile: null,
          tables: { 'ci.notes': [{ id: 'n1', user_id: 'user-1' }] },
          fileBlobs: [],
        }),
      ).rejects.toThrow('constraint violation');

      // The delete already ran (it's earlier in the sequence than the
      // failing insert) — commit must NOT happen, or the delete half of
      // "delete-then-restore" would be a permanent, uncommitted-restore
      // data loss instead of an all-or-nothing operation.
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('importArchive — archive keys become SQL identifiers', () => {
    const discovery = [
      { schema: 'ci', table: 'notes', user_column: 'user_id', columns: ['id', 'title', 'user_id'] },
    ];

    const archiveWith = (row: Record<string, unknown>) => ({
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      userId: 'user-1',
      profile: null,
      tables: { 'ci.notes': [row] },
      fileBlobs: [],
    });

    it('refuses a row naming a column the table does not have, before any INSERT is built', async () => {
      dataSource.query = jest.fn().mockResolvedValue(discovery);
      const calls: string[] = [];
      queryRunner.query = jest.fn(async (sql: string) => {
        calls.push(sql);

        return undefined;
      }) as unknown as QueryRunner['query'];

      // The pre-fix code interpolated every archive key as `"${key}"`, so a key
      // carrying a double quote closed the identifier and the rest of the key
      // ran as SQL (bound values kept it to one statement, but a data-modifying
      // CTE is one statement). The allowlist rejects it by name; the quoting
      // helper would have neutralised the quote even if it had not.
      const hostile =
        "title\") WITH w AS (UPDATE ci.users SET role = 'admin' RETURNING 1) SELECT $1, $2, $3 FROM w --";

      await expect(
        service.importArchive(
          { userId: 'user-1' } as never,
          archiveWith({ id: 'n1', [hostile]: 'x', user_id: 'user-1' }),
        ),
      ).rejects.toThrow(BadRequestException);

      expect(calls.some((sql) => sql.startsWith('INSERT'))).toBe(false);
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    });

    it('reports schema drift by column name, bounded, without echoing the whole key', async () => {
      dataSource.query = jest.fn().mockResolvedValue(discovery);
      queryRunner.query = jest.fn().mockResolvedValue(undefined) as unknown as QueryRunner['query'];

      const longKey = `body_${'x'.repeat(200)}`;

      await expect(
        service.importArchive(
          { userId: 'user-1' } as never,
          archiveWith({ id: 'n1', archived_at: null, [longKey]: 1, user_id: 'user-1' }),
        ),
      ).rejects.toThrow(/ci\.notes names column\(s\) that do not exist: "archived_at", "body_x{75}…"/);
    });

    it('quotes every identifier it does interpolate, so a catalog name with a quote cannot break out', async () => {
      // Not a name Postgres would ever hand back for this schema — the point is
      // that the identifier position is safe on its own, independent of the
      // allowlist that already stops archive keys from reaching it.
      dataSource.query = jest
        .fn()
        .mockResolvedValue([
          { schema: 'ci', table: 'notes', user_column: 'user_id', columns: ['id', 'odd"name', 'user_id'] },
        ]);
      const calls: string[] = [];
      queryRunner.query = jest.fn(async (sql: string) => {
        calls.push(sql);

        return undefined;
      }) as unknown as QueryRunner['query'];

      await service.importArchive(
        { userId: 'user-1' } as never,
        archiveWith({ id: 'n1', 'odd"name': 'v', user_id: 'user-1' }),
      );

      const insert = calls.find((sql) => sql.startsWith('INSERT'));
      expect(insert).toBe('INSERT INTO "ci"."notes" ("id", "odd""name", "user_id") VALUES ($1, $2, $3)');
    });

    it('fails closed when discovery reports no column list for a table', async () => {
      dataSource.query = jest
        .fn()
        .mockResolvedValue([{ schema: 'ci', table: 'notes', user_column: 'user_id' }]);
      const calls: string[] = [];
      queryRunner.query = jest.fn(async (sql: string) => {
        calls.push(sql);

        return undefined;
      }) as unknown as QueryRunner['query'];

      await expect(
        service.importArchive({ userId: 'user-1' } as never, archiveWith({ id: 'n1', user_id: 'user-1' })),
      ).rejects.toThrow(BadRequestException);
      expect(calls.some((sql) => sql.startsWith('INSERT'))).toBe(false);
    });
  });

  describe('archive file keys never reach object storage or a files row unchanged', () => {
    const USER_ID = '11111111-1111-4111-8111-111111111111';
    const OTHER_USERS_KEY = '22222222-2222-4222-8222-222222222222';
    const OWNED_KEY = '33333333-3333-4333-8333-333333333333';

    const filesDiscovery = [
      { schema: 'ci', table: 'files', user_column: 'user_id', columns: ['id', 'bucket', 'key', 'user_id'] },
    ];

    function fakeRequest(lines: unknown[]): Request {
      const text = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;

      return {
        setEncoding: () => undefined,

        [Symbol.asyncIterator]: async function* () {
          yield text;
        },
      } as unknown as Request;
    }

    const manifest = {
      type: 'manifest',
      version: 1,
      format: 'ndjson',
      exportedAt: new Date().toISOString(),
      userId: USER_ID,
      profile: null,
    };

    const chunkFor = (key: string, bucket = 'somebody-elses-bucket') => ({
      type: 'file-chunk',
      id: 'f1',
      bucket,
      key,
      index: 0,
      total: 1,
      data: Buffer.from('bytes').toString('base64'),
    });

    /** Records every INSERT's parameters and answers the owned-keys snapshot. */
    function recordingRunner(ownedKeys: string[]) {
      const inserts: Array<{ sql: string; params: unknown[] }> = [];

      queryRunner.query = jest.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT key FROM ci.files')) {
          return ownedKeys.map((key) => ({ key }));
        }

        if (sql.startsWith('INSERT')) {
          inserts.push({ sql, params: params ?? [] });
        }

        return undefined;
      }) as unknown as QueryRunner['query'];

      return inserts;
    }

    beforeEach(() => {
      userService.findById = jest.fn().mockResolvedValue({ email: 'jane@example.com' });
      dataSource.query = jest.fn().mockResolvedValue(filesDiscovery);
      fileService.putObject = jest.fn().mockResolvedValue(undefined);
    });

    it('replaces a key this account never owned with a fresh one — and the row and its bytes agree on it, whichever arrives first', async () => {
      const inserts = recordingRunner([]);

      // Chunk BEFORE row: the export writes rows first, but the import must not
      // depend on that.
      const req = fakeRequest([
        manifest,
        chunkFor(OTHER_USERS_KEY),
        {
          type: 'row',
          table: 'ci.files',
          row: { id: 'f1', bucket: 'somebody-elses-bucket', key: OTHER_USERS_KEY },
        },
      ]);

      await service.importNdjsonStream({ userId: USER_ID } as never, req, 'jane@example.com');

      const [, writtenBucket, writtenKey] = (fileService.putObject as jest.Mock).mock.calls[0] as [
        unknown,
        string,
        string,
      ];
      expect(writtenBucket).toBe(config.staticfiles.bucket);
      expect(writtenKey).toMatch(UUID_V4);
      expect(writtenKey).not.toBe(OTHER_USERS_KEY);

      // The files row was rewritten to the same minted key and to this
      // appliance's bucket, so the pointer and the object stay consistent and
      // the foreign key is gone from the account entirely.
      const filesInsert = inserts.find((insert) => insert.sql.includes('"files"'));
      expect(filesInsert?.sql).toBe(
        'INSERT INTO "ci"."files" ("id", "bucket", "key", "user_id") VALUES ($1, $2, $3, $4)',
      );
      expect(filesInsert?.params).toEqual(['f1', config.staticfiles.bucket, writtenKey, USER_ID]);
    });

    it('keeps a key this account already owned on this box, so a same-box restore rewrites its own objects in place', async () => {
      const inserts = recordingRunner([OWNED_KEY]);

      const req = fakeRequest([
        manifest,
        { type: 'row', table: 'ci.files', row: { id: 'f1', bucket: 'whatever', key: OWNED_KEY } },
        chunkFor(OWNED_KEY),
      ]);

      await service.importNdjsonStream({ userId: USER_ID } as never, req, 'jane@example.com');

      const [, , writtenKey] = (fileService.putObject as jest.Mock).mock.calls[0] as [
        unknown,
        string,
        string,
      ];
      expect(writtenKey).toBe(OWNED_KEY);
      expect(inserts.find((insert) => insert.sql.includes('"files"'))?.params).toEqual([
        'f1',
        config.staticfiles.bucket,
        OWNED_KEY,
        USER_ID,
      ]);
    });

    it('takes "owned" from the database before the deletes, never from the archive', async () => {
      const calls: string[] = [];
      queryRunner.query = jest.fn(async (sql: string) => {
        calls.push(sql);

        return sql.includes('SELECT key FROM ci.files') ? [] : undefined;
      }) as unknown as QueryRunner['query'];

      const req = fakeRequest([manifest, chunkFor(OTHER_USERS_KEY)]);

      await service.importNdjsonStream({ userId: USER_ID } as never, req, 'jane@example.com');

      const snapshot = calls.findIndex((sql) => sql.includes('SELECT key FROM ci.files'));
      const firstDelete = calls.findIndex((sql) => sql.startsWith('DELETE'));
      expect(snapshot).toBeGreaterThanOrEqual(0);
      expect(firstDelete).toBeGreaterThan(snapshot);
    });

    it('applies the same rule on the legacy JSON path', async () => {
      const inserts = recordingRunner([OWNED_KEY]);

      await service.importArchive({ userId: USER_ID } as never, {
        version: 1,
        exportedAt: new Date().toISOString(),
        userId: USER_ID,
        profile: null,
        tables: {
          'ci.files': [
            { id: 'f-owned', bucket: 'x', key: OWNED_KEY },
            { id: 'f-foreign', bucket: 'x', key: OTHER_USERS_KEY },
          ],
        },
        fileBlobs: [
          { id: 'f-owned', bucket: 'x', key: OWNED_KEY, contentBase64: Buffer.from('a').toString('base64') },
          {
            id: 'f-foreign',
            bucket: 'x',
            key: OTHER_USERS_KEY,
            contentBase64: Buffer.from('b').toString('base64'),
          },
        ],
      });

      const writes = (fileService.putObject as jest.Mock).mock.calls.map(
        ([, bucket, key]: [unknown, string, string]) => ({ bucket, key }),
      );
      expect(writes.map((write) => write.bucket)).toEqual([
        config.staticfiles.bucket,
        config.staticfiles.bucket,
      ]);
      expect(writes[0].key).toBe(OWNED_KEY);
      expect(writes[1].key).toMatch(UUID_V4);
      expect(writes[1].key).not.toBe(OTHER_USERS_KEY);

      const rowKeys = inserts
        .filter((insert) => insert.sql.includes('"files"'))
        .map((insert) => insert.params[2]);
      expect(rowKeys).toEqual([OWNED_KEY, writes[1].key]);
    });
  });

  describe('importNdjsonStream', () => {
    // The manifest record is zod-validated end to end (portabilityManifestSchema
    // requires `userId` to be a real UUID) — unlike the legacy importArchive
    // path above, which takes a plain TS-typed archive with no runtime schema.
    const USER_ID = '11111111-1111-4111-8111-111111111111';

    function fakeRequest(lines: unknown[]): Request {
      const text = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;

      return {
        setEncoding: () => undefined,

        [Symbol.asyncIterator]: async function* () {
          yield text;
        },
      } as unknown as Request;
    }

    const manifest = (over: Record<string, unknown> = {}) => ({
      type: 'manifest',
      version: 1,
      format: 'ndjson',
      exportedAt: new Date().toISOString(),
      userId: USER_ID,
      profile: null,
      ...over,
    });

    beforeEach(() => {
      userService.findById = jest.fn().mockResolvedValue({ email: 'jane@example.com' });
      queryRunner.query = jest.fn().mockResolvedValue(undefined);
    });

    it('rejects a row record that arrives before the manifest', async () => {
      dataSource.query = jest.fn().mockResolvedValue([]);

      const req = fakeRequest([{ type: 'row', table: 'ci.notes', row: { id: 'n1' } }]);

      await expect(
        service.importNdjsonStream({ userId: USER_ID } as never, req, 'jane@example.com'),
      ).rejects.toThrow('Archive manifest must be the first record');
    });

    it('rejects a second manifest record appearing mid-stream', async () => {
      dataSource.query = jest.fn().mockResolvedValue([]);

      const req = fakeRequest([manifest(), manifest()]);

      await expect(
        service.importNdjsonStream({ userId: USER_ID } as never, req, 'jane@example.com'),
      ).rejects.toThrow('Archive manifest must be the first record');
    });

    it('reassembles a chunked file upload by index, regardless of arrival order', async () => {
      dataSource.query = jest.fn().mockResolvedValue([]);
      fileService.putObject = jest.fn().mockResolvedValue(undefined);

      const chunk0 = Buffer.from('hello ').toString('base64');
      const chunk1 = Buffer.from('world').toString('base64');

      const req = fakeRequest([
        manifest(),
        {
          type: 'file-chunk',
          id: 'f1',
          bucket: 'ci-files',
          key: 'user-1/f1',
          index: 1,
          total: 2,
          data: chunk1,
        },
        {
          type: 'file-chunk',
          id: 'f1',
          bucket: 'ci-files',
          key: 'user-1/f1',
          index: 0,
          total: 2,
          data: chunk0,
        },
      ]);

      const result = await service.importNdjsonStream({ userId: USER_ID } as never, req, 'jane@example.com');

      expect(fileService.putObject).toHaveBeenCalledTimes(1);
      const [, bucket, key, buffer] = (fileService.putObject as jest.Mock).mock.calls[0] as [
        unknown,
        string,
        string,
        Buffer,
      ];
      // Neither the bucket nor the key is the archive's: the bucket is always
      // this appliance's, and a key this account did not already own is
      // replaced by a freshly minted one (see the "archive keys" block below).
      expect(bucket).toBe(config.staticfiles.bucket);
      expect(key).not.toBe('user-1/f1');
      expect(key).toMatch(UUID_V4);
      // Chunks arrived 1-then-0 but must reassemble in INDEX order, not
      // arrival order — a network-level reorder must not corrupt the file.
      expect(buffer.toString('utf8')).toBe('hello world');
      expect(result.filesRestored).toBe(1);
    });

    it('rejects an archive whose file upload never completes (a chunk index never arrives)', async () => {
      dataSource.query = jest.fn().mockResolvedValue([]);

      const req = fakeRequest([
        manifest(),
        {
          type: 'file-chunk',
          id: 'f1',
          bucket: 'ci-files',
          key: 'user-1/f1',
          index: 0,
          total: 2,
          data: Buffer.from('x').toString('base64'),
        },
      ]);

      await expect(
        service.importNdjsonStream({ userId: USER_ID } as never, req, 'jane@example.com'),
      ).rejects.toThrow('Archive is missing one or more file chunks');

      // The delete-then-restore for row tables already ran inside the
      // transaction before this file-completeness check fails at the end —
      // it must not be left committed.
      expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    });
  });

  describe('tables with both user_id and owner_user_id', () => {
    const CALLER = '11111111-1111-4111-8111-111111111111';
    const OTHER = '22222222-2222-4222-8222-222222222222';

    // What the catalog returns for ci.receipts: one row per user column. In
    // catalog order owner_user_id can come either side of user_id, so both
    // orders are exercised.
    const receiptsDiscovery = (order: Array<'user_id' | 'owner_user_id'>) =>
      order.map((column) => ({
        schema: 'ci',
        table: 'receipts',
        user_column: column,
        columns: ['receipt_id', 'user_id', 'owner_user_id', 'merchant_name'],
      }));

    const insertsInto = (table: string) =>
      (queryRunner.query as jest.Mock).mock.calls.filter(
        ([sql]: [string]) => sql.startsWith('INSERT') && sql.includes(`"${table}"`),
      );

    const insertedRow = (call: [string, unknown[]]) => {
      const columns = [...call[0].matchAll(/"([^"]+)"/g)].map((match) => match[1]).slice(2);

      return Object.fromEntries(columns.map((column, index) => [column, call[1][index]]));
    };

    beforeEach(() => {
      queryRunner.query = jest.fn().mockResolvedValue(undefined) as unknown as QueryRunner['query'];
      userService.findById = jest.fn().mockResolvedValue({ email: 'jane@example.com' });
    });

    for (const order of [
      ['user_id', 'owner_user_id'],
      ['owner_user_id', 'user_id'],
    ] as Array<Array<'user_id' | 'owner_user_id'>>) {
      it(`JSON import: names only the importer, and inserts the row once (catalog order ${order.join(', ')})`, async () => {
        dataSource.query = jest.fn().mockResolvedValue(receiptsDiscovery(order));

        await service.importArchive({ userId: CALLER } as never, {
          version: 1,
          exportedAt: new Date().toISOString(),
          userId: CALLER,
          profile: null,
          tables: {
            'ci.receipts': [
              { receipt_id: 'r1', user_id: OTHER, owner_user_id: OTHER, merchant_name: 'Shop' },
            ],
          },
          fileBlobs: [],
        });

        const inserts = insertsInto('receipts');

        expect(inserts).toHaveLength(1);
        expect(insertedRow(inserts[0])).toMatchObject({ user_id: CALLER, owner_user_id: CALLER });
      });

      it(`stream import: names only the importer (catalog order ${order.join(', ')})`, async () => {
        dataSource.query = jest.fn().mockResolvedValue(receiptsDiscovery(order));

        const text = [
          {
            type: 'manifest',
            version: 1,
            format: 'ndjson',
            exportedAt: new Date().toISOString(),
            userId: CALLER,
            profile: null,
          },
          {
            type: 'row',
            table: 'ci.receipts',
            row: { receipt_id: 'r1', user_id: OTHER, owner_user_id: OTHER, merchant_name: 'Shop' },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join('\n');
        const req = {
          setEncoding: () => undefined,
          [Symbol.asyncIterator]: async function* () {
            yield `${text}\n`;
          },
        } as unknown as Request;

        await service.importNdjsonStream({ userId: CALLER } as never, req, 'jane@example.com');

        const inserts = insertsInto('receipts');

        expect(inserts).toHaveLength(1);
        expect(insertedRow(inserts[0])).toMatchObject({ user_id: CALLER, owner_user_id: CALLER });
      });
    }

    it('keeps an unknown (null) detected owner null rather than claiming it', async () => {
      dataSource.query = jest.fn().mockResolvedValue(receiptsDiscovery(['user_id', 'owner_user_id']));

      await service.importArchive({ userId: CALLER } as never, {
        version: 1,
        exportedAt: new Date().toISOString(),
        userId: CALLER,
        profile: null,
        tables: { 'ci.receipts': [{ receipt_id: 'r1', user_id: CALLER, owner_user_id: null }] },
        fileBlobs: [],
      });

      expect(insertedRow(insertsInto('receipts')[0])).toMatchObject({ user_id: CALLER, owner_user_id: null });
    });

    it("deletes and exports by user_id only, never reaching a row whose user_id is another account's", async () => {
      dataSource.query = jest.fn().mockResolvedValue(receiptsDiscovery(['owner_user_id', 'user_id']));

      await service.importArchive({ userId: CALLER } as never, {
        version: 1,
        exportedAt: new Date().toISOString(),
        userId: CALLER,
        profile: null,
        tables: {},
        fileBlobs: [],
      });

      const deletes = (queryRunner.query as jest.Mock).mock.calls
        .map(([sql]: [string]) => sql)
        .filter((sql: string) => sql.startsWith('DELETE') && sql.includes('"receipts"'));

      expect(deletes).toEqual([expect.stringContaining('WHERE user_id = $1')]);

      dataSource.query = jest
        .fn()
        .mockResolvedValueOnce(receiptsDiscovery(['owner_user_id', 'user_id']))
        .mockResolvedValue([]);
      userService.findById = jest.fn().mockResolvedValue(null);
      await service.exportArchive({ userId: CALLER } as never);

      const selects = (dataSource.query as jest.Mock).mock.calls
        .map(([sql]: [string]) => sql)
        .filter((sql: string) => sql.includes('"receipts"'));

      expect(selects).toEqual([expect.stringContaining('WHERE user_id = $1')]);
    });
  });

  describe('grant and trust tables never travel in an archive', () => {
    const TRUST_TABLES = [
      'federated_identities',
      'mcp_server_configs',
      'peer_links',
      'ask_grants',
      'household_tiers',
      'push_subscriptions',
      'pending_actions',
      'pipeline_dead_letters',
      'account_purges',
    ];
    const CALLER = '11111111-1111-4111-8111-111111111111';

    const discovery = [
      { schema: 'ci', table: 'notes', user_column: 'user_id', columns: ['id', 'user_id'] },
      ...TRUST_TABLES.map((table) => ({
        schema: 'ci',
        table,
        user_column:
          table === 'peer_links' || table === 'ask_grants' || table === 'household_tiers'
            ? 'owner_user_id'
            : 'user_id',
        columns: ['id', 'user_id', 'owner_user_id', 'issuer', 'subject', 'command'],
      })),
    ];

    it('export leaves them out', async () => {
      dataSource.query = jest.fn().mockResolvedValueOnce(discovery).mockResolvedValue([]);
      userService.findById = jest.fn().mockResolvedValue(null);

      const archive = await service.exportArchive({ userId: CALLER } as never);

      expect(Object.keys(archive.tables)).toEqual(['ci.notes']);
    });

    it('the JSON import neither deletes nor restores them, so an older archive still imports', async () => {
      dataSource.query = jest.fn().mockResolvedValue(discovery);
      queryRunner.query = jest.fn().mockResolvedValue(undefined) as unknown as QueryRunner['query'];

      await service.importArchive({ userId: CALLER } as never, {
        version: 1,
        exportedAt: new Date().toISOString(),
        userId: CALLER,
        profile: null,
        tables: Object.fromEntries(
          TRUST_TABLES.map((table) => [
            `ci.${table}`,
            [{ id: 'x', user_id: CALLER, issuer: 'https://idp.example.com' }],
          ]),
        ),
        fileBlobs: [],
      });

      const touched = (queryRunner.query as jest.Mock).mock.calls
        .map(([sql]: [string]) => sql)
        .filter((sql: string) => TRUST_TABLES.some((table) => sql.includes(`"${table}"`)));

      expect(touched).toEqual([]);
      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it('the stream import drops their rows from an older archive instead of failing on them', async () => {
      dataSource.query = jest.fn().mockResolvedValue(discovery);
      queryRunner.query = jest.fn().mockResolvedValue(undefined) as unknown as QueryRunner['query'];
      userService.findById = jest.fn().mockResolvedValue({ email: 'jane@example.com' });

      const text = [
        {
          type: 'manifest',
          version: 1,
          format: 'ndjson',
          exportedAt: new Date().toISOString(),
          userId: CALLER,
          profile: null,
        },
        {
          type: 'row',
          table: 'ci.federated_identities',
          row: { id: 'x', user_id: CALLER, issuer: 'https://idp.example.com' },
        },
        { type: 'row', table: 'ci.mcp_server_configs', row: { id: 'y', user_id: CALLER, command: 'true' } },
        { type: 'row', table: 'ci.notes', row: { id: 'n1', user_id: CALLER } },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n');
      const req = {
        setEncoding: () => undefined,
        [Symbol.asyncIterator]: async function* () {
          yield `${text}\n`;
        },
      } as unknown as Request;

      const result = await service.importNdjsonStream({ userId: CALLER } as never, req, 'jane@example.com');

      const touched = (queryRunner.query as jest.Mock).mock.calls
        .map(([sql]: [string]) => sql)
        .filter((sql: string) => TRUST_TABLES.some((table) => sql.includes(`"${table}"`)));

      expect(touched).toEqual([]);
      expect(result.rowsImported).toBe(1);
    });

    it('a table nobody knows about still fails the stream import', async () => {
      dataSource.query = jest.fn().mockResolvedValue(discovery);
      queryRunner.query = jest.fn().mockResolvedValue(undefined) as unknown as QueryRunner['query'];
      userService.findById = jest.fn().mockResolvedValue({ email: 'jane@example.com' });

      const text = [
        {
          type: 'manifest',
          version: 1,
          format: 'ndjson',
          exportedAt: new Date().toISOString(),
          userId: CALLER,
          profile: null,
        },
        { type: 'row', table: 'ci.not_a_table', row: { id: 'x' } },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n');
      const req = {
        setEncoding: () => undefined,
        [Symbol.asyncIterator]: async function* () {
          yield `${text}\n`;
        },
      } as unknown as Request;

      await expect(
        service.importNdjsonStream({ userId: CALLER } as never, req, 'jane@example.com'),
      ).rejects.toThrow('Unknown table in archive: ci.not_a_table');
    });
  });
});
