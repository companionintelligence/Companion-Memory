/**
 * The guard on the curated list's other half.
 *
 * "Life details" is a contract between two files that no compiler checks:
 * lifeDetails.ts names 29 questions by `ci.questions.question_key`, and
 * 20260824234643_seed_life_details_question_keys.sql is what puts rows under
 * those keys in the database. Break the contract and nothing errors — the grid
 * renders questions from the hardcoded list, the catalogue returns no row for
 * them, and the section is quietly unanswerable. That is exactly what shipped
 * when the list keyed off `question_id` (a uuid `gen_uuid_v7()` mints fresh on
 * every appliance) and 27 of the 29 ids matched nothing outside the machine
 * they were captured on.
 *
 * So the migration is parsed and diffed against the list. A curated question
 * added on one side and forgotten on the other fails here, at `yarn test`,
 * instead of on somebody else's appliance.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  curatedQuestionKeys,
  curatedQuestions,
  HOME_TOWN_CITY_QUESTION_KEYS,
  LIFE_DETAIL_THEMES,
} from './lifeDetails';

const MIGRATION_FILE =
  'backend/apps/api/db/postgres/migrations/20260824234643_seed_life_details_question_keys.sql';

/**
 * Walk up to the repo root rather than counting `..` segments: this file sits
 * six directories deep in one workspace and the migration lives in another, and
 * a hardcoded relative path silently rots the first time either moves.
 */
function migrationPath(): string {
  let dir = __dirname;

  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, MIGRATION_FILE);
    if (existsSync(candidate)) {
      return candidate;
    }

    dir = path.dirname(dir);
  }

  throw new Error(`Could not find ${MIGRATION_FILE} above ${__dirname}`);
}

interface SeededQuestion {
  key: string;
  text: string;
  category: string;
  questionType: string;
  tier: string;
}

/**
 * Split one `VALUES` tuple on its top-level commas. Quoted strings (which
 * contain commas, and may contain `''` escapes) and `ARRAY[...]` literals are
 * skipped over rather than split inside.
 */
