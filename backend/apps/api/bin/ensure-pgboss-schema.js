#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Prepare a migrated database so the DB-backed jest suites can run: create the
 * `pgboss` schema, the dead-letter queue, and a catch-all job partition.
 *
 * pg-boss builds its own tables at boot rather than through dbmate, so a
 * freshly-migrated database has `ci.*` but no `pgboss.job`. That is fine on an
 * appliance — the API boots pg-boss on startup — and fatal in CI, which
 * migrates and then runs jest without ever starting the API.
 *
 * `DeadLetterReaperListener.spec.ts` guards on that table and deliberately
 * FAILS rather than skips when the database is present but the table is not
 * ("skipping would turn a migration mistake into a green run"). Its `describe`
 * block was dormant until CI gained `PIPELINE_TEST_DATABASE_URL` (#2584), at
 * which point it began running and hard-failing on every `ci.yml` run — and
 * `ci.yml` is `required` in publish.yml's release gate, so releases have been
 * shipping on `skip_test_gate=true` since.
 *
 * Uses pg-boss's OWN start/createQueue rather than hand-written DDL, so the
 * schema matches whatever version the lockfile resolves and a major bump cannot
 * silently leave CI creating last year's tables.
 */

const { Client } = require('pg');
const PgBoss = require('pg-boss');

// Must match PGBossEventService's `schema` and DEAD_LETTER_QUEUE, or CI would
// prepare a schema and a queue the suites do not look in.
const SCHEMA = 'pgboss';
const DEAD_LETTER_QUEUE = 'dead-letter';

const url = process.env.DATABASE_URL;

if (!url) {
  console.error('ensure-pgboss-schema: DATABASE_URL is unset — nothing to create.');
  process.exit(1);
}

/**
 * A DEFAULT partition for `pgboss.job`.
 *
 * pg-boss v10 declares `job ... PARTITION BY LIST (name)` and adds one
 * partition per queue inside `create_queue`, so an INSERT naming a queue that
 * was never created fails with `no partition of relation "job" found for row`.
 * On an appliance that is correct and desirable: every real queue is registered
 * by a listener at boot.
 *
 * The suites are the exception. They seed synthetic `pgboss.job` rows for
 * queues drawn from the listener registry, which a bin script cannot enumerate
 * without booting Nest — so rather than couple this script to that registry (and
 * silently under-create the day someone adds a queue), CI gets a catch-all.
 *
 * This is deliberately a TEST-ONLY accommodation: pg-boss attaches the
 * `q_fkey`/`dlq_fkey` foreign keys per-partition, so the default partition has
 * none and accepts any queue name. That is the point — the suites assert on the
 * rows they seeded, never on partition routing — but it is also why this script
 * must never be pointed at an appliance database.
 */
const CREATE_DEFAULT_PARTITION = `CREATE TABLE IF NOT EXISTS ${SCHEMA}.job_ci_default PARTITION OF ${SCHEMA}.job DEFAULT`;

async function main() {
  const boss = new PgBoss({ connectionString: url, schema: SCHEMA, schedule: false });

  // pg-boss surfaces background failures here; without a listener Node treats
  // the 'error' event as fatal.
  boss.on('error', (error) => {
    console.error(`ensure-pgboss-schema: pg-boss error: ${error && error.message ? error.message : error}`);
  });

  await boss.start();

  // Created before the default partition below: this one gets pg-boss's real
  // per-partition foreign keys and a `pgboss.queue` row, so anything joining
  // the queue table for the DLQ sees what an appliance would.
  await boss.createQueue(DEAD_LETTER_QUEUE, { name: DEAD_LETTER_QUEUE });

  await boss.stop({ graceful: false });

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(CREATE_DEFAULT_PARTITION);
  } finally {
    await client.end();
  }

  console.log(
    `ensure-pgboss-schema: '${SCHEMA}' schema, '${DEAD_LETTER_QUEUE}' queue and catch-all job partition are present.`,
  );
}

main().catch((error) => {
  console.error(`ensure-pgboss-schema: failed — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
