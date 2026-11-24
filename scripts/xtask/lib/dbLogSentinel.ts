/**
 * The database crash sentinel.
 *
 * A test run whose database crash-restarted underneath it can still exit 0: the
 * suites that were mid-query fail with connection errors that read like defects
 * in the code under test, the ones that were not simply pass, and jest reports
 * whichever it saw. The evidence that the DATABASE was the problem is in the
 * container's own log, which nothing reads. This reads it.
 *
 * Root cause it exists for (measured 2026-09-28, written up beside `init: true`
 * in docker-compose.yml): with the postmaster as PID 1 the kernel hands it every
 * orphaned process in the container, and it treats a child it did not fork that
 * exits above 1 as a crashed backend — it kills every session and runs crash
 * recovery. The log then says, in this order:
 *
 *   [1] LOG:  untracked child process (PID 45672) exited with exit code 2
 *   [1] LOG:  terminating any other active server processes
 *   [1] LOG:  all server processes terminated; reinitializing
 *   [46000] LOG:  database system was not properly shut down; automatic recovery in progress
 *   [46001] FATAL:  the database system is in recovery mode
 *
 * Matching is on the MESSAGE, after Postgres's own `LEVEL:` marker, so that a
 * suite which stores the text of one of these lines in a row (this file's own
 * tests do, in a string) cannot trip it through a `STATEMENT:` echo.
 *
 * What is deliberately NOT matched:
 *   - `FATAL: terminating connection due to administrator command` — what
 *     `pg_terminate_backend()` and `DROP DATABASE ... WITH (FORCE)` produce,
 *     which the scratch-database suites do on purpose;
 *   - `background worker "..." (PID n) exited with exit code 1` — TimescaleDB's
 *     per-database scheduler exits that way whenever its database is dropped;
 *   - `ERROR:` lines in general — suites assert on constraint violations.
 *
 * If a suite ever has to kill a backend or the server on purpose, that suite —
 * not this list — is the thing to change; if it truly cannot be avoided, add an
 * entry to {@link ALLOWED_LOG_PATTERNS} with the reason, so the exception is
 * reviewed rather than implied.
 */

export interface Signature {
  /** Stable id, printed in the report. */
  id: string;
  /** Tested against the message text after `LEVEL:`. */
  pattern: RegExp;
  /** Restrict to these log levels; any level when omitted. */
  levels?: readonly string[];
  /** One line on what it means, for whoever reads the failure. */
  meaning: string;
}

export const CRASH_SIGNATURES: readonly Signature[] = [
  {
    id: 'terminating-other-processes',
    pattern: /terminating any other active server processes/,
    meaning: 'a backend died abnormally, so the postmaster is killing every other session',
  },
  {
    id: 'terminated-by-signal',
    pattern: /was terminated by signal \d+/,
    meaning: 'a server or background-worker process was killed by a signal (SIGSEGV, SIGKILL, OOM…)',
  },
  {
    id: 'untracked-child',
    pattern: /untracked child process \(PID \d+\)/,
    meaning: 'an orphan the postmaster did not fork exited — it counts that as a crashed backend',
  },
  {
    id: 'server-process-exited',
    pattern: /server process \(PID \d+\) exited with exit code \d+/,
    meaning: 'a server process exited abnormally',
  },
  {
    id: 'panic',
    pattern: /.*/,
    levels: ['PANIC'],
    meaning: 'Postgres hit an unrecoverable internal error and aborted',
  },
  {
    id: 'reinitializing',
    pattern: /all server processes terminated; reinitializing/,
    meaning: 'the postmaster finished a crash restart',
  },
  {
    id: 'crash-recovery',
    pattern: /automatic recovery in progress/,
    meaning: 'the server started up after an unclean shutdown and is replaying WAL',
  },
  {
    id: 'crash-of-another-process',
    pattern: /terminating connection because of crash of another server process/,
    meaning: 'this session was killed because a different backend crashed',
  },
  {
    id: 'in-recovery',
    pattern: /database system is in recovery/,
    meaning: 'connections are being refused while the server recovers',
  },
];

/**
 * Log lines that match a signature and are nonetheless expected. EMPTY on
 * purpose, and every entry needs a `reason`. See the file comment before adding one.
 */
export const ALLOWED_LOG_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [];

export interface CrashFinding {
  signature: string;
  meaning: string;
  /** 1-based line number within the log text. */
  line: number;
  text: string;
}

/** `2026-09-29 04:14:28.822 UTC [7] LOG:  message` → level and message. */
const LEVELED_LINE = /\b(LOG|WARNING|FATAL|PANIC|ERROR):\s+(.*)$/;

/** Every crash signature in a Postgres log, in order of appearance. */
export function findCrashSignatures(
  logText: string,
  allowed: readonly { pattern: RegExp; reason: string }[] = ALLOWED_LOG_PATTERNS,
): CrashFinding[] {
  const findings: CrashFinding[] = [];

  logText.split(/\r?\n/).forEach((text, index) => {
    const leveled = LEVELED_LINE.exec(text);

    if (leveled == null) {
      return;
    }

    const [, level, message] = leveled;

    if (allowed.some((a) => a.pattern.test(text))) {
      return;
    }

    for (const sig of CRASH_SIGNATURES) {
      if (sig.levels != null && !sig.levels.includes(level)) {
        continue;
      }

      if (sig.pattern.test(message)) {
        findings.push({ signature: sig.id, meaning: sig.meaning, line: index + 1, text: text.trim() });

        // One finding per line: a line is evidence once, however many patterns fit it.
        return;
      }
    }
  });

  return findings;
}

/** A readable failure block: the first few lines of each kind, then a count. */
export function formatFindings(findings: CrashFinding[], perSignature = 3): string[] {
  const bySig = new Map<string, CrashFinding[]>();

  for (const f of findings) {
    bySig.set(f.signature, [...(bySig.get(f.signature) ?? []), f]);
  }

  const out: string[] = [];

  for (const [sig, list] of bySig) {
    out.push(`${sig} x${list.length} — ${list[0].meaning}`);

    for (const f of list.slice(0, perSignature)) {
      out.push(`    log line ${f.line}: ${f.text}`);
    }

    if (list.length > perSignature) {
      out.push(`    … and ${list.length - perSignature} more`);
    }
  }

  return out;
}
