import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_RETRY_FILES,
  asUnretried,
  classifyRetry,
  decide,
  failedFiles,
  firstErrorLine,
  mergeRetryIntoReport,
  nameFilterArgs,
  planRetry,
  retryJestArgs,
  timeoutArgs,
  type ClassifiedFailure,
  type FailedFile,
} from './flakes';
import {
  checkNoSkips,
  type JestAssertion,
  type JestReport,
  type JestSuiteResult,
  type SkipContext,
} from './noSkips';

const ROOT = '/repo';
const API = `${ROOT}/backend/apps/api`;
const file = (name: string): string => `${API}/src/domains/${name}.test.ts`;
const CTX: SkipContext = { platform: 'darwin', env: {}, hasBinary: () => true };

const pass = (title: string): JestAssertion => ({
  status: 'passed',
  title,
  fullName: title,
  failureMessages: [],
});
const skip = (title: string): JestAssertion => ({
  status: 'pending',
  title,
  fullName: title,
  failureMessages: [],
});
const fail = (title: string, message: string): JestAssertion => ({
  status: 'failed',
  title,
  fullName: title,
  failureMessages: [message],
});

/** The shape jest's --json gives a suite whose test failed. */
const failingSuite = (name: string, ...assertions: JestAssertion[]): JestSuiteResult => ({
  name: file(name),
  status: 'failed',
  assertionResults: assertions,
  message: `  ● ${name} › a test\n\n    boom\n`,
});
const passingSuite = (name: string, ...assertions: JestAssertion[]): JestSuiteResult => ({
  name: file(name),
  status: 'passed',
  assertionResults: assertions.length > 0 ? assertions : [pass('works')],
  message: '',
});
/** A suite that failed to RUN: an error at load, no assertions at all. */
const loadFailure = (name: string, error: string): JestSuiteResult => ({
  name: file(name),
  status: 'failed',
  assertionResults: [],
  message: `  ● Test suite failed to run\n\n    ${error}\n\n    at Object.<anonymous> (x.ts:1:7)\n`,
});

/** jest's own totals, computed from the suites the way its JSON reports them. */
function report(suites: JestSuiteResult[], extra: Partial<JestReport> = {}): JestReport {
  const count = (status: string) =>
    suites.flatMap((s) => s.assertionResults ?? []).filter((a) => a.status === status).length;
  const failedSuites = suites.filter((s) => s.status === 'failed').length;
  const runtimeErrors = suites.filter(
    (s) => s.status === 'failed' && (s.assertionResults ?? []).length === 0,
  ).length;

  return {
    success: failedSuites === 0,
    numTotalTestSuites: suites.length,
    numFailedTestSuites: failedSuites,
    numPassedTestSuites: suites.filter((s) => s.status === 'passed').length,
    numPendingTestSuites: suites.filter((s) => s.status === 'pending').length,
    numRuntimeErrorTestSuites: runtimeErrors,
    numTotalTests: count('passed') + count('failed') + count('pending') + count('todo'),
    numPassedTests: count('passed'),
    numFailedTests: count('failed'),
    numPendingTests: count('pending'),
    numTodoTests: count('todo'),
    testResults: suites,
    ...extra,
  };
}

const ff = (name: string, firstError = 'boom'): FailedFile => ({
  file: file(name),
  display: `backend/apps/api/src/domains/${name}.test.ts`,
  firstError,
});

// -- reading the failures ------------------------------------------------------------------------

test('firstErrorLine: the first line that says something — not a blank, not the jest `●` header', () => {
  const assertion = failingSuite(
    'a',
    fail(
      't',
      'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 2\nReceived: 1\n    at Object.toBe (x.ts:3:49)',
    ),
  );

  // A bare matcher header alone says nothing, so the `Received:` line is appended.
  assert.equal(
    firstErrorLine(assertion),
    'Error: expect(received).toBe(expected) // Object.is equality — Received: 1',
  );
  assert.equal(
    firstErrorLine(
      failingSuite(
        'a',
        fail('t', 'error: deadlock detected\nDETAIL: Process 1 waits for ShareLock\nReceived: not this'),
      ),
    ),
    'error: deadlock detected',
    'only a matcher header gets the Received line',
  );
  assert.equal(
    firstErrorLine(
      loadFailure('b', 'failed printing to stderr: Resource temporarily unavailable (os error 35)'),
    ),
    'failed printing to stderr: Resource temporarily unavailable (os error 35)',
  );
  assert.equal(
    firstErrorLine({
      name: 'x',
      status: 'failed',
      message: '\u001b[31m  ● S › t\u001b[39m\n\n    \u001b[1mdeadlock detected\u001b[22m\n',
    }),
    'deadlock detected',
    'ANSI colour is stripped',
  );
  assert.equal(firstErrorLine({ name: 'x', status: 'failed' }), '(the report carries no error message)');
  assert.ok(firstErrorLine(loadFailure('c', 'x'.repeat(500))).length <= 200);
});

