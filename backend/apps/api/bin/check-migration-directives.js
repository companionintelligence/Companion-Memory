/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Guard against migration comments that dbmate reads as directives.
 *
 * dbmate does not parse SQL. It finds `-- migrate:up` and `-- migrate:down`
 * with a line-anchored regex, so a comment line that merely STARTS with one is
 * a directive as far as it is concerned. 20260930025958 wrapped its prose as
 *
 *   -- re-runs a migration. (The statement below is idempotent, so running the
 *   -- migrate:up half again by hand is safe if the census at the bottom ever finds
 *
 * and what a line like that does depends on the dbmate version:
 *
 *  - up to 2.28 the first of each marker wins, so a stray up line is harmless,
 *    but a stray `-- migrate:down` inside the up half silently ends it there:
 *    every statement below it is filed under rollback and never runs.
 *  - from 2.29 every `-- migrate:up` opens a new section that needs its own
 *    `-- migrate:down`, so the line above fails the whole file ("dbmate requires
 *    each migration to define a down block") and `migrate` stops for every
 *    database that has not applied it yet. #2865 moved dbmate from 2.27 to 2.36
 *    and did exactly that. A stray down fails the file too (with a message of
 *    its own since 2.34). Sections that DO pair up are no better on Postgres:
 *    each one inserts the version into schema_migrations, so the second dies on
 *    the primary key after the first has committed, leaving the file half
 *    applied and recorded as done.
 *
 * So every file gets exactly one of each, up first. In prose, quote the word
 * (-- `migrate:up`) or re-wrap the line so it does not start with it.
 *
 * Plain CommonJS with no dependencies, like check-migration-versions.js beside
 * it and for the same reason: `yarn migrate` runs both in the production image.
 */

const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const MIGRATIONS_DIR = join(__dirname, '../db/postgres/migrations');

// dbmate's own patterns (upRegExp / downRegExp in pkg/dbmate/migration.go),
//   (?m)^--\s*migrate:up(\s*$|\s+\S+)
// transcribed rather than paraphrased, so this counts exactly the lines dbmate
// counts. Go's \s is ASCII-only and its multi-line ^ and $ break at \n alone,
// where JavaScript's \s takes any Unicode space and its m flag also breaks at
// \r and at the Unicode line and paragraph separators. Hence the spelled-out
// class and the lookarounds.
const SPACE = '[\\t\\n\\f\\r ]';
const NOT_SPACE = '[^\\t\\n\\f\\r ]';

function directivePattern(kind) {
  return new RegExp(`(?<=^|\\n)--${SPACE}*migrate:${kind}(?:${SPACE}*(?=\\n|$)|${SPACE}+${NOT_SPACE})`, 'g');
}

/**
 * Every line dbmate would take as a directive, in file order.
 *
 * @param {string} sql
 * @returns {{ kind: 'up' | 'down', index: number, line: number, text: string }[]}
 */
function findDirectives(sql) {
  const found = [];

  for (const kind of ['up', 'down']) {
    for (const match of sql.matchAll(directivePattern(kind))) {
      const end = sql.indexOf('\n', match.index);

      found.push({
        kind,
        index: match.index,
        line: sql.slice(0, match.index).split('\n').length,
        text: sql.slice(match.index, end === -1 ? undefined : end).replace(/\r$/, ''),
      });
    }
  }

  return found.sort((a, b) => a.index - b.index);
}

/**
 * True when dbmate sees exactly one up directive followed by one down: one
 * section, run the way the file reads.
 *
 * @param {ReturnType<typeof findDirectives>} directives
 */
function isSingleSection(directives) {
  return directives.length === 2 && directives[0].kind === 'up' && directives[1].kind === 'down';
}

/**
 * The migrations in `dir` that are not a single section, with the directive
 * lines dbmate would see in each.
 *
 * @param {string} [dir]
 */
function checkMigrationDirectives(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, directives: findDirectives(readFileSync(join(dir, file), 'utf8')) }))
    .filter(({ directives }) => !isSingleSection(directives));
}

if (require.main === module) {
  const failures = checkMigrationDirectives();

  if (failures.length > 0) {
    console.error(
      'Migrations that are not exactly one `-- migrate:up` line followed by one `-- migrate:down` line:',
    );

    for (const { file, directives } of failures) {
      console.error(`\n  ${file}`);

      if (directives.length === 0) {
        console.error('    (no directive lines at all)');
      }

      for (const { line, text } of directives) {
        console.error(`    line ${line}: ${text}`);
      }
    }

    console.error('\ndbmate takes ANY line that starts with `-- migrate:up` or `-- migrate:down` as a');
    console.error('directive, comments included, and splits or truncates the file there. Re-wrap the');
    console.error('comment, or quote the word: -- `migrate:up`.');
    process.exit(1);
  }
}

module.exports = { checkMigrationDirectives, findDirectives, isSingleSection };
