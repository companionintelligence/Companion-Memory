import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  checkNoSkips,
  parseAllowList,
  whenHolds,
  type AllowedSkip,
  type JestReport,
  type SkipContext,
} from './noSkips';

const CWD = '/repo/backend/apps/api';
const abs = (rel: string) => `${CWD}/src/${rel}`;

/** A host with nothing special installed, on Linux, with no opt-ins set. */
const bareLinux: SkipContext = { platform: 'linux', env: {}, hasBinary: () => false };
const fullMac: SkipContext = { platform: 'darwin', env: {}, hasBinary: () => true };

function report(suites: [string, string[]][], overrides: Partial<JestReport> = {}): JestReport {
  return {
    success: true,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    numPassedTests: 10,
    testResults: suites.map(([file, statuses]) => ({
      name: abs(file),
      status: statuses.every((s) => s === 'passed') ? 'passed' : 'failed',
      assertionResults: statuses.map((status, i) => ({
        status,
        fullName: `${file} test ${i}`,
        title: `test ${i}`,
      })),
    })),
    ...overrides,
  };
}

const check = (r: JestReport, allow: AllowedSkip[] = [], ctx: SkipContext = bareLinux) =>
  checkNoSkips(r, allow, ctx, CWD);

test('a run where everything passed is ok', () => {
  const res = check(
    report([
      ['a/a.spec.ts', ['passed', 'passed']],
      ['b/b.spec.ts', ['passed']],
    ]),
  );

  assert.equal(res.ok, true);
  assert.deepEqual(res.failures, []);
  assert.equal(res.suites, 2);
});

test('a pending test (describe.skip / it.skip) fails the run', () => {
  const res = check(report([['a/a.spec.ts', ['passed', 'pending']]]));

  assert.equal(res.ok, false);
  assert.deepEqual(res.unexpected, [
    { file: 'src/a/a.spec.ts', title: 'a/a.spec.ts test 1', status: 'pending' },
  ]);
  assert.match(res.failures.join('\n'), /1 test\(s\) in 1 file\(s\) were SKIPPED/);
});

test('todo, skipped and disabled all count as "did not run"', () => {
  const res = check(report([['a/a.spec.ts', ['todo', 'skipped', 'disabled', 'passed']]]));

  assert.deepEqual(
    res.unexpected.map((s) => s.status),
    ['todo', 'skipped', 'disabled'],
  );
});

test('a whole suite jest marked pending with no assertions still did not run', () => {
  const res = check({
    success: true,
    testResults: [{ name: abs('a/a.spec.ts'), status: 'pending', assertionResults: [] }],
  });

  assert.equal(res.ok, false);
  assert.equal(res.unexpected[0].title, '(entire suite)');
});

test('zero suites is a failure: a path filter that matched nothing proves nothing', () => {
  const res = check({ success: true, testResults: [] });

  assert.equal(res.ok, false);
  assert.match(res.failures[0], /ZERO test suites/);
  assert.equal(check({ success: true }).ok, false);
});

test('jest failures fail the run, including a suite that failed to run (how CI_REQUIRE_DB reports a missing database)', () => {
  const res = check(
    report([['a/a.spec.ts', ['passed']]], { success: false, numFailedTestSuites: 1, numFailedTests: 0 }),
  );

  assert.equal(res.ok, false);
  assert.match(res.failures.join('\n'), /jest reported failures: 0 test\(s\) in 1 failed suite\(s\)/);
});

test('an allow-list entry forgives its file, and the hit carries the reason', () => {
  const allow: AllowedSkip[] = [{ file: 'a/a.spec.ts', reason: 'an opt-in that a normal run does not make' }];
  const res = check(report([['a/a.spec.ts', ['passed', 'pending', 'pending']]]), allow);

  assert.equal(res.ok, true);
  assert.equal(res.allowed.length, 2);
  assert.equal(res.allowed[0].reason, 'an opt-in that a normal run does not make');
  assert.deepEqual(res.unused, []);
});

test('an entry matches by path suffix, so it survives different absolute roots', () => {
  const allow: AllowedSkip[] = [
    { file: 'a/a.spec.ts', reason: 'suffix matching keeps this stable across runners' },
  ];
  const r = report([['a/a.spec.ts', ['pending']]]);

  r.testResults![0].name = 'C:\\runner\\work\\api\\src\\a\\a.spec.ts';
  assert.equal(check(r, allow).ok, true);
});

