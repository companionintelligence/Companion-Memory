#!/usr/bin/env node
/**
 * Create the `pgboss` schema against DATABASE_URL, then exit.
 *
 * pg-boss builds its own tables at boot rather than through dbmate, so a
 * freshly-migrated database has `ci.*` but no `pgboss.job`. That is fine for a
 * running appliance — the API boots pg-boss on startup — and fatal for CI,
 * which migrates and then runs jest without ever starting the API.
 *
 * `DeadLetterReaperListener.spec.ts` guards on exactly that and, deliberately,
 * FAILS rather than skips when the database is present but the table is not
 * ("skipping would turn a migration mistake into a green run"). Its
 * `describe` block was dormant until CI gained `PIPELINE_TEST_DATABASE_URL`
 * (#2584, 2026-09-04), at which point it began running and hard-failing on
 * every `ci.yml` run — and `ci.yml` is `required` in publish.yml's release
 * gate, so releases have been shipping on `skip_test_gate=true` since.
 *
 * This calls pg-boss's OWN start/stop rather than hand-writing the DDL: the
 * schema then matches whatever version of pg-boss the lockfile resolves, and a
 * major bump cannot silently leave CI creating last year's tables.
 */

const PgBoss = require('pg-boss');

const url = process.env.DATABASE_URL;

if (!url) {
  console.error('ensure-pgboss-schema: DATABASE_URL is unset — nothing to create.');
  process.exit(1);
}

async function main() {
  // `schema` must match PGBossEventService's, or CI would create a schema the
  // suite does not look in and the guard would still fire.
  const boss = new PgBoss({ connectionString: url, schema: 'pgboss', schedule: false });

  // pg-boss surfaces background failures here; without a listener Node treats
  // the 'error' event as fatal.
  boss.on('error', (error) => {
    console.error(`ensure-pgboss-schema: pg-boss error: ${error && error.message ? error.message : error}`);
  });

  await boss.start();
  await boss.stop({ graceful: false });

  console.log("ensure-pgboss-schema: 'pgboss' schema is present.");
}

main().catch((error) => {
  console.error(`ensure-pgboss-schema: failed — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
