import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

import { DOCTOR_CHECKS, type DoctorCheck, type DoctorSeverity } from './checks';

/**
 * What happened to one check.
 *
 * `clean` and `found` are both SUCCESSES — the check ran and returned a number.
 * `timeout` and `error` are the check failing to answer, which is deliberately
 * NOT the same as answering zero: a gate that reads "I could not look" as "there
 * is nothing there" is worse than no gate, and this split is what lets the exit
 * code say so.
 */
export type DoctorStatus = 'clean' | 'found' | 'timeout' | 'error';

/** One check's result, carrying enough of the check itself to be read standalone. */
export interface DoctorFinding {
  id: string;
  severity: DoctorSeverity;
  status: DoctorStatus;
  title: string;
  scope: string;
  remedy: string;
  mirrors: string | null;
  /** Offending rows. Null when the check did not answer (`timeout` / `error`). */
  count: number | null;
  /** `{dimension: n}` — how the count splits. Null when the check does not compute one, or found nothing. */
  breakdown: Record<string, number> | null;
  /** One offending row, shape check-specific. Null when nothing was found. */
  sample: Record<string, unknown> | null;
  /** Wall-clock for this statement, which is also the number to look at when it timed out. */
  durationMs: number;
  /** The database's own message, for `timeout` and `error`. Null otherwise. */
  error: string | null;
}

export interface DoctorReport {
  /**
   * The gate. False when any HIGH check found rows, AND when any HIGH check
   * failed to answer — see {@link DoctorStatus}.
   */
  ok: boolean;
  at: string;
  durationMs: number;
  /** The per-statement cap that was in force, echoed so a TIMEOUT is interpretable. */
  statementTimeoutMs: number;
  totals: {
    checks: number;
    clean: number;
    found: number;
    timeout: number;
    error: number;
    /** HIGH checks that found rows. The number the exit code is really about. */
    highFindings: number;
    /** HIGH checks that could not answer. Also fails the gate. */
    highUnresolved: number;
  };
  findings: DoctorFinding[];
}

export interface RunDoctorOptions {
  /** Restrict to these check ids. Unknown ids are the caller's problem; the controller validates. */
  checks?: readonly string[];
  /** Per-statement cap in ms. Clamped to {@link TIMEOUT_BOUNDS}. */
  statementTimeoutMs?: number;
}

/**
 * Default per-statement cap.
 *
 * Sized against the real thing rather than a guess. Measured mid-import on a
 * live appliance holding 181k communications and 3.6k events, the whole
 * 19-check suite ran in 631ms — slowest check 161ms
 * (`communications-missing-search-vector`, an anti-join over the whole
 * hypertable), next 117ms. A plain `count(*)` on that hypertable is 1–2s at a
 * million rows (the figure `/api/maintenance/ingest-status` was built around),
 * and the regex checks evaluate a pattern per row on top of that, so a few
 * seconds is the honest expectation at full corpus size and fifteen is the
 * honest ceiling.
 *
 * With 19 checks that is a ~4m45s worst case if EVERY one times out, and well
 * under a second in the normal case. Raise it with `--timeout` for a deliberate
 * full audit on a large corpus; the point of the default is that an agent can
 * put `ci doctor --json` in a loop without the loop occasionally taking
 * five minutes.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

/** Floor stops a zero disabling the cap entirely (Postgres reads 0 as "no timeout"). */
export const TIMEOUT_BOUNDS = { min: 100, max: 600_000 } as const;

/**
 * Postgres `query_canceled` — what `statement_timeout` raises.
 *
 * Verified through this stack, not read off a table: with `statement_timeout =
 * 100` and a deliberate cross join, node-postgres surfaces
 * `err.code === '57014'` with the message "canceling statement due to statement
 * timeout", and the very next statement on the SAME connection returns
 * normally. Both halves matter — the code is how a timeout is told apart from a
 * broken query, and the survival is what makes running the rest of the suite on
 * that connection legitimate rather than hopeful.
 */
const QUERY_CANCELED = '57014';

/** Row shape the check statements are contracted to return. See checks.ts. */
interface CheckRow {
  count: string | number | null;
  breakdown?: Record<string, number> | null;
  sample?: Record<string, unknown> | null;
}

/**
 * Runs the data-quality check suite and reports what it found.
 *
 * ## Why it owns a connection
 *
 * `statement_timeout` is a SESSION setting, so it has to be applied to a
 * connection this service controls from first check to last — hence one pinned
 * `QueryRunner` rather than `dataSource.query`, which hands back a different
 * pooled connection each call. The corollary is the `RESET` in the `finally`:
 * releasing a connection to the pool while it still carries a 15-second cap
 * would silently break unrelated queries elsewhere in the process, in a way
 * that would look like a flaky database rather than like this file.
 *
 * `SET LOCAL` would scope it automatically, but it requires a transaction, and a
 * transaction is precisely what a cancelled statement destroys: `statement_timeout`
 * raises 57014, which aborts the surrounding transaction and leaves every
 * subsequent statement failing with "current transaction is aborted". Autocommit
 * plus an explicit RESET is the shape where one slow check costs one check.
 *
 * ## Why sequential
 *
 * One connection means one statement at a time, which is also what we want:
 * nineteen concurrent sequential scans over the same few large tables would
 * contend for exactly the same buffers and finish later than running them in
 * order. Ordering also makes the report readable as a walk down the pipeline.
 *
 * ## Scope
 *
 * Counts are GLOBAL, not user-scoped, matching the other observability surfaces
 * (`/api/maintenance/ingest-status`, `/search/coverage`). The question this
 * answers is "is this appliance's data sound", not "is mine" — and several of
 * the tables it reads carry rows with no owner at all, which a user-scoped query
 * would silently drop. That is exactly the class of blindness this exists to
 * remove.
 */
