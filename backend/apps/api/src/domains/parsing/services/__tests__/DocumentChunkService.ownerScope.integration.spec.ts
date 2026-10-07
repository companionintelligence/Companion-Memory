import { randomUUID } from 'node:crypto';

import { DataSource, type QueryRunner, type Repository } from 'typeorm';

import { SYSTEM_USER } from '@ci/common/context';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { FileChunkEntity } from '../../entities/FileChunkEntity';
import { DocumentChunkService } from '../DocumentChunkService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A CHUNK BY ID IS THE CALLER'S OR IT IS NOTHING — REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `findByIds` is how `node(id: "file-chunk:…")` and search hydration turn a
 * chunk id into its document's parsed text, and `findByFileId` reads a whole
 * document's chunks. Both used to filter on id alone, so another user's chunk
 * id returned their text. They are object-style `find({ where })` reads, where
 * an undefined `userId` silently drops the condition, which only the real SQL
 * can show is not happening. So: a stranger asks for the owner's chunks, and
 * the system user, which reads across owners on purpose, asks too.
 *
 * Every test runs inside one transaction and rolls back, so nothing is committed.
 *
 * Opt-in like the other DB-backed suites: skips with the reason when nothing listens at
 * `MEMORY_TEST_DATABASE_URL` / `DATABASE_URL`, and `make test-db` provides one.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[parsing/DocumentChunkService.ownerScope.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = { setContext: () => undefined, log: () => undefined, warn: () => undefined };

describeWithDb(`DocumentChunkService owner scope (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let repository: Repository<FileChunkEntity>;
  let service: DocumentChunkService;

  let ownerId: string;
  let strangerId: string;
  let ownerFileId: string;
  let strangerFileId: string;
  /** The owner's chunks, by reading position. */
  let ownerChunks: string[];
  let strangerChunk: string;

  const query = (sql: string, params?: unknown[]) => runner.query(sql, params);

  const insertFile = async (userId: string, filename: string): Promise<string> => {
    const id = randomUUID();

    await query(
      `INSERT INTO ci.files (id, content_type, variant, user_id, external_id, filename)
       VALUES ($1::uuid, 'application/pdf', 'ORIGINAL', $2::uuid, $3, $4)`,
      [id, userId, `ext-${id}`, filename],
    );

    return id;
  };

  const insertChunk = async (
    fileId: string,
    userId: string,
    index: number,
    content: string,
  ): Promise<string> => {
    const id = randomUUID();

    await query(
      `INSERT INTO ci.file_chunks (id, file_id, user_id, chunk_index, content, parser_name, parser_version, chunker_version)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'spec', '1', '1')`,
      [id, fileId, userId, index, content],
    );

    return id;
  };

  const contents = (chunks: Array<{ content: string }>) => chunks.map((chunk) => chunk.content);

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(ENV),
      entities: [FileChunkEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();

    // SHARED: these tests write ci.files / ci.users inside their transaction.
    // See domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'parsing/DocumentChunkService.ownerScope');
  });

  afterAll(async () => {
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    ownerId = await createSyntheticTestUser(query, 'ChunkScope-owner');
    strangerId = await createSyntheticTestUser(query, 'ChunkScope-stranger');
    ownerFileId = await insertFile(ownerId, 'lease.pdf');
    strangerFileId = await insertFile(strangerId, 'notes.pdf');

    // Written out of order: reading order is the chunk index.
    const second = await insertChunk(ownerFileId, ownerId, 1, 'lease page two');
    const first = await insertChunk(ownerFileId, ownerId, 0, 'lease page one');
    ownerChunks = [first, second];
    strangerChunk = await insertChunk(strangerFileId, strangerId, 0, 'stranger notes');

    repository = runner.manager.getRepository(FileChunkEntity);
    service = new DocumentChunkService(repository, logger as never);
  });

  afterEach(async () => {
    await runner.rollbackTransaction();
    await runner.release();
  });

  describe('findByIds', () => {
    it("returns the caller's own chunks in reading order", async () => {
      const chunks = await service.findByIds({ userId: ownerId }, [ownerChunks[1], ownerChunks[0]]);

      expect(contents(chunks)).toStrictEqual(['lease page one', 'lease page two']);
    });

    it("returns nothing for another user's chunk ids", async () => {
      expect(await service.findByIds({ userId: strangerId }, ownerChunks)).toStrictEqual([]);
    });

    it("drops another user's ids from a mixed list and keeps the caller's", async () => {
      const chunks = await service.findByIds({ userId: strangerId }, [...ownerChunks, strangerChunk]);

      expect(contents(chunks)).toStrictEqual(['stranger notes']);
    });

    it('reads across owners for the system user, which the indexing and maintenance paths rely on', async () => {
      const chunks = await service.findByIds({ userId: SYSTEM_USER }, [...ownerChunks, strangerChunk]);

      expect(contents(chunks).sort()).toStrictEqual(['lease page one', 'lease page two', 'stranger notes']);
    });

    it('answers nothing, without asking the database, for a caller with no user id', async () => {
      const find = jest.spyOn(repository, 'find');

      expect(await service.findByIds({ userId: '' }, ownerChunks)).toStrictEqual([]);
      expect(await service.findByIds({ userId: undefined as unknown as string }, ownerChunks)).toStrictEqual(
        [],
      );
      expect(find).not.toHaveBeenCalled();
    });
  });

  describe('findByFileId', () => {
    it("returns every chunk of the caller's file in reading order", async () => {
      const chunks = await service.findByFileId({ userId: ownerId }, ownerFileId);

      expect(contents(chunks)).toStrictEqual(['lease page one', 'lease page two']);
    });

    it("reads another user's file as one with nothing parsed", async () => {
      expect(await service.findByFileId({ userId: strangerId }, ownerFileId)).toStrictEqual([]);
    });

    it('reads any file for the system user', async () => {
      const chunks = await service.findByFileId({ userId: SYSTEM_USER }, ownerFileId);

      expect(contents(chunks)).toStrictEqual(['lease page one', 'lease page two']);
    });

    it('answers nothing for a caller with no user id', async () => {
      expect(
        await service.findByFileId({ userId: undefined as unknown as string }, ownerFileId),
      ).toStrictEqual([]);
    });
  });
});
