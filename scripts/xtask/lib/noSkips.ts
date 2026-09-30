/**
 * "A green tick that skipped the test is worse than no tick" — for the whole
 * jest run, not just the five consent-path suites.
 *
 * `.github/scripts/assert-consent-suites-ran.mjs` made that true for one named
 * list of suites: it reads jest's own JSON report and refuses to pass unless
 * nothing in scope skipped. This is the same check with the scope widened to
 * every test a run executed, and one thing added — an allow-list — because
 * across the whole tree, "zero skips" is not achievable and should not be: some
 * suites legitimately need a binary or a platform the machine does not have.
 *
 * The allow-list (`scripts/test-db/allowed-skips.json`) is what keeps that from
 * decaying back into silence. Every entry needs a REASON, and where the reason
 * is an environmental condition it states the condition (`when`), so a skip is
 * forgiven only while the reason is actually true. A vips suite that skips on a
 * machine that HAS vips is not "missing an external binary"; it is broken, and
 * is reported as such.
 *
 * Jest reports a skipped test as `pending`, a `test.todo` as `todo`, a test
 * filtered out by `-t` as `skipped` and a `--bail`/`only` casualty as
 * `disabled`. All four mean "this did not run".
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** The subset of jest's `--json` report this reads. */
export interface JestAssertion {
  status: string;
  title?: string;
  fullName?: string;
  /** Present on a failed assertion; the first entry starts with the error. */
  failureMessages?: string[];
}

export interface JestSuiteResult {
  name: string;
  status?: string;
  assertionResults?: JestAssertion[];
  message?: string;
}

export interface JestReport {
  success?: boolean;
  numFailedTests?: number;
  numFailedTestSuites?: number;
  numTotalTests?: number;
  numPassedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  numTotalTestSuites?: number;
  numPassedTestSuites?: number;
  numPendingTestSuites?: number;
  /** Suites that failed to RUN (an error at load), as opposed to having a failing test. */
  numRuntimeErrorTestSuites?: number;
  testResults?: JestSuiteResult[];
}

export const SKIP_STATUSES: readonly string[] = ['pending', 'todo', 'skipped', 'disabled'];

// ---------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------

/**
 * When a skip is forgiven. Every condition that is present must hold; an entry
 * with no `when` forgives the skip unconditionally, which is the weakest thing
 * this file offers and is used only where the reason is a standing decision
 * rather than a property of the machine.
 */
export interface AllowedWhen {
  /** Forgiven only if EVERY named binary is absent from PATH. */
  missingBinaries?: string[];
  /** Forgiven only if the platform is NOT one of these (the suite is for these platforms only). */
  platformNotIn?: string[];
  /** Forgiven only while `env[name] !== value` (an opt-in that was not made). `value` defaults to `1`. */
  envNotSet?: { name: string; value?: string };
}

export interface AllowedSkip {
  /** Path suffix of the spec file, forward slashes, e.g. `domains/files/__tests__/VipsService.test.ts`. */
  file: string;
  /** Substring of the test's full name; omit to cover every skipped test in the file. */
  title?: string;
  /** Why this is allowed to skip. Mandatory, and must say something. */
  reason: string;
  when?: AllowedWhen;
}

/** What the environment looks like, injectable so tests need not depend on the host. */
export interface SkipContext {
  platform: string;
  env: NodeJS.ProcessEnv;
  hasBinary: (name: string) => boolean;
}

export function hostContext(): SkipContext {
  return {
    platform: process.platform,
    env: process.env,
    hasBinary: (name) => spawnSync('which', [name], { stdio: 'ignore' }).status === 0,
  };
}

const MIN_REASON_LENGTH = 20;
const ENTRY_KEYS = new Set(['file', 'title', 'reason', 'when']);
const WHEN_KEYS = new Set(['missingBinaries', 'platformNotIn', 'envNotSet']);

