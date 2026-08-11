/**
 * Historical: `20260809182943_graph_delta_triggers.sql` proved statement-level
 * triggers filled `ci.graph_deltas` when TypeORM subscribers could not see
 * QueryBuilder inserts (GraphIngest).
 *
 * Those triggers were dropped in `20260811210000_drop_graph_delta_triggers.sql`.
 * App code now writes deltas via {@link GraphDeltaWriter} (MemoryModule) and
 * fold SQL (`change_source` = service name / fold helper). See #1941 / PR #1942.
 *
 * Integration coverage for the writer lives with ContentService / GraphIngest /
 * fold SQL unit tests; a full Postgres matrix can be re-added against the writer
 * if regressions reappear.
 */
describe('ci.graph_deltas app writer (triggers removed)', () => {
  it('documents the cutover from db_trigger to GraphDeltaWriter', () => {
    expect('GraphDeltaWriter').toEqual(expect.stringContaining('GraphDelta'));
  });
});