function splitTupleFields(tuple: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inString = false;
  let bracketDepth = 0;

  for (let i = 0; i < tuple.length; i += 1) {
    const char = tuple[i];

    if (inString) {
      if (char === "'" && tuple[i + 1] === "'") {
        current += "''";
        i += 1;
        continue;
      }

      inString = char !== "'";
      current += char;
      continue;
    }

    if (char === "'") {
      inString = true;
      current += char;
      continue;
    }

    if (char === '[') {
      bracketDepth += 1;
    } else if (char === ']') {
      bracketDepth -= 1;
    }

    if (char === ',' && bracketDepth === 0) {
      fields.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  fields.push(current.trim());

  return fields;
}

/** `'What is your blood type?'` -> `What is your blood type?`. */
function unquote(field: string): string {
  if (!field.startsWith("'") || !field.endsWith("'")) {
    throw new Error(`Expected a quoted SQL literal, got: ${field}`);
  }

  return field.slice(1, -1).split("''").join("'");
}

/**
 * Pull the seeded rows out of the migration's `INSERT INTO
 * _curated_life_details ... VALUES (...)` block.
 *
 * Every step throws rather than returning nothing: a parser that silently
 * yields an empty list would turn this whole file into a test that passes no
 * matter what the migration says, which is worse than having no test.
 */
function parseSeededQuestions(sql: string): SeededQuestion[] {
  const columnsMatch = sql.match(/INSERT INTO _curated_life_details\s*\(([^)]*)\)\s*VALUES/);
  if (!columnsMatch) {
    throw new Error('Could not find the INSERT INTO _curated_life_details ... VALUES block');
  }

  const columns = columnsMatch[1].split(',').map((column) => column.trim());
  for (const required of [
    'question_key',
    'question_text',
    'question_category',
    'question_type',
    'answer_tier',
  ]) {
    if (!columns.includes(required)) {
      throw new Error(`The seed migration no longer inserts a ${required} column`);
    }
  }

  const body = sql.slice(columnsMatch.index! + columnsMatch[0].length);
  const end = body.indexOf(';');
  if (end === -1) {
    throw new Error('The VALUES block is not terminated');
  }

  const tuples = body.slice(0, end).match(/\(([\s\S]*?)\)(?=\s*,\s*\(|\s*$)/g);
  if (!tuples || tuples.length === 0) {
    throw new Error('The VALUES block contains no rows');
  }

  return tuples.map((tuple) => {
    const fields = splitTupleFields(tuple.trim().slice(1, -1));
    if (fields.length !== columns.length) {
      throw new Error(`Expected ${columns.length} fields, parsed ${fields.length}, in: ${tuple}`);
    }

    const at = (column: string) => unquote(fields[columns.indexOf(column)]);

    return {
      key: at('question_key'),
      text: at('question_text'),
      category: at('question_category'),
      questionType: at('question_type'),
      tier: at('answer_tier'),
    };
  });
}

const seeded = parseSeededQuestions(readFileSync(migrationPath(), 'utf8'));
const seededByKey = new Map(seeded.map((question) => [question.key, question]));

describe('the curated Life details list', () => {
  it('parses a plausible number of seeded rows out of the migration', () => {
    // A sanity check on the parser itself: every assertion below is vacuous if
    // this list comes back empty or half-read.
    expect(seeded.length).toBeGreaterThanOrEqual(curatedQuestions().length);
    expect(seededByKey.size).toBe(seeded.length);
  });

  it('names only keys the seed migration actually creates', () => {
    const unseeded = curatedQuestions()
      .filter((question) => !seededByKey.has(question.key))
      .map((question) => question.key);

    // The failure this whole file exists for: a curated question with no row
    // behind it renders an input that silently discards the answer.
    expect(unseeded).toEqual([]);
  });

  it('agrees with the migration about every question it shows', () => {
    const drifted = curatedQuestions()
      .map((question) => ({ question, seed: seededByKey.get(question.key) }))
      .filter(({ question, seed }) => seed !== undefined && seed.text !== question.text)
      .map(({ question, seed }) => ({ key: question.key, file: question.text, migration: seed!.text }));

    expect(drifted).toEqual([]);
  });

  it('agrees with the migration about every question category, type and tier', () => {
    const drifted = curatedQuestions()
      .map((question) => ({ question, seed: seededByKey.get(question.key) }))
      .filter(
        ({ question, seed }) =>
          seed !== undefined &&
          (seed.category !== question.category ||
            seed.questionType !== question.questionType ||
            seed.tier !== question.tier),
      )
      .map(({ question, seed }) => ({
        key: question.key,
        file: [question.category, question.questionType, question.tier],
        migration: [seed!.category, seed!.questionType, seed!.tier],
      }));

    expect(drifted).toEqual([]);
  });

  it('uses each key exactly once, in one theme only', () => {
    const keys = curatedQuestions().map((question) => question.key);
    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);

    // Two themes sharing a key would render one question twice and let each
    // copy overwrite the other's answer.
    expect(duplicates).toEqual([]);
  });

  it('uses keys the database will accept', () => {
    // Mirrors questions_question_key_format on ci.questions: a key that fails
    // the CHECK cannot be seeded, so it could only ever match nothing.
    const malformed = curatedQuestions()
      .map((question) => question.key)
      .filter((key) => !/^[a-z0-9]+(_[a-z0-9]+)*$/.test(key));

    expect(malformed).toEqual([]);
  });

  it('gives every theme at least one question', () => {
    expect(LIFE_DETAIL_THEMES.filter((theme) => theme.questions.length === 0)).toEqual([]);
  });

  it('lets other surfaces name curated keys, but only ones this list actually has', () => {
    // The Map's home camera (useHomeMapCenter) picks two questions out of this
    // list by key. Nothing else ties the two files together, so a key renamed
    // here — or a home-town key that was never curated — would leave the Map
    // silently unable to find a home city, the same failure by another route.
    const unknown = HOME_TOWN_CITY_QUESTION_KEYS.filter((key) => !curatedQuestionKeys().includes(key));

    expect(unknown).toEqual([]);
  });
});
