import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';

import { ApplianceAdminGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { DOCTOR_CHECKS, DOCTOR_CHECK_IDS, type DoctorCheck } from '../doctor/checks';
import { ImportDoctorService, type DoctorReport } from '../doctor/ImportDoctorService';

/** The registry as `GET /import/doctor/checks` publishes it — everything but the SQL. */
export type DoctorCheckSummary = Omit<DoctorCheck, 'sql'>;

/**
 * Data-quality checks over what the importers actually wrote.
 *
 * ## Why this is a route and not a script
 *
 * The audit these checks came from was fifty statements typed into `psql` during
 * a live import. That works exactly once, for exactly the person holding the
 * shell. As a route it is: the same suite the CLI runs (`ci doctor`), on
 * an appliance nobody has database credentials for, from an agent loop that has
 * an api key and nothing else, with the predicates version-controlled next to
 * the guards they mirror.
 *
 * ## GET, and global
 *
 * GET because it writes nothing — every statement is a SELECT — and because a
 * poller and a `curl` should both be able to have it. Counts are GLOBAL rather
 * than user-scoped, matching `/api/maintenance/ingest-status` and
 * `/search/coverage`: "is this appliance's data sound" is the question, several
 * of the tables carry rows with no owner, and a user-scoped query would drop
 * exactly those rows without saying so.
 *
 * ## Errors
 *
 * An unknown check id is a 400 that NAMES the unknown ids, because the caller
 * most likely to send one is an agent working from a half-remembered id, and
 * "unknown check: comms-null-thread" plus the list is a fix; a silent empty
 * result is a wild goose chase. A check that fails or times out is NOT an error
 * here — it is a finding with `status: "timeout"`, and the response is still
 * 200. See {@link ImportDoctorService}.
 */
@Controller('import/doctor')
export class ImportDoctorController {
  constructor(private readonly doctor: ImportDoctorService) {}

  /**
   * The registry itself: what can be checked, how bad each one is, and what to
   * do about it — without running anything.
   *
   * Listed first on purpose: this is the call an agent makes to learn the
   * vocabulary before it starts asking for individual checks.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('checks')
  listChecks(): DoctorCheckSummary[] {
    // The SQL is stripped: it is an implementation detail that would double the
    // payload, and a caller that wants it can read checks.ts.
    return DOCTOR_CHECKS.map(({ sql: _sql, ...rest }) => rest);
  }

  /**
   * Run the suite (or a named subset) and report.
   *
   * `checks` is a comma-separated list of ids; omit it for all of them.
   * `timeoutMs` overrides the per-statement cap — raise it for a deliberate
   * full audit over a large corpus, where a check that times out at the default
   * would still finish given a minute.
   *
   * Administrator-only, the same gate the appliance-wide maintenance sweeps
   * carry. Each check scans every account and returns a sample row from
   * whichever one owns the defect, so a household member running this would
   * read the owner's contact names, event locations and pipeline errors. The
   * static registry on `/checks` stays open — it names what can be checked and
   * leaks no data. On an unclaimed appliance the guard admits everyone, which
   * is the honest answer for a box that has no owner yet.
   */
  @UseGuards(JwtOrApiKeyAuthGuard, ApplianceAdminGuard)
  @Get()
  async run(@Query('checks') checks?: string, @Query('timeoutMs') timeoutMs?: string): Promise<DoctorReport> {
    const requested = parseCheckIds(checks);
    const parsedTimeout = timeoutMs == null ? undefined : Number(timeoutMs);

    return this.doctor.run({
      checks: requested,
      statementTimeoutMs: Number.isFinite(parsedTimeout) ? parsedTimeout : undefined,
    });
  }
}

/**
 * Split and validate the `checks` filter.
 *
 * Returns undefined for "no filter", which the service reads as "all of them" —
 * distinct from an empty array, which would be a filter matching nothing and is
 * never what a caller means by an empty query string.
 */
export function parseCheckIds(value: string | undefined): string[] | undefined {
  if (value == null) {
    return undefined;
  }

  const ids = value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (ids.length === 0) {
    return undefined;
  }

  const unknown = ids.filter((id) => !DOCTOR_CHECK_IDS.includes(id));

  if (unknown.length > 0) {
    throw new BadRequestException(
      `Unknown check id(s): ${unknown.join(', ')}. Known ids: ${DOCTOR_CHECK_IDS.join(', ')}`,
    );
  }

  return ids;
}