test('an entry for one file does not forgive another', () => {
  const allow: AllowedSkip[] = [{ file: 'a/a.spec.ts', reason: 'only this one file is allowed to skip' }];
  const res = check(report([['b/b.spec.ts', ['pending']]]), allow);

  assert.equal(res.ok, false);
  assert.deepEqual(
    res.unused.map((e) => e.file),
    ['a/a.spec.ts'],
  );
});

test('an entry with a title forgives only the matching tests in the file', () => {
  const allow: AllowedSkip[] = [
    { file: 'a/a.spec.ts', title: 'test 1', reason: 'only the second test needs the missing thing' },
  ];
  const res = check(report([['a/a.spec.ts', ['pending', 'pending']]]), allow);

  assert.equal(res.ok, false);
  assert.deepEqual(
    res.unexpected.map((s) => s.title),
    ['a/a.spec.ts test 0'],
  );
  assert.equal(res.allowed.length, 1);
});

test('missingBinaries: forgiven only while the binary really is missing', () => {
  const allow: AllowedSkip[] = [
    { file: 'v/vips.test.ts', reason: 'needs the vips CLI', when: { missingBinaries: ['vips'] } },
  ];
  const r = report([['v/vips.test.ts', ['pending']]]);

  assert.equal(check(r, allow, bareLinux).ok, true, 'skipping without vips is fine');

  const onMac = check(r, allow, fullMac);

  assert.equal(onMac.ok, false, 'skipping WITH vips installed is a bug, not an allowance');
  assert.equal(onMac.unexpected.length, 1);
});

test('missingBinaries with several names needs every one of them absent (unzip OR ditto present means it should run)', () => {
  const allow: AllowedSkip[] = [
    {
      file: 'z/extract.test.ts',
      reason: 'needs unzip or ditto',
      when: { missingBinaries: ['unzip', 'ditto'] },
    },
  ];
  const r = report([['z/extract.test.ts', ['pending']]]);
  const hasUnzip: SkipContext = { platform: 'linux', env: {}, hasBinary: (b) => b === 'unzip' };

  assert.equal(check(r, allow, bareLinux).ok, true);
  assert.equal(check(r, allow, hasUnzip).ok, false);
});

test('platformNotIn: a macOS-only suite may skip elsewhere, never on macOS', () => {
  const allow: AllowedSkip[] = [
    { file: 'm/mac.test.ts', reason: 'reads macOS-only state', when: { platformNotIn: ['darwin'] } },
  ];
  const r = report([['m/mac.test.ts', ['pending']]]);

  assert.equal(check(r, allow, bareLinux).ok, true);
  assert.equal(check(r, allow, fullMac).ok, false);
});

test('envNotSet: an opt-in suite may skip until the opt-in is made, then it must run', () => {
  const allow: AllowedSkip[] = [
    {
      file: 'p/real.spec.ts',
      reason: 'measures an operator archive; opt in with PIPELINE_REAL_CORPUS=1',
      when: { envNotSet: { name: 'PIPELINE_REAL_CORPUS' } },
    },
  ];
  const r = report([['p/real.spec.ts', ['pending']]]);
  const optedIn: SkipContext = {
    platform: 'linux',
    env: { PIPELINE_REAL_CORPUS: '1' },
    hasBinary: () => false,
  };

  assert.equal(check(r, allow, bareLinux).ok, true);
  assert.equal(check(r, allow, optedIn).ok, false);
});

test('whenHolds: no condition means always; every present condition must hold', () => {
  assert.equal(whenHolds(undefined, bareLinux), true);
  assert.equal(whenHolds({ missingBinaries: ['x'], platformNotIn: ['darwin'] }, bareLinux), true);
  assert.equal(whenHolds({ missingBinaries: ['x'], platformNotIn: ['linux'] }, bareLinux), false);
});

test('unused entries are reported but never fail the run', () => {
  const allow: AllowedSkip[] = [{ file: 'gone/gone.spec.ts', reason: 'this entry matches nothing this run' }];
  const res = check(report([['a/a.spec.ts', ['passed']]]), allow);

  assert.equal(res.ok, true);
  assert.equal(res.unused.length, 1);
});

