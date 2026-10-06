import { ApiError, describeFailureBody } from '../client';
import type { DoctorFinding, DoctorReport } from '../wire';
import { doctorCommand } from '../commands/doctor';
import { CliError } from '../context';
import { GraphQLApiError } from '../graphqlClient';

import { harness } from './support/harness';

/** A clean finding, overridden per test. Typed as the real thing so the fixtures cannot drift from the API. */
const finding = (
  over: Partial<DoctorFinding> & Pick<DoctorFinding, 'id' | 'severity' | 'status'>,
): DoctorFinding => ({
  title: 'Something is wrong with the data in a way worth a sentence',
  scope: 'ci.communications',
  remedy: 'Fix the parser named in the breakdown, re-import, then re-check.',
  mirrors: 'db/postgres/migrations/20260809184710_clean_stage_support.sql',
  count: 0,
  breakdown: null,
  sample: null,
  durationMs: 12,
  error: null,
  ...over,
});

/** The rollup the service computes, recomputed here so the fixtures stay internally consistent. */
function buildReport(findings: DoctorFinding[]): DoctorReport {
  const highFindings = findings.filter((f) => f.severity === 'high' && f.status === 'found').length;
  const highUnresolved = findings.filter(
    (f) => f.severity === 'high' && (f.status === 'timeout' || f.status === 'error'),
  ).length;

  return {
    ok: highFindings === 0 && highUnresolved === 0,
    at: '2026-08-19T01:00:00.000Z',
    durationMs: 1234,
    statementTimeoutMs: 15_000,
    totals: {
      checks: findings.length,
      clean: findings.filter((f) => f.status === 'clean').length,
      found: findings.filter((f) => f.status === 'found').length,
      timeout: findings.filter((f) => f.status === 'timeout').length,
      error: findings.filter((f) => f.status === 'error').length,
      highFindings,
      highUnresolved,
    },
    findings,
  };
}

/**
 * The command's contract with the two readers it was written for: a person
 * looking at a table, and a loop looking at an exit code and a JSON document.
 */