test('failedFiles lists exactly the failed suites, relative to the repo root', () => {
  const r = report([
    passingSuite('ok'),
    failingSuite('flaky', fail('t', 'deadlock detected')),
    loadFailure('loads', 'os error 35'),
  ]);

  assert.deepEqual(failedFiles(r, ROOT), [
    {
      file: file('flaky'),
      display: 'backend/apps/api/src/domains/flaky.test.ts',
      firstError: 'deadlock detected',
    },
    { file: file('loads'), display: 'backend/apps/api/src/domains/loads.test.ts', firstError: 'os error 35' },
  ]);
  assert.deepEqual(failedFiles(report([passingSuite('ok')]), ROOT), []);
  assert.deepEqual(failedFiles({}, ROOT), []);
});

// -- what is re-run, and how ------------------------------------------------------------------------

test('retryJestArgs: serial, by exact path, same name filter, its own report', () => {
  assert.deepEqual(
    retryJestArgs('/tmp/r.json', ['/a/x.test.ts', '/a/y.test.ts'], ['src/domains', '--workers-ignored']),
    [
      '--ci',
      '--json',
      '--outputFile=/tmp/r.json',
      '--runInBand',
      '--runTestsByPath',
      '/a/x.test.ts',
      '/a/y.test.ts',
    ],
  );
  assert.deepEqual(retryJestArgs('/tmp/r.json', ['/a/x.test.ts'], ['-t', 'revocation', 'src']), [
    '--ci',
    '--json',
    '--outputFile=/tmp/r.json',
    '--runInBand',
    '-t',
    'revocation',
    '--runTestsByPath',
    '/a/x.test.ts',
  ]);
});

test("the retry runs at the timeout the run was given, not at jest's default", () => {
  assert.deepEqual(timeoutArgs(['--testTimeout=30000', 'src/x', '--maxWorkers=2']), ['--testTimeout=30000']);
  assert.deepEqual(timeoutArgs(['--testTimeout', '30000']), ['--testTimeout', '30000']);
  assert.deepEqual(timeoutArgs(['--testTimeout']), [], 'a flag with no value is not invented a value');
  assert.deepEqual(timeoutArgs(['src/x']), []);
  assert.deepEqual(retryJestArgs('/tmp/r.json', ['/a/x.test.ts'], ['--testTimeout=30000', 'src']), [
    '--ci',
    '--json',
    '--outputFile=/tmp/r.json',
    '--runInBand',
    '--testTimeout=30000',
    '--runTestsByPath',
    '/a/x.test.ts',
  ]);
});

test('nameFilterArgs carries the name filter and nothing else', () => {
  assert.deepEqual(nameFilterArgs(['-t', 'a b', 'src/x', '--maxWorkers=2']), ['-t', 'a b']);
  assert.deepEqual(nameFilterArgs(['--testNamePattern', 'x']), ['--testNamePattern', 'x']);
  assert.deepEqual(nameFilterArgs(['--testNamePattern=x', '--onlyChanged']), ['--testNamePattern=x']);
  assert.deepEqual(
    nameFilterArgs(['-t']),
    [],
    'a dangling -t is dropped rather than eating the next argument',
  );
  assert.deepEqual(nameFilterArgs([]), []);
});

test('planRetry: retries the failed files once — unless retry is off, interrupted, or there are too many', () => {
  const two = [ff('a'), ff('b')];

  assert.deepEqual(planRetry([], { enabled: true, interrupted: false }), { files: [] });
  assert.deepEqual(planRetry(two, { enabled: true, interrupted: false }), { files: two });
  assert.deepEqual(planRetry(two, { enabled: false, interrupted: false }), {
    files: [],
    skipReason: 'retry is off (--no-retry)',
  });
  assert.deepEqual(planRetry(two, { enabled: true, interrupted: true }), {
    files: [],
    skipReason: 'the run was interrupted',
  });

  const many = Array.from({ length: MAX_RETRY_FILES + 1 }, (_, i) => ff(`f${i}`));
  const plan = planRetry(many, { enabled: true, interrupted: false });

  assert.deepEqual(plan.files, []);
  assert.match(plan.skipReason ?? '', /21 files failed, more than 20: that is a broken run, not flaky tests/);
  assert.equal(
    planRetry(many.slice(0, MAX_RETRY_FILES), { enabled: true, interrupted: false }).files.length,
    MAX_RETRY_FILES,
    'exactly the limit still retries',
  );
});

