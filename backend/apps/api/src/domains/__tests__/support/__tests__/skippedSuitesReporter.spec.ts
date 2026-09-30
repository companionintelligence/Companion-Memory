/**
 * The reporter that names skipped test files and their reasons — which jest's
 * default reporter silently drops for any file whose tests were all skipped.
 * See the header of `../skippedSuitesReporter.js`.
 */

interface SkippedSuite {
  file: string;
  reason: string | null;
}

interface FakeTestResult {
  skipped: boolean;
  testExecError?: unknown;
  testFilePath: string;
  console?: Array<{ message: string; origin: string; type: string }> | null;
}

interface ReporterModule {
  new (globalConfig: { rootDir: string }): {
    onRunStart(): void;
    onTestResult(test: unknown, testResult: FakeTestResult): void;
    onRunComplete(): void;
  };
  skipReason(consoleBuffer: FakeTestResult['console']): string | null;
  summarizeSkippedSuites(skipped: SkippedSuite[]): string | null;
}

// Plain CommonJS on purpose — jest loads reporters without a transform.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Reporter = require('../skippedSuitesReporter') as ReporterModule;

const ROOT = '/repo/backend/apps/api';

function warned(message: string) {
  return { message, origin: 'at Object.<anonymous> (spec.ts:1:1)', type: 'warn' };
}

function skippedFile(file: string, messages: string[] | null): FakeTestResult {
  return { skipped: true, testFilePath: `${ROOT}/${file}`, console: messages?.map(warned) ?? null };
}

/** Run the reporter over `results` and return what it printed. */
function report(results: FakeTestResult[]): string {
  const printed: string[] = [];
  const write = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    printed.push(String(chunk));

    return true;
  });

  try {
    const reporter = new Reporter({ rootDir: ROOT });

    reporter.onRunStart();

    for (const result of results) {
      reporter.onTestResult({}, result);
    }

    reporter.onRunComplete();
  } finally {
    write.mockRestore();
  }

  return printed.join('');
}

describe('skipReason', () => {
  it('takes the reason from the first SKIPPED notice in the buffered console output', () => {
    expect(
      Reporter.skipReason([
        warned('[configuration] SIDECAR_AUTH_SECRET is not set'),
        warned(
          '[memory/PersonService.findSelf] SKIPPED — no database configured — set MEMORY_TEST_DATABASE_URL',
        ),
        warned('[other] SKIPPED — a second notice'),
      ]),
    ).toBe('no database configured — set MEMORY_TEST_DATABASE_URL');
  });

  it('is null when the file logged no notice, or its output was printed live (verbose runs)', () => {
    expect(Reporter.skipReason([warned('unrelated')])).toBeNull();
    expect(Reporter.skipReason(undefined)).toBeNull();
    expect(Reporter.skipReason(null)).toBeNull();
  });
});

describe('the skipped-files summary', () => {
  it('prints nothing when no file was skipped outright', () => {
    expect(
      report([
        {
          skipped: false,
          testFilePath: `${ROOT}/src/a.spec.ts`,
          console: [warned('[a] SKIPPED — only one block')],
        },
      ]),
    ).toBe('');
  });

  it('ignores a file that failed to run — jest already reports that loudly', () => {
    expect(
      report([{ ...skippedFile('src/a.spec.ts', ['[a] SKIPPED — x']), testExecError: new Error('boom') }]),
    ).toBe('');
  });

  it('names each skipped file under the reason it gave, grouping suites that differ only in their variable', () => {
    const printed = report([
      skippedFile('src/domains/memory/b.integration.spec.ts', [
        '[memory/b] SKIPPED — no database configured — set MEMORY_TEST_DATABASE_URL or DATABASE_URL',
      ]),
      skippedFile('src/domains/import/a.integration.spec.ts', [
        '[import/a] SKIPPED — no database configured — set IMPORT_TEST_DATABASE_URL or DATABASE_URL',
      ]),
      skippedFile('src/domains/auth/c.integration.test.ts', null),
    ]);

    expect(printed).toBe(
      [
        '',
        '3 test files were skipped outright — none of their tests ran:',
        '  2 × no database configured — set <SUITE>_TEST_DATABASE_URL or DATABASE_URL',
        '      src/domains/import/a.integration.spec.ts',
        '      src/domains/memory/b.integration.spec.ts',
        '  1 × no SKIPPED reason was logged',
        '      src/domains/auth/c.integration.test.ts',
        '',
        '',
      ].join('\n'),
    );
  });

  it('says "file" and "its" for a single skipped file', () => {
    expect(report([skippedFile('src/a.spec.ts', ['[a] SKIPPED — x'])])).toContain(
      '1 test file was skipped outright — none of its tests ran:\n  1 × x\n',
    );
  });

  it('lists a handful of files per reason and counts the rest', () => {
    const printed = report(
      Array.from({ length: 8 }, (_, index) =>
        skippedFile(`src/s${index}.spec.ts`, [`[s${index}] SKIPPED — no database configured`]),
      ),
    );

    expect(printed).toContain('8 test files were skipped outright');
    expect(printed).toContain('  8 × no database configured\n');
    expect(printed).toContain('      src/s4.spec.ts\n      … and 3 more\n');
    expect(printed).not.toContain('src/s5.spec.ts');
  });

  it('starts every run afresh, as watch mode reuses one reporter', () => {
    const reporter = new Reporter({ rootDir: ROOT });
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      reporter.onRunStart();
      reporter.onTestResult({}, skippedFile('src/a.spec.ts', ['[a] SKIPPED — x']));
      reporter.onRunStart();
      reporter.onRunComplete();

      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it('never throws, whatever jest hands it', () => {
    const reporter = new Reporter({ rootDir: ROOT });

    expect(() => reporter.onTestResult({}, null as unknown as FakeTestResult)).not.toThrow();
    expect(() => reporter.onTestResult({}, { skipped: true } as FakeTestResult)).not.toThrow();
  });
});
