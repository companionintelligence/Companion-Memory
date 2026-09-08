/**
 * images — the built image identities: repo names, the `TAG`-derived extra
 * tag, and the `ci.source-tree` staleness stamp. Mirrors the pre-port Makefile
 * (the `export X_REPO ?= ci/y` lines, which stay in the Makefile untouched —
 * `smoke-api`/`smoke-stack`, not ported, still read them directly, so they
 * remain the source of truth; reading them here via `process.env` with the
 * same literal fallback just means both sides agree without either
 * declaring the other), the pre-port Makefile's `versioned_tag` and `sidecar_stamp` helpers.
 */
import { tryRun } from './exec';

export const API_REPO = (): string => process.env.API_REPO ?? 'ci/api';
export const DATABASE_REPO = (): string => process.env.DATABASE_REPO ?? 'ci/database';
export const GATEWAY_REPO = (): string => process.env.GATEWAY_REPO ?? 'ci/gateway';
export const OBJECT_STORE_REPO = (): string => process.env.OBJECT_STORE_REPO ?? 'ci/object-store';
export const SETUP_SECRETS_REPO = (): string => process.env.SETUP_SECRETS_REPO ?? 'ci/setup-secrets';
export const SETUP_DATABASE_REPO = (): string => process.env.SETUP_DATABASE_REPO ?? 'ci/setup-database';
export const SUMMARY_REPO = (): string => process.env.SUMMARY_REPO ?? 'ci/summary-service';
export const HBPE_REPO = (): string => process.env.HBPE_REPO ?? 'ci/hbpe-service';

/** `TAG`: an explicit env override (Makefile exports it unconditionally, so
 * this is already correct whenever invoked via `make`), else the exact-match
 * tag for HEAD, else `''` — mirrors the pre-port Makefile's
 * `git describe --tags --exact-match 2>/dev/null`. */
export function computeTag(root: string): string {
  if (process.env.TAG !== undefined) {
    return process.env.TAG;
  }

  return tryRun('git', ['describe', '--tags', '--exact-match'], { cwd: root }).stdout.trim();
}

/** `-t repo:tag`, only when `tag` is non-empty (the pre-port Makefile). */
export function versionedTagArgs(repo: string, tag: string): string[] {
  return tag ? ['-t', `${repo}:${tag}`] : [];
}

/**
 * The `ci.source-tree` label value for a Python sidecar image — a stamp of
 * exactly what its content depends on, so `dev` can tell a warm image was
 * built from different source than HEAD. Mirrors the pre-port Makefile's
 * `git rev-parse HEAD:<appDir> HEAD:backend/packages/telemetry HEAD:uv.lock
 * 2>/dev/null | tr '\n' '-'` — including the trailing dash `tr` leaves after
 * the last hash, and including that a failed `git rev-parse` (e.g. a shallow
 * clone) is not specially handled: whatever stdout it produced, even none,
 * gets the same `tr` treatment, exactly as the shell version does.
 */
export function sidecarStamp(root: string, appDir: 'summary' | 'hbpe'): string {
  const res = tryRun(
    'git',
    ['rev-parse', `HEAD:backend/apps/${appDir}`, 'HEAD:backend/packages/telemetry', 'HEAD:uv.lock'],
    { cwd: root },
  );

  return res.stdout.replace(/\n/g, '-');
}
