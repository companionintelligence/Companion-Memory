import path from 'node:path';

/**
 * bin/check-migration-directives.js keeps a comment line from turning into a
 * dbmate directive (see that file for what each dbmate version does with one).
 * It runs before every `yarn migrate` and from lint-staged; this suite runs it
 * over every committed migration too, so `make test` catches a stray directive
 * that reached main through a commit that skipped the hook, and pins the guard
 * to the dbmate behaviour it copies.
 *
 * The guard is plain CommonJS under bin/ because the production image runs it,
 * hence the require.
 */

interface Directive {
  kind: 'up' | 'down';
  index: number;
  line: number;
  text: string;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const guard = require(path.resolve(__dirname, '../../../../bin/check-migration-directives.js')) as {
  checkMigrationDirectives(dir?: string): { file: string; directives: Directive[] }[];
  findDirectives(sql: string): Directive[];
  isSingleSection(directives: Directive[]): boolean;
};

function directiveLines(sql: string): string[] {
  return guard.findDirectives(sql).map(({ kind, line }) => `${kind}@${line}`);
}

function isSingleSection(sql: string): boolean {
  return guard.isSingleSection(guard.findDirectives(sql));
}

describe('migration directives', () => {
  it('finds exactly one up and then one down in every committed migration', () => {
    expect(guard.checkMigrationDirectives()).toStrictEqual([]);
  });

  it('catches a wrapped comment line that starts with a directive, as 20260930025958 once had', () => {
    const sql = [
      '-- migrate:up',
      '-- re-runs a migration. (The statement below is idempotent, so running the',
      '-- migrate:up half again by hand is safe if the census at the bottom ever finds',
      'SELECT 1;',
      '-- migrate:down',
      'SELECT 1;',
    ].join('\n');

    expect(directiveLines(sql)).toStrictEqual(['up@1', 'up@3', 'down@5']);
    expect(isSingleSection(sql)).toBe(false);
  });

  it('catches a stray down inside the up half, where dbmate up to 2.28 silently ended it', () => {
    const sql = [
      '-- migrate:up',
      'CREATE TABLE a (id int);',
      '-- migrate:down is a no-op for the table below, because',
      'CREATE TABLE b (id int);',
      '-- migrate:down',
      'DROP TABLE a;',
    ].join('\n');

    expect(directiveLines(sql)).toStrictEqual(['up@1', 'down@3', 'down@5']);
    expect(isSingleSection(sql)).toBe(false);
  });

  it('leaves the word alone when it is quoted or mid-line', () => {
    const sql = [
      '-- migrate:up',
      '-- `migrate:up` half again by hand is safe',
      '-- running the migrate:up half again by hand is safe',
      'SELECT 1;',
      '-- migrate:down',
      '',
    ].join('\n');

    expect(directiveLines(sql)).toStrictEqual(['up@1', 'down@5']);
    expect(isSingleSection(sql)).toBe(true);
  });

  it('matches what dbmate matches: options, no space and CRLF count; indentation or a longer word does not', () => {
    expect(
      directiveLines('-- migrate:up transaction:false\r\nSELECT 1;\r\n--migrate:down\r\n'),
    ).toStrictEqual(['up@1', 'down@3']);
    expect(
      directiveLines('-- migrate:up\n  -- migrate:up\n-- migrate:upgrade\n-- migrate:down\n'),
    ).toStrictEqual(['up@1', 'down@4']);
  });

  it('wants the up before the down', () => {
    expect(isSingleSection('-- migrate:down\nSELECT 1;\n-- migrate:up\nSELECT 1;\n')).toBe(false);
  });
});