describe('ci doctor', () => {
  it('prints every check, clean ones included, and the detail for the findings', async () => {
    const report = buildReport([
      finding({ id: 'comms-missing-thread-id', severity: 'high', status: 'clean' }),
      finding({
        id: 'capture-events-without-content',
        severity: 'high',
        status: 'found',
        count: 2098,
        breakdown: { google_photos: 2090, facebook: 8 },
        sample: { event_id: 'abc', file_id: 'def' },
      }),
    ]);

    const ctx = harness({ runDoctor: async () => report });

    await expect(doctorCommand(ctx)).rejects.toBeInstanceOf(CliError);

    const text = ctx.term.text();

    // "What ran" is half of what this command is for, so a clean check is still
    // a row: a suite that only printed failures would be indistinguishable from
    // a suite that only ran the failing checks.
    expect(text).toContain('comms-missing-thread-id');
    expect(text).toMatch(/capture-events-without-content\s+high\s+FOUND\s+2,098/);
    expect(text).toContain('1 finding(s) (1 high), 1 clean, 0 timed out, 0 errored');
    // Sub-second resolution: the shared duration() helper rounds to whole
    // seconds, and a suite whose checks run in single-digit milliseconds would
    // print an entire column of `0s`.
    expect(text).toContain('12ms');
    // Biggest first, so the source most responsible reads first.
    expect(text).toContain('breakdown google_photos=2,090 facebook=8');
    expect(text).toContain('sample    {"event_id":"abc","file_id":"def"}');
    expect(text).toContain('remedy    Fix the parser');
  });

  it('hides the clean checks under --failures-only', async () => {
    const report = buildReport([
      finding({ id: 'comms-missing-thread-id', severity: 'high', status: 'clean' }),
      finding({ id: 'person-duplicate-names', severity: 'medium', status: 'found', count: 100 }),
    ]);

    const ctx = harness({ runDoctor: async () => report });

    await doctorCommand(ctx, { failuresOnly: true });

    const [header] = ctx.term.lines;

    // The table is trimmed; the summary line still counts everything, because
    // "1 clean" is the fact that makes the trimmed table interpretable.
    expect(header).not.toContain('comms-missing-thread-id');
    expect(ctx.term.text()).toContain('person-duplicate-names');
    expect(ctx.term.text()).toContain('1 clean');
  });

  it('exits zero when nothing high is wrong, even with medium findings', async () => {
    const report = buildReport([
      finding({
        id: 'events-dated-in-future',
        severity: 'medium',
        status: 'found',
        count: 3,
        breakdown: { calendar: 3 },
      }),
    ]);

    const ctx = harness({ runDoctor: async () => report });

    // Three future-dated calendar events on the live appliance were all
    // correct. A gate that failed on them would be turned off within a day.
    await expect(doctorCommand(ctx)).resolves.toBeUndefined();
  });

  it('exits non-zero and names the checks when a HIGH check is non-zero', async () => {
    const report = buildReport([
      finding({ id: 'comms-missing-thread-id', severity: 'high', status: 'found', count: 4 }),
      finding({ id: 'person-name-garbage', severity: 'high', status: 'found', count: 17 }),
      finding({ id: 'person-duplicate-names', severity: 'medium', status: 'found', count: 100 }),
    ]);

    const ctx = harness({ runDoctor: async () => report });

    await expect(doctorCommand(ctx)).rejects.toMatchObject({
      exitCode: 1,
      message: 'high findings: comms-missing-thread-id, person-name-garbage',
    });
  });

  it('exits non-zero when a HIGH check could not answer at all', async () => {
    const report = buildReport([
      finding({
        id: 'comms-placeholder-content',
        severity: 'high',
        status: 'timeout',
        count: null,
        error: 'canceling statement due to statement timeout',
      }),
    ]);

    const ctx = harness({ runDoctor: async () => report });

    await expect(doctorCommand(ctx)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('could not answer (raise --timeout): comms-placeholder-content'),
    });
    // The scope is printed next to the failure, so the reader knows what was
    // being scanned when the clock ran out.
    expect(ctx.term.text()).toContain('scanning  ci.communications');
  });

  it('emits the documented shape under --json, and nothing else on stdout', async () => {
    const report = buildReport([
      finding({
        id: 'capture-events-without-content',
        severity: 'high',
        status: 'found',
        count: 10,
        breakdown: { facebook: 10 },
        sample: { event_id: 'abc' },
      }),
    ]);

    const ctx = harness({ runDoctor: async () => report });

    await expect(doctorCommand(ctx, { json: true })).rejects.toBeInstanceOf(CliError);

    // The gate message goes to stderr, so stdout stays one parseable document
    // even when the run fails — an agent must never have to strip a human
    // sentence off the front of the payload.
    const parsed = JSON.parse(ctx.term.text());

    expect(parsed.ok).toBe(false);
    expect(parsed.statementTimeoutMs).toBe(15_000);
    expect(parsed.totals).toMatchObject({ checks: 1, found: 1, highFindings: 1, highUnresolved: 0 });
    expect(parsed.findings[0]).toMatchObject({
      id: 'capture-events-without-content',
      severity: 'high',
      status: 'found',
      count: 10,
      breakdown: { facebook: 10 },
      sample: { event_id: 'abc' },
    });
    // Every finding carries its own remedy and provenance: a fresh agent with
    // no context should be able to act on one without a second call.
    expect(typeof parsed.findings[0].remedy).toBe('string');
    expect(parsed.findings[0].mirrors).toContain('db/postgres/migrations/');
  });

  it('passes the requested subset and timeout through to the appliance', async () => {
    const seen: Array<{ checks?: readonly string[]; timeoutMs?: number }> = [];
    const ctx = harness({
      runDoctor: async (options) => {
        seen.push(options ?? {});

        return buildReport([]);
      },
    });

    await doctorCommand(ctx, { check: ['pipeline-dead-letters'], timeout: '60000' });

    expect(seen).toEqual([{ checks: ['pipeline-dead-letters'], timeoutMs: 60_000 }]);
  });

  it('explains that a non-admin cannot run doctor instead of forwarding the raw 403', async () => {
    // The suite reads every account's data, so the appliance limits it to the
    // administrator. A household member should learn that, not be told their
    // key was rejected and go mint a new one that fails the same way.
    const ctx = harness({
      runDoctor: async () => {
        throw new ApiError(
          403,
          describeFailureBody(
            403,
            JSON.stringify({ message: 'This action requires an administrator account' }),
            true,
          ),
          '/import/doctor',
        );
      },
    });

    await expect(doctorCommand(ctx, {})).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('limited to the appliance administrator'),
    });
  });

  it('leaves a 403 that is not the admin gate to the client, whose advice fits it', async () => {
    // A scope-limited key is refused before the admin gate is asked. A fresh
    // key is the fix there, and "you are not the administrator" would be wrong.
    const refusal = new ApiError(
      403,
      describeFailureBody(
        403,
        JSON.stringify({ message: 'This API key is scope-limited and cannot access this endpoint' }),
        true,
      ),
      '/import/doctor',
    );
    const ctx = harness({
      runDoctor: async () => {
        throw refusal;
      },
    });

    await expect(doctorCommand(ctx, {})).rejects.toBe(refusal);
  });

  it('refuses a --timeout that is not a positive number of milliseconds', async () => {
    const ctx = harness({});

    await expect(doctorCommand(ctx, { timeout: '30s' })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('--timeout takes milliseconds'),
    });
  });

  it('lists the registry without running anything under --list', async () => {
    const ctx = harness({
      listDoctorChecks: async () => [
        {
          id: 'comms-missing-thread-id',
          severity: 'high' as const,
          title: 'Communications with no thread_id',
          scope: 'ci.communications',
          remedy: 'Run the backfill.',
          mirrors: null,
        },
      ],
    });

    // `runDoctor` is deliberately not stubbed: the harness throws on any client
    // call a test did not name, so this asserts that `--list` runs nothing.
    await doctorCommand(ctx, { list: true });

    expect(ctx.term.text()).toContain('comms-missing-thread-id');
    expect(ctx.term.text()).toContain('1 checks');
  });

  it('emits the registry as JSON under --list --json', async () => {
    const ctx = harness({
      listDoctorChecks: async () => [
        {
          id: 'pipeline-dead-letters',
          severity: 'high' as const,
          title: 'Dead letters never replayed',
          scope: 'ci.pipeline_dead_letters',
          remedy: 'Read the errors first.',
          mirrors: null,
        },
      ],
    });

    await doctorCommand(ctx, { list: true, json: true });

    expect(JSON.parse(ctx.term.text())[0].id).toBe('pipeline-dead-letters');
  });

  describe('--graphql', () => {
    it('reports who the key resolves to, and runs no REST checks at all', async () => {
      // `runDoctor` / `listDoctorChecks` are deliberately unstubbed: the harness
      // throws if either is called, which is the assertion that `--graphql`
      // short-circuits before touching the REST doctor suite.
      const ctx = harness(
        {},
        { me: async () => ({ id: 'user_1', name: 'Liam', email: 'liam@example.com', avatarUrl: null }) },
      );

      await doctorCommand(ctx, { graphql: true });

      expect(ctx.term.text()).toBe('GraphQL reachable as Liam <liam@example.com> (user_1).');
    });

    it('says so plainly when `me` resolves to nothing', async () => {
      const ctx = harness({}, { me: async () => null });

      await doctorCommand(ctx, { graphql: true });

      expect(ctx.term.text()).toContain('returned nothing');
    });

    it('emits the documented shape under --json', async () => {
      const ctx = harness(
        {},
        { me: async () => ({ id: 'user_1', name: 'Liam', email: 'liam@example.com', avatarUrl: null }) },
      );

      await doctorCommand(ctx, { graphql: true, json: true });

      expect(JSON.parse(ctx.term.text())).toMatchObject({ ok: true, me: { id: 'user_1' } });
    });

    it('does not swallow an auth failure — the appliance is unreachable-for-this-key, not "clean"', async () => {
      const ctx = harness(
        {},
        {
          me: async () => {
            throw new GraphQLApiError('UNAUTHENTICATED', 'the api key was rejected', 'me');
          },
        },
      );

      await expect(doctorCommand(ctx, { graphql: true })).rejects.toMatchObject({ status: 401 });
    });
  });
});
