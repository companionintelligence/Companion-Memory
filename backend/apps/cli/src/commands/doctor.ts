import type { DoctorCheckSummary, DoctorFinding, DoctorReport } from '../wire';
import { CliError, type CliContext } from '../context';
import { duration, json, table } from '../output';

export interface DoctorOptions {
  /** Print the registry and run nothing. */
  list?: boolean;
  /** Restrict the run to these check ids (repeatable flag). */
  check?: string[];
  /** Per-statement cap in milliseconds. */
  timeout?: string;
  json?: boolean;
  /** Human output only: hide the checks that came back clean. */
  failuresOnly?: boolean;
  /** Skip the data-quality suite; only check that /graphql answers for this key. */
  graphql?: boolean;
}

/**
 * `ci doctor` — is the data this appliance imported actually sound?
 *
 * ## What it is for
 *
 * The other commands answer "did the import run": stages, percentages, rows
 * written. None of them answers "did it write the RIGHT rows", and that is where
 * every defect this session found actually lived — a push stage that reported
 * 100% while writing people named "Missed call from", places named
 * "IMG_0139.JPG", and photo events with no thumbnail behind them. The run looked
 * perfect. The data was wrong.
 *
 * So: a suite of checks (see `../../doctor/checks.ts`), each one a regression
 * detector for a defect that really shipped, run in one call and reported in one
 * screen.
 *
 * ## Written for two readers
 *
 * A person watching an import wants the table: what ran, how long, what it
 * found. An agent working out what an import did wrong wants `--json`, and wants
 * every finding to carry enough context to act without asking a follow-up
 * question — which is why each one ships its own `remedy` and `mirrors` rather
 * than an id the reader has to go look up. The two outputs are the same data;
 * neither is a summary of the other.
 *
 * ## The gate
 *
 * Exit 1 when any HIGH check is non-zero, so this can sit at the end of an
 * agent's loop or a release check and mean something. Exit 1 ALSO when a HIGH
 * check could not answer — a timeout or a database error. That is deliberate and
 * it is the part most likely to be argued with: a gate that reads "I could not
 * look" as "there is nothing there" passes exactly when the corpus got big
 * enough for the checks to matter. Raise `--timeout` rather than ignoring it.
 *
 * Exit 2 stays what it is everywhere else in this CLI: you asked for something
 * impossible (an unknown check id, no api key, no appliance).
 */
export async function doctorCommand(ctx: CliContext, options: DoctorOptions = {}): Promise<void> {
  if (options.graphql) {
    return checkGraphQL(ctx, options);
  }

  if (options.list) {
    return listChecks(ctx, options);
  }

  const timeoutMs = parseTimeout(options.timeout);
  const report = await ctx.client.runDoctor({ checks: options.check, timeoutMs });

  if (options.json) {
    json(ctx.term, report);
  } else {
    render(ctx, report, options);
  }

  if (!report.ok) {
    // The message goes to stderr via CliError, so `--json`'s stdout stays a
    // single parseable document even when the gate trips. An agent reads the
    // exit code and the JSON; it should never have to strip a human sentence
    // off the front of the payload.
    throw new CliError(describeGate(report), 1);
  }
}

/**
 * `doctor --graphql` — can this CLI reach `/graphql` at all with the given key?
 *
 * The REST half of this command answers "did the import run correctly"; this
 * answers a narrower question about the OTHER protocol the CLI now speaks (see
 * `../graphqlClient.ts`): is there a CI-Server at `--server` / `CI_SERVER_URL`,
 * does it serve GraphQL, and does the api key authenticate there too. It runs
 * `{ me }` — the cheapest authenticated query on the schema — and reports who
 * it resolves to. Any answer at all, even a `null` `me`, proves reachability
 * and a valid key; only an unreachable appliance or a rejected key fails this,
 * exactly as `UnreachableError` / `ApiError` already report for the REST side.
 *
 * A short-circuit rather than a fifth check bolted onto the REST suite: the
 * two answer unrelated questions (network/auth vs. data quality), and mixing
 * them would mean `--check <id>` and `--failures-only` had to pretend to make
 * sense of a check with no `severity` or `count`.
 */
async function checkGraphQL(ctx: CliContext, options: DoctorOptions): Promise<void> {
  const me = await ctx.graphql.me();

  if (options.json) {
    json(ctx.term, { ok: true, me });

    return;
  }

  ctx.term.out(
    me == null
      ? 'GraphQL reachable, but `me` returned nothing — is this key signed in as anyone?'
      : `GraphQL reachable as ${me.name} <${me.email}> (${me.id}).`,
  );
}

/** `--list`: the vocabulary, without running anything. */
async function listChecks(ctx: CliContext, options: DoctorOptions): Promise<void> {
  const checks = await ctx.client.listDoctorChecks();

  if (options.json) {
    json(ctx.term, checks);

    return;
  }

  ctx.term.out(
    table(checks, [
      { header: 'check', value: (check: DoctorCheckSummary) => check.id },
      { header: 'sev', value: (check) => check.severity },
      { header: 'scope', value: (check) => check.scope },
      { header: 'a non-zero count means', value: (check) => check.title },
    ]),
  );
  ctx.term.out(
    `\n${checks.length} checks. Naming none runs them all; \`--check <id>\` (repeatable) runs a subset.` +
      '\nHIGH checks gate the exit code. Full remedies: `--list --json`.',
  );
}