/** Validate the parsed JSON of the allow-list file. Throws, naming the entry, on anything malformed. */
export function parseAllowList(json: unknown): AllowedSkip[] {
  if (typeof json !== 'object' || json === null || !Array.isArray((json as { skips?: unknown }).skips)) {
    throw new Error('allowed-skips: expected an object with a "skips" array');
  }

  return (json as { skips: unknown[] }).skips.map((raw, index) => {
    const at = `allowed-skips: skips[${index}]`;

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`${at} is not an object`);
    }

    const entry = raw as Record<string, unknown>;

    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) {
        throw new Error(`${at} has unknown key "${key}" (valid: ${[...ENTRY_KEYS].join(', ')})`);
      }
    }

    if (typeof entry.file !== 'string' || entry.file.trim() === '' || entry.file.startsWith('/')) {
      throw new Error(`${at} needs a "file": a non-empty path suffix that does not start with "/"`);
    }

    if (typeof entry.reason !== 'string' || entry.reason.trim().length < MIN_REASON_LENGTH) {
      throw new Error(
        `${at} (${entry.file}) needs a "reason" of at least ${MIN_REASON_LENGTH} characters — say why this is allowed to skip, not just that it is`,
      );
    }

    if (entry.title !== undefined && (typeof entry.title !== 'string' || entry.title === '')) {
      throw new Error(`${at} (${entry.file}) has an empty "title"; omit it to cover the whole file`);
    }

    let when: AllowedWhen | undefined;

    if (entry.when !== undefined) {
      if (typeof entry.when !== 'object' || entry.when === null || Array.isArray(entry.when)) {
        throw new Error(`${at} (${entry.file}) has a "when" that is not an object`);
      }

      const w = entry.when as Record<string, unknown>;

      for (const key of Object.keys(w)) {
        if (!WHEN_KEYS.has(key)) {
          throw new Error(
            `${at} (${entry.file}) has unknown "when" key "${key}" (valid: ${[...WHEN_KEYS].join(', ')})`,
          );
        }
      }

      for (const key of ['missingBinaries', 'platformNotIn'] as const) {
        const v = w[key];

        if (
          v !== undefined &&
          (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string'))
        ) {
          throw new Error(`${at} (${entry.file}) "when.${key}" must be a non-empty array of strings`);
        }
      }

      const envNotSet = w.envNotSet as { name?: unknown; value?: unknown } | undefined;

      if (
        envNotSet !== undefined &&
        (typeof envNotSet !== 'object' ||
          typeof envNotSet.name !== 'string' ||
          (envNotSet.value !== undefined && typeof envNotSet.value !== 'string'))
      ) {
        throw new Error(`${at} (${entry.file}) "when.envNotSet" must be { name: string, value?: string }`);
      }

      when = w as AllowedWhen;
    }

    return {
      file: entry.file.replaceAll('\\', '/'),
      ...(entry.title === undefined ? {} : { title: entry.title as string }),
      reason: entry.reason.trim(),
      ...(when === undefined ? {} : { when }),
    };
  });
}