// -- the classifier -------------------------------------------------------------------------------------

test("classifyRetry: failed then PASSED is a FLAKE; failed again is REAL, with the serial run's error", () => {
  const retried = [ff('flaky', 'deadlock detected'), ff('broken', 'first error, under load')];
  const retry = report([
    passingSuite('flaky'),
    failingSuite('broken', fail('t', 'Error: expected 1, got 2')),
  ]);

  assert.deepEqual(classifyRetry(retried, retry), [
    { ...retried[0], kind: 'flake' },
    { ...retried[1], kind: 'real', firstError: 'Error: expected 1, got 2' },
  ]);
});

test('classifyRetry: a file the retry did not report, or that skipped, or a retry that produced no report, is REAL — not knowing is not passing', () => {
  const retried = [ff('gone'), ff('skipped')];
  const noMention = classifyRetry(retried, report([passingSuite('somethingelse')]));

  assert.deepEqual(
    noMention.map((c) => [c.kind, c.note]),
    [
      ['real', 'the retry report does not mention this file'],
      ['real', 'the retry report does not mention this file'],
    ],
  );

  const skipped = classifyRetry(
    [ff('skipped')],
    report([{ name: file('skipped'), status: 'pending', assertionResults: [skip('t')] }]),
  );

  assert.deepEqual([skipped[0].kind, skipped[0].note], ['real', "on the retry its status was 'pending'"]);
  assert.deepEqual(
    classifyRetry(retried, null).map((c) => [c.kind, c.note]),
    [
      ['real', 'the retry produced no report'],
      ['real', 'the retry produced no report'],
    ],
  );
});

test('classifyRetry handles a load failure that passes serially (the swc `os error 35` case)', () => {
  const [c] = classifyRetry(
    failedFiles(report([loadFailure('loads', 'failed printing to stderr (os error 35)')]), ROOT),
    report([passingSuite('loads')]),
  );

  assert.equal(c.kind, 'flake');
  assert.equal(
    c.firstError,
    'failed printing to stderr (os error 35)',
    'the flake keeps the error of the run that failed',
  );
});

test('asUnretried marks files as failures that nobody re-ran', () => {
  assert.deepEqual(asUnretried([ff('a')]), [{ ...ff('a'), kind: 'unretried' }]);
  assert.deepEqual(asUnretried([ff('a')], 'retry is off (--no-retry)'), [
    { ...ff('a'), kind: 'unretried', note: 'retry is off (--no-retry)' },
  ]);
});

// -- setting flakes aside: the merged report -----------------------------------------------------------

test('mergeRetryIntoReport: a flaked file is replaced by its serial result and every total moves by exactly the difference', () => {
  const original = report([
    passingSuite('fine', pass('a'), pass('b')),
    failingSuite('flaky', pass('x'), fail('y', 'deadlock detected'), skip('z')),
    loadFailure('loads', 'os error 35'),
  ]);
  const retry = report([
    passingSuite('flaky', pass('x'), pass('y'), skip('z')),
    passingSuite('loads', pass('p'), pass('q'), pass('r')),
  ]);
  const failures = classifyRetry(failedFiles(original, ROOT), retry);
  const merged = mergeRetryIntoReport(original, retry, failures);

  assert.deepEqual(
    failures.map((f) => f.kind),
    ['flake', 'flake'],
  );
  // What jest would have said had the retry been the first run.
  assert.deepEqual(
    { ...merged, testResults: undefined },
    {
      ...report([
        passingSuite('fine', pass('a'), pass('b')),
        passingSuite('flaky', pass('x'), pass('y'), skip('z')),
        passingSuite('loads', pass('p'), pass('q'), pass('r')),
      ]),
      testResults: undefined,
    },
  );
  assert.equal(merged.success, true);
  assert.equal(original.success, false, 'the original report is not mutated');
  assert.equal(original.numFailedTestSuites, 2);
});

