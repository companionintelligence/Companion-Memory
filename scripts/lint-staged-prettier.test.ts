import assert from 'node:assert/strict';
import { test } from 'node:test';

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

type Task = string | ((files: string[]) => string | string[]);

async function loadConfig(path: string): Promise<Record<string, Task | Task[]>> {
  if (path.endsWith('.mjs')) {
    return (await import(pathToFileURL(join(ROOT, path)).href)).default;
  }

  return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

function commands(tasks: Task | Task[]): string[] {
  return [tasks].flat().flatMap((t) => (typeof t === 'function' ? [t(['x.ts'])].flat() : [t]));
}

// A nested config replaces the root one for its whole subtree, so a config
// that forgets Prettier silently exempts every file under it — which is how
// be-api and fe-web went unformatted at commit time for months.
test('every lint-staged config that handles TypeScript runs prettier --write', async () => {
  const configs = execFileSync('git', ['ls-files', '--', ':(glob)**/.lintstagedrc*'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  assert.ok(configs.length >= 3, `expected the root and two app configs, found ${configs}`);

  for (const path of configs) {
    const tsGlobs = Object.entries(await loadConfig(path)).filter(([glob]) => /[{,]ts[,}]|\.ts$/.test(glob));
    assert.ok(tsGlobs.length > 0, `${path} has no TypeScript glob`);

    for (const [glob, tasks] of tsGlobs) {
      const prettier = commands(tasks).find((c) => /\bprettier\b.*--write/.test(c));
      assert.ok(prettier, `${path} "${glob}" never runs prettier --write`);

      // Tasks run from the config's directory, where Prettier cannot see the
      // root ignore file. The root config runs from the root, so it is exempt.
      if (dirname(path) !== '.') {
        assert.ok(
          prettier.includes(`--ignore-path "${join(ROOT, '.prettierignore')}"`),
          `${path} runs prettier without the root .prettierignore`,
        );
      }
    }
  }
});

// The failure the ignore path prevents: from frontend/apps/web, a bare
// Prettier formats the generated graphql.ts, and the codegen check then fails.
test('the nested prettier task still ignores the generated GraphQL client', async () => {
  const { prettierWrite } = await import(pathToFileURL(join(ROOT, 'scripts/lint-staged-prettier.mjs')).href);
  const ignorePaths = [...(prettierWrite as string).matchAll(/--ignore-path "([^"]+)"/g)].flatMap((m) => [
    '--ignore-path',
    m[1],
  ]);
  const info = (...extra: string[]) =>
    JSON.parse(
      execFileSync('yarn', ['run', '-T', 'prettier', '--file-info', 'src/graphql/graphql.ts', ...extra], {
        cwd: join(ROOT, 'frontend/apps/web'),
        encoding: 'utf8',
      }),
    ).ignored;

  assert.equal(info(), false, 'precondition: from this cwd Prettier alone does not ignore it');
  assert.equal(info(...ignorePaths), true);
});
