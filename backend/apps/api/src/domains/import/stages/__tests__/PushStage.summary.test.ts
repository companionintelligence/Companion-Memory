import { PushStage } from '../PushStage';

/**
 * The push's account of itself, over a fake ledger.
 *
 * This stage's summary is read BACK OUT of `staged_items` / `staged_entities`
 * rather than accumulated in memory, so what is under test is the reading: the
 * SQL's shape is exercised against the live database in review, and the mapping
 * from ledger rows to reconciled counts is exercised here.
 *
 * The case that matters most is the last one. A re-import writes zero rows —
 * every destination is find-or-return on the `(source_type, source_system,
 * source_id)` triple — and before this that was reported as `deduped: N`, which
 * is the same field a row routed NOWHERE landed in and the same shape as a push
 * that produced nothing at all. "Wrote 0 rows" has three completely different
 * meanings and the detail could not tell them apart.
 */

/** The private read-back, reached the way a unit test is allowed to. */
type Summarizable = { summarize(runId: string): Promise<Record<string, unknown>> };

const RUN_ID = '11111111-1111-4111-8111-111111111111';

/**
 * A PushStage over a fake `dataSource` that answers only the summary's queries.
 *
 * Every collaborator is a stub: `summarize` touches none of them, and giving it
 * real ones would make this test about dependency injection rather than about
 * what the numbers mean.
 */
function stageOver(
  items: Array<{
    dataSource: string | null;
    status: string;
    unrouted?: boolean;
    representedElsewhere?: boolean;
    count: number;
  }>,
  entities: Array<{ status: string; reason: string | null; count: number }> = [],
  failures: Array<{ dataSource: string; id: string; error: string }> = [],
) {
  const dataSource = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('AS unrouted')) {
        return items.map((row) => ({ ...row, unrouted: row.unrouted ?? false, count: String(row.count) }));
      }

      if (sql.includes('DISTINCT ON (data_source)')) {
        return failures;
      }

      if (sql.includes('FROM ci_import.staged_entities')) {
        return entities.map((row) => ({ ...row, count: String(row.count) }));
      }

      throw new Error(`unexpected query: ${sql}`);
    }),
  };

  const noop = {} as never;
  const stage = new PushStage(
    dataSource as never,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    { setContext: jest.fn() } as never,
  );

  return stage as unknown as Summarizable;
}

