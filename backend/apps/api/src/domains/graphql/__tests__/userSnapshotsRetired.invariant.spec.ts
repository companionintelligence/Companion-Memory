import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `ci.user_snapshots` is retired (migration `20260826202515_retire_user_snapshots`).
 *
 * It was a compressed TimescaleDB hypertable that accumulated rows forever and
 * was never read: not one `SELECT` in the repo, and no caller anywhere in the
 * workspace for `ingestUserSnapshot`, the mutation that fed it. The mutation
 * could not have had the caller it was built for — its resolver was guarded by
 * the bare `JwtAuthGuard`, which 401s the API-key and Portal-OIDC credentials
 * CI-Capture actually presents, and CI-Capture's supported lane POSTs the same
 * focus/window/fs-event payload to `/v1/events` instead.
 *
 * This guard exists because that combination is invisible to every other check.
 * A re-added entity typechecks, a re-added resolver passes every resolver test,
 * and the table quietly grows again with nobody reading it — which is exactly
 * how it got here the first time. So the invariant is asserted over the two
 * artifacts that would have to change for a writer to come back: the source
 * tree, and the checked-in schema the web app's codegen reads.
 *
 * If you are re-introducing this table on purpose, land the reader in the same
 * change and then delete this file — do not weaken the patterns.
 */
const API_SRC = join(__dirname, '..', '..', '..');
const SCHEMA_FILE = join(__dirname, '..', '__generated__', 'schema.graphql');

/** A TypeORM entity mapped onto the retired table. */
const ENTITY_MAPPING = /@Entity\(\s*\{[^}]*name:\s*['"]user_snapshots['"]/s;

/** Any raw SQL — query builder, `dataSource.query`, migration helper — naming it. */
const RAW_SQL_REFERENCE = /\bci\.user_snapshots\b/;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '__generated__') {
        collectSourceFiles(full, out);
      }

      continue;
    }

    if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }

  return out;
}

describe('ci.user_snapshots stays retired', () => {
  const sourceFiles = collectSourceFiles(API_SRC).filter((file) => file !== __filename);

  it('scans a source tree that actually contains files', () => {
    // Positive control. If the walker silently returned [] — a bad root, a
    // renamed directory — the two assertions below would pass vacuously
    // forever. This is the assertion that survives neutralising the change.
    expect(sourceFiles.length).toBeGreaterThan(500);
  });

  it('has no TypeORM entity mapped to the table', () => {
    const offenders = sourceFiles.filter((file) => ENTITY_MAPPING.test(readFileSync(file, 'utf8')));

    expect(offenders).toStrictEqual([]);
  });

  it('has no raw SQL naming the table', () => {
    const offenders = sourceFiles.filter((file) => RAW_SQL_REFERENCE.test(readFileSync(file, 'utf8')));

    expect(offenders).toStrictEqual([]);
  });

  it('no longer exposes the ingest mutation in the generated schema', () => {
    const schema = readFileSync(SCHEMA_FILE, 'utf8');

    // Positive control: the file we are asserting over is the real schema.
    expect(schema).toMatch(/^type Mutation \{$/m);

    expect(schema).not.toMatch(/\bingestUserSnapshot\b/);
    expect(schema).not.toMatch(/\bIngestUserSnapshot(Input|Payload)\b/);
  });
});
