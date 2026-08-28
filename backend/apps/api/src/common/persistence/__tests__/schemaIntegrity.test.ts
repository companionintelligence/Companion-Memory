import {
  describeSchemaIntegrity,
  diffMigrations,
  inspectSchemaIntegrity,
  migrationVersionsOnDisk,
  resolveMigrationsDir,
  STACK_KEY_SETTING,
  type SchemaProbe,
} from '../schemaIntegrity';

/**
 * Fake probe: `stackKey` is what the database reports as its owning stack (null
 * = unstamped), `applied` is its schema_migrations contents. Pass `applied:
 * 'missing'` to simulate a database that has never been migrated at all.
 */
function probeFor(stackKey: string | null, applied: string[] | 'missing'): SchemaProbe {
  return {
    query: (sql: string) => {
      if (sql.includes('current_setting')) {
        return Promise.resolve({ rows: [{ stack_key: stackKey }] });
      }

      if (applied === 'missing') {
        return Promise.reject(
          Object.assign(new Error('relation "schema_migrations" does not exist'), { code: '42P01' }),
        );
      }

      return Promise.resolve({ rows: applied.map((version) => ({ version })) });
    },
  };
}

const DISK = ['20250101000000', '20250102000000', '20250103000000'];

describe('diffMigrations', () => {
  it('reports no drift when the applied set matches the files', () => {
    expect(diffMigrations(DISK, DISK)).toMatchObject({ pending: [], unknown: [] });
  });

  it('reports files that were never applied as pending', () => {
    expect(diffMigrations(DISK, DISK.slice(0, 2))).toMatchObject({
      pending: ['20250103000000'],
      unknown: [],
      latestOnDisk: '20250103000000',
      latestApplied: '20250102000000',
    });
  });

  // The reported failure: another worktree's migration applied to this stack's
  // database. dbmate records it, so `migrate` has nothing to do and the app
  // queries a table its own migrations never created.
  it('reports applied versions with no file as unknown', () => {
    expect(diffMigrations(DISK, [...DISK, '20260820004455'])).toMatchObject({
      pending: [],
      unknown: ['20260820004455'],
    });
  });

  // Equal counts hide a swap; the comparison must be set-based, not a tally.
  it('catches a same-count mismatch', () => {
    const drift = diffMigrations(DISK, ['20250101000000', '20250102000000', '20260820004455']);

    expect(drift.onDiskCount).toBe(drift.appliedCount);
    expect(drift).toMatchObject({ pending: ['20250103000000'], unknown: ['20260820004455'] });
  });
});

describe('migrationVersionsOnDisk', () => {
  it("reads this checkout's own migrations, including the 15-digit grandfathered prefix", () => {
    const versions = migrationVersionsOnDisk(resolveMigrationsDir());

    expect(versions.length).toBeGreaterThan(100);
    expect(versions).toContain('202601112192456');
    expect(versions.every((version) => /^\d+$/.test(version))).toBe(true);
  });
});

describe('inspectSchemaIntegrity', () => {
  const migrationsDir = resolveMigrationsDir();

  it('flags a database stamped by another stack', async () => {
    const report = await inspectSchemaIntegrity({
      probe: probeFor('ci-server-other-worktree', migrationVersionsOnDisk(migrationsDir)),
      expectedStackKey: 'ci-server-mine',
      migrationsDir,
    });

    expect(report.foreign).toBe(true);
    expect(describeSchemaIntegrity(report)).toContain('ci-server-other-worktree');
  });

  it('passes an unstamped database that is fully migrated', async () => {
    const report = await inspectSchemaIntegrity({
      probe: probeFor(null, migrationVersionsOnDisk(migrationsDir)),
      expectedStackKey: 'ci-server-mine',
      migrationsDir,
    });

    expect(report.foreign).toBe(false);
    expect(describeSchemaIntegrity(report)).toBeNull();
  });

  it('passes when the stamp matches', async () => {
    const report = await inspectSchemaIntegrity({
      probe: probeFor('ci-server-mine', migrationVersionsOnDisk(migrationsDir)),
      expectedStackKey: 'ci-server-mine',
      migrationsDir,
    });

    expect(describeSchemaIntegrity(report)).toBeNull();
  });

  it('treats an absent schema_migrations as everything pending, not an error', async () => {
    const report = await inspectSchemaIntegrity({
      probe: probeFor(null, 'missing'),
      migrationsDir,
    });

    expect(report.drift.appliedCount).toBe(0);
    expect(report.drift.pending.length).toBe(report.drift.onDiskCount);
    expect(describeSchemaIntegrity(report)).toContain('make migrate');
  });

  it('reads the owning stack from the documented setting', async () => {
    const seen: string[] = [];

    await inspectSchemaIntegrity({
      probe: {
        query: (sql: string) => {
          seen.push(sql);

          return Promise.resolve({ rows: sql.includes('current_setting') ? [{ stack_key: null }] : [] });
        },
      },
      migrationsDir,
    });

    expect(seen.some((sql) => sql.includes(STACK_KEY_SETTING))).toBe(true);
  });
});

describe('describeSchemaIntegrity', () => {
  const migrationsDir = resolveMigrationsDir();

  it('names both directions of drift and how to recover', async () => {
    const onDisk = migrationVersionsOnDisk(migrationsDir);
    const message = describeSchemaIntegrity(
      await inspectSchemaIntegrity({
        // A synthetic version that can never exist on disk. Do NOT use a
        // plausible-looking timestamp here: this test previously hardcoded
        // 20260820004455, and the day a real migration was created with that
        // exact stamp the "ahead of the code" case silently stopped being
        // ahead of anything and the assertion got null.
        probe: probeFor(null, [...onDisk, '29991231235959']),
        migrationsDir,
      }),
    );

    expect(message).toContain('AHEAD of the code');
    expect(message).toContain('29991231235959');
    expect(message).toContain('make migrate');
    expect(message).toContain('CI_SKIP_SCHEMA_CHECK');
  });
});
