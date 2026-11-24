#!/usr/bin/env node
/**
 * Ratchet guard for `backend/apps/api/.dependency-cruiser-known-violations.json`.
 *
 * `yarn workspace @ci/be-api depcheck` passes `--ignore-known`, which prevents new
 * cross-domain imports unless someone runs `yarn depcheck:accept` and commits a
 * larger `.dependency-cruiser-known-violations.json`. This script closes that
 * loophole in `make lint`:
 *   1. The total number of grandfathered violations may only go DOWN, never up
 *      above `MAX_KNOWN_VIOLATIONS`.
 *   2. Every grandfathered entry's `from` and `to` paths must still exist on disk
 *      (stale entries for deleted or moved files must be pruned).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_KNOWN_VIOLATIONS = 63;
export const DEFAULT_BASELINE_PATH = 'backend/apps/api/.dependency-cruiser-known-violations.json';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Validate a parsed dependency-cruiser baseline array against the ratchet ceiling
 * and the current filesystem.
 *
 * @param {Array<{from?: string, to?: string, rule?: {name?: string}}>} entries
 * @param {{ rootDir?: string, maxViolations?: number, checkFilesExist?: boolean }} [options]
 * @returns {{ ok: boolean, count: number, maxViolations: number, problems: string[] }}
 */
export function validateDepcheckRatchet(entries, options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const maxViolations = options.maxViolations ?? MAX_KNOWN_VIOLATIONS;
  const checkFilesExist = options.checkFilesExist ?? true;
  const problems = [];

  if (!Array.isArray(entries)) {
    return {
      ok: false,
      count: 0,
      maxViolations,
      problems: ['Baseline file is not a JSON array.'],
    };
  }

  if (entries.length > maxViolations) {
    problems.push(
      `Known dependency-cruiser violations grew to ${entries.length} (ceiling is ${maxViolations}). ` +
        `Fix the cross-domain import or circular dependency instead of running 'depcheck:accept'.`,
    );
  }

  const seenKeys = new Set();

  for (const [index, entry] of entries.entries()) {
    const from = entry?.from;
    const to = entry?.to;
    const ruleName = entry?.rule?.name;

    if (!from || !to || !ruleName) {
      problems.push(`Entry #${index} is missing required 'from', 'to', or 'rule.name' fields.`);
      continue;
    }

    const key = `${ruleName}:${from}->${to}`;
    if (seenKeys.has(key)) {
      problems.push(`Duplicate baseline violation entry: ${key}`);
    }

    seenKeys.add(key);

    if (checkFilesExist) {
      const fromAbs = join(rootDir, 'backend/apps/api', from);
      const toAbs = join(rootDir, 'backend/apps/api', to);

      if (!existsSync(fromAbs)) {
        problems.push(
          `Stale baseline entry (${ruleName}): 'from' file no longer exists: backend/apps/api/${from}`,
        );
      }

      if (!existsSync(toAbs)) {
        problems.push(
          `Stale baseline entry (${ruleName}): 'to' file no longer exists: backend/apps/api/${to}`,
        );
      }
    }
  }

  return {
    ok: problems.length === 0,
    count: entries.length,
    maxViolations,
    problems,
  };
}

export function runDepcheckRatchetCli(rootDir = REPO_ROOT) {
  const baselinePath = join(rootDir, DEFAULT_BASELINE_PATH);
  if (!existsSync(baselinePath)) {
    console.error(`✗ Missing dependency-cruiser baseline at ${DEFAULT_BASELINE_PATH}`);

    return 1;
  }

  const raw = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const result = validateDepcheckRatchet(raw, { rootDir });

  if (!result.ok) {
    console.error('✗ Dependency-cruiser baseline ratchet check failed:\n');
    for (const problem of result.problems) {
      console.error(`  - ${problem}`);
    }

    console.error('');

    return 1;
  }

  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(runDepcheckRatchetCli());
}
