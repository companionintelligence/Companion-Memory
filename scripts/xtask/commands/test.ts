/**
 * test — ports the `test` target, the pre-port Makefile.
 *
 * The untested-workspace report (1006-1017) is reimplemented natively here
 * (`yarn workspaces list --json` + `JSON.parse` each package.json) rather
 * than porting the original's sed-plus-shelled-`node -e` pipeline
 * character-for-character — behaviorally identical, considerably easier to
 * read. Everything else is a direct, sequential, fail-fast port.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { run, tryRun } from '../lib/exec';
import { ok, info } from '../../dev-stack/log';

const YELLOW = '\x1b[0;33m';
const RESET = '\x1b[0m';

/** Mirrors `find frontend/apps/desktop/scripts -name '*.test.cjs'` filtered to
 * exclude any node_modules subtree, then `sort` — recursive. */
function findDesktopTestSuites(root: string): string[] {
  const start = path.join(root, 'frontend/apps/desktop/scripts');
  const results: string[] = [];

  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) {
      return;
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') {
        continue;
      }

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.test.cjs')) {
        results.push(full);
      }
    }
  };

  walk(start);

  return results.sort();
}

interface WorkspaceListEntry {
  location: string;
}

/** Every workspace `yarn workspaces foreach --all run test` silently skips
 * because it declares no `test` script — the pre-port Makefile's own fix for
 * `foreach`'s silent skip, which `typecheck` (the pre-port Makefile) already had to
 * learn the same lesson from. */
function findUntestedWorkspaces(root: string): string[] {
  const out = tryRun('yarn', ['workspaces', 'list', '--json'], { cwd: root }).stdout;
  const locations = out
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as WorkspaceListEntry).location);

  return locations.filter((loc) => {
    const pkgPath = path.join(root, loc, 'package.json');

    if (!fs.existsSync(pkgPath)) {
      return true;
    }

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };

    return !pkg.scripts?.test;
  });
}

export async function runTest(root: string): Promise<void> {
  console.log('🧪 Running tests...\n');

  // foreach only runs workspaces that declare a test script, so a new
  // workspace's tests are picked up without a line here.
  run('yarn', ['workspaces', 'foreach', '--all', 'run', 'test'], { cwd: root });

  console.log('');

  // frontend/apps/desktop is deliberately EXCLUDED from the Yarn workspaces
  // (Tauri needs a real node_modules tree PnP does not produce), so it is
  // invisible to the line above and to the untested-workspace warning below.
  // Dependency-free — node's own runner, no install.
  const suites = findDesktopTestSuites(root);

  if (suites.length === 0) {
    throw new Error(
      'Found no *.test.cjs under frontend/apps/desktop/scripts — this step would have checked nothing.',
    );
  }

  run('node', ['--test', ...suites], { cwd: root });

  console.log('');

  run('uv', ['run', 'pytest'], { cwd: root });

  console.log('');

  // The gateway entrypoint is plain sh with no Docker in its test, so it runs
  // here rather than in any workspace. Its own file says what it covers.
  run('sh', ['infrastructure/gateway/test.sh'], { cwd: root });

  console.log('');

  // The secrets generator is plain sh with no Docker in its test, so it runs
  // here rather than in any workspace. Its own file says what it covers.
  run('sh', ['infrastructure/setup-secrets/test.sh'], { cwd: root });

  console.log('');
  ok('All the tests that exist passed.');
  console.log('');

  const untested = findUntestedWorkspaces(root);

  if (untested.length > 0) {
    console.log(
      `${YELLOW}⚠${RESET}  ${untested.length} workspace(s) declare no 'test' script and were skipped, silently, by 'yarn workspaces foreach':`,
    );

    for (const loc of untested) {
      // The root workspace used to be listed here permanently with a note that
      // its only suites were the Playwright e2e configs. It now declares a
      // `test` script (the xtask suite), so it no longer reaches this branch —
      // the label is kept only for the case where that script is removed again.
      const text = loc === '.' ? '. (repo root)' : loc;

      console.log(`       ${text}`);
    }

    console.log('');
  }

  // The native suites are deliberately not part of this target.
  info(`Native suites are separate: ${YELLOW}make test-android${RESET}, ${YELLOW}make test-desktop${RESET}`);
  console.log('');
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { help: { type: 'boolean' } },
    allowPositionals: false,
  });

  if (values.help) {
    console.log('Usage: xtask test\n\nRun the unit tests, both stacks.');

    return;
  }

  await runTest(process.cwd());
}