test('mergeRetryIntoReport leaves a REAL failure exactly as it was, and the merged report still fails', () => {
  const original = report([
    passingSuite('fine'),
    failingSuite('flaky', fail('y', 'deadlock')),
    failingSuite('broken', fail('t', 'nope')),
  ]);
  const retry = report([passingSuite('flaky'), failingSuite('broken', fail('t', 'nope again'))]);
  const failures = classifyRetry(failedFiles(original, ROOT), retry);
  const merged = mergeRetryIntoReport(original, retry, failures);

  assert.deepEqual(
    failures.map((f) => f.kind),
    ['flake', 'real'],
  );
  assert.equal(merged.numFailedTestSuites, 1);
  assert.equal(merged.numFailedTests, 1);
  assert.equal(merged.success, false);
  assert.equal(
    merged.testResults?.find((s) => s.name === file('broken')),
    original.testResults?.[2],
    'the REAL entry is the original one',
  );
});

test('mergeRetryIntoReport with nothing flaked (or no retry report) returns the original untouched', () => {
  const original = report([failingSuite('broken', fail('t', 'nope'))]);

  assert.equal(
    mergeRetryIntoReport(original, report([failingSuite('broken', fail('t', 'nope'))]), [
      { ...ff('broken'), kind: 'real' },
    ]),
    original,
  );
  assert.equal(mergeRetryIntoReport(original, null, []), original);
});

test('the no-skip judge, run on the merged report: flakes-only is clean; a REAL failure is not; a skip that appears in the retry is caught', () => {
  const allow = [{ file: 'domains/allowed.test.ts', reason: 'a documented environmental need, spelled out' }];
  const judge = (r: JestReport) => checkNoSkips(r, allow, CTX, API);
  const original = report([passingSuite('fine'), failingSuite('flaky', fail('t', 'deadlock detected'))]);

  // Flakes only.
  const okRetry = report([passingSuite('flaky')]);
  const okMerged = mergeRetryIntoReport(
    original,
    okRetry,
    classifyRetry(failedFiles(original, ROOT), okRetry),
  );

  assert.equal(judge(okMerged).ok, true, judge(okMerged).failures.join('\n'));

  // The unmerged original is (rightly) a failure.
  assert.equal(judge(original).ok, false);

  // A REAL failure survives the merge.
  const badRetry = report([failingSuite('flaky', fail('t', 'again'))]);
  const badMerged = mergeRetryIntoReport(
    original,
    badRetry,
    classifyRetry(failedFiles(original, ROOT), badRetry),
  );

  assert.equal(judge(badMerged).ok, false);

  // The file passed on the retry — but by skipping a test nobody forgave.
  const skipRetry = report([passingSuite('flaky', pass('a'), skip('b'))]);
  const skipMerged = mergeRetryIntoReport(
    original,
    skipRetry,
    classifyRetry(failedFiles(original, ROOT), skipRetry),
  );
  const verdict = judge(skipMerged);

  assert.equal(verdict.ok, false);
  assert.equal(verdict.unexpected.length, 1);
});

// -- the exit-code logic --------------------------------------------------------------------------------

const flake: ClassifiedFailure = { ...ff('f'), kind: 'flake' };
const real: ClassifiedFailure = { ...ff('r'), kind: 'real' };
const unretried: ClassifiedFailure = { ...ff('u'), kind: 'unretried' };

test('decide: exit 0 only when everything passed or was a FLAKE', () => {
  assert.equal(decide({ problems: [], failures: [] }).pass, true, 'nothing failed');
  assert.equal(decide({ problems: [], failures: [flake] }).pass, true, 'flakes only');
  assert.equal(decide({ problems: [], failures: [flake, flake] }).pass, true);
});

test('decide: a REAL or UNRETRIED failure fails the run — and a flake beside it cannot excuse it', () => {
  assert.equal(decide({ problems: [], failures: [real] }).pass, false);
  assert.equal(decide({ problems: [], failures: [unretried] }).pass, false);
  assert.equal(decide({ problems: [], failures: [flake, real, flake] }).pass, false);
  assert.deepEqual(decide({ problems: [], failures: [flake, real] }).blocking, [real]);
  assert.deepEqual(decide({ problems: [], failures: [flake, real] }).flakes, [flake]);
});

test('decide: any other problem (a crashed database, an unexplained skip) fails the run even when every failure was a flake', () => {
  assert.equal(decide({ problems: ['the database CRASHED'], failures: [flake] }).pass, false);
  assert.equal(decide({ problems: ['1 test(s) were SKIPPED'], failures: [] }).pass, false);
});
