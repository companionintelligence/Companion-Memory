/** format — ports the `format` target, Makefile:711-722. No branching logic
 * to speak of: a straight sequential, fail-fast port. */
import { parseArgs } from 'node:util';

import { run } from '../lib/exec';
import { ok } from '../../dev-stack/log';

export async function runFormat(root: string): Promise<void> {
  console.log('🧹 Formatting source...\n');

  run('yarn', ['format'], { cwd: root });

  console.log('');

  run('uv', ['run', 'ruff', 'format', '.'], { cwd: root });
  run('uv', ['run', 'ruff', 'check', '--fix', '.'], { cwd: root });

  console.log('');
  ok('Source successfully formatted.');
  console.log('');
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean' } }, allowPositionals: false });

  if (values.help) {
    console.log('Usage: xtask format\n\nFormat the source, both stacks (yarn + ruff).');

    return;
  }

  await runFormat(process.cwd());
}
