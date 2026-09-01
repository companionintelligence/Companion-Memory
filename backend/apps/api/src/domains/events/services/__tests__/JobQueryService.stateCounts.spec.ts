import { JobQueryService } from '../JobQueryService';

/**
 * Regression guard for the `stateCounts` bucket expression.
 *
 * The Jobs table returned a 500 for every request — "invalid input value for
 * enum pgboss.job_state: dead-letter" — while the dashboard summary above it
 * rendered fine. The cause is a Postgres typing rule rather than a logic error:
 * a CASE unifies its branches to a single type, so
 *
 *   CASE WHEN job.name = 'dead-letter' THEN 'dead-letter' ELSE job.state END
 *
 * takes the ENUM type from the ELSE branch and then tries to coerce the literal
 * into it. `dead-letter` is a QUEUE name, never a member of `pgboss.job_state`,
 * so the query dies at parse time.
 *
 * The rest of the service already handled the synthetic state correctly, which
 * is why this survived review — and the other specs in this folder mock the
 * query builder, so the SQL is never executed and a mocked test cannot catch it.
 * Asserting on the emitted expression is the cheapest guard that actually binds.
 */
describe('JobQueryService.facetCounts — bucket expression', () => {
  function captureSelect(): { select: string; addSelects: string[]; groupBy: string } {
    const captured = { select: '', addSelects: [] as string[], groupBy: '' };

    const builder: Record<string, unknown> = {};
    const chain = () => builder;

    Object.assign(builder, {
      select: jest.fn((expression: string) => {
        captured.select = expression;

        return builder;
      }),
      addSelect: jest.fn((expression: string) => {
        captured.addSelects.push(expression);

        return builder;
      }),
      setParameter: jest.fn(chain),
      groupBy: jest.fn((expression: string) => {
        captured.groupBy = expression;

        return builder;
      }),
      andWhere: jest.fn(chain),
      where: jest.fn(chain),
      orWhere: jest.fn(chain),
      getRawMany: jest.fn().mockResolvedValue([]),
    });

    const repo = { createQueryBuilder: jest.fn(() => builder) };
    const service = new JobQueryService(repo as never, repo as never, repo as never, repo as never);

    // facetCounts is private; exercising it through the public shape keeps the
    // test honest about what it is guarding.
    (service as unknown as { facetCounts: (q: unknown, u: string) => Promise<unknown> }).facetCounts(
      {},
      'user-1',
    );

    return captured;
  }

  it('casts job.state to text so the CASE does not unify to the enum', () => {
    const { select } = captureSelect();

    expect(select).toContain('CASE WHEN');
    // The cast is the fix. Without it Postgres coerces 'dead-letter' into
    // pgboss.job_state and the whole jobs list 500s.
    expect(select).toMatch(/job\.state::text/);
  });

  it("still buckets the dead-letter QUEUE under a synthetic 'dead-letter' label", () => {
    const { select } = captureSelect();

    expect(select).toContain("'dead-letter'");
    expect(select).toContain('job.name');
  });

  /**
   * The category half of the same scan, and the reason it cannot group by queue.
   *
   * pg-boss copies a job's `data` verbatim onto the dead-letter row but rewrites
   * the queue column to the literal `dead-letter`, so the queue a job died on is
   * gone. On a live appliance 88% of rows are dead-lettered — grouping the
   * category counts on `job.name` would file almost the entire table under one
   * meaningless bucket and every category chip would read ~0.
   */
  it('groups the category counts on the event in the payload, never on the queue', () => {
    const { addSelects, groupBy } = captureSelect();

    expect(addSelects).toContain("job.data->>'name'");
    // Both grouped columns in one call: the mock builder above implements
    // `groupBy` but not `addGroupBy`, and so does this service on purpose.
    expect(groupBy).toBe('1, 2');
  });
});
