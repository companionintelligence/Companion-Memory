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

/**
 * An `active` job's worker went away when the old build stopped, so it goes back
 * to `retry` to run again, as pg-boss's own expiry would have sent it. The id
 * stays: `ci_import.import_stages.claim_job_id` points at it.
 *
 * `ON CONFLICT DO NOTHING` covers the queue policies' unique indexes, where an
 * interrupted job can collide with one already waiting behind it.
 */
const MOVE_JOBS = `
  INSERT INTO ${SCHEMA}.job (
    id, name, priority, data, state, retry_limit, retry_count, retry_delay, retry_backoff,
    expire_seconds, singleton_key, singleton_on, start_after, created_on, started_on,
    completed_on, keep_until, output, dead_letter, policy
  )
  SELECT
    j.id, j.name, j.priority, j.data,
    (CASE WHEN j.state = 'active' THEN 'retry' ELSE j.state::text END)::${SCHEMA}.job_state,
    j.retry_limit, j.retry_count, j.retry_delay, j.retry_backoff,
    GREATEST(EXTRACT(EPOCH FROM j.expire_in)::int, 1), j.singleton_key, j.singleton_on, j.start_after, j.created_on,
    CASE WHEN j.state = 'active' THEN NULL ELSE j.started_on END,
    j.completed_on, j.keep_until, j.output, j.dead_letter, q.policy
  FROM ${OLD_SCHEMA}.job j
  JOIN ${SCHEMA}.queue q ON q.name = j.name
  ON CONFLICT DO NOTHING`;

async function schemaExists(client, schema) {
  const { rows } = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);

  return rows.length > 0;
}

/** The migration that creates `pgboss` leaves it empty until pg-boss first boots, so no table means nothing to do. */
async function setOldSchemaAside(client) {
  const { rows } = await client.query(`SELECT to_regclass('${SCHEMA}.version') AS version_table`);

  if (rows[0].version_table === null) {
    return;
  }

  const { rows: versions } = await client.query(`SELECT version FROM ${SCHEMA}.version`);

  if (Number(versions[0].version) < OLDEST_VERSION_PG_BOSS_12_CAN_START_FROM) {
    await client.query(`ALTER SCHEMA ${SCHEMA} RENAME TO ${OLD_SCHEMA}`);
  }
}

/**
 * Starting pg-boss builds the new schema, and each queue needs a row before jobs
 * can reference it. Only what a queue can't change later is copied: the API's
 * boot runs `updateQueue` with the real retry and retention settings.
 */
async function createQueues(client, url) {
  // Here and not at the top of the file: every `dbmate` command loads this module, and only an upgrade needs pg-boss.
  const { PgBoss } = require('pg-boss');

  const boss = new PgBoss({ connectionString: url, schema: SCHEMA, schedule: false, supervise: false });

  boss.on('error', (error) => {
    console.error(`pg-boss upgrade: ${error && error.message ? error.message : error}`);
  });

  await boss.start();

  try {
    // Queues with no dead letter first: `dead_letter` references another queue's
    // row. `__pgboss__*` are pg-boss 10's cron queues, and the API turns cron off.
    const { rows } = await client.query(
      `SELECT name, policy, dead_letter
         FROM ${OLD_SCHEMA}.queue
        WHERE name NOT LIKE '\\_\\_pgboss%'
        ORDER BY dead_letter IS NOT NULL, name`,
    );

    for (const queue of rows) {
      await boss.createQueue(queue.name, {
        ...(queue.policy ? { policy: queue.policy } : {}),
        ...(queue.dead_letter ? { deadLetter: queue.dead_letter } : {}),
      });
    }
  } finally {
    await boss.stop({ graceful: false });
  }
}

async function moveJobs(client) {
  await client.query('BEGIN');

  try {
    const { rows } = await client.query(`SELECT count(*)::int AS total FROM ${OLD_SCHEMA}.job`);
    const { rowCount } = await client.query(MOVE_JOBS);

    await client.query(`DROP SCHEMA ${OLD_SCHEMA} CASCADE`);
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

    if (await schemaExists(client, OLD_SCHEMA)) {
      await createQueues(client, url);
      await moveJobs(client);
    }
  } finally {
    await client.end();
  }
}

module.exports = { upgradePgBossSchema };
