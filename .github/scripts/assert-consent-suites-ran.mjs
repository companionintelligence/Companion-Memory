#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A GREEN TICK THAT SKIPPED THE TEST IS WORSE THAN NO TICK.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The consent-path suites that prove the things a reviewer actually cares about
 * — retroactive revocation, lapsed grants, the supersede chain, the jsonb
 * disclosure ceiling, atomic answer+audit rollback, correlation idempotency,
 * and now immediate peer revocation — are DB-backed. Every one of them is
 * written as:
 *
 *     const availability = databaseAvailability({ urlEnvVar: '…' });
 *     const describeWithDatabase = availability.available ? describe : describe.skip;
 *
 * That is the right design (see `domains/__tests__/support/databaseConnection.ts`:
 * "nothing is listening" must SKIP, "listening but the schema is wrong" must
 * FAIL). It is also, on a runner with no database, completely silent. Measured
 * on this repo, `jest src/domains/asks src/domains/peers` with no Postgres:
 *
 *     Test Suites: 2 skipped, 25 passed, 25 of 27 total
 *     Tests:       18 skipped, 367 passed, 385 total
 *     → exit 0, "success": true
 *
 * Eighteen consent tests evaporated and the job went green. A reviewer reading
 * that tick would believe the disclosure ceiling had been checked. It had not.
 *
 * This script is the thing that makes the tick mean something: it reads jest's
 * own JSON report and refuses to pass unless the suites that matter RAN.
 *
 * ═══ WHY BOTH CHECKS ═══
 *
 *  1. ZERO SKIPS ANYWHERE IN SCOPE. Catches a suite that skipped for any
 *     reason, including ones added after this file was written — the failure
 *     mode is "a new DB-backed suite appears and nobody updates the manifest",
 *     and a manifest alone cannot see it.
 *
 *  2. A NAMED MANIFEST. Catches what check 1 structurally cannot: a required
 *     suite that produced NO tests at all — deleted, renamed, excluded by a
 *     path-filter typo, or emptied. Zero tests is zero skips, so check 1 is
 *     perfectly happy with a file that has ceased to exist.
 *
 * Usage: node .github/scripts/assert-consent-suites-ran.mjs <jest-report.json>
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The DB-backed consent-path suites. Every one of these is `describe.skip`ped
 * without a database, and every one of them proves a promise the product makes
 * to the owner in words.
 *
 * Keep this list in step with:
 *   grep -rl 'databaseAvailability' backend/apps/api/src/domains/{asks,peers,graphql,search-next}
 *
 * Entries are matched as path suffixes, so they are stable across the absolute
 * paths jest reports on different runners.
 */
const REQUIRED_SUITES = [
  // Retroactive revocation, lapsed grants, the supersede chain, cross-user
  // scoping — the WHERE clause IS the authorization boundary.
  'domains/asks/services/__tests__/GrantService.integration.spec.ts',
  // The jsonb disclosure ceiling, and the federated availability read that
  // reaches the owner's calendar directly.
  'domains/graphql/resolvers/__tests__/AskDisclosureCeiling.integration.spec.ts',
  // Atomic answer+audit rollback, correlation idempotency, and that a completed
  // disclosure is not rewritten by a later revoke.
  'domains/peers/__tests__/PeerAskLifecycle.integration.spec.ts',
  // "Revocation is immediate" — the inbound-authentication filter, in SQL.
  'domains/peers/__tests__/PeerLinkRevocation.integration.spec.ts',
  // Tenancy scoping on the retrieval side: what the answer path is allowed to
  // see before any ceiling is applied.
  'domains/search-next/services/__tests__/SearchService.scoping.integration.spec.ts',
];

const reportPath = process.argv[2];

if (reportPath == null) {
  console.error('usage: assert-consent-suites-ran.mjs <jest-report.json>');
  process.exit(2);
}

let report;

try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  // An unreadable report is a failed gate, never a passed one: the most likely
  // cause is that jest died before writing it.
  console.error(`✗ could not read jest report at ${reportPath}: ${error.message}`);
  process.exit(1);
}

const failures = [];

// ── 0. The run happened at all ───────────────────────────────────────────
const suites = Array.isArray(report.testResults) ? report.testResults : [];

if (suites.length === 0) {
  failures.push('jest reported ZERO test suites — the path filter matched nothing.');
}

// ── 1. Jest's own verdict ────────────────────────────────────────────────
if (report.success !== true || report.numFailedTests > 0 || report.numFailedTestSuites > 0) {
  failures.push(
    `jest reported failures: ${report.numFailedTests} test(s), ` +
      `${report.numFailedTestSuites} suite(s). See the run log above.`,
  );
}

// ── 2. Zero skips anywhere in scope ──────────────────────────────────────
//
// This is the whole point of the file. A skipped consent test is not a neutral
// event — it is a control that silently stopped being enforced.
const skipped = [];

for (const suite of suites) {
  for (const assertion of suite.assertionResults ?? []) {
    if (assertion.status === 'pending' || assertion.status === 'todo' || assertion.status === 'skipped') {
      skipped.push({
        file: path.relative(process.cwd(), suite.name),
        title: assertion.fullName || assertion.title,
        status: assertion.status,
      });
    }
  }
}

if (skipped.length > 0) {
  failures.push(
    `${skipped.length} consent-path test(s) SKIPPED rather than ran.\n` +
      '    A DB-backed suite skips when no Postgres is reachable — which means the\n' +
      '    controls it exists to enforce were not checked. Fix the database, do not\n' +
      '    relax this check.\n' +
      skipped.map((s) => `      · [${s.status}] ${s.file}\n          ${s.title}`).join('\n'),
  );
}

// ── 3. Every required suite actually produced passing tests ──────────────
for (const required of REQUIRED_SUITES) {
  const suite = suites.find((candidate) => candidate.name.replaceAll('\\', '/').endsWith(required));

  if (suite == null) {
    failures.push(
      `required suite did not run at all: ${required}\n` +
        '    It was deleted, renamed, or the jest path filter no longer selects it.\n' +
        '    If the move was deliberate, update REQUIRED_SUITES in this file.',
    );
    continue;
  }

  const assertions = suite.assertionResults ?? [];
  const passed = assertions.filter((a) => a.status === 'passed').length;

  if (passed === 0) {
    failures.push(
      `required suite produced NO passing tests: ${required}\n` +
        `    (${assertions.length} assertion(s) reported). An empty suite is not a green suite.`,
    );
  }
}

// ── Verdict ──────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error('\n═══ CONSENT-PATH GATE FAILED ═══\n');
  for (const failure of failures) {
    console.error(`  ✗ ${failure}\n`);
  }

  process.exit(1);
}

console.log(
  `✓ consent-path gate: ${report.numPassedTests} tests passed across ${suites.length} suites, ` +
    `0 skipped, all ${REQUIRED_SUITES.length} DB-backed suites ran.`,
);
