#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Prepare a migrated database so the DB-backed jest suites can run: create the
 * `pgboss` schema and the dead-letter queue, then let the default job partition
 * take a row for any queue name.
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
 * silently leave CI creating last year's tables. The one statement it writes
 * itself, dropping the default partition's queue keys, finds those keys in the
 * catalog instead of naming them, for the same reason.
 */

const { Client } = require('pg');
// pg-boss 12 is an ES module with a named export only. Node 22's require(esm)
// returns the module namespace, so the class has to be picked out by name.
const { PgBoss } = require('pg-boss');

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
 * Let `pgboss.job` take a row for any queue name.
 *
 * The suites seed synthetic `pgboss.job` rows for queues drawn from the
 * listener registry (`default`, `pipeline-index`, `people-linking`, ...), which
 * a bin script cannot enumerate without booting Nest. Several of them commit
 * those rows, because the service under test reads them over its own
 * connection.
 *
 * Under pg-boss 10 such a row had no partition to land in, so this script added
 * a catch-all DEFAULT partition with no foreign keys. pg-boss 12 attaches its
 * own DEFAULT partition (`job_common`) and keeps every queue there unless the
 * queue asks for `partition: true`; a second default is refused ("conflicts
 * with existing default partition"). What refuses the rows now is
 * `job_common`'s `q_fkey` and `dlq_fkey`: a name with no `pgboss.queue` row
 * fails at COMMIT. Dropping the default partition's foreign keys to
 * `pgboss.queue` gives the suites what the old catch-all did, a partition that
 * accepts any queue name. Partitions made with `partition: true` get their own
 * keys from `create_queue` and keep them.
 *
 * The keys are read from `pg_constraint` rather than named. `DROP CONSTRAINT IF
 * EXISTS q_fkey` would quietly do nothing the day a pg-boss release renames one.
 * The suites that commit rows would then fail at COMMIT with a foreign-key
 * error that points nowhere near this script.
 *
 * This is a TEST-ONLY accommodation, as the old partition was. On an appliance
 * those keys are how pg-boss notices a job sent to a queue that was deleted
 * after it cached the queue, so this script must never be pointed at an
 * appliance database.
 */
const DEFAULT_PARTITION_QUERY = `
  SELECT p.partdefid::regclass::text AS partition,
         COALESCE(array_agg(k.conname::text ORDER BY k.conname) FILTER (WHERE k.oid IS NOT NULL), '{}') AS keys
    FROM pg_partitioned_table p
    LEFT JOIN pg_constraint k
      ON k.conrelid = p.partdefid AND k.contype = 'f' AND k.confrelid = to_regclass($2::text)
   WHERE p.partrelid = to_regclass($1::text) AND p.partdefid <> 0
   GROUP BY p.partdefid`;

async function main() {
  const boss = new PgBoss({ connectionString: url, schema: SCHEMA, schedule: false });

  // pg-boss surfaces background failures here; without a listener Node treats
  // the 'error' event as fatal.
  boss.on('error', (error) => {
    console.error(`ensure-pgboss-schema: pg-boss error: ${error && error.message ? error.message : error}`);
  });

  await boss.start();

  // A real `pgboss.queue` row, so anything joining the queue table for the DLQ
  // sees what an appliance would.
  await boss.createQueue(DEAD_LETTER_QUEUE);

  await boss.stop({ graceful: false });

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(DEFAULT_PARTITION_QUERY, [`${SCHEMA}.job`, `${SCHEMA}.queue`]);

    if (rows.length === 0) {
      throw new Error(
        `${SCHEMA}.job has no DEFAULT partition, so rows for queues that were never created have nowhere to go. ` +
          'pg-boss 12 attaches job_common as the default; check what this version does instead.',
      );
    }

    // `partition` is regclass output, already schema-qualified and quoted where needed.
    const { partition, keys } = rows[0];

    if (keys.length > 0) {
      await client.query(
        `ALTER TABLE ${partition} ${keys.map((key) => `DROP CONSTRAINT ${client.escapeIdentifier(key)}`).join(', ')}`,
      );
    }
  } finally {
    await client.end();
  }

  console.log(
    `ensure-pgboss-schema: '${SCHEMA}' schema, '${DEAD_LETTER_QUEUE}' queue and an any-name default job partition are present.`,
  );
}

main().catch((error) => {
  console.error(`ensure-pgboss-schema: failed — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
