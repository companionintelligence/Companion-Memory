/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Carry an appliance's job queue over from pg-boss 10 to pg-boss 12.
 *
 * pg-boss 12 refuses to start on a schema below version 25 and pg-boss 10 leaves
 * version 24. No release bridges the two: the 11.0.0 notes say automatic
 * migration from v10 "is not supported" and to "manually move jobs via the API
 * or SQL via INSERT ... SELECT". Without this step the API and the workers die
 * at boot on every appliance that ever ran a pg-boss 10 build.
 *
 * `dbmate up` runs this after the migrations, so it has finished before anything
 * that uses the queue starts. The old schema is renamed out of the way, pg-boss
 * builds its own tables under the usual name, and the jobs move in one
 * transaction that also drops the old schema. A run that dies part way leaves the
 * renamed schema behind, and the next `dbmate up` carries on from there.
 *
 * Only `job` is carried. `archive` holds finished jobs, pg-boss 12 has no such
 * table, and the history that outlives it is already in `ci.job_metrics`.
 */

const { Client } = require('pg');

// Must match PGBossEventService's `schema`.
const SCHEMA = 'pgboss';
const OLD_SCHEMA = 'pgboss_v10';

const OLDEST_VERSION_PG_BOSS_12_CAN_START_FROM = 25;

// Must match PGBossEventService's FINISHED_JOB_RETENTION_SECONDS. `deletion_seconds`
// is stored per job and `updateQueue` never reaches it, so a moved job would
// otherwise keep pg-boss's 7-day default for good.
const FINISHED_JOB_RETENTION_SECONDS = 24 * 60 * 60;

/**
 * An `active` job's worker went away when the old build stopped, so it goes back
 * to `retry` to run again. Clearing `started_on` keeps the interruption from
 * counting as a retry, so a job already on its last retry gets one more run where
 * pg-boss's own expiry would have failed it. The id stays:
 * `ci_import.import_stages.claim_job_id` points at it.
 *
 * `ON CONFLICT DO NOTHING` covers the `stately` policy's unique index, where an
 * interrupted job can collide with one already in `retry`.
 */
const moveJobsSql = (oldSchema) => `
  INSERT INTO ${SCHEMA}.job (
    id, name, priority, data, state, retry_limit, retry_count, retry_delay, retry_backoff,
    expire_seconds, deletion_seconds, singleton_key, singleton_on, start_after, created_on, started_on,
    completed_on, keep_until, output, dead_letter, policy
  )
  SELECT
    j.id, j.name, j.priority, j.data,
    (CASE WHEN j.state = 'active' THEN 'retry' ELSE j.state::text END)::${SCHEMA}.job_state,
    j.retry_limit, j.retry_count, j.retry_delay, j.retry_backoff,
    GREATEST(EXTRACT(EPOCH FROM j.expire_in)::int, 1), ${FINISHED_JOB_RETENTION_SECONDS},
    j.singleton_key, j.singleton_on, j.start_after, j.created_on,
    CASE WHEN j.state = 'active' THEN NULL ELSE j.started_on END,
    j.completed_on, j.keep_until, j.output, j.dead_letter, q.policy
  FROM ${oldSchema}.job j
  JOIN ${SCHEMA}.queue q ON q.name = j.name
  ON CONFLICT DO NOTHING`;

/** The schemas set aside so far and not yet emptied. */
async function oldSchemas(client) {
  const { rows } = await client.query(
    `SELECT nspname FROM pg_namespace WHERE nspname = $1 OR nspname LIKE $1 || '\\_%' ORDER BY nspname`,
    [OLD_SCHEMA],
  );

  return rows.map((row) => row.nspname);
}

/** The migration that creates `pgboss` leaves it empty until pg-boss first boots, so no table means nothing to do. */
async function setOldSchemaAside(client) {
  const { rows } = await client.query(`SELECT to_regclass('${SCHEMA}.version') AS version_table`);

  if (rows[0].version_table === null) {
    return;
  }

  const { rows: versions } = await client.query(`SELECT version FROM ${SCHEMA}.version`);

  if (Number(versions[0].version) < OLDEST_VERSION_PG_BOSS_12_CAN_START_FROM) {
    // The name is taken when a move failed and the old build then ran, because
    // pg-boss 10 rebuilds a missing `pgboss`. Both schemas hold jobs worth keeping.
    const taken = (await oldSchemas(client)).includes(OLD_SCHEMA);

    await client.query(
      `ALTER SCHEMA ${SCHEMA} RENAME TO ${taken ? `${OLD_SCHEMA}_${Date.now()}` : OLD_SCHEMA}`,
    );
  }
}

/**
 * Starting pg-boss builds the new schema, and each queue needs a row before jobs
 * can reference it. The policy is copied because a queue can't change it later,
 * and the dead letter because a retired queue never gets another `updateQueue`.
 * The API's boot applies the real retry and retention settings.
 */
async function createQueues(client, url, oldSchema) {
  // Here and not at the top of the file: every `dbmate` command loads this module, and only an upgrade needs pg-boss.
  const { PgBoss } = require('pg-boss');

  const boss = new PgBoss({ connectionString: url, schema: SCHEMA, schedule: false, supervise: false });

  boss.on('error', (error) => {
    console.error(`pg-boss upgrade: ${error && error.message ? error.message : error}`);
  });

  await boss.start();

  try {
    // `__pgboss__*` are pg-boss 10's cron queues, and the API turns cron off.
    const { rows } = await client.query(
      `SELECT name, policy, dead_letter
         FROM ${oldSchema}.queue
        WHERE name NOT LIKE '\\_\\_pgboss%'`,
    );

    for (const queue of rows) {
      await boss.createQueue(queue.name, { policy: queue.policy });
    }

    // Once every queue exists: `dead_letter` references another queue's row.
    for (const queue of rows.filter((row) => row.dead_letter)) {
      await boss.updateQueue(queue.name, { deadLetter: queue.dead_letter });
    }
  } finally {
    await boss.stop({ graceful: false });
  }
}

async function moveJobs(client, oldSchema) {
  await client.query('BEGIN');

  try {
    // Through the queue join, so the cron jobs dropped on purpose don't read as a shortfall.
    const { rows } = await client.query(
      `SELECT count(*)::int AS total FROM ${oldSchema}.job j JOIN ${SCHEMA}.queue q ON q.name = j.name`,
    );
    const { rowCount } = await client.query(moveJobsSql(oldSchema));

    await client.query(`DROP SCHEMA ${oldSchema} CASCADE`);
    await client.query('COMMIT');

    console.log(`Moved ${rowCount} of ${rows[0].total} jobs to the new pg-boss schema.`);
  } catch (err) {
    await client.query('ROLLBACK');

    throw err;
  }
}

async function upgradePgBossSchema(url) {
  const client = new Client(url);

  await client.connect();

  try {
    await setOldSchemaAside(client);

    for (const oldSchema of await oldSchemas(client)) {
      await createQueues(client, url, oldSchema);
      await moveJobs(client, oldSchema);
    }
  } finally {
    await client.end();
  }
}

module.exports = { upgradePgBossSchema };
