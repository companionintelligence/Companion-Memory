import { ESTIMATED_CONFIDENCE, LocationEstimateService } from '../LocationEstimateService';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeService(queryImpl: (...args: unknown[]) => Promise<unknown>) {
  const dataSource = { query: jest.fn(queryImpl) };
  const service = new LocationEstimateService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dataSource as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    makeLogger() as any,
  );

  return { service, dataSource };
}

const USER = '00000000-0000-0000-0000-0000000000aa';

describe('LocationEstimateService.countCandidates', () => {
  it('counts coordinate-less, non-estimated, non-predicted, donor-backed events for the user', async () => {
    const { service, dataSource } = makeService(async () => [{ count: '42' }]);

    const n = await service.countCandidates(USER, ['calendar', 'uber'], 86400);

    expect(n).toBe(42);
    const [sql, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('location_coordinates IS NULL');
    expect(sql).toContain('source_system = ANY($2)');
    expect(sql).toContain('is_deleted = false');
    expect(sql).toContain("<> 'estimated'");
    // Blocker guard: never count/estimate a predicted event (CHECK constraint).
    expect(sql).toContain('COALESCE(e.is_predicted, false) = false');
    // Exact (not upper-bound) count: only candidates with a donor in the gap.
    expect(sql).toContain('EXISTS (');
    expect(sql).toContain('make_interval(secs => $3)'); // sargable window, gap = $3 here
    // forced is the trailing bind; default false omits estimated rows.
    expect(params).toEqual([USER, ['calendar', 'uber'], 86400, false]);
    // Predicate is forced-aware (the SQL admits previously-estimated rows when $4 is true).
    expect(sql).toContain('$4::bool');
    expect(sql).toContain("metadata->>'location_source' = 'estimated'");
  });

  it('never counts an event that names its own location — forced or not', async () => {
    // Its coordinate is the geocoder's to resolve. A neighbour's fix pinned a
    // calendar flight "Bangkok BKK" to the user's home (enrich.estimate_location
    // v2 records the same rows as `skipped: has_location_name`). The clause sits
    // OUTSIDE the forced-aware OR, so `forced` cannot re-admit them either.
    const { service, dataSource } = makeService(async () => [{ count: '0' }]);

    await service.countCandidates(USER, ['calendar'], 86400, true);

    const [sql] = dataSource.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(
      /\)\s*AND \(e\.location_name IS NULL OR btrim\(e\.location_name\) = ''\)\s*AND e\.is_deleted/,
    );
  });

  it('with forced=true, widens the candidate predicate to include prior estimates', async () => {
    const { service, dataSource } = makeService(async () => [{ count: '7' }]);

    const n = await service.countCandidates(USER, ['calendar'], 86400, true);

    expect(n).toBe(7);
    const [, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toBe(true);
  });
});

describe('LocationEstimateService.estimateBatch', () => {
  it('short-circuits (no UPDATE) when there are no candidates', async () => {
    const { service, dataSource } = makeService(async () => [{ count: '0' }]);

    const res = await service.estimateBatch(USER, {
      limit: 100,
      maxGapHours: 24,
      sourceSystems: ['calendar'],
    });

    expect(res).toEqual({ candidates: 0, estimated: 0 });
    expect(dataSource.query).toHaveBeenCalledTimes(1); // count only — no UPDATE issued
  });

  it('runs the bounded temporal-NN UPDATE and reports rows actually filled', async () => {
    let call = 0;
    const { service, dataSource } = makeService(async () => {
      call += 1;
      if (call === 1) {
        return [{ count: '5' }];
      } // countCandidates

      // The UPDATE's counting CTE, answered the way the driver answers a
      // SELECT. Not 2: that is the constant `.length` of TypeORM's
      // `[rows, rowCount]` pair, which is what a bare UPDATE used to report.
      return [{ count: 3 }];
    });

    const res = await service.estimateBatch(USER, {
      limit: 100,
      maxGapHours: 24,
      sourceSystems: ['calendar', 'uber'],
    });

    expect(res).toEqual({ candidates: 5, estimated: 3 });

    const [sql, params] = dataSource.query.mock.calls[1] as [string, unknown[]];
    // The UPDATE sits inside a CTE and the OUTER command is the SELECT that
    // counts it; with the UPDATE outermost the count reads TypeORM's pair.
    expect(sql).toMatch(/estimated AS \(\s*UPDATE ci\.events tgt/);
    expect(sql).toMatch(/RETURNING 1\s*\)\s*SELECT count\(\*\)::int AS count FROM estimated$/);
    // params: [userId, sourceSystems, limit, maxGapSeconds, ESTIMATED_CONFIDENCE, maxGapHours, forced]
    expect(params[0]).toBe(USER);
    expect(params[1]).toEqual(['calendar', 'uber']);
    expect(params[2]).toBe(100);
    expect(params[3]).toBe(24 * 3600);
    expect(params[4]).toBe(ESTIMATED_CONFIDENCE);
    expect(params[5]).toBe(24);
    expect(params[6]).toBe(false); // forced defaults off

    // Safety invariants encoded in the SQL.
    expect(sql).toContain('location_coordinates IS NULL'); // candidate predicate (NULL coords admitted)
    expect(sql).toContain("(e.location_name IS NULL OR btrim(e.location_name) = '')"); // named rows are the geocoder's
    expect(sql).toContain("|| jsonb_build_object('location_source', 'estimated')");
    expect(sql).toContain('is_inferred = true');
    expect(sql).toContain('COALESCE(e.is_predicted, false) = false'); // never abort batch on a predicted row
    expect(sql).toContain("'position'"); // GPS-fix donor branch present
    expect(sql).toContain('make_interval(secs => $4)'); // sargable donor window (gap = $4 in the UPDATE)
    expect(sql).toContain('$7::bool'); // forced bind threaded into candidate predicate + inference_sources
    expect(sql).toContain("'forced', $7::bool"); // forced flag recorded in inference_sources
    // Nearest-in-time is the PRIMARY donor sort; a GPS position fix only breaks a
    // tie at equal delta. (A far position fix must not beat a closer event.)
    expect(sql).toContain("ORDER BY delta_seconds ASC, (donor <> 'position')");
  });

  it('forced=true threads the flag into countCandidates AND the UPDATE bind', async () => {
    let call = 0;
    const { service, dataSource } = makeService(async () => {
      call += 1;
      if (call === 1) {
        return [{ count: '3' }];
      }

      return [{ count: 1 }];
    });

    const res = await service.estimateBatch(USER, {
      limit: 50,
      maxGapHours: 12,
      sourceSystems: ['calendar'],
      forced: true,
    });

    expect(res).toEqual({ candidates: 3, estimated: 1 });

    // countCandidates call: forced is the 4th bind.
    const countParams = dataSource.query.mock.calls[0][1] as unknown[];
    expect(countParams[3]).toBe(true);

    // UPDATE call: forced is the 7th bind, used by the predicate + inference_sources.
    const updateParams = dataSource.query.mock.calls[1][1] as unknown[];
    expect(updateParams[6]).toBe(true);
  });

  it('converts a fractional maxGapHours to whole seconds', async () => {
    let call = 0;
    const { service, dataSource } = makeService(async () =>
      ++call === 1 ? [{ count: '1' }] : [{ count: 0 }],
    );

    await service.estimateBatch(USER, { limit: 10, maxGapHours: 1.5, sourceSystems: ['calendar'] });

    const params = dataSource.query.mock.calls[1][1] as unknown[];
    expect(params[3]).toBe(5400); // 1.5h -> 5400s
  });
});
