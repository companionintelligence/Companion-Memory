/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NAME EVERY SKIPPED TEST FILE, AND SAY WHY — jest's default reporter does not.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A database-backed spec that cannot run calls `describe.skip` and prints
 * `[<suite>] SKIPPED — <reason>` with `console.warn`. In a multi-file run jest
 * buffers each file's console output and prints it with that file's result —
 * except when EVERY test in the file was skipped: `DefaultReporter.onTestResult`
 * only prints a result `if (!testResult.skipped)`. So the one line that says
 * why a suite did not run is dropped, and all that is left is a count:
 *
 *   Test Suites: 1 skipped, 68 passed, 68 of 69 total
 *
 * That is how a suite pointed at a healthy database skipped all seven of its
 * tests during a loaded run on 2026-09-29 and nobody could tell which one, or
 * why. The buffered output is still on the result (`testResult.console`); this
 * reporter reads it and prints, just above jest's own totals, which files were
 * skipped outright and the reason each one gave.
 *
 * Plain CommonJS, not TypeScript: jest loads a reporter with a bare `require`,
 * without the transform the specs go through.
 *
 * Wired in `jest.config.mjs` (`reporters`). Its only contract with the specs is
 * the `SKIPPED — ` marker they already print.
 */
'use strict';

// CommonJS by necessity (see above), like bin/*.js.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('node:path');

/** What a spec prints when it skips: `[pipeline.integration] SKIPPED — <reason>`. */
const SKIP_NOTICE = /\bSKIPPED\s+[—-]\s+([\s\S]+)$/;

/**
 * Suites differ only in which variable they name, so their reasons are grouped
 * with the name generalised: `MEMORY_TEST_DATABASE_URL` and
 * `IMPORT_TEST_DATABASE_URL` both read `<SUITE>_TEST_DATABASE_URL`.
 */
const SUITE_VARIABLE = /\b[A-Z][A-Z0-9_]*?_TEST_(DATABASE_URL|PROBE_TIMEOUT_MS)\b/g;

/** Files listed under each reason before the rest are counted instead. */
const FILES_PER_REASON = 5;

const NO_REASON = 'no SKIPPED reason was logged';

/**
 * The reason a skipped file gave, or `null`. `consoleBuffer` is jest's
 * `testResult.console`: absent in verbose runs, which print it live instead.
 *
 * @param {Array<{ message: string }> | undefined | null} consoleBuffer
 * @returns {string | null}
 */
function skipReason(consoleBuffer) {
  for (const entry of consoleBuffer ?? []) {
    const match = SKIP_NOTICE.exec(String(entry.message));

    if (match != null) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * The block printed at the end of a run, or `null` when nothing was skipped.
 *
 * @param {Array<{ file: string; reason: string | null }>} skipped
 * @returns {string | null}
 */
function summarizeSkippedSuites(skipped) {
  if (skipped.length === 0) {
    return null;
  }

  /** @type {Map<string, string[]>} */
  const byReason = new Map();

  for (const { file, reason } of skipped) {
    const key = reason == null ? NO_REASON : reason.replace(SUITE_VARIABLE, '<SUITE>_TEST_$1');
    const files = byReason.get(key) ?? [];

    files.push(file);
    byReason.set(key, files);
  }

  const groups = [...byReason.entries()].sort(
    ([a, filesA], [b, filesB]) => filesB.length - filesA.length || a.localeCompare(b),
  );
  const count = skipped.length;
  const lines = [
    '',
    count === 1
      ? '1 test file was skipped outright — none of its tests ran:'
      : `${count} test files were skipped outright — none of their tests ran:`,
  ];

  for (const [reason, files] of groups) {
    lines.push(`  ${files.length} × ${reason}`);

    const sorted = [...files].sort();

    for (const file of sorted.slice(0, FILES_PER_REASON)) {
      lines.push(`      ${file}`);
    }

    if (sorted.length > FILES_PER_REASON) {
      lines.push(`      … and ${sorted.length - FILES_PER_REASON} more`);
    }
  }

  return `${lines.join('\n')}\n\n`;
}

class SkippedSuitesReporter {
  /** @param {{ rootDir: string }} globalConfig */
  constructor(globalConfig) {
    this.rootDir = globalConfig.rootDir;
    /** @type {Array<{ file: string; reason: string | null }>} */
    this.skipped = [];
  }

  /** Watch mode reruns reuse the reporter; each run reports only its own skips. */
  onRunStart() {
    this.skipped = [];
  }

  /**
   * @param {unknown} _test
   * @param {{ skipped: boolean; testExecError?: unknown; testFilePath: string; console?: Array<{ message: string }> | null }} testResult
   */
  onTestResult(_test, testResult) {
    // A reporter that throws takes the whole run down with it; this one is
    // advisory, so it never does.
    try {
      if (!testResult.skipped || testResult.testExecError != null) {
        return;
      }

      this.skipped.push({
        file: path.relative(this.rootDir, testResult.testFilePath),
        reason: skipReason(testResult.console),
      });
    } catch {
      // Advisory only — see above.
    }
  }

  onRunComplete() {
    try {
      const summary = summarizeSkippedSuites(this.skipped);

      if (summary != null) {
        process.stderr.write(summary);
      }
    } catch {
      // Advisory only — see onTestResult.
    }
  }
}

module.exports = SkippedSuitesReporter;
module.exports.skipReason = skipReason;
module.exports.summarizeSkippedSuites = summarizeSkippedSuites;
