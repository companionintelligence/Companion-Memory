import { randomUUID } from 'node:crypto';

import { DataSource, type QueryRunner, type Repository } from 'typeorm';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { FileChunkEntity } from '../../entities/FileChunkEntity';
import { DocumentChunkService } from '../DocumentChunkService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PARSED TEXT OF ONE FILE, READ FOR A CHAT PROMPT — REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `findLeadingByFileId` is how a PDF or an Office document a person attaches to a chat reaches the
 * model: the parse pipeline's chunks, first to last. It is the one read in this service that must
 * never cross owners, and it is a query builder with a bound `user_id` for a reason that a mocked
 * repository cannot show: an object-style `where` whose value is undefined silently loses that
 * condition. So this runs the real SQL, with a stranger asking for the owner's file.
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
  console.warn(`[parsing/DocumentChunkService.leadingChunks.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = { setContext: () => undefined, log: () => undefined, warn: () => undefined };

describeWithDb(`DocumentChunkService.findLeadingByFileId (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let repository: Repository<FileChunkEntity>;
  let service: DocumentChunkService;

  let ownerId: string;
  let strangerId: string;
  let pdfId: string;
  let otherFileId: string;

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

  const insertChunk = async (fileId: string, userId: string, index: number, content: string) => {
    await query(
      `INSERT INTO ci.file_chunks (id, file_id, user_id, chunk_index, content, parser_name, parser_version, chunker_version)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'spec', '1', '1')`,
      [randomUUID(), fileId, userId, index, content],
    );
  };

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
    schemaLock = await acquireSchemaWriteLock(dataSource, 'parsing/DocumentChunkService.leadingChunks');
  });

  afterAll(async () => {
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    ownerId = await createSyntheticTestUser(query, 'LeadingChunks-owner');
    strangerId = await createSyntheticTestUser(query, 'LeadingChunks-stranger');
    pdfId = await insertFile(ownerId, 'plan.pdf');
    otherFileId = await insertFile(ownerId, 'other.pdf');

    // Out of order on purpose: reading order is the chunk index, not the order they were written.
    await insertChunk(pdfId, ownerId, 2, 'third');
    await insertChunk(pdfId, ownerId, 0, 'first');
    await insertChunk(pdfId, ownerId, 3, 'fourth');
    await insertChunk(pdfId, ownerId, 1, 'second');
    await insertChunk(otherFileId, ownerId, 0, 'a different document');

    repository = runner.manager.getRepository(FileChunkEntity);
    service = new DocumentChunkService(repository, logger as never);
  });

  afterEach(async () => {
    await runner.rollbackTransaction();
    await runner.release();
  });

  it('returns the first chunks of the file in reading order, whatever order they were written in', async () => {
    const chunks = await service.findLeadingByFileId({ userId: ownerId }, pdfId, 3);

    expect(chunks).toStrictEqual([
      { chunkIndex: 0, content: 'first' },
      { chunkIndex: 1, content: 'second' },
      { chunkIndex: 2, content: 'third' },
    ]);
  });

  it('returns them all when the limit is more than there are', async () => {
    const chunks = await service.findLeadingByFileId({ userId: ownerId }, pdfId, 65);

    expect(chunks.map((chunk) => chunk.content)).toStrictEqual(['first', 'second', 'third', 'fourth']);
  });

  it('returns only what a prompt needs, not the rest of the row', async () => {
    const [chunk] = await service.findLeadingByFileId({ userId: ownerId }, pdfId, 1);

    expect(Object.keys(chunk).sort()).toStrictEqual(['chunkIndex', 'content']);
  });

  it('never returns the chunks of another file', async () => {
    const chunks = await service.findLeadingByFileId({ userId: ownerId }, otherFileId, 10);

    expect(chunks.map((chunk) => chunk.content)).toStrictEqual(['a different document']);
  });

  it("reads another user's file as one with nothing parsed", async () => {
    expect(await service.findLeadingByFileId({ userId: strangerId }, pdfId, 10)).toStrictEqual([]);
  });

  it("does not return a chunk row that belongs to someone else, even under the caller's file id", async () => {
    // A row that should not exist (the file is the owner's), written by the stranger's pipeline.
    await insertChunk(pdfId, strangerId, 9, 'planted by someone else');

    const owners = await service.findLeadingByFileId({ userId: ownerId }, pdfId, 10);
    const strangers = await service.findLeadingByFileId({ userId: strangerId }, pdfId, 10);

    expect(owners.map((chunk) => chunk.content)).not.toContain('planted by someone else');
    expect(strangers.map((chunk) => chunk.content)).toStrictEqual(['planted by someone else']);
  });

  it('is empty for a file that does not exist', async () => {
    expect(await service.findLeadingByFileId({ userId: ownerId }, randomUUID(), 10)).toStrictEqual([]);
  });

  it('answers nothing, without asking the database, when the caller or the file is not named', async () => {
    const find = jest.spyOn(repository, 'createQueryBuilder');

    expect(await service.findLeadingByFileId({ userId: '' }, pdfId, 10)).toStrictEqual([]);
    expect(
      await service.findLeadingByFileId({ userId: undefined as unknown as string }, pdfId, 10),
    ).toStrictEqual([]);
    expect(await service.findLeadingByFileId({ userId: ownerId }, '', 10)).toStrictEqual([]);
    expect(await service.findLeadingByFileId({ userId: ownerId }, pdfId, 0)).toStrictEqual([]);
    expect(find).not.toHaveBeenCalled();
  });
});
