/** lint — ports the `lint` target, Makefile:913-933. Straight sequential,
 * fail-fast port; the only branching is the uv.lock freshness gate's custom
 * error message. */
import { parseArgs } from 'node:util';

import { run } from '../lib/exec';
import { ok } from '../../dev-stack/log';

export async function runLint(root: string): Promise<void> {
  console.log('🔎 Checking formatting...\n');

  run('yarn', ['lint'], { cwd: root });
  run('yarn', ['format:check'], { cwd: root });

  console.log('');

  run('uv', ['run', 'ruff', 'check', '.'], { cwd: root });
  run('uv', ['run', 'ruff', 'format', '--check', '.'], { cwd: root });
  run('uv', ['run', 'mypy'], { cwd: root });

  // Catches a uv.lock left stale after the merge driver kept one side (see
  // scripts/merge-uv-lock.sh) or a manifest edit without a relock.
  try {
    run('uv', ['lock', '--check'], { cwd: root });
  } catch {
    throw new Error("uv.lock is out of date with the manifests. Run 'uv lock' and retry.");
  }

  run('sh', ['scripts/check-ci-namespace.sh'], { cwd: root });
  run('node', ['scripts/check-capacitor-native-sync.mjs'], { cwd: root });

  console.log('');
  ok('No lint errors found.');
  console.log('');
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { help: { type: 'boolean' } },
    allowPositionals: false,
  });

  if (values.help) {
    console.log('Usage: xtask lint\n\nCheck the source for lint and formatting errors, both stacks.');

    return;
  }

  await runLint(process.cwd());
}