/** Does the entry's condition hold in this environment? (No condition: always.) */
export function whenHolds(when: AllowedWhen | undefined, ctx: SkipContext): boolean {
  if (when === undefined) {
    return true;
  }

  if (when.missingBinaries !== undefined && when.missingBinaries.some((b) => ctx.hasBinary(b))) {
    return false;
  }

  if (when.platformNotIn !== undefined && when.platformNotIn.includes(ctx.platform)) {
    return false;
  }

  if (when.envNotSet !== undefined && ctx.env[when.envNotSet.name] === (when.envNotSet.value ?? '1')) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export interface SkippedTest {
  /** As jest reported it, made relative to `cwd` when it is under it. */
  file: string;
  title: string;
  status: string;
}

export interface AllowedSkipHit extends SkippedTest {
  reason: string;
}

export interface NoSkipsResult {
  ok: boolean;
  /** Human-readable, one per problem. Empty when `ok`. */
  failures: string[];
  /** Skips nothing forgave — the reason `ok` is false when it is. */
  unexpected: SkippedTest[];
  /** Skips an allow-list entry forgave, with its reason. */
  allowed: AllowedSkipHit[];
  /** Entries that forgave nothing this run. Informational: a Linux-only entry is idle on a Mac. */
  unused: AllowedSkip[];
  suites: number;
  passed: number;
  failed: number;
}

const normalise = (p: string): string => p.replaceAll('\\', '/');

function relativeTo(cwd: string, file: string): string {
  const rel = path.relative(cwd, file);

  return normalise(rel.startsWith('..') ? file : rel);
}

/**
 * Judge a jest report. It fails on: no suites at all (a path filter that matched
 * nothing), any failing test or suite (including one that failed to RUN, which
 * is how `CI_REQUIRE_DB=1` reports a missing database), and any skipped, pending
 * or todo test that no allow-list entry forgives under the current environment.
 */
export function checkNoSkips(
  report: JestReport,
  allowList: AllowedSkip[],
  ctx: SkipContext = hostContext(),
  cwd: string = process.cwd(),
): NoSkipsResult {
  const suites = Array.isArray(report.testResults) ? report.testResults : [];
  const failures: string[] = [];
  const unexpected: SkippedTest[] = [];
  const allowed: AllowedSkipHit[] = [];
  const used = new Set<AllowedSkip>();

  if (suites.length === 0) {
    failures.push(
      'jest reported ZERO test suites — the path filter matched nothing, or jest died before running.',
    );
  }

  const failedTests = report.numFailedTests ?? 0;
  const failedSuites = report.numFailedTestSuites ?? 0;

  if (report.success !== true || failedTests > 0 || failedSuites > 0) {
    failures.push(`jest reported failures: ${failedTests} test(s) in ${failedSuites} failed suite(s).`);
  }

  for (const suite of suites) {
    const file = normalise(suite.name);
    const assertions = suite.assertionResults ?? [];

    // A suite jest marked pending with no assertions to show for it (whole file
    // skipped before any test was registered) still did not run.
    const skippedInSuite: JestAssertion[] =
      assertions.length === 0 && suite.status === 'pending'
        ? [{ status: 'pending', fullName: '(entire suite)' }]
        : assertions.filter((a) => SKIP_STATUSES.includes(a.status));

    for (const a of skippedInSuite) {
      const title = a.fullName || a.title || '(untitled)';
      const hit = allowList.find(
        (entry) =>
          file.endsWith(entry.file) &&
          (entry.title === undefined || title.includes(entry.title)) &&
          whenHolds(entry.when, ctx),
      );
      const skipped: SkippedTest = { file: relativeTo(cwd, suite.name), title, status: a.status };

      if (hit === undefined) {
        unexpected.push(skipped);
      } else {
        used.add(hit);
        allowed.push({ ...skipped, reason: hit.reason });
      }
    }
  }

  if (unexpected.length > 0) {
    const files = new Set(unexpected.map((s) => s.file));

    failures.push(
      `${unexpected.length} test(s) in ${files.size} file(s) were SKIPPED and nothing on the allow-list forgives them.\n` +
        '    A skip is not a pass: whatever those tests check was not checked. Make them run (a database, a binary,\n' +
        '    an opt-in variable), or — only if the reason is genuinely environmental — add an entry WITH a reason and a\n' +
        '    `when` condition to scripts/test-db/allowed-skips.json.\n' +
        [...files]
          .sort()
          .map((f) => {
            const mine = unexpected.filter((s) => s.file === f);

            return (
              `      · ${f} (${mine.length})\n` +
              mine
                .slice(0, 3)
                .map((s) => `          [${s.status}] ${s.title}`)
                .join('\n') +
              (mine.length > 3 ? `\n          … and ${mine.length - 3} more` : '')
            );
          })
          .join('\n'),
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    unexpected,
    allowed,
    unused: allowList.filter((e) => !used.has(e)),
    suites: suites.length,
    passed: report.numPassedTests ?? 0,
    failed: failedTests,
  };
}
