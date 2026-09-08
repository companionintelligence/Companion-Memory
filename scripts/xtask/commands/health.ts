/**
 * health — ports the `health` target, Makefile:736-854.
 *
 * Node/yarn/uv presence+version are FATAL (Makefile exits 1 on any of
 * them); the git-hooks repair and the docker-volume-orphan report are
 * explicitly "warn, never fail" (Makefile:803,832's own comments) — `dev`
 * calls this in-process and must only abort on the fatal set, so the
 * result distinguishes the two rather than collapsing to one boolean.
 */
import fs from 'node:fs';
import path from 'node:path';

import { tryRun } from '../lib/exec';
import { computeRepo, gitMainRoot, projectNameFor } from '../lib/identity';
import { ok, fail, note, info } from '../../dev-stack/log';

export interface HealthResult {
  fatalOk: boolean;
  warnings: string[];
}

function checkNode(root: string): boolean {
  const node = tryRun('which', ['node']).stdout.trim();

  if (!node) {
    const nvmrc = fs.existsSync(path.join(root, '.nvmrc'))
      ? fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim()
      : '[unknown]';

    fail(`You do not have 'node' installed or it is not in your path. Please install NodeJS v${nvmrc} first.`);
    console.log('');

    return false;
  }

  ok(`NodeJS found at ${node}`);
  console.log('');

  const required = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
  const current = tryRun('node', ['-v']).stdout.trim().replace(/^v/, '');

  if (current !== required) {
    fail(`Node version mismatch. Expected ${required}, but got ${current}.`);
    console.log('');

    return false;
  }

  ok(`Node version matches (${current})`);
  console.log('');

  return true;
}

function checkYarn(root: string): boolean {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { packageManager?: string };
  const required = pkg.packageManager?.split('@')[1] ?? '';
  const current = tryRun('yarn', ['--version']).stdout.trim();

  if (!current) {
    fail("You do not have 'yarn' installed or it is not in your PATH.");
    console.log('');

    return false;
  }

  if (current !== required) {
    fail(`Yarn version mismatch. Expected ${required}, but got ${current}.`);
    console.log('');

    return false;
  }

  ok(`Yarn version matches (${current})`);
  console.log('');

  return true;
}

function checkUv(): boolean {
  const uv = tryRun('which', ['uv']).stdout.trim();

  if (!uv) {
    fail("You do not have 'uv' installed or it is not in your path. Install it with 'brew install uv'.");
    console.log('');

    return false;
  }

  const version = tryRun('uv', ['--version']).stdout.trim().split(' ')[1] ?? '';

  ok(`uv found at ${uv} (${version})`);
  console.log('');

  return true;
}

/**
 * The trickiest block: resolves a possibly-relative `core.hooksPath`
 * against the worktree root, and — if it points nowhere in THIS worktree —
 * repairs it to the main checkout's `.husky/_`, so the pre-commit guards
 * (the migration-version check, the plist/Capacitor sync checks) actually
 * fire in a linked worktree instead of running nothing with no message.
 *
 * Deliberate improvement over the Makefile (confirmed in the plan): before
 * attempting the `--worktree` write, this also runs
 * `git config extensions.worktreeConfig true` — without it, `--worktree`
 * likely persists nowhere on a repo that never turned that on (which
 * nothing else in this Makefile does), so today's repair probably no-ops
 * silently and falls through to printing manual instructions. The success
 * message is still gated on the write's actual exit status either way —
 * never claimed unless earned.
 */
