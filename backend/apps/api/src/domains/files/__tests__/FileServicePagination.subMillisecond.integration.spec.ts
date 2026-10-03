import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { syntheticTestUserEmail } from '../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';
import {
  DATASETS,
  DATASET_NAMES,
  INSTANT,
  PAGE_SIZES,
  expectedForwardWalk,
  idSequence,
  readWalk,
  walkForward,
  type DatasetName,
  type FetchPage,
  type SeededRow,
} from '../../__tests__/support/subMillisecondRows';
import { FileEntity } from '../entities/FileEntity';
import { FileService } from '../services/FileService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `FileService.findPage` OVER FILES THAT SHARE AN INSTANT, AGAINST REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `FileServicePagination.integration.spec.ts` holds the files browse to its contract for
 * files a second apart and for a tie it can spell (two files stamped the same second).
 * This file is the case that one cannot reach, files whose `created_at` carries
 * MICROseconds.
 *
 * `ci.files.created_at` is `timestamptz(6) DEFAULT now()`: a write-time column, and a bulk
 * upload stamps every file of a batch with one `now()`. The cursor is a file id; the seek
 * used to read that file's `created_at` back as a JavaScript `Date`, and the driver
 * TRUNCATES to milliseconds on the way in (`00:00:00.123456` is read as `.123`). So the
 * anchor sorted, to the seek that followed it, BEFORE ITSELF, and
 * `(created_at, id) < (:anchorCreatedAt, :anchorId)` skipped every file of the anchor's
 * instant that sorted after the page boundary. Silently: `totalCount` counted them, no page
 * ever served them.
 *
 * Two datasets (see `subMillisecondRows.ts`), each owned by its own synthetic user:
 *
 *   ONE INSTANT       seven files stamped to the same MICROsecond, more than any page.
 *                     Three decoys share that instant and sit between them by id: another
 *                     user's file, a PREVIEW variant and a soft-deleted original. None may
 *                     be served, and none may disturb the walk.
 *   ONE MILLISECOND   six files in one millisecond at six different microseconds, seeded
 *                     latest first so their ids run AGAINST their times. The page is ordered
 *                     `(created_at, id)` at full precision, so the seek has to agree.
 *
 * Each is walked page by page at several page sizes, so the cursor lands on every position
 * in the cluster, and a walk must serve each file exactly once, in order, with an honest
 * `hasNextPage` and `totalCount`.
 *
 * Opt-in like its neighbours: set `DATABASE_URL` to a migrated database of your OWN, or run
 * `make test-db ARGS=FileServicePagination.subMillisecond`. Every fixture belongs to a
 * synthetic user and is deleted in `afterAll`.
 */