@Injectable()
export class ImportDoctorService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ImportDoctorService.name);
  }

  async run(options: RunDoctorOptions = {}): Promise<DoctorReport> {
    const selected =
      options.checks == null || options.checks.length === 0
        ? DOCTOR_CHECKS
        : DOCTOR_CHECKS.filter((check) => options.checks?.includes(check.id));

    const statementTimeoutMs = clampTimeout(options.statementTimeoutMs);
    const startedAt = Date.now();
    const findings: DoctorFinding[] = [];

    const runner = this.dataSource.createQueryRunner();

    try {
      await runner.connect();
      // Not parameterizable: SET takes a literal, not a bind. `clampTimeout`
      // guarantees an integer in range, which is what makes the interpolation
      // safe rather than merely conventional.
      await runner.query(`SET statement_timeout = ${statementTimeoutMs}`);

      for (const check of selected) {
        findings.push(await this.runOne(runner, check));
      }
    } finally {
      // Both statements can fail if the connection died mid-suite; neither
      // failure should replace the report we already built.
      await runner.query('RESET statement_timeout').catch(() => undefined);
      await runner.release().catch(() => undefined);
    }

    return summarize(findings, statementTimeoutMs, Date.now() - startedAt);
  }

  private async runOne(
    runner: { query: (sql: string) => Promise<unknown> },
    check: DoctorCheck,
  ): Promise<DoctorFinding> {
    const startedAt = Date.now();

    const base = {
      id: check.id,
      severity: check.severity,
      title: check.title,
      scope: check.scope,
      remedy: check.remedy,
      mirrors: check.mirrors,
    };

    try {
      const rows = (await runner.query(check.sql)) as CheckRow[];
      const row = rows[0];
      const count = Number(row?.count ?? 0);

      return {
        ...base,
        status: count > 0 ? 'found' : 'clean',
        count,
        // Both are null when nothing was found — an empty aggregate, not a
        // missing column — so normalizing them away keeps the JSON of a clean
        // check uniform whatever the check computes.
        breakdown: count > 0 ? (row?.breakdown ?? null) : null,
        sample: count > 0 ? (row?.sample ?? null) : null,
        durationMs: Date.now() - startedAt,
        error: null,
      };
    } catch (err) {
      const timedOut = (err as { code?: string }).code === QUERY_CANCELED;
      const message = (err as Error).message ?? String(err);

      // WARN, not ERROR: one check that cannot answer is a documented outcome of
      // this design, and paging on it would make the suite unusable on a big
      // corpus. The report carries the same fact in a form the caller acts on.
      this.logger.warn(`Doctor check ${timedOut ? 'timed out' : 'failed'}; the suite continues`, {
        check: check.id,
        scope: check.scope,
        durationMs: Date.now() - startedAt,
        error: message,
      });

      return {
        ...base,
        status: timedOut ? 'timeout' : 'error',
        count: null,
        breakdown: null,
        sample: null,
        durationMs: Date.now() - startedAt,
        error: message,
      };
    }
  }
}

/**
 * Keep the cap an integer inside sane bounds.
 *
 * The floor matters more than it looks: Postgres reads `statement_timeout = 0`
 * as "no timeout at all", so a caller passing 0 — meaning "be quick" — would get
 * the opposite of what they asked for and hang the request forever.
 */
export function clampTimeout(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) {
    return DEFAULT_STATEMENT_TIMEOUT_MS;
  }

  return Math.min(TIMEOUT_BOUNDS.max, Math.max(TIMEOUT_BOUNDS.min, Math.round(value)));
}

/** Roll findings up into the report header, including the gate. */
export function summarize(
  findings: DoctorFinding[],
  statementTimeoutMs: number,
  durationMs: number,
): DoctorReport {
  const count = (status: DoctorStatus) => findings.filter((f) => f.status === status).length;

  const highFindings = findings.filter((f) => f.severity === 'high' && f.status === 'found').length;
  const highUnresolved = findings.filter(
    (f) => f.severity === 'high' && (f.status === 'timeout' || f.status === 'error'),
  ).length;

  return {
    ok: highFindings === 0 && highUnresolved === 0,
    at: new Date().toISOString(),
    durationMs,
    statementTimeoutMs,
    totals: {
      checks: findings.length,
      clean: count('clean'),
      found: count('found'),
      timeout: count('timeout'),
      error: count('error'),
      highFindings,
      highUnresolved,
    },
    findings,
  };
}