describe('PushStage summary', () => {
  it('reconciles a healthy push per data source', async () => {
    // The amazon run from the live QA corpus, exactly: 2,777 staged rows,
    // 2,760 written, 17 already in ci.*.
    const summary = await stageOver([
      { dataSource: 'amazon', status: 'pushed', count: 2_760 },
      { dataSource: 'amazon', status: 'skipped', count: 17 },
    ]).summarize(RUN_ID);

    expect(summary).toMatchObject({
      stage: 'push',
      unitKind: 'data_source',
      consumed: 2_777,
      produced: 2_760,
      dropped: 17,
      reconciled: true,
    });
    expect(summary.dropsByReason).toEqual({ already_present: 17 });
    // 17 rows that already existed is the dedup working, not a gap.
    expect(summary.gaps).toEqual([]);
  });

  it('splits one push across the sources it actually wrote', async () => {
    // What the in-process counters cannot give: `counts` is keyed by
    // destination TABLE, and one Takeout push writes thirteen sources into six
    // tables. "How much of this import was Google Voice?" needs the source.
    const summary = await stageOver([
      { dataSource: 'google_voice', status: 'pushed', count: 309_689 },
      { dataSource: 'google_fit', status: 'pushed', count: 66_579 },
      { dataSource: 'calendar', status: 'pushed', count: 686 },
      { dataSource: 'calendar', status: 'skipped', count: 14 },
    ]).summarize(RUN_ID);

    expect((summary.units as Array<{ unit: string }>).map((unit) => unit.unit)).toEqual([
      'google_voice',
      'google_fit',
      'calendar',
    ]);
    expect(summary.produced).toBe(376_954);
  });

  it('tells a row routed nowhere apart from a row that was already there', async () => {
    // Both are `skipped` in the ledger, both were reported as `deduped`, and
    // only one of them means the record exists. `destinationsFor` returns []
    // for an undated raw GPS fix — the row was never offered to any
    // destination at all, and nothing else carries it.
    const summary = await stageOver([
      { dataSource: 'amazon', status: 'pushed', count: 100 },
      { dataSource: 'amazon', status: 'skipped', unrouted: false, count: 17 },
      { dataSource: 'amazon', status: 'skipped', unrouted: true, count: 43 },
    ]).summarize(RUN_ID);

    expect(summary.dropsByReason).toEqual({ already_present: 17, no_destination: 43 });
    // And only one of the two is something to look at.
    expect(summary.gaps).toEqual([{ reason: 'no_destination', count: 43 }]);
    expect(summary.consumed).toBe(160);
  });

  it('keeps a row carried by another lane visible, and out of the gaps', async () => {
    // The Takeout that motivated this: 341 vCard contact items routed nowhere
    // BY DESIGN — each card's Person arrived on the entity lane, 337 of them
    // resolved in the same run — reported as a gap beside the real losses.
    const summary = await stageOver(
      [
        { dataSource: 'vcard', status: 'skipped', representedElsewhere: true, count: 341 },
        { dataSource: 'google_voice', status: 'pushed', count: 1_000 },
        { dataSource: 'nmea', status: 'skipped', unrouted: true, count: 2 },
      ],
      [{ status: 'pushed', reason: null, count: 337 }],
    ).summarize(RUN_ID);

    // Still counted, under its own name…
    expect(summary.dropsByReason).toEqual({ represented_elsewhere: 341, no_destination: 2 });
    // …and not a loss. The routed-nowhere row nothing claimed still is.
    expect(summary.gaps).toEqual([{ reason: 'no_destination', count: 2 }]);
    expect(summary).toMatchObject({ consumed: 1_343 + 337, reconciled: true });
  });

  it('says a re-import is a re-import, not a push that produced nothing', async () => {
    // THE case. Zero rows written, and the reason is that ci.* already holds
    // all of them — which reads identically to a total failure unless the
    // summary says which.
    const summary = await stageOver([{ dataSource: 'amazon', status: 'skipped', count: 2_777 }]).summarize(
      RUN_ID,
    );

    expect(summary).toMatchObject({
      produced: 0,
      dropped: 2_777,
      consumed: 2_777,
      emptyReason: 'all_already_present',
      reconciled: true,
    });
    expect(summary.gaps).toEqual([]);
  });

  it('names a quarantined row rather than only counting it', async () => {
    const summary = await stageOver(
      [
        { dataSource: 'imessage', status: 'pushed', count: 9 },
        { dataSource: 'imessage', status: 'failed', count: 1 },
      ],
      [],
      [{ dataSource: 'imessage', id: 'row-9', error: 'invalid byte sequence for encoding UTF8' }],
    ).summarize(RUN_ID);

    expect(summary.gaps).toEqual([{ reason: 'row_failed', count: 1 }]);
    // Bounded samples, never one per row: this stage's largest single run on
    // the QA corpus is 703,956 staged items.
    expect(summary.samples).toEqual([
      {
        reason: 'row_failed',
        slug: 'row_push_failed',
        detail: 'imessage row-9: invalid byte sequence for encoding UTF8',
      },
    ]);
  });

  it('keeps a bookkeeping entity exclusion out of the gaps, and an unresolved one in', async () => {
    // `isGraphExcluded` skips an `email_thread` row per gmail thread on every
    // ordinary import — the stage working as designed. An entity with neither
    // a handle nor a name is the subset that is a real gap, and it will not
    // resolve on a retry either.
    const summary = await stageOver(
      [{ dataSource: 'gmail', status: 'pushed', count: 500 }],
      [
        { status: 'pushed', reason: null, count: 120 },
        { status: 'skipped', reason: 'excluded from the graph', count: 3_400 },
        { status: 'skipped', reason: 'no stable name or handle to resolve by', count: 7 },
      ],
    ).summarize(RUN_ID);

    expect(summary.dropsByReason).toEqual({ entity_excluded: 3_400, entity_unresolved: 7 });
    expect(summary.gaps).toEqual([{ reason: 'entity_unresolved', count: 7 }]);

    const entities = (summary.units as Array<{ unit: string; produced: number }>).find(
      (unit) => unit.unit === '(entities)',
    );

    expect(entities?.produced).toBe(120);
  });

  it('counts rows the stage never reached, so a stopped push is not read as a loss', async () => {
    // A push that ran out of disk leaves the untouched rows `pending`. That is
    // the state it resumes from — not data that went missing — but a summary
    // that ignored them would report a consumed figure smaller than the run.
    const summary = await stageOver([
      { dataSource: 'google_voice', status: 'pushed', count: 50_000 },
      { dataSource: 'google_voice', status: 'pending', count: 255_000 },
    ]).summarize(RUN_ID);

    expect(summary).toMatchObject({ consumed: 305_000, produced: 50_000, reconciled: true });
    expect(summary.gaps).toEqual([{ reason: 'not_attempted', count: 255_000 }]);
  });
});
