/**
 * The retry policy of `xtask test-db`, and the honest bookkeeping around it.
 *
 * Under parallel load a handful of jest suites fail for reasons that have
 * nothing to do with the change under test: an swc "failed printing to stderr
 * (os error 35)" while a suite loads, a `deadlock detected` between two suites
 * inserting into the same table, a timing-sensitive controller test. A run that
 * fails for one of those teaches people to ignore red; a run that retried
 * everything silently teaches them nothing failed. So the policy is explicit:
 *
 *   1. After the parallel run, re-run ONLY the test files that failed, ONCE,
 *      serially (`--runInBand`), against the same database.
 *   2. A file that failed in the parallel run and PASSED serially is a FLAKE.
 *      It does not fail the run, but it is printed as a warning, by name, with
 *      the first line of its error — never folded into "passed".
 *   3. A file that failed both times is REAL, and fails the run.
 *   4. A file that was not retried (`--no-retry`, too many files, an interrupt)
 *      is UNRETRIED, which also fails the run: not knowing is not passing.
 *
 * The retry is not a search for a green tick. A flake is only the FIRST failure
 * of a file that then passes; `--no-retry` turns the whole thing off.
 *
 * Everything here is pure: it reads jest's `--json` report and returns data.
 */
import path from 'node:path';

import type { JestAssertion, JestReport, JestSuiteResult } from './noSkips';

/**
 * More failed files than this is not what flaky tests look like — it is a
 * database that went away, or a broken change — and re-running every one of them
 * serially would take longer than the run itself. They are reported as they are.
 */
export const MAX_RETRY_FILES = 20;

export type FailureKind = 'flake' | 'real' | 'unretried';

export interface FailedFile {
  /** As jest reports it: an absolute path. */
  file: string;
  /** Relative to the repo root when under it — what a person reads. */
  display: string;
  /** The first meaningful line of the error, ANSI stripped. */
  firstError: string;
}

export interface ClassifiedFailure extends FailedFile {
  kind: FailureKind;
  /** Why this kind, when the kind alone does not say (e.g. it was missing from the retry report). */
  note?: string;
}

