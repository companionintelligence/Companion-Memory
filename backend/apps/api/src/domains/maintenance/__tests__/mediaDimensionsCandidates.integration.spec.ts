import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { createSyntheticTestUser } from '../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';
import {
  MEDIA_DIMENSIONS_STAGE_ID,
  MEDIA_DIMENSIONS_STAGE_VERSION,
  countMediaDimensionsCandidates,
} from '../mediaDimensionsCandidates';

/**
 * The count behind `backfill-media-dimensions` and the nightly leg, against the
 * real schema: what it counts decides whether the backfill ever says `noop`.
 * The case it exists for is a file the stage could not decode, which keeps a
 * NULL width for good and must stop being counted once the ledger says so at
 * the current stage version, and only then.
 *
 * The constants it duplicates are pinned in `mediaDimensionsCandidates.spec.ts`,
 * which runs without a database.
 */

const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[maintenance/mediaDimensionsCandidates.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`media-dimensions candidate count (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let userId: string;

  const count = (): Promise<number> => countMediaDimensionsCandidates(dataSource, userId);

  const file = async (overrides: { width?: number; deleted?: boolean; contentType?: string } = {}) => {
    const id = randomUUID();

    await dataSource.query(
      `INSERT INTO ci.files (id, user_id, key, content_type, variant, width, deleted_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ORIGINAL', $5, CASE WHEN $6::boolean THEN now() END)`,
      [
        id,
        userId,
        randomUUID(),
        overrides.contentType ?? 'image/jpeg',
        overrides.width ?? null,
        overrides.deleted === true,
      ],
    );

    return id;
  };

  /** A reason the stage itself writes for each status that needs one. */
  const REASONS: Record<string, string> = {
    skipped: 'probe_failed',
    failed: 'object_storage_read_failed',
    quarantined: 'object_storage_read_failed',
  };

  const ledger = async (
    fileId: string,
    status: string,
    options: { nextAttemptAt?: Date | null; stageVersion?: number } = {},
  ) => {
    await dataSource.query(
      `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, stage_version, status, reason, next_attempt_at, user_id)
       VALUES ('file', $1::uuid, $2, $3, $4, $5, $6, $7::uuid)`,
      [
        fileId,
        MEDIA_DIMENSIONS_STAGE_ID,
        options.stageVersion ?? MEDIA_DIMENSIONS_STAGE_VERSION,
        status,
        REASONS[status] ?? null,
        options.nextAttemptAt ?? null,
        userId,
      ],
    );
  };

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', ...dataSourceConnection(), synchronize: false });

    await dataSource.initialize();
    // This suite commits its rows and deletes a `ci.users` row in teardown, the
    // shape that deadlocks against a suite applying a migration.
    schemaLock = await acquireSchemaWriteLock(
      dataSource,
      'maintenance/mediaDimensionsCandidates.integration',
    );
  });

  beforeEach(async () => {
    userId = await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'MediaDimsCount');
  });

  afterEach(async () => {
    await dataSource.query(`DELETE FROM ci.pipeline_state WHERE user_id = $1::uuid`, [userId]);
    await dataSource.query(`DELETE FROM ci.files WHERE user_id = $1::uuid`, [userId]);
    await dataSource.query(`DELETE FROM ci.users WHERE id = $1::uuid`, [userId]);
  });

  afterAll(async () => {
    try {
      await schemaLock?.release();
    } finally {
      if (dataSource?.isInitialized) {
        await dataSource.destroy();
      }
    }
  });

  it('counts an unmeasured image or video the stage has never looked at', async () => {
    await file();
    await file({ contentType: 'video/mp4' });
    await file({ width: 640 });
    await file({ contentType: 'application/pdf' });

    expect(await count()).toBe(2);
  });

  it('stops counting a file the stage could not decode, so the backfill reaches noop', async () => {
    const broken = await file();

    expect(await count()).toBe(1);

    await ledger(broken, 'skipped');

    expect(await count()).toBe(0);
  });

  it('still counts a file an older stage version could not decode, which the sweep re-probes', async () => {
    const before = await file();

    await ledger(before, 'skipped', { stageVersion: MEDIA_DIMENSIONS_STAGE_VERSION - 1 });

    expect(await count()).toBe(1);
  });

  it('counts a claim left at version 0, which the sweep picks up again', async () => {
    const stranded = await file();

    await ledger(stranded, 'running', { stageVersion: 0 });

    expect(await count()).toBe(1);
  });

  it('leaves out a quarantined file at the current version, which waits for a person', async () => {
    const parked = await file();

    await ledger(parked, 'quarantined');

    expect(await count()).toBe(0);
  });

  it('counts a failed probe again once its retry is due, and not before', async () => {
    const waiting = await file();
    const due = await file();

    await ledger(waiting, 'failed', { nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000) });
    await ledger(due, 'failed', { nextAttemptAt: new Date(Date.now() - 60 * 1000) });

    expect(await count()).toBe(1);
  });

  it('leaves out a soft-deleted file, which the stage never measures', async () => {
    await file({ deleted: true });

    expect(await count()).toBe(0);
  });
});
