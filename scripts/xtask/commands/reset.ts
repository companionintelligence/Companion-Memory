/**
 * reset — ports the `reset` target, Makefile:409-434. Destructive (removes
 * this worktree's Docker volumes and networks, i.e. all local data), so it
 * supports `--dry-run` to list what would be removed without touching
 * anything, and `stop`/`overmind quit`/the removals are all skipped under it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { run, tryRun } from '../lib/exec';
import { computeProjectName } from '../lib/identity';
import { ok } from '../../dev-stack/log';

export interface ResetOptions {
  dryRun?: boolean;
}

function isSocket(p: string): boolean {
  try {
    return fs.statSync(p).isSocket();
  } catch {
    return false;
  }
}

export async function runReset(root: string, opts: ResetOptions = {}): Promise<void> {
  console.log('🧹 Resetting Docker environment INCLUDING ALL DATA...\n');

  if (opts.dryRun) {
    console.log('  (dry run — would run: make stop)');
  } else {
    run('make', ['stop'], { cwd: root });
  }

  if (isSocket(path.join(root, '.overmind.sock'))) {
    console.log('\n➤ Stopping Overmind dev session...\n');

    if (opts.dryRun) {
      console.log('  (dry run — would run: overmind quit)');
    } else {
      tryRun('overmind', ['quit'], { cwd: root });
    }
  }

  const projectName = computeProjectName(root);

  const vols = tryRun('docker', ['volume', 'ls', '-q', '--filter', `name=${projectName}`])
    .stdout.split('\n')
    .filter(Boolean);

  if (vols.length > 0) {
    console.log('\n➤ Removing project volumes...');
    console.log(vols.join('\n'));

    if (opts.dryRun) {
      console.log('  (dry run — not removed)');
    } else {
      tryRun('docker', ['volume', 'rm', '-f', ...vols]);
    }
  }

  const nets = tryRun('docker', ['network', 'ls', '-q', '--filter', `name=${projectName}`])
    .stdout.split('\n')
    .filter(Boolean);

  if (nets.length > 0) {
    console.log('\n➤ Removing project networks...');
    console.log(nets.join('\n'));

    if (opts.dryRun) {
      console.log('  (dry run — not removed)');
    } else {
      tryRun('docker', ['network', 'rm', '-f', ...nets]);
    }
  }

  console.log('');
  ok('Reset complete.');
  console.log('');
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { help: { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(
      'Usage: xtask reset [--dry-run]\n\nReset the local development environment (stops the stack, removes this worktree\'s Docker volumes and networks — ALL local data). --dry-run lists what would be removed.',
    );

    return;
  }

  await runReset(process.cwd(), { dryRun: values['dry-run'] as boolean | undefined });
}