const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[files/FileServicePagination.subMillisecond.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

/** A file that shares the cluster's instant but is not the list's to serve. */
type Decoy = 'foreign' | 'preview' | 'deleted';

/** Seeded right after the file of that label, so each decoy's id falls inside the cluster. */
const DECOYS_AFTER: Record<string, Decoy> = { c1: 'foreign', c3: 'preview', c5: 'deleted' };

describeWithDatabase(`FileService.findPage over files that share an instant (${availability.target})`, () => {
  let dataSource: DataSource;
  let service: FileService;
  let schemaLock: SchemaLock | null = null;

  const nextId = idSequence();
  const owners = {} as Record<DatasetName, string>;
  const foreignOwner = randomUUID();
  const seeded = new Map<DatasetName, SeededRow[]>();
  const decoyIds = new Map<Decoy, string>();

  const query = (sql: string, params?: unknown[]): Promise<unknown> => dataSource.query(sql, params);
  const ctx = (userId: string) => ({ userId }) as never;

  async function insertFile(
    id: string,
    owner: string,
    at: string,
    options: { variant?: string; deleted?: boolean } = {},
  ): Promise<void> {
    // `bucket` stays NULL and `external_id` is set, which `signFile` resolves without the object store.
    await query(
      `INSERT INTO ci.files (id, content_type, variant, user_id, external_id, filename, created_at, deleted_at)
       VALUES ($1::uuid, 'image/jpeg', $2, $3::uuid, $4, $5, $6::timestamptz,
               CASE WHEN $7::boolean THEN $6::timestamptz END)`,
      [id, options.variant ?? 'ORIGINAL', owner, `ext-${id}`, `${id}.jpg`, at, options.deleted === true],
    );
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(),
      entities: [FileEntity],
      synchronize: false,
      // A session zone that is neither UTC nor a whole hour. The anchor's text is printed in the session's
      // zone, offset and all, and bound back: it has to name the same instant whichever zone that is.
      extra: { options: '-c timezone=Asia/Kolkata' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'files/FileServicePagination.subMillisecond');

    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    service = new FileService(
      dataSource.getRepository(FileEntity),
      { send: jest.fn() } as never,
      logger as never,
    );

    for (const dataset of DATASET_NAMES) {
      owners[dataset] = randomUUID();
    }

    for (const [id, name] of [
      ...DATASET_NAMES.map((dataset) => [owners[dataset], `file-subms-${dataset.replace(' ', '-')}`]),
      [foreignOwner, 'file-subms-foreign'],
    ]) {
      await query(
        `INSERT INTO ci.users (id, name, email) VALUES ($1::uuid, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [id, name, syntheticTestUserEmail(name, id)],
      );
    }

    for (const dataset of DATASET_NAMES) {
      const rows: SeededRow[] = [];

      // In array order, so the ids ascend with it.
      for (const spec of DATASETS[dataset]) {
        const row = { ...spec, id: nextId() };

        await insertFile(row.id, owners[dataset], row.at);
        rows.push(row);

        const decoy = dataset === 'one instant' ? DECOYS_AFTER[spec.label] : undefined;

        if (decoy != null) {
          const id = nextId();

          await insertFile(id, decoy === 'foreign' ? foreignOwner : owners[dataset], INSTANT, {
            variant: decoy === 'preview' ? 'PREVIEW' : 'ORIGINAL',
            deleted: decoy === 'deleted',
          });
          decoyIds.set(decoy, id);
        }
      }

      seeded.set(dataset, rows);
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      const users = [...Object.values(owners), foreignOwner];

      try {
        await query('DELETE FROM ci.files WHERE user_id = ANY($1::uuid[])', [users]);
        await query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [users]);
      } finally {
        await schemaLock?.release();
        await dataSource.destroy();
      }
    }
  });

  const rowsOf = (dataset: DatasetName): SeededRow[] => seeded.get(dataset) ?? [];

  /** The files browse as a client walks it: `first` files, then `after` the id of the last one served. */
  const fetchPage =
    (dataset: DatasetName): FetchPage<string> =>
    async (size, after) => {
      const page = await service.findPage(ctx(owners[dataset]), { limit: size, afterId: after });
      const ids = page.files.map((file) => file.id);

      // Whatever the page, `totalCount` is every original the user owns and has not deleted.
      expect(page.totalCount).toBe(rowsOf(dataset).length);

      return { ids, hasNextPage: page.hasNextPage, next: ids.length > 0 ? ids[ids.length - 1] : null };
    };

  describe('the fixture', () => {
    it('keeps its microseconds, and the driver reads them back as milliseconds', async () => {
      const row = rowsOf('one instant').find((candidate) => candidate.label === 'c1')!;

      // A BEFORE INSERT trigger that re-stamped the row would let every case below pass for the wrong reason.
      const [{ exact }] = (await query(
        `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact
           FROM ci.files WHERE id = $1`,
        [row.id],
      )) as Array<{ exact: string }>;

      expect(exact).toBe(INSTANT);

      // ...and the read findPage's anchor lookup used to make loses them, which is the whole flaw.
      const entity = await dataSource.getRepository(FileEntity).findOneByOrFail({ id: row.id });

      expect(entity.createdAt.toISOString()).toBe('2026-05-01T00:00:00.123Z');
    });

    it('seeds the decoys at the cluster instant, outside the list', async () => {
      const [{ shared }] = (await query(
        `SELECT count(*)::int AS shared FROM ci.files WHERE id = ANY($1::uuid[]) AND created_at = $2::timestamptz`,
        [[...decoyIds.values()], INSTANT],
      )) as Array<{ shared: number }>;

      expect(shared).toBe(3);
    });
  });

  describe.each(DATASET_NAMES)('walking the files browse over %s', (dataset) => {
    it.each(PAGE_SIZES)('in pages of %i serves every file once, in order', async (size) => {
      const rows = rowsOf(dataset);
      const reading = readWalk(await walkForward(fetchPage(dataset), size, rows.length), rows);

      // Named first, so a failure says WHAT went wrong before the diff says where.
      expect({ repeated: reading.repeated, dropped: reading.dropped }).toEqual({ repeated: [], dropped: [] });
      expect(reading.pages).toEqual(expectedForwardWalk(rows, size));
    });
  });

  describe('an anchor the list cannot see reads as "from the start"', () => {
    // What the in-memory paginator did with a stale cursor, and what the anchor lookup must keep doing
    // however it finds the anchor: the same scope (the user's own, ORIGINAL, not deleted) as the page.
    const newestFirstTwo = () => {
      const rows = rowsOf('one instant');

      return expectedForwardWalk(rows, 2)[0].labels;
    };

    it.each([
      ['an id that names no file', () => randomUUID()],
      ["another user's file", () => decoyIds.get('foreign')!],
      ['a PREVIEW variant', () => decoyIds.get('preview')!],
      ['a soft-deleted file', () => decoyIds.get('deleted')!],
    ] as const)('%s', async (_name, anchor) => {
      const rows = rowsOf('one instant');
      const labelOf = new Map(rows.map((row) => [row.id, row.label]));
      const page = await service.findPage(ctx(owners['one instant']), { limit: 2, afterId: anchor() });

      expect(page.files.map((file) => labelOf.get(file.id))).toEqual(newestFirstTwo());
    });
  });
});
