import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Readers for the migrations that
 * 20260930171822_reactivate_expanded_reflections_legacy_rows repairs after.
 *
 * That migration copies data out of three other files — the expand migration's
 * VALUES list, the ids 20251214231106_seed_questions pinned, and the category
 * fold in 20260818235602 — and a copy is only as good as the check that it still
 * matches. These parse the files themselves, so the unit test can diff the lists
 * and the integration spec can apply the migration exactly as it sits on disk.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../db/postgres/migrations');

export const REACTIVATION_MIGRATION = '20260930171822_reactivate_expanded_reflections_legacy_rows.sql';
export const EXPAND_MIGRATION = '20260824233929_expand_reflections_catalogue.sql';
export const LEGACY_SEED_MIGRATION = '20251214231106_seed_questions.sql';
export const FUNCTIONAL_CATALOG_MIGRATION = '20260818235602_reflections_functional_catalog.sql';
export const EVIDENCE_CLASS_MIGRATION = '20260825074747_add_question_evidence_class.sql';

export function readMigration(file: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
}

/** One half of a dbmate migration, as dbmate would run it. */
export function migrationSection(file: string, section: 'up' | 'down'): string {
  const sql = readMigration(file);
  const down = sql.indexOf('\n-- migrate:down');

  if (down === -1) {
    throw new Error(`${file} has no "-- migrate:down" section.`);
  }

  return section === 'up' ? sql.slice(0, down) : sql.slice(down);
}

/**
 * The fields of one `VALUES` tuple written on a single line: quoted literals
 * (with `''` escapes) and bare `NULL`. Anything else throws, so a tuple this does
 * not understand fails the test rather than parsing into something plausible.
 */
function parseTupleLine(line: string): Array<string | null> {
  const trimmed = line.trim().replace(/[,;]$/, '');

  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) {
    throw new Error(`Not a one-line tuple: ${line}`);
  }

  const body = trimmed.slice(1, -1);
  const fields: Array<string | null> = [];
  let i = 0;

  while (i < body.length) {
    while (body[i] === ' ') {
      i += 1;
    }

    if (body[i] === "'") {
      let value = '';

      i += 1;

      for (;;) {
        if (i >= body.length) {
          throw new Error(`Unterminated literal in: ${line}`);
        }

        if (body[i] === "'") {
          if (body[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }

          i += 1;
          break;
        }

        value += body[i];
        i += 1;
      }

      fields.push(value);
    } else if (body.startsWith('NULL', i)) {
      fields.push(null);
      i += 'NULL'.length;
    } else {
      throw new Error(`Unexpected token at ${i} in: ${line}`);
    }

    while (body[i] === ' ') {
      i += 1;
    }

    if (i < body.length) {
      if (body[i] !== ',') {
        throw new Error(`Expected a comma at ${i} in: ${line}`);
      }

      i += 1;
    }
  }

  return fields;
}

/**
 * Every data tuple between two markers: a line that opens with `('`, which a
 * column list — `(question_text, ...` — never does.
 */
