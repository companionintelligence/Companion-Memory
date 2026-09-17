/**
 * identity — REPO/PROJECT_NAME derivation, mirroring the Makefile's own formula
 * (the lines that predate this port and stay in the Makefile untouched,
 * since `production`/`staging`/every other non-ported target still needs
 * them). Always recomputed fresh from git — the Makefile uses `:=`, not
 * `?=`, on those two, and that is deliberate: trusting an inherited
 * COMPOSE_PROJECT_NAME risks reaching a sibling worktree's stack (see
 * the pre-port Makefile's account of exactly that happening when a DB port
 * lookup fell back to a hardcoded default instead of asking the running
 * container).
 */
import path from 'node:path';

import { tryRun } from './exec';

export function repoStemFromUrl(url: string): string {
  const last = url.split('/').filter(Boolean).pop() ?? '';

  return last.endsWith('.git') ? last.slice(0, -'.git'.length) : last;
}

/** REPO: the origin remote's repo name — never the checkout directory's own
 * basename, which is transient across clones/renames (the pre-port Makefile's own
 * comment) — falling back to the cwd's basename only when there is no
 * remote. Always lowercased. */
export function computeRepo(cwd: string): string {
  const url = tryRun('git', ['remote', 'get-url', 'origin'], { cwd }).stdout.trim();
  const stem = url ? repoStemFromUrl(url) : '';

  return (stem || path.basename(cwd)).toLowerCase();
}

/** The main checkout's root — the worktree `--git-common-dir` belongs to.
 * Matches the pre-port Makefile's `cd "$(dirname "$(git rev-parse --git-common-dir)")" && pwd`:
 * a logical (non-symlink-resolving) path, hence `path.resolve` rather than
 * `fs.realpathSync`. */
export function gitMainRoot(cwd: string): string {
  const commonDir = tryRun('git', ['rev-parse', '--git-common-dir'], { cwd }).stdout.trim();

  return commonDir ? path.resolve(cwd, path.dirname(commonDir)) : '';
}

/**
 * PROJECT_NAME for an arbitrary worktree root: the main checkout is bare
 * `repo`, any linked worktree is `repo-<lowercased dir basename>`.
 *
 * A single, parameterized formula standing in for what the Makefile wrote
 * out twice, independently: once for the CURRENT worktree (the pre-port Makefile,
 * via a `git rev-parse --git-dir` vs `--git-common-dir` comparison) and
 * again for EVERY worktree `health`'s volume-orphan report enumerates
 * (the pre-port Makefile, via a direct path comparison against `main_root`). Both
 * answer the same question — "is this worktree the main checkout, and if
 * not, what is its suffix" — so both call this.
 */
export function projectNameFor(worktreeRoot: string, mainRoot: string, repo: string): string {
  if (!worktreeRoot || worktreeRoot === mainRoot) {
    return repo;
  }

  return `${repo}-${path.basename(worktreeRoot).toLowerCase()}`;
}

/** PROJECT_NAME for the current worktree. */
export function computeProjectName(cwd: string): string {
  const repo = computeRepo(cwd);
  const mainRoot = gitMainRoot(cwd);
  const toplevel = tryRun('git', ['rev-parse', '--show-toplevel'], { cwd }).stdout.trim();

  return projectNameFor(toplevel, mainRoot, repo);
}
