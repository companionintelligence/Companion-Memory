import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_BASELINE_PATH,
  MAX_KNOWN_VIOLATIONS,
  validateDepcheckRatchet,
} from './check-depcheck-ratchet.mjs';
import {
  checkGatedWorkflowsInvariant,
  checkMarkdownLinks,
  checkWorkflowReferences,
  runDocsCheck,
} from './docs-check.mjs';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

test('dependency-cruiser ratchet passes on the committed baseline', () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, DEFAULT_BASELINE_PATH), 'utf8'));
  const result = validateDepcheckRatchet(baseline, { rootDir: ROOT });

  assert.equal(result.ok, true, `Expected clean ratchet, got: ${result.problems.join('; ')}`);
  assert.ok(result.count <= MAX_KNOWN_VIOLATIONS);
});

test('dependency-cruiser ratchet rejects baselines exceeding MAX_KNOWN_VIOLATIONS or missing files', () => {
  const overLimit = Array.from({ length: 5 }, (_, i) => ({
    from: `src/a${i}.ts`,
    to: `src/b${i}.ts`,
    rule: { name: 'no-cross-domain-internals' },
  }));

  const resOver = validateDepcheckRatchet(overLimit, {
    rootDir: ROOT,
    maxViolations: 3,
    checkFilesExist: false,
  });
  assert.equal(resOver.ok, false);
  assert.match(resOver.problems[0], /ceiling is 3/);

  const resMissingFile = validateDepcheckRatchet(
    [
      {
        from: 'src/domains/nonexistent/foo.ts',
        to: 'src/domains/nonexistent/bar.ts',
        rule: { name: 'no-cross-domain-internals' },
      },
    ],
    { rootDir: ROOT, maxViolations: 10, checkFilesExist: true },
  );
  assert.equal(resMissingFile.ok, false);
  assert.ok(resMissingFile.problems.some((p) => p.includes('no longer exists')));
});

test('docs-check passes across all normative documentation in the repository', () => {
  const result = runDocsCheck({ rootDir: ROOT });
  assert.equal(result.ok, true, `Unexpected docs-check failures:\n${result.problems.join('\n')}`);
});

test('docs-check catches broken markdown links and non-existent workflow references', () => {
  const linkProblems = checkMarkdownLinks(
    'docs/README.md',
    'See [broken](./does-not-exist-anywhere.md) and ```\n[ignored](./also-missing.md)\n```',
    ROOT,
  );
  assert.equal(linkProblems.length, 1);
  assert.match(linkProblems[0], /does-not-exist-anywhere\.md/);

  const wfProblems = checkWorkflowReferences(
    'docs/CI.md',
    'Dispatched via `.github/workflows/imaginary-lane.yml` and retired `.github/workflows/pr-gate.yml`.',
    ROOT,
  );
  assert.equal(wfProblems.length, 1);
  assert.match(wfProblems[0], /imaginary-lane\.yml/);

  const gatedProblems = checkGatedWorkflowsInvariant(ROOT);
  assert.deepEqual(gatedProblems, []);
});

test('@ci/be-api package.json separates test:unit and fail-loud test:integration (CI_REQUIRE_DB=1)', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'backend/apps/api/package.json'), 'utf8'));
  assert.ok(pkg.scripts['test:unit'], 'expected test:unit script in @ci/be-api');
  assert.ok(pkg.scripts['test:integration'], 'expected test:integration script in @ci/be-api');
  assert.match(pkg.scripts['test:integration'], /\bCI_REQUIRE_DB=1\b/);
  assert.ok(pkg.scripts['depcheck:ratchet'], 'expected depcheck:ratchet script in @ci/be-api');
});