function tuplesBetween(sql: string, start: string, end: string): Array<Array<string | null>> {
  const from = sql.indexOf(start);
  const to = sql.indexOf(end, from + start.length);

  if (from === -1 || to === -1) {
    throw new Error(`Cannot find the block between "${start}" and "${end}".`);
  }

  return sql
    .slice(from + start.length, to)
    .split('\n')
    .filter((line) => /^\s*\('/.test(line))
    .map(parseTupleLine);
}

function text(field: string | null, line: Array<string | null>): string {
  if (field == null) {
    throw new Error(`Unexpected NULL in (${line.join(', ')})`);
  }

  return field;
}

export interface CatalogueRow {
  questionText: string;
  questionCategory: string;
  questionType: string;
  answerTier: string;
}

export interface ReactivationRow extends CatalogueRow {
  legacyQuestionId: string | null;
}

/** 20260824233929's list, in its own order. */
export function expandList(): CatalogueRow[] {
  return tuplesBetween(readMigration(EXPAND_MIGRATION), 'FROM (VALUES', ') AS v(').map((row) => {
    if (row.length !== 4) {
      throw new Error(`Expected 4 fields, got ${row.length}: ${row.join(', ')}`);
    }

    return {
      questionText: text(row[0], row),
      questionCategory: text(row[1], row),
      questionType: text(row[2], row),
      answerTier: text(row[3], row),
    };
  });
}

/** 20260930171822's list, in its own order. */
export function reactivationList(): ReactivationRow[] {
  return tuplesBetween(
    migrationSection(REACTIVATION_MIGRATION, 'up'),
    'INSERT INTO _expanded_reflections',
    'WITH batch AS',
  ).map((row) => {
    if (row.length !== 5) {
      throw new Error(`Expected 5 fields, got ${row.length}: ${row.join(', ')}`);
    }

    return {
      questionText: text(row[0], row),
      questionCategory: text(row[1], row),
      questionType: text(row[2], row),
      answerTier: text(row[3], row),
      legacyQuestionId: row[4],
    };
  });
}

export interface LegacySeedRow {
  questionId: string;
  /** As it stands after 20260818235602 step 2 stripped the trailing-digit artefact. */
  questionText: string;
  /** As seeded — before 20260818235602 step 4 folded it. */
  questionCategory: string;
}

/** The rows 20251214231106 pinned. */
export function legacySeedRows(): LegacySeedRow[] {
  return tuplesBetween(readMigration(LEGACY_SEED_MIGRATION), 'VALUES', 'ON CONFLICT').map((row) => ({
    questionId: text(row[0], row),
    questionText: text(row[1], row).replace(/\s+[0-9]{1,3}\s*$/, ''),
    questionCategory: text(row[2], row),
  }));
}

/** `WHEN 'a' THEN 'b'` pairs, as a map from a to b. */
function caseMap(sql: string): Map<string, string> {
  return new Map([...sql.matchAll(/WHEN '([^']+)'\s+THEN '([^']+)'/g)].map((m) => [m[1], m[2]]));
}

/** 20260818235602 step 4: the fold from the legacy categories onto the eight that survived. */
export function functionalCatalogFold(): Map<string, string> {
  const sql = readMigration(FUNCTIONAL_CATALOG_MIGRATION);
  const from = sql.indexOf('-- 4. Fold');
  const to = sql.indexOf('-- 5. The catalogue.');

  if (from === -1 || to === -1) {
    throw new Error(`Cannot find step 4 of ${FUNCTIONAL_CATALOG_MIGRATION}.`);
  }

  return caseMap(sql.slice(from, to));
}

/** The reactivation's down: the fold from the expand categories back onto the eight. */
export function reactivationDownFold(): Map<string, string> {
  return caseMap(migrationSection(REACTIVATION_MIGRATION, 'down'));
}

/** Every id the reactivation's down may reset. */
export function reactivationDownIds(): string[] {
  return [
    ...migrationSection(REACTIVATION_MIGRATION, 'down').matchAll(
      /'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/g,
    ),
  ].map((m) => m[1]);
}

/**
 * The rating-scale pattern 20260825074747 retires rows by, verbatim. Anchored on
 * its opening alternative: the same file matches `question_text ~*` against
 * other patterns first.
 */
export function ratingScalePattern(): string {
  const match = /AND question_text ~\* '(\(scale of 1\|[^']+)'/.exec(readMigration(EVIDENCE_CLASS_MIGRATION));

  if (match == null) {
    throw new Error(`Cannot find the rating-scale pattern in ${EVIDENCE_CLASS_MIGRATION}.`);
  }

  return match[1];
}

/** The key every seed migration's NOT EXISTS guard compares on: lower(btrim(question_text)). */
export function textKey(value: string): string {
  return value.replace(/^ +| +$/g, '').toLowerCase();
}
