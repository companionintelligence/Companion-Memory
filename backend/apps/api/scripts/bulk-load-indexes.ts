import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource } from 'typeorm';

import config from '@ci/configuration';
import { DEFERRABLE_INDEXES, type DroppedIndex } from '@ci/domains/maintenance/services/IndexDeferralService';

// =====================================================================
// bulk-load-indexes — OPT-IN index deferral CLI (issue #12)
// =====================================================================
// The classic bulk-load pattern, run by hand around a very large import:
//
//   # 1. before the load — drop deferrable secondary indexes, save defs
//   yarn workspace @ci/be-api exec scripts/bulk-load-indexes.ts drop
//
//   # 2. run the import (POST /v1/bulk/communications, /v1/bulk/events …)
//
//   # 3. after the load — recreate every dropped index from the saved defs
//   yarn workspace @ci/be-api exec scripts/bulk-load-indexes.ts recreate
//
// State (the exact CREATE statements captured at drop time) is written to
// ./.bulk-load-indexes.json so `recreate` is byte-for-byte reversible even
// across processes. NEVER drops provenance unique indexes or primary keys
// (the service enforces this). This is NOT a migration and never runs
// automatically.

const STATE_FILE = path.resolve(process.cwd(), '.bulk-load-indexes.json');

async function withDataSource<T>(fn: (db: DataSource) => Promise<T>): Promise<T> {
  const db = new DataSource({
    type: config.db.type,
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    username: config.db.username,
    password: config.db.password,
    entities: [],
    synchronize: false,
    logging: ['error'],
  });

  await db.initialize();
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

async function drop(db: DataSource): Promise<void> {
  const dropped: DroppedIndex[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const { schema, name } of DEFERRABLE_INDEXES) {
    const meta: { indexdef: string; is_unique: boolean; is_constraint: boolean }[] = await db.query(
      `SELECT i.indexdef,
              ix.indisunique AS is_unique,
              (con.conindid IS NOT NULL) AS is_constraint
         FROM pg_indexes i
         JOIN pg_class c ON c.relname = i.indexname
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
         JOIN pg_index ix ON ix.indexrelid = c.oid
         LEFT JOIN pg_constraint con ON con.conindid = c.oid
        WHERE i.schemaname = $1 AND i.indexname = $2`,
      [schema, name],
    );

    if (meta.length === 0) {
      skipped.push({ name, reason: 'not found' });
      continue;
    }

    if (meta[0].is_unique || meta[0].is_constraint) {
      skipped.push({ name, reason: 'unique/constraint — refusing to drop' });
      continue;
    }

    await db.query(`DROP INDEX IF EXISTS "${schema}"."${name}"`);
    dropped.push({ schema, name, definition: meta[0].indexdef });
    console.log(`dropped  ${schema}.${name}`);
  }

  for (const s of skipped) {
    console.log(`skipped  ${s.name} (${s.reason})`);
  }

  writeFileSync(STATE_FILE, JSON.stringify(dropped, null, 2));
  console.log(`\nSaved ${dropped.length} index definition(s) to ${STATE_FILE}`);
  console.log('Run the import, then: bulk-load-indexes.ts recreate');
}

async function recreate(db: DataSource): Promise<void> {
  let dropped: DroppedIndex[];
  try {
    dropped = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as DroppedIndex[];
  } catch {
    throw new Error(`No state file at ${STATE_FILE}; was \`drop\` run first?`);
  }

  for (const { name, definition } of dropped) {
    await db.query(definition);
    console.log(`recreated  ${name}`);
  }

  console.log(`\nRecreated ${dropped.length} index(es).`);
}

(async () => {
  const command = process.argv[2];

  if (command !== 'drop' && command !== 'recreate') {
    console.error('Usage: bulk-load-indexes.ts <drop|recreate>');
    process.exit(1);
  }

  try {
    await withDataSource(command === 'drop' ? drop : recreate);
    process.exit(0);
  } catch (err) {
    console.error(`\nFailed: ${(err as Error).message}`);
    process.exit(1);
  }
})();
