/**
 * The Makefile recipes for the xtask commands that must clean up after an interrupt.
 *
 * `yarn tsx <script>` runs the script as a CHILD of the tsx CLI, which relays SIGINT and SIGTERM to it and
 * SIGKILLs it when it has not acknowledged within about 60 ms. `test-db` and `test` spend their time blocked
 * in a child process (docker, jest, a workspace's test run), so they cannot acknowledge in time: the relay
 * kills them mid-run, with no summary, a leftover temp directory and, for `test-db`, sometimes a Postgres
 * container still running. Measured on a real `make test-db`: the container leaked on 2 of 2 group-SIGINTs at
 * start-up, and 10 of 11 group-SIGTERMs during jest killed xtask outright, through the wrapper; with the
 * wrapper out of the path, 27 of 27 signals were handled cleanly. `node --import tsx` loads the same loader in the same process, with nothing between the signal and
 * xtask. Nothing in a unit test can see this happen, so the recipe text is what is pinned.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { HELP } from './commands/test-db';

/** The recipe lines (tab-indented, not comments) of one target. */
function recipe(makefile: string, target: string): string[] {
  const lines = makefile.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${target}:`));

  assert.notEqual(start, -1, `no '${target}:' target in the Makefile`);

  const out: string[] = [];

  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('\t')) {
      if (line.trim() === '' || line.startsWith('.PHONY')) {
        break;
      }

      continue;
    }

    if (!line.trimStart().startsWith('@#') && !line.trimStart().startsWith('#')) {
      out.push(line.trim());
    }
  }

  return out;
}

const makefile = fs.readFileSync(path.join(process.cwd(), 'Makefile'), 'utf8');

for (const command of ['test', 'test-db']) {
  test(`make ${command} runs xtask without the tsx CLI wrapper`, () => {
    const lines = recipe(makefile, command);
    const xtask = lines.filter((line) => line.includes('scripts/xtask/index.ts'));

    assert.equal(
      xtask.length,
      1,
      `expected exactly one xtask line in the '${command}' recipe, got: ${lines.join(' | ')}`,
    );
    assert.doesNotMatch(
      xtask[0],
      /\byarn tsx\b/,
      `'${command}' goes through the tsx CLI wrapper, which SIGKILLs xtask on Ctrl-C`,
    );
    assert.match(xtask[0], /\bnode --import tsx\b/, `'${command}' must run xtask as \`node --import tsx\``);
  });
}

test('every make variable `test-db --help` shows is passed on by the Makefile, as the flag it stands for', () => {
  const line = recipe(makefile, 'test-db').find((l) => l.includes('scripts/xtask/index.ts')) ?? '';
  // `make test-db KEEP=1 WORKERS=2 DB_IMAGE=my/db:1   # ...`: the NAME=value words of the make examples.
  const variables = new Set(
    [...HELP.matchAll(/^ {2}make test-db ([^#\n]*)/gm)].flatMap((m) =>
      [...m[1].matchAll(/\b([A-Z][A-Z_]*)=/g)].map((v) => v[1]),
    ),
  );

  // ARGS rides after `--`; the rest each become one flag.
  for (const name of ['KEEP', 'KEEP_FOR', 'WORKERS', 'DB_IMAGE', 'NO_RETRY']) {
    assert.ok(variables.has(name), `${name} is not in --help's make examples`);
  }

  for (const name of [...variables].filter((v) => v !== 'ARGS')) {
    assert.match(
      line,
      new RegExp(`\\$\\(if \\$\\(${name}\\),--[a-z-]+`),
      `${name} is shown in --help but not wired in the Makefile`,
    );
  }

  assert.match(
    line,
    /\$\(if \$\(KEEP_FOR\),--keep-for \$\(KEEP_FOR\)\)/,
    'KEEP_FOR becomes --keep-for <value>',
  );
  assert.match(line, /\$\(if \$\(KEEP\),--keep\)/, 'KEEP is still the bare flag');
});