/**
 * The human report: one row per check, then the detail for everything that is
 * not clean.
 *
 * Every check appears in the table by default, including the clean ones,
 * because "what ran" is half of what this command is for — a suite that only
 * printed its failures would be indistinguishable from a suite that only ran
 * the failing checks. `--failures-only` trims it once you already know.
 */
function render(ctx: CliContext, report: DoctorReport, options: DoctorOptions): void {
  const rows = options.failuresOnly
    ? report.findings.filter((finding) => finding.status !== 'clean')
    : report.findings;

  ctx.term.out(
    table(
      rows,
      [
        { header: 'check', value: (finding: DoctorFinding) => finding.id },
        { header: 'sev', value: (finding) => finding.severity },
        { header: 'status', value: (finding) => finding.status.toUpperCase() },
        {
          header: 'count',
          value: (finding) => (finding.count == null ? '?' : finding.count.toLocaleString('en-US')),
          align: 'right',
        },
        { header: 'took', value: (finding) => took(finding.durationMs), align: 'right' },
      ],
      '(no checks matched)',
    ),
  );

  const t = report.totals;

  ctx.term.out(
    `\n${t.found} finding(s) (${t.highFindings} high), ${t.clean} clean, ` +
      `${t.timeout} timed out, ${t.error} errored — ${took(report.durationMs)} total, ` +
      `at a ${took(report.statementTimeoutMs)} cap per statement.`,
  );

  for (const finding of report.findings) {
    if (finding.status === 'clean') {
      continue;
    }

    ctx.term.out('');
    ctx.term.out(`${finding.severity.toUpperCase()}  ${finding.id}  [${finding.status}]`);
    ctx.term.out(`  ${finding.title}`);

    if (finding.count != null) {
      ctx.term.out(`  rows      ${finding.count.toLocaleString('en-US')}`);
    }

    if (finding.breakdown != null) {
      // Labelled `breakdown` rather than `by source` because the dimension is
      // per-check: source_system for most, but stage for the pipeline ones and
      // mimetype for the content one. Naming it after the JSON field is also
      // what lets someone reading the table find the same number in `--json`.
      ctx.term.out(`  breakdown ${describeBreakdown(finding.breakdown)}`);
    }

    if (finding.sample != null) {
      ctx.term.out(`  sample    ${JSON.stringify(finding.sample)}`);
    }

    if (finding.error != null) {
      ctx.term.out(`  error     ${finding.error}`);
      ctx.term.out(`  scanning  ${finding.scope}`);
    }

    ctx.term.out(`  remedy    ${finding.remedy}`);

    if (finding.mirrors != null) {
      ctx.term.out(`  mirrors   ${finding.mirrors}`);
    }
  }
}

/**
 * A check's wall-clock, at the resolution a check actually takes.
 *
 * NOT the shared `duration()` helper, which rounds to whole seconds — right for
 * a run list where stages take minutes, useless here, where the whole 19-check
 * suite measured 631ms on a live appliance and every row would read `0s`. A
 * `took` column that cannot tell 2ms from 900ms is a column that cannot point
 * at the check about to become the one that times out.
 */
function took(ms: number): string {
  return ms < 1000 ? `${ms}ms` : duration(ms);
}

/** `{gmail: 4, imessage: 2}` as `gmail=4 imessage=2`, biggest first. */
function describeBreakdown(breakdown: Record<string, number>): string {
  return Object.entries(breakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${key}=${value.toLocaleString('en-US')}`)
    .join(' ');
}

/**
 * Why the gate tripped, in one sentence.
 *
 * Names the failing check ids rather than just counting them: the reader of this
 * line is deciding what to do next, and "comms-missing-thread-id,
 * capture-events-without-content" is that decision, where "2 high findings" is
 * another command.
 */
function describeGate(report: DoctorReport): string {
  const found = report.findings.filter((f) => f.severity === 'high' && f.status === 'found');
  const unresolved = report.findings.filter(
    (f) => f.severity === 'high' && (f.status === 'timeout' || f.status === 'error'),
  );

  const parts: string[] = [];

  if (found.length > 0) {
    parts.push(`high findings: ${found.map((f) => f.id).join(', ')}`);
  }

  if (unresolved.length > 0) {
    parts.push(
      `high checks that could not answer (raise --timeout): ${unresolved.map((f) => f.id).join(', ')}`,
    );
  }

  return parts.join('; ');
}

/** `--timeout` is milliseconds, and a value that is not a positive number is a mistake worth saying so about. */
function parseTimeout(value: string | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError(`--timeout takes milliseconds, got "${value}".`);
  }

  return parsed;
}