test('the failure text names the file, the status and the test, and says where to add an allowance', () => {
  const res = check(report([['a/a.spec.ts', ['pending']]]));
  const text = res.failures.join('\n');

  assert.match(text, /src\/a\/a\.spec\.ts \(1\)/);
  assert.match(text, /\[pending\] a\/a\.spec\.ts test 0/);
  assert.match(text, /scripts\/test-db\/allowed-skips\.json/);
});

// -- parseAllowList ----------------------------------------------------------

const good = { file: 'a/a.spec.ts', reason: 'a reason that says something real' };

test('parseAllowList accepts a well-formed file and normalises backslashes in paths', () => {
  const [entry] = parseAllowList({
    skips: [{ ...good, file: 'a\\a.spec.ts', title: 't', when: { missingBinaries: ['vips'] } }],
  });

  assert.equal(entry.file, 'a/a.spec.ts');
  assert.equal(entry.title, 't');
});

test('parseAllowList rejects a missing or too-short reason — the whole point of the file', () => {
  assert.throws(() => parseAllowList({ skips: [{ file: 'a/a.spec.ts' }] }), /needs a "reason"/);
  assert.throws(() => parseAllowList({ skips: [{ file: 'a/a.spec.ts', reason: '' }] }), /needs a "reason"/);
  assert.throws(
    () => parseAllowList({ skips: [{ file: 'a/a.spec.ts', reason: 'flaky' }] }),
    /at least 20 characters/,
  );
  assert.throws(
    () => parseAllowList({ skips: [{ file: 'a/a.spec.ts', reason: 'x'.repeat(19) }] }),
    /at least 20/,
  );
});

test('parseAllowList rejects a missing, empty or absolute file', () => {
  assert.throws(() => parseAllowList({ skips: [{ reason: good.reason }] }), /needs a "file"/);
  assert.throws(() => parseAllowList({ skips: [{ ...good, file: '  ' }] }), /needs a "file"/);
  assert.throws(
    () => parseAllowList({ skips: [{ ...good, file: '/abs/a.spec.ts' }] }),
    /does not start with "\/"/,
  );
});

test('parseAllowList rejects unknown keys, so a typo cannot silently disable a condition', () => {
  assert.throws(() => parseAllowList({ skips: [{ ...good, whenn: {} }] }), /unknown key "whenn"/);
  assert.throws(
    () => parseAllowList({ skips: [{ ...good, when: { missingBinary: ['x'] } }] }),
    /unknown "when" key "missingBinary"/,
  );
});

test('parseAllowList validates the shape of each condition', () => {
  assert.throws(
    () => parseAllowList({ skips: [{ ...good, when: { missingBinaries: [] } }] }),
    /non-empty array/,
  );
  assert.throws(
    () => parseAllowList({ skips: [{ ...good, when: { platformNotIn: 'darwin' } }] }),
    /non-empty array/,
  );
  assert.throws(() => parseAllowList({ skips: [{ ...good, when: { envNotSet: 'X' } }] }), /envNotSet/);
  assert.throws(() => parseAllowList({ skips: [{ ...good, title: '' }] }), /empty "title"/);
});

test('parseAllowList rejects a wrong top-level shape', () => {
  assert.throws(() => parseAllowList([]), /"skips" array/);
  assert.throws(() => parseAllowList({}), /"skips" array/);
  assert.throws(() => parseAllowList({ skips: ['x'] }), /not an object/);
});

test('the committed allowed-skips.json is valid, and every file it names exists', () => {
  const file = path.join(process.cwd(), 'scripts/test-db/allowed-skips.json');
  const entries = parseAllowList(JSON.parse(fs.readFileSync(file, 'utf8')));
  const apiSrc = path.join(process.cwd(), 'backend/apps/api/src');

  for (const entry of entries) {
    assert.ok(
      fs.existsSync(path.join(apiSrc, entry.file)),
      `allowed-skips.json names ${entry.file}, which does not exist under backend/apps/api/src — a stale allowance forgives nothing and hides the day the file comes back`,
    );
  }
});