function checkGitHooks(root: string): string | null {
  const hooks = tryRun('git', ['config', '--get', 'core.hooksPath'], { cwd: root }).stdout.trim();

  if (!hooks) {
    ok('git hooks: repository default (no core.hooksPath override)');
    console.log('');

    return null;
  }

  const toplevel = tryRun('git', ['rev-parse', '--show-toplevel'], { cwd: root }).stdout.trim();
  const resolved = hooks.startsWith('/') ? hooks : path.join(toplevel, hooks);
  const mainHooks = path.join(gitMainRoot(root), '.husky/_');

  if (fs.existsSync(path.join(resolved, 'pre-commit'))) {
    ok(`git hooks resolve (${resolved})`);
    console.log('');

    return null;
  }

  if (fs.existsSync(path.join(mainHooks, 'pre-commit'))) {
    tryRun('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: root });

    const repaired = tryRun('git', ['config', '--worktree', 'core.hooksPath', mainHooks], { cwd: root }).status === 0;

    if (repaired) {
      const msg = `core.hooksPath was '${hooks}', which does not exist in this worktree — commits here were running NO pre-commit checks.\n  Repaired: this worktree now uses ${mainHooks}`;

      note(msg);
      console.log('');

      return msg;
    }
  }

  const msg =
    `core.hooksPath is '${hooks}', which does not exist here, so commits in this worktree run NO pre-commit checks\n` +
    `  (no migration-version guard, no plist or Capacitor sync check). Repair it with either:\n` +
    `    yarn prepare                                                  # re-creates .husky/_ in this worktree\n` +
    `    git config extensions.worktreeConfig true && \\\n` +
    `      git config --worktree core.hooksPath "${mainHooks}"`;

  note(msg);
  console.log('');

  return msg;
}

/** Purely informational: flags data volumes whose worktree is gone. Never
 * removes anything. Silently does nothing if Docker itself isn't reachable
 * — matches Makefile:833's `if docker volume ls >/dev/null 2>&1; then`. */
function reportOrphanVolumes(root: string): string | null {
  if (tryRun('docker', ['volume', 'ls']).status !== 0) {
    return null;
  }

  const repo = computeRepo(root);
  const mainRoot = gitMainRoot(root);

  const worktreePaths = tryRun('git', ['worktree', 'list', '--porcelain'], { cwd: root })
    .stdout.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim());

  const active = new Set(worktreePaths.map((p) => projectNameFor(p, mainRoot, repo)));

  const vols = tryRun('docker', ['volume', 'ls', '-q', '--filter', `name=${repo}`])
    .stdout.split('\n')
    .filter((line) => line.includes('-local-'));

  const total = vols.length;
  const keys = Array.from(new Set(vols.map((v) => v.split('-local-')[0]))).sort();
  const stacks = keys.length;

  info(`${total} project data volume(s) across ${stacks} stack(s)`);
  console.log('');

  const orphans = keys.filter((k) => !active.has(k));

  if (orphans.length === 0) {
    return null;
  }

  const orphanVolCount = orphans.reduce(
    (sum, k) =>
      sum +
      tryRun('docker', ['volume', 'ls', '-q', '--filter', `name=${k}-local-`]).stdout.split('\n').filter(Boolean)
        .length,
    0,
  );

  const lines = [
    `${orphanVolCount} volume(s) with no live worktree:${orphans.join(' ')}`,
    '  remove a dead stack (its stopped containers + volumes) with:',
    ...orphans.map(
      (k) => `    COMPOSE_PROJECT_NAME=${k} docker compose -f docker-compose.yml -f docker-compose.local.yml --profile local down -v`,
    ),
  ].join('\n');

  note(lines);
  console.log('');

  return lines;
}

export async function runHealth(root: string): Promise<HealthResult> {
  console.log('🩺 Checking repository health...\n');

  // Each check below is a separate recipe line in the original Makefile, and
  // Make aborts a recipe at its first nonzero line — so a missing/mismatched
  // node, yarn or uv stops the target right there and the hooks/volume
  // checks never run. Mirrored here with the same short-circuit.
  const fatalOk = checkNode(root) && checkYarn(root) && checkUv();

  if (!fatalOk) {
    return { fatalOk, warnings: [] };
  }

  const warnings: string[] = [];
  const hooksWarning = checkGitHooks(root);

  if (hooksWarning) {
    warnings.push(hooksWarning);
  }

  const volumesWarning = reportOrphanVolumes(root);

  if (volumesWarning) {
    warnings.push(volumesWarning);
  }

  return { fatalOk, warnings };
}

export async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help')) {
    console.log('Usage: xtask health\n\nCheck the repository for prerequisites.');

    return;
  }

  const result = await runHealth(process.cwd());

  if (!result.fatalOk) {
    process.exitCode = 1;
  }
}
