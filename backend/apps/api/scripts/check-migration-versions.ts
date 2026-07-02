/**
 * Guard against dbmate version collisions.
 *
 * dbmate records applied migrations in `schema_migrations` keyed on the
 * numeric filename prefix. Two files sharing a prefix therefore break
 * `migrate` for everyone: the first is applied and recorded, the second
 * fails its version insert with a duplicate-key error (see the
 * 20260628120000 collision between saved-search sharing and communications
 * dedup).
 *
 * Never hand-write the timestamp — create migrations with:
 *   yarn workspace @ci/be-api migrate:make <name>
 * which stamps the actual UTC time to the second.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(__dirname, '../db/postgres/migrations');

/**
 * Pre-existing files whose versions are already recorded in production
 * schema_migrations tables. Renaming an applied migration makes dbmate
 * re-apply it, so these are grandfathered rather than fixed. Do not add
 * to this list.
 */
const GRANDFATHERED = new Set([
  '202601112192456_add_saved_searches.sql', // 15-digit hand-written timestamp
]);

const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql') && !GRANDFATHERED.has(name));

const byVersion = new Map<string, string[]>();
const malformed: string[] = [];

for (const file of files) {
  const match = /^(\d{14})_.+\.sql$/.exec(file);

  if (match == null) {
    malformed.push(file);
    continue;
  }

  const version = match[1];
  const existing = byVersion.get(version) ?? [];

  existing.push(file);
  byVersion.set(version, existing);
}

const duplicates = [...byVersion.entries()].filter(([, names]) => names.length > 1);

let failed = false;

if (malformed.length > 0) {
  failed = true;
  console.error('Migration filenames must be <yyyymmddhhmmss>_<name>.sql:');
  for (const file of malformed) {
    console.error(`  ${file}`);
  }
}

if (duplicates.length > 0) {
  failed = true;
  console.error('Duplicate migration versions (dbmate keys schema_migrations on the prefix):');
  for (const [version, names] of duplicates) {
    console.error(`  ${version}: ${names.join(', ')}`);
  }
}

if (failed) {
  console.error('\nCreate migrations with `yarn workspace @ci/be-api migrate:make <name>`;');
  console.error('never hand-write the timestamp.');
  process.exit(1);
}
