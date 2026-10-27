import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { STAGE_IDS } from '@ci/domains/pipeline';

import { createSyntheticTestUser } from '../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';
import {
  MEDIA_DIMENSIONS_CANDIDATE_COUNT_SQL,
  MEDIA_DIMENSIONS_STAGE_ID,
} from '../mediaDimensionsCandidates';

/**
 * The count behind `backfill-media-dimensions` and the nightly leg, against the
 * real schema: what it counts decides whether the backfill ever says `noop`.
 * The case it exists for is a file the stage could not decode, which keeps a
 * NULL width for good and must stop being counted once the ledger says so.
 */

const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[maintenance/mediaDimensionsCandidates.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

it('names the real media-dimensions stage', () => {
  expect(MEDIA_DIMENSIONS_STAGE_ID).toBe(STAGE_IDS.ENRICH_MEDIA_DIMENSIONS);
});

describeWithDatabase(`media-dimensions candidate count (${availability.target})`, () => {
  let dataSource: DataSource;
  let userId: string;

  const count = async (): Promise<number> => {
    const [row] = await dataSource.query<Array<{ count: string }>>(MEDIA_DIMENSIONS_CANDIDATE_COUNT_SQL, [
      userId,
      MEDIA_DIMENSIONS_STAGE_ID,
    ]);

    return Number(row.count);
  };

  const file = async (overrides: { width?: number; deleted?: boolean; contentType?: string } = {}) => {
    const id = randomUUID();

    await dataSource.query(
      `INSERT INTO ci.files (id, user_id, key, content_type, variant, width, deleted_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ORIGINAL', $5, CASE WHEN $6 THEN now() END)`,
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

  const ledger = async (fileId: string, status: string, nextAttemptAt: Date | null = null) => {
    await dataSource.query(
      `INSERT INTO ci.pipeline_state (entity_type, entity_id, stage, stage_version, status, reason, next_attempt_at, user_id)
       VALUES ('file', $1::uuid, $2, 1, $3, $4, $5, $6::uuid)`,
      [
        fileId,
        MEDIA_DIMENSIONS_STAGE_ID,
        status,
        status === 'skipped' ? 'probe_failed' : null,
        nextAttemptAt,
        userId,
      ],
    );
  };

  beforeAll(async () => {
    const connection = resolveConnection();

    if (connection == null) {
      throw new Error('databaseAvailability() said yes and resolveConnection() said no');
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
      synchronize: false,
    });

    await dataSource.initialize();
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
    await dataSource?.destroy();
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

  it('counts a failed probe again once its retry is due, and not before', async () => {
    const waiting = await file();
    const due = await file();

    await ledger(waiting, 'failed', new Date(Date.now() + 60 * 60 * 1000));
    await ledger(due, 'failed', new Date(Date.now() - 60 * 1000));

    expect(await count()).toBe(1);
  });

  it('leaves out a soft-deleted file, which the stage never measures', async () => {
    await file({ deleted: true });

    expect(await count()).toBe(0);
  });
});
