import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { resolveMigrationsDir } from '../schemaIntegrity';

/**
 * `ci.event_analytics` was created by the 20260808150100 schema consolidation to
 * hold `salience` / `access_count` and five older dead columns moved off the hot
 * `ci.events` row. Nothing ever wrote or read any of them, so 20260826202329
 * retires the table.
 *
 * Two properties are worth holding onto, and neither is visible to `tsc`:
 *
 *  1. Replaying every `migrate:up` must leave the table ABSENT — i.e. nobody has
 *     quietly re-created it without also landing a writer and a reader.
 *  2. Replaying every `migrate:down` in reverse must never touch the table while
 *     it is absent. The consolidation's own down does
 *     `UPDATE ci.events e SET ... FROM ci.event_analytics a`, which raises 42P01
 *     against a missing table, so the retiring migration's down has to recreate
 *     it before that point in the chain.
 */

const TABLE = 'event_analytics';

type Section = 'up' | 'down';
type Effect = 'create' | 'drop' | 'reference';

interface MigrationFile {
  version: string;
  file: string;
  up: string;
  down: string;
}

/**
 * Strip `--` line comments so prose ABOUT the table (there is a lot of it, in
 * both migrations and this one) is not mistaken for SQL that touches it. Naive
 * with respect to `--` inside string literals, which is why only files that
 * mention the table at all are parsed, and why only statements that mention it
 * are classified.
 */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

function readMigrations(): MigrationFile[] {
  const dir = resolveMigrationsDir();

  return readdirSync(dir)
    .map((file) => ({ file, version: /^(\d+)_.+\.sql$/.exec(file)?.[1] }))
    .filter((entry): entry is { file: string; version: string } => entry.version != null)
    .sort((a, b) => a.version.localeCompare(b.version))
    .map(({ file, version }) => {
      const body = readFileSync(path.join(dir, file), 'utf8');
      const downAt = body.indexOf('-- migrate:down');

      return {
        version,
        file,
        up: downAt === -1 ? body : body.slice(0, downAt),
        down: downAt === -1 ? '' : body.slice(downAt),
      };
    });
}

/** Ordered effects on `ci.event_analytics` within one section of one migration. */
function effectsOn(migration: MigrationFile, section: Section): Effect[] {
  const sql = migration[section];

  if (!sql.includes(TABLE)) {
    return [];
  }

  return stripComments(sql)
    .split(';')
    .filter((statement) => statement.includes(TABLE))
    .map((statement) => {
      const normalized = statement.replace(/\s+/g, ' ').trim();

      if (new RegExp(`\\bCREATE TABLE\\b.*\\b${TABLE}\\b`, 'i').test(normalized)) {
        return 'create';
      }

      if (new RegExp(`\\bDROP TABLE\\b.*\\b${TABLE}\\b`, 'i').test(normalized)) {
        return 'drop';
      }

      return 'reference';
    });
}

function tsFilesUnderSrc(): string[] {
  const root = path.join(resolveMigrationsDir(), '..', '..', '..', 'src');
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);

      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith('.ts')) {
        found.push(full);
      }
    }
  };

  walk(root);

  return found;
}

const migrations = readMigrations();

describe('ci.event_analytics is retired', () => {
  it('is absent after every migrate:up is replayed in order', () => {
    let exists = false;
    const trail: string[] = [];

    for (const migration of migrations) {
      for (const effect of effectsOn(migration, 'up')) {
        if (effect === 'create') {
          exists = true;
          trail.push(`${migration.version} create`);
        } else if (effect === 'drop') {
          exists = false;
          trail.push(`${migration.version} drop`);
        }
      }
    }

    // Guard against a silently-passing test if the parser ever stops matching.
    expect(trail).toStrictEqual(['20260808150100 create', '20260826202329 drop']);
    expect(exists).toBe(false);
  });

  it('never touches the table while it is absent when migrate:down is replayed in reverse', () => {
    let exists = false;
    const touchedWhileAbsent: string[] = [];
    let referencesSeen = 0;

    for (const migration of [...migrations].reverse()) {
      for (const effect of effectsOn(migration, 'down')) {
        if (effect === 'create') {
          exists = true;
        } else if (effect === 'drop') {
          exists = false;
        } else {
          referencesSeen += 1;

          if (!exists) {
            touchedWhileAbsent.push(`${migration.version} (${migration.file})`);
          }
        }
      }
    }

    // The consolidation's `UPDATE ci.events ... FROM ci.event_analytics` is the
    // reference this test exists to protect; assert it was actually reached.
    expect(referencesSeen).toBeGreaterThan(0);
    expect(touchedWhileAbsent).toStrictEqual([]);
  });

  it('has no TypeScript reader or writer', () => {
    const referencing = tsFilesUnderSrc().filter((file) => {
      const body = readFileSync(file, 'utf8');

      return body.includes(TABLE) && !file.endsWith(path.basename(__filename));
    });

    expect(referencing).toStrictEqual([]);
  });
});