// eslint-disable-next-line no-control-regex -- matching ESC is the whole point
const ANSI = /\x1b\[[0-9;]*m/g;
const MAX_ERROR_LENGTH = 200;

/**
 * The first line of the error that says something: not blank, not jest's `● Suite › test` header.
 * A bare matcher header (`expect(received).toBe(expected)`) says nothing about what went wrong, so
 * the `Received:` line that follows it is appended.
 */
export function firstErrorLine(suite: JestSuiteResult): string {
  const failedAssertions = (suite.assertionResults ?? []).filter((a: JestAssertion) => a.status === 'failed');
  const texts = [...failedAssertions.flatMap((a) => a.failureMessages ?? []), suite.message ?? ''];

  for (const text of texts) {
    const lines = text
      .replace(ANSI, '')
      .split('\n')
      .map((raw) => raw.trim());
    const at = lines.findIndex((line) => line !== '' && !line.startsWith('●'));

    if (at === -1) {
      continue;
    }

    let line = lines[at];

    if (/^(Error: )?expect\(/.test(line)) {
      const received = lines.slice(at + 1).find((l) => l.startsWith('Received:'));

      line = received === undefined ? line : `${line} — ${received}`;
    }

    return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH - 1)}…` : line;
  }

  return '(the report carries no error message)';
}

const displayPath = (file: string, root: string): string => {
  const rel = path.relative(root, file);

  return (rel.startsWith('..') ? file : rel).replaceAll('\\', '/');
};

/** Every suite jest marked failed — a failing test, or a suite that failed to run. */
export function failedFiles(report: JestReport, root: string): FailedFile[] {
  return (report.testResults ?? [])
    .filter((suite) => suite.status === 'failed')
    .map((suite) => ({
      file: suite.name,
      display: displayPath(suite.name, root),
      firstError: firstErrorLine(suite),
    }));
}

/**
 * The name filters among jest's arguments, so the retry runs the same TESTS as
 * the run it is checking. Without them a `-t foo` run would be retried against
 * every test in the file, and a test nobody selected could fail the run.
 * Path patterns and every other flag are deliberately not carried over: the
 * retry names its files exactly. The one exception is {@link timeoutArgs}.
 */
export function nameFilterArgs(jestArgs: string[]): string[] {
  const out: string[] = [];

  for (let i = 0; i < jestArgs.length; i += 1) {
    const arg = jestArgs[i];

    if ((arg === '-t' || arg === '--testNamePattern') && i + 1 < jestArgs.length) {
      out.push(arg, jestArgs[i + 1]);
      i += 1;
    } else if (arg.startsWith('--testNamePattern=')) {
      out.push(arg);
    }
  }

  return out;
}

/**
 * `--testTimeout`, so a run the user widened is retried at the same width. Left out, a test that needs 6 s
 * and passed under `--testTimeout=30000` was retried at jest's 5 s default and reported as a REAL failure
 * on the strength of a limit nobody had asked for.
 */
export function timeoutArgs(jestArgs: string[]): string[] {
  const out: string[] = [];

  for (let i = 0; i < jestArgs.length; i += 1) {
    const arg = jestArgs[i];

    if (arg === '--testTimeout' && i + 1 < jestArgs.length) {
      out.push(arg, jestArgs[i + 1]);
      i += 1;
    } else if (arg.startsWith('--testTimeout=')) {
      out.push(arg);
    }
  }

  return out;
}

/** What follows `jest` on the retry's command line. `--runTestsByPath` because a file name is not a regular expression. */
export function retryJestArgs(reportPath: string, files: string[], jestArgs: string[]): string[] {
  return [
    '--ci',
    '--json',
    `--outputFile=${reportPath}`,
    '--runInBand',
    ...nameFilterArgs(jestArgs),
    ...timeoutArgs(jestArgs),
    '--runTestsByPath',
    ...files,
  ];
}

export interface RetryPlan {
  /** Files to re-run; empty when there is nothing to retry or retrying is off. */
  files: FailedFile[];
  /** Why nothing is being retried, when there were failures and that is so. */
  skipReason?: string;
}

export function planRetry(
  failed: FailedFile[],
  opts: { enabled: boolean; interrupted: boolean; max?: number },
): RetryPlan {
  const max = opts.max ?? MAX_RETRY_FILES;

  if (failed.length === 0) {
    return { files: [] };
  }

  if (!opts.enabled) {
    return { files: [], skipReason: 'retry is off (--no-retry)' };
  }

  if (opts.interrupted) {
    return { files: [], skipReason: 'the run was interrupted' };
  }

  if (failed.length > max) {
    return {
      files: [],
      skipReason: `${failed.length} files failed, more than ${max}: that is a broken run, not flaky tests, and re-running them serially would take longer than the run did`,
    };
  }

  return { files: failed };
}

/**
 * Judge each retried file by what the serial re-run says about it. Only a
 * status of `passed` makes a flake: a file the retry report does not mention, or
 * one that failed again, or one whose tests all skipped, is REAL. For a REAL
 * file the error shown is the retry's — serial, without load noise — so it is
 * the one worth reading.
 */
export function classifyRetry(retried: FailedFile[], retryReport: JestReport | null): ClassifiedFailure[] {
  const bySuite = new Map((retryReport?.testResults ?? []).map((suite) => [suite.name, suite]));

  return retried.map((f): ClassifiedFailure => {
    const again = bySuite.get(f.file);

    if (again?.status === 'passed') {
      return { ...f, kind: 'flake' };
    }

    if (again === undefined) {
      return {
        ...f,
        kind: 'real',
        note:
          retryReport === null
            ? 'the retry produced no report'
            : 'the retry report does not mention this file',
      };
    }

    return {
      ...f,
      kind: 'real',
      ...(again.status === 'failed'
        ? { firstError: firstErrorLine(again) }
        : { note: `on the retry its status was '${again.status}'` }),
    };
  });
}

/** Files nobody retried: still failures. */
export const asUnretried = (failed: FailedFile[], note?: string): ClassifiedFailure[] =>
  failed.map((f) => ({ ...f, kind: 'unretried', ...(note === undefined ? {} : { note }) }));

interface Tally {
  passed: number;
  failed: number;
  pending: number;
  todo: number;
}

function tally(suite: JestSuiteResult | undefined): Tally {
  const t: Tally = { passed: 0, failed: 0, pending: 0, todo: 0 };

  for (const a of suite?.assertionResults ?? []) {
    if (a.status === 'passed') {
      t.passed += 1;
    } else if (a.status === 'failed') {
      t.failed += 1;
    } else if (a.status === 'todo') {
      t.todo += 1;
    } else {
      t.pending += 1; // pending, skipped, disabled: it did not run
    }
  }

  return t;
}

/**
 * The report to judge once flakes are set aside: the original, with each
 * FLAKED file's entry replaced by what the serial re-run reported for it, and
 * jest's totals adjusted by exactly the difference. Every other entry — REAL
 * failures, everything that passed the first time — is untouched.
 *
 * Replacing rather than deleting matters: the no-skip check then sees what the
 * retried file actually did (a test that skipped on the retry is caught), and the
 * summary's counts stay true.
 */
export function mergeRetryIntoReport(
  original: JestReport,
  retryReport: JestReport | null,
  failures: ClassifiedFailure[],
): JestReport {
  const flaked = new Set(failures.filter((f) => f.kind === 'flake').map((f) => f.file));

  if (flaked.size === 0 || retryReport === null) {
    return original;
  }

  const again = new Map((retryReport.testResults ?? []).map((suite) => [suite.name, suite]));
  const merged: JestReport = { ...original };
  let failedSuites = original.numFailedTestSuites ?? 0;
  let passedSuites = original.numPassedTestSuites ?? 0;
  let runtimeErrors = original.numRuntimeErrorTestSuites ?? 0;
  const totals: Tally = {
    passed: original.numPassedTests ?? 0,
    failed: original.numFailedTests ?? 0,
    pending: original.numPendingTests ?? 0,
    todo: original.numTodoTests ?? 0,
  };
  let totalTests = original.numTotalTests ?? 0;

  merged.testResults = (original.testResults ?? []).map((suite) => {
    const replacement = flaked.has(suite.name) ? again.get(suite.name) : undefined;

    if (replacement === undefined) {
      return suite;
    }

    const before = tally(suite);
    const after = tally(replacement);

    if ((suite.assertionResults ?? []).length === 0 && runtimeErrors > 0) {
      runtimeErrors -= 1; // it had failed to run at all
    }

    failedSuites -= 1;
    passedSuites += 1;

    for (const key of ['passed', 'failed', 'pending', 'todo'] as const) {
      totals[key] += after[key] - before[key];
      totalTests += after[key] - before[key];
    }

    return replacement;
  });

  merged.numFailedTestSuites = failedSuites;
  merged.numPassedTestSuites = passedSuites;
  merged.numRuntimeErrorTestSuites = runtimeErrors;
  merged.numPassedTests = totals.passed;
  merged.numFailedTests = totals.failed;
  merged.numPendingTests = totals.pending;
  merged.numTodoTests = totals.todo;
  merged.numTotalTests = totalTests;
  merged.success = failedSuites === 0 && totals.failed === 0 && runtimeErrors === 0;

  return merged;
}

export interface Decision {
  /** True only if there is no problem and nothing failed for good. */
  pass: boolean;
  /** Failed the parallel run and passed the serial one: a warning, never a failure. */
  flakes: ClassifiedFailure[];
  /** REAL and UNRETRIED: each fails the run. */
  blocking: ClassifiedFailure[];
}

/**
 * The exit-code logic, in one place so it can be tested: the run passes when
 * there is no problem AND no file failed for good. FLAKEs never fail it, and can
 * never mask a REAL failure — `blocking` is judged on its own, whatever
 * `problems` holds.
 */
export function decide(input: {
  problems: readonly string[];
  failures: readonly ClassifiedFailure[];
}): Decision {
  const flakes = input.failures.filter((f) => f.kind === 'flake');
  const blocking = input.failures.filter((f) => f.kind !== 'flake');

  return { pass: input.problems.length === 0 && blocking.length === 0, flakes, blocking };
}
